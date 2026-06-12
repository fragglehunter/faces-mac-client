#!/usr/bin/env python3
"""Mock faces-admin server — dev/test harness for the Mac app's Admin window.

Implements the documented faces-admin REST API (see ../docs/ADMIN_API.md) with
in-memory mutable state, so the Admin window UI can be exercised end-to-end
without a cluster. NOT bundled into the app (lives outside web/).

Usage:
  python3 tools/mock-admin-server.py [--port 8899] [--auth] [--mode pubsub|classic]
                                     [--flaky] [--partial-fail] [--serve-web DIR]

  --auth          gate /api/* behind the faces-admin-session cookie
                  (login: faces-admin / welovetosmile)
  --mode          initial faceMode (default pubsub); PUT /api/config can flip it
  --flaky         color service reports unhealthy on ~every 4th status poll
  --partial-fail  chaos PUTs report one failed pod (exercise the ⚠ toast path)
  --serve-web     serve admin.html/.css/.js same-origin from DIR (default ../web)
                  so browser-preview auth cookies round-trip without CORS pain

Every request is logged to stdout: METHOD path body -> status
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- fixtures

SMILEYS = {
    "Grinning":    "&#x1F603;",
    "Sleeping":    "&#x1F634;",
    "Cursing":     "&#x1F92C;",
    "Kaboom":      "&#x1F92F;",
    "HeartEyes":   "&#x1F60D;",
    "Neutral":     "&#x1F610;",
    "RollingEyes": "&#x1F644;",
    "Screaming":   "&#x1F631;",
    "Vomiting":    "&#x1F92E;",
}

COLORS = {
    "grey":     "#BBBBBB",
    "black":    "#000000",
    "white":    "#FFFFFF",
    "darkblue": "#4477AA",
    "blue":     "#66CCEE",
    "green":    "#228833",
    "yellow":   "#CCBB44",
    "red":      "#EE6677",
    "purple":   "#AA3377",
}

# 1x1 px PNG, valid enough for an <img> tag (the "linky" custom image).
LINKY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)

ZERO_CHAOS = {"errorFraction": 0, "latchFraction": 0, "maxRate": 0,
              "delayBuckets": [], "latched": False}


def pod(name, ip, node="", zone="", region="", **extra):
    p = {"name": name, "ip": ip, "phase": "Running"}
    if node:
        p["node"] = node
    if zone:
        p["zone"] = zone
        p["region"] = region
    p.update(extra)
    return p


# Static pod topology. Keys are *instance* names (smiley2 exercises the
# multi-instance base-service mapping in the UI).
PODS = {
    "smiley": [
        pod("smiley-7d9c4b-xk2j9", "10.244.51.177", "worker-1", "us-east-1a", "us-east-1"),
        pod("smiley-7d9c4b-m2p4r", "10.244.48.188", "worker-2", "us-east-1b", "us-east-1"),
        pod("smiley-084c777e", "10.4.11.88", workloadType="externalworkload", port="80"),
    ],
    "smiley2": [
        pod("smiley2-5fb8c-q8r2p", "10.244.51.190", "worker-1", "us-east-1a", "us-east-1"),
    ],
    "color": [
        pod("color-6c5d7-aa1b2", "10.244.51.178", "worker-1", "us-east-1a", "us-east-1"),
        pod("color-6c5d7-cc3d4", "10.244.48.189", "worker-2", "us-east-1b", "us-east-1"),
    ],
    "gui": [
        pod("faces-gui-58fd7-gggg1", "10.244.51.181", "worker-1", "us-east-1a", "us-east-1"),
    ],
    "face": [
        pod("face-69c9d-ffff1", "10.244.51.182", "worker-1", "us-east-1a", "us-east-1"),
    ],
    "publisher": [
        pod("face-publisher-5d5f9-aaaa1", "10.244.51.179", "worker-1", "us-east-1a", "us-east-1"),
        pod("face-publisher-5d5f9-aaaa2", "10.244.48.190", "worker-2", "us-east-1b", "us-east-1"),
    ],
    "subscriber": [
        pod("face-subscriber-7c6d8-bbbb1", "10.244.51.180", "worker-1", "us-east-1a", "us-east-1"),
    ],
}

# chaos base service -> instance keys it broadcasts to (multi-instance discovery)
CHAOS_INSTANCES = {
    "smiley":     ["smiley", "smiley2"],
    "color":      ["color"],
    "face":       ["face"],
    "publisher":  ["publisher"],
    "subscriber": ["subscriber"],
}

DEFAULT_URLS = {
    "smileyURL":     "http://smiley",
    "colorURL":      "color:80",
    "guiURL":        "http://faces-gui",
    "faceURL":       "http://face",
    "publisherURL":  "http://face-publisher",
    "subscriberURL": "http://face-subscriber",
}

# ---------------------------------------------------------------- state

LOCK = threading.Lock()


def initial_state(mode):
    pod_smiley, pod_color = {}, {}
    for key in ("smiley", "smiley2"):
        for p in PODS[key]:
            pod_smiley[p["ip"]] = {"center": SMILEYS["Grinning"], "edge": SMILEYS["Grinning"]}
    for p in PODS["color"]:
        pod_color[p["ip"]] = {"center": COLORS["blue"], "edge": COLORS["blue"]}
    # Seeded fixtures: zone-b smiley serves a different edge emoji and has chaos
    # applied; zone-b color serves a different edge color.
    pod_smiley["10.244.48.188"]["edge"] = "&#x1F621;"
    pod_color["10.244.48.189"] = {"center": COLORS["green"], "edge": COLORS["purple"]}

    pod_chaos = {}
    for svc, keys in CHAOS_INSTANCES.items():
        for key in keys:
            for p in PODS[key]:
                pod_chaos[p["ip"]] = dict(ZERO_CHAOS, delayBuckets=[])
    pod_chaos["10.244.48.188"] = {"errorFraction": 55, "latchFraction": 0, "maxRate": 0,
                                  "delayBuckets": [500, 1000], "latched": False}

    return {
        "faceMode": mode,
        "urlOverrides": {},
        "chaos": {svc: dict(ZERO_CHAOS, delayBuckets=[]) for svc in CHAOS_INSTANCES},
        "podChaos": pod_chaos,
        "podSmiley": pod_smiley,
        "podColor": pod_color,
        "publisher": {"paused": False, "publishIntervalMs": 50, "publishConcurrency": 2},
        "subscriber": {"paused": False},
        "db": {"pending": 0, "queued": 412, "acknowledged": 8800},
        "queueDepth": 400,
        "history": [],
        "sessions": {},
        "statusPolls": 0,
    }


STATE = None  # set in main()
ARGS = None


# ---------------------------------------------------------------- helpers

def clamp(v, lo, hi):
    try:
        return max(lo, min(hi, int(v)))
    except (TypeError, ValueError):
        return lo


def apply_chaos_fields(target, body):
    if "errorFraction" in body:
        target["errorFraction"] = clamp(body["errorFraction"], 0, 100)
    if "latchFraction" in body:
        target["latchFraction"] = clamp(body["latchFraction"], 0, 100)
    if "maxRate" in body:
        try:
            target["maxRate"] = max(0.0, float(body["maxRate"]))
        except (TypeError, ValueError):
            pass
    if "delayBuckets" in body and isinstance(body["delayBuckets"], list):
        target["delayBuckets"] = [clamp(d, 0, 600000) for d in body["delayBuckets"]]
    if body.get("forceUnlatch"):
        target["latched"] = False
    if target["latchFraction"] >= 100 and target["errorFraction"] > 0 and not body.get("forceUnlatch"):
        target["latched"] = True  # crude latch simulation for UI testing


def chaos_pod_ips(svc):
    return [p["ip"] for key in CHAOS_INSTANCES.get(svc, []) for p in PODS[key]]


def serving_list(kind):
    """podServing[] for /api/smileystate (kind=smiley) or /api/colorstate."""
    out = []
    store = STATE["podSmiley"] if kind == "smiley" else STATE["podColor"]
    keys = ("smiley", "smiley2") if kind == "smiley" else ("color",)
    field = "smiley" if kind == "smiley" else "color"
    for key in keys:
        for p in PODS[key]:
            s = store.get(p["ip"])
            if not s:
                continue
            entry = {"ip": p["ip"], "name": p["name"]}
            if p.get("zone"):
                entry["zone"] = p["zone"]
            entry[field] = s["center"]
            if s["edge"] != s["center"]:
                entry[field + "Edge"] = s["edge"]
            out.append(entry)
    out.sort(key=lambda e: (e.get("name", ""), e["ip"]))
    return out


def infra_pod(svc_key, p):
    """One InfraPod object reflecting current state."""
    entry = {k: p[k] for k in ("name", "ip", "phase") if k in p}
    for k in ("node", "zone", "region", "workloadType", "port"):
        if p.get(k):
            entry[k] = p[k]
    entry["available"] = True
    base = re.sub(r"\d+$", "", svc_key)
    if base in ("smiley",):
        s = STATE["podSmiley"].get(p["ip"])
        if s:
            entry["smiley"] = s["center"]
            if s["edge"] != s["center"]:
                entry["smileyEdge"] = s["edge"]
    if base == "color":
        c = STATE["podColor"].get(p["ip"])
        if c:
            entry["color"] = c["center"]
            if c["edge"] != c["center"]:
                entry["colorEdge"] = c["edge"]
    if base == "publisher":
        entry["paused"] = STATE["publisher"]["paused"]
        entry["publishIntervalMs"] = STATE["publisher"]["publishIntervalMs"]
    if base == "subscriber":
        entry["paused"] = STATE["subscriber"]["paused"]
    if base != "gui":  # gui has no chaos endpoint
        ch = STATE["podChaos"].get(p["ip"])
        if ch:
            entry["chaos"] = dict(ch, available=True)
    return entry


def infrastructure():
    mode = STATE["faceMode"]
    svc_keys = ["gui", "smiley", "smiley2", "color"]
    svc_keys += ["publisher", "subscriber"] if mode == "pubsub" else ["face"]

    zones = {}
    for key in svc_keys:
        for p in PODS[key]:
            if p.get("workloadType") == "externalworkload":
                zkey, label, icon, region = "external", "External Workload", "\U0001F517", ""
            elif p.get("zone"):
                zkey, label, icon, region = p["zone"], p["zone"], "\U0001F4CD", p.get("region", "")
            else:
                zkey, label, icon, region = "", "On-Premise", "\U0001F3E2", ""
            z = zones.setdefault(zkey, {"zone": "" if zkey == "external" else zkey,
                                        "region": region, "label": label, "icon": icon,
                                        "pods": {}})
            z["pods"].setdefault(key, []).append(infra_pod(key, p))
    for z in zones.values():
        for plist in z["pods"].values():
            plist.sort(key=lambda e: (e.get("name", ""), e["ip"]))
    ordered = sorted(zones.values(), key=lambda z: (z["label"] in ("External Workload",),
                                                    z["label"] == "On-Premise", z["label"]))
    return {"mode": mode, "hasTopology": True, "zones": ordered}


def status_payload():
    STATE["statusPolls"] += 1
    flaky_down = ARGS.flaky and STATE["statusPolls"] % 4 == 0
    mode = STATE["faceMode"]

    def healthy(ms):
        return {"healthy": True, "latencyMs": ms}

    services = {"gui": healthy(2), "smiley": healthy(3)}
    services["color"] = ({"healthy": False, "latencyMs": 0, "error": "connection refused"}
                         if flaky_down else healthy(4))
    if mode == "pubsub":
        services["publisher"] = healthy(3)
        services["subscriber"] = healthy(2)
        services["mysql"] = healthy(2)
        services["queue"] = healthy(5)
    else:
        services["face"] = healthy(5)
    return {"mode": mode, "queueBackend": "rabbitmq", "services": services}


def config_payload():
    cfg = {
        "faceMode": STATE["faceMode"],
        "queueBackend": "rabbitmq",
        "maxDepth": 5000,
        "namespace": "faces-pub-sub",
        "k8sAvailable": True,
        "linkerdMeshed": True,
        "authEnabled": bool(ARGS.auth),
    }
    for k, v in DEFAULT_URLS.items():
        cfg[k] = STATE["urlOverrides"].get(k, v)
    return cfg


def pipeline_payload():
    """Advance a crude pipeline simulation by one poll tick (~3 s) and return
    the documented /api/pipeline shape (mysql counts, queue stats, history)."""
    pub, sub, db = STATE["publisher"], STATE["subscriber"], STATE["db"]
    max_depth = 5000
    produced = 0
    if not pub["paused"]:
        per_sec = 1000.0 / max(1, pub["publishIntervalMs"]) * pub["publishConcurrency"] * len(PODS["publisher"])
        produced = int(min(per_sec * 3, max_depth - STATE["queueDepth"]))
        produced = max(produced, 0)
        db["queued"] += produced
        STATE["queueDepth"] += produced
    if not sub["paused"]:
        consumed = min(STATE["queueDepth"], max(80, produced))
        STATE["queueDepth"] -= consumed
        db["acknowledged"] += consumed
        db["queued"] = max(0, db["queued"] - consumed)
    ready = 0.0 if pub["paused"] else round(1000.0 / max(1, pub["publishIntervalMs"]) * pub["publishConcurrency"] * len(PODS["publisher"]), 1)
    deliver = 0.0 if sub["paused"] else round(min(ready if ready else 27.0, 60.0) or 27.0, 1)
    STATE["history"].append({"queueDepth": STATE["queueDepth"], "queued": db["queued"],
                             "acknowledged": db["acknowledged"]})
    STATE["history"] = STATE["history"][-120:]
    return {
        "mysql": {"available": True, "pending": db["pending"], "queued": db["queued"],
                  "acknowledged": db["acknowledged"]},
        "queue": {"backend": "rabbitmq", "available": True, "depth": STATE["queueDepth"],
                  "maxDepth": max_depth, "readyRate": ready, "deliverRate": deliver},
        "history": STATE["history"],
    }


def controls_payload():
    pub, sub = STATE["publisher"], STATE["subscriber"]
    return {
        "publisher": {
            "available": True, "paused": pub["paused"],
            "publishIntervalMs": pub["publishIntervalMs"],
            "publishConcurrency": pub["publishConcurrency"],
            "podCount": len(PODS["publisher"]),
            "pods": [{"podIP": p["ip"], "paused": pub["paused"],
                      "publishIntervalMs": pub["publishIntervalMs"]} for p in PODS["publisher"]],
        },
        "subscriber": {
            "available": True, "paused": sub["paused"],
            "podCount": len(PODS["subscriber"]),
            "pods": [{"podIP": p["ip"], "paused": sub["paused"]} for p in PODS["subscriber"]],
        },
    }


# ---------------------------------------------------------------- handler

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # -- plumbing ---------------------------------------------------------

    def log_message(self, fmt, *a):  # silence default access log (we log ourselves)
        pass

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Credentials", "true")
        else:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _reply(self, status, payload=None, content_type="application/json",
               raw=None, extra_headers=None):
        body = raw if raw is not None else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)
        print(f"{self.command} {self.path} {self._body_str} -> {status}", flush=True)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        self._body_str = raw.decode("utf-8", "replace") if raw else ""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def _session_ok(self):
        if not ARGS.auth:
            return True
        cookies = self.headers.get("Cookie") or ""
        for part in cookies.split(";"):
            name, _, val = part.strip().partition("=")
            if name == "faces-admin-session" and val in STATE["sessions"]:
                return True
        return False

    # -- routing ----------------------------------------------------------

    def do_OPTIONS(self):
        self._body_str = ""
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._body_str = ""
        self.route("GET")

    def do_PUT(self):
        self.route("PUT")

    def do_POST(self):
        self.route("POST")

    def route(self, method):
        path = self.path.split("?")[0]
        body = self._read_body() if method in ("PUT", "POST") else {}
        if not hasattr(self, "_body_str"):
            self._body_str = ""

        if path == "/healthz":
            return self._reply(200, raw=b"ok", content_type="text/plain")

        if method == "POST" and path == "/api/login":
            return self.handle_login(body)
        if method == "POST" and path == "/api/logout":
            return self.handle_logout()

        if path.startswith("/api/"):
            if not self._session_ok():
                return self._reply(401, {"error": "unauthorized"})
            with LOCK:
                return self.api(method, path, body)

        return self.serve_static(path)

    # -- auth -------------------------------------------------------------

    def handle_login(self, body):
        if body.get("username") == "faces-admin" and body.get("password") == "welovetosmile":
            token = secrets.token_hex(16)
            STATE["sessions"][token] = True
            days = 7 if body.get("rememberMe") else 0
            cookie = f"faces-admin-session={token}; Path=/; HttpOnly; SameSite=Lax"
            if days:
                cookie += f"; Max-Age={days * 86400}"
            return self._reply(200, {"status": "ok"}, extra_headers={"Set-Cookie": cookie})
        return self._reply(401, {"error": "invalid credentials"})

    def handle_logout(self):
        cookies = self.headers.get("Cookie") or ""
        for part in cookies.split(";"):
            name, _, val = part.strip().partition("=")
            if name == "faces-admin-session":
                STATE["sessions"].pop(val, None)
        return self._reply(303, raw=b"", content_type="text/plain", extra_headers={
            "Location": "/login",
            "Set-Cookie": "faces-admin-session=; Path=/; Max-Age=0",
        })

    # -- API --------------------------------------------------------------

    def api(self, method, path, body):
        mode = STATE["faceMode"]

        if path == "/api/status" and method == "GET":
            return self._reply(200, status_payload())

        if path == "/api/pipeline" and method == "GET":
            return self._reply(200, pipeline_payload())

        if path == "/api/config":
            if method == "GET":
                return self._reply(200, config_payload())
            if method == "PUT":
                if body.get("faceMode") in ("classic", "pubsub"):
                    STATE["faceMode"] = body["faceMode"]
                url_keys = [k for k in DEFAULT_URLS if k in body]
                if url_keys:
                    for k in url_keys:
                        v = str(body[k]).strip()
                        if v and v != DEFAULT_URLS[k]:
                            STATE["urlOverrides"][k] = v
                        else:
                            STATE["urlOverrides"].pop(k, None)
                elif not body.get("faceMode"):
                    STATE["urlOverrides"].clear()  # empty PUT = reset overrides
                return self._reply(200, {"message": "config updated"})

        if path == "/api/chaos" and method == "GET":
            agg = {}
            for svc in CHAOS_INSTANCES:
                unavailable = (svc == "face" and mode == "pubsub") or \
                              (svc in ("publisher", "subscriber") and mode == "classic")
                if unavailable:
                    agg[svc] = {"available": False, "error": "connection refused"}
                else:
                    agg[svc] = dict(STATE["chaos"][svc], available=True)
            return self._reply(200, agg)

        m = re.fullmatch(r"/api/chaos/(smiley|color|face|publisher|subscriber)", path)
        if m:
            svc = m.group(1)
            if method == "GET":
                return self._reply(200, dict(STATE["chaos"][svc], available=True))
            if method == "PUT":
                target_ips = body.get("pods") or chaos_pod_ips(svc)
                if not body.get("pods"):
                    apply_chaos_fields(STATE["chaos"][svc], body)
                for ip in target_ips:
                    if ip in STATE["podChaos"]:
                        apply_chaos_fields(STATE["podChaos"][ip], body)
                n = len(target_ips)
                failed = 1 if (ARGS.partial_fail and n > 1) else 0
                return self._reply(200, {"pods": n, "succeeded": n - failed, "failed": failed})

        if path == "/api/infrastructure" and method == "GET":
            return self._reply(200, infrastructure())

        if path == "/api/smiley":
            if method == "GET":
                return self._reply(200, SMILEYS)
            if method == "PUT":
                return self.apply_serving(body, "podSmiley", "smiley")
        if path == "/api/color":
            if method == "GET":
                return self._reply(200, COLORS)
            if method == "PUT":
                return self.apply_serving(body, "podColor", "color")

        if path == "/api/smileypods" and method == "GET":
            pods = sorted(PODS["smiley"] + PODS["smiley2"],
                          key=lambda p: (p["name"], p["ip"]))
            return self._reply(200, pods)
        if path == "/api/colorpods" and method == "GET":
            return self._reply(200, sorted(PODS["color"], key=lambda p: (p["name"], p["ip"])))
        if path == "/api/facepods" and method == "GET":
            return self._reply(200, sorted(PODS["face"], key=lambda p: (p["name"], p["ip"])))

        if path == "/api/smileystate" and method == "GET":
            return self._reply(200, serving_list("smiley"))
        if path == "/api/colorstate" and method == "GET":
            return self._reply(200, serving_list("color"))

        if path == "/api/controls" and method == "GET":
            return self._reply(200, controls_payload())
        m = re.fullmatch(r"/api/controls/(publisher|subscriber)", path)
        if m and method == "PUT":
            tgt = STATE[m.group(1)]
            if "paused" in body:
                tgt["paused"] = bool(body["paused"])
            if "publishIntervalMs" in body and m.group(1) == "publisher":
                tgt["publishIntervalMs"] = clamp(body["publishIntervalMs"], 1, 1000000)
            if body.get("warm"):
                STATE["queueDepth"] = STATE["db"]["queued"]
            return self._reply(200, {"ok": True})

        if path == "/api/linkys" and method == "GET":
            return self._reply(200, ["linky.png"])

        if path == "/api/maintenance/db/status" and method == "GET":
            return self._reply(200, dict(connected=True, latencyMs=2, **STATE["db"]))
        if path == "/api/maintenance/db/migrate" and method == "POST":
            return self._reply(200, {"ok": True, "message": "migration complete"})
        if path == "/api/maintenance/db/purge" and method == "POST":
            deleted = sum(STATE["db"].values())
            STATE["db"] = {"pending": 0, "queued": 0, "acknowledged": 0}
            return self._reply(200, {"ok": True, "rows_deleted": deleted,
                                     "message": f"Purged {deleted} rows; face_queue table ready for the demo"})
        if path == "/api/maintenance/queue/purge" and method == "POST":
            STATE["queueDepth"] = 0
            return self._reply(200, {"ok": True, "message": "queue purged"})

        return self._reply(404, {"error": "not found"})

    def apply_serving(self, body, store_key, field):
        """PUT /api/smiley or /api/color — update center/edge serving values."""
        value = body.get(field, "")
        which = body.get("which", "all")
        if field == "color":
            value = COLORS.get(value, value)  # name -> hex passthrough
        ips = body.get("pods") or list(STATE[store_key].keys())
        for ip in ips:
            entry = STATE[store_key].setdefault(ip, {})
            if which in ("all", "center"):
                entry["center"] = value
            if which in ("all", "edge"):
                entry["edge"] = value
        return self._reply(200, {"pods": len(ips), "succeeded": len(ips), "failed": 0})

    # -- static -----------------------------------------------------------

    def serve_static(self, path):
        if path == "/linkys/linky.png":
            return self._reply(200, raw=LINKY_PNG, content_type="image/png")
        if not ARGS.web_dir:
            return self._reply(404, {"error": "not found"})
        rel = path.lstrip("/") or "admin.html"
        full = os.path.realpath(os.path.join(ARGS.web_dir, rel))
        if not full.startswith(os.path.realpath(ARGS.web_dir) + os.sep):
            return self._reply(403, {"error": "forbidden"})
        if not os.path.isfile(full):
            return self._reply(404, {"error": "not found"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            data = f.read()
        return self._reply(200, raw=data, content_type=ctype)


# ---------------------------------------------------------------- main

def main():
    global STATE, ARGS
    ap = argparse.ArgumentParser(description="Mock faces-admin server")
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--auth", action="store_true")
    ap.add_argument("--mode", choices=["classic", "pubsub"], default="pubsub")
    ap.add_argument("--flaky", action="store_true")
    ap.add_argument("--partial-fail", action="store_true")
    ap.add_argument("--serve-web", dest="serve_web",
                    default=os.path.join(os.path.dirname(__file__), "..", "web"))
    ARGS = ap.parse_args()
    ARGS.web_dir = os.path.realpath(ARGS.serve_web) if ARGS.serve_web else None
    STATE = initial_state(ARGS.mode)

    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler)
    print(f"mock-admin-server on http://127.0.0.1:{ARGS.port} "
          f"mode={ARGS.mode} auth={ARGS.auth} web={ARGS.web_dir}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()

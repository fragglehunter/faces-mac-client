// faces-gui-mac-app — self-contained backend simulator
//
// This file is NOT part of the original faces-demo. It makes the Mac app fully
// self-contained (no Kubernetes, no real face/smiley/color services) by
// faithfully porting the demo's server-side behavior to the browser and
// intercepting the grid's XHR calls.
//
// Ports of:
//   - pkg/faces/base_provider.go      (chaos engine: errorFraction, latchFraction,
//                                       maxRate rate-limiting, delay, latch/unlatch)
//   - pkg/utils/ratecounter.go        (10-second averaged RPS counter)
//   - pkg/faces/face_provider.go      (face: fan-out to smiley + color, mapStatus)
//   - pkg/faces/smiley_provider.go    (smiley service)
//   - pkg/faces/color_provider.go     (color service)
//   - pkg/utils/constants.go          (Smileys, Colors, Defaults)
//
// The verbatim faces.js renders whatever the simulated `face` service returns,
// so the demo's visuals match the real thing for the single-binary case.
//
// SPDX-License-Identifier: Apache-2.0

(function () {
  "use strict";

  /////////////////////////////////////////////////////////////////////////////
  // Data tables — ported verbatim from pkg/utils/constants.go
  /////////////////////////////////////////////////////////////////////////////

  const SMILEYS = {
    fallback: "&#x1F92E;", // Vomiting
    map: {
      Grinning: "&#x1F603;",
      Sleeping: "&#x1F634;",
      Cursing: "&#x1F92C;",
      Kaboom: "&#x1F92F;",
      HeartEyes: "&#x1F60D;",
      Neutral: "&#x1F610;",
      RollingEyes: "&#x1F644;",
      Screaming: "&#x1F631;",
      Vomiting: "&#x1F92E;",
    },
  };

  function lookupSmiley(name) {
    if (!name) return SMILEYS.fallback;
    if (name in SMILEYS.map) return SMILEYS.map[name];
    if (name.startsWith("&#x") || name.startsWith("<")) return name;
    if (name.startsWith("U+")) return name.replace("U+", "&#x") + ";";
    for (const ch of name) if (ch.codePointAt(0) > 127) return name;
    return SMILEYS.fallback;
  }

  const COLORS = {
    fallback: "#CCBB44", // yellow
    map: {
      grey: "#BBBBBB",
      black: "#000000",
      white: "#FFFFFF",
      darkblue: "#4477AA",
      blue: "#66CCEE",
      green: "#228833",
      yellow: "#CCBB44",
      red: "#EE6677",
      purple: "#AA3377",
    },
  };

  function lookupColor(name) {
    if (!name) return COLORS.fallback;
    if (name in COLORS.map) return COLORS.map[name];
    if (name[0] === "#") return name;
    return COLORS.fallback;
  }

  const DEFAULTS = {
    color: "grey",
    smiley: "Cursing",
    "color-504": "red",
    "smiley-504": "Sleeping",
    "color-ratelimit": "yellow",
    "smiley-ratelimit": "Kaboom",
  };

  // mapStatus — verbatim port of face_provider.go mapStatus(). Note that, as in
  // the Go source, the numeric keys it builds ("-NNN", "-Nxx", "-error") never
  // match the "-504"/"-ratelimit" entries above, so those are effectively
  // unused here too. This is intentional: it matches the real binary exactly.
  function mapStatus(name, statusCode) {
    const keys = [
      `${name}-${String(statusCode).padStart(3, "0")}`,
      `${name}-${Math.floor(statusCode / 100)}xx`,
      `${name}-error`,
    ];
    for (const k of keys) if (k in DEFAULTS) return DEFAULTS[k];
    return DEFAULTS[name];
  }

  /////////////////////////////////////////////////////////////////////////////
  // RateCounter — port of pkg/utils/ratecounter.go (10 one-second buckets).
  /////////////////////////////////////////////////////////////////////////////

  class RateCounter {
    constructor(numberOfBuckets) {
      this.n = numberOfBuckets;
      this.buckets = new Array(numberOfBuckets).fill(0);
      this.firstBucket = 0; // ms epoch; 0 == unset
      // Fall-off ticker, mirroring the Go goroutine.
      this._timer = setInterval(() => this.tick(Date.now()), 1000);
    }
    currentRate() {
      let sum = 0;
      for (const c of this.buckets) sum += c;
      return sum / this.n;
    }
    tick(nowMs) {
      if (this.firstBucket === 0) this.firstBucket = nowMs;
      let bucket = Math.floor((nowMs - this.firstBucket) / 1000);
      if (bucket >= this.n) {
        const numberPast = bucket - this.n + 1;
        this.firstBucket += numberPast * 1000;
        if (numberPast >= this.n) {
          this.buckets = new Array(this.n).fill(0);
        } else {
          this.buckets = this.buckets.slice(numberPast).concat(new Array(numberPast).fill(0));
        }
        bucket = Math.floor((nowMs - this.firstBucket) / 1000);
      }
      return bucket;
    }
    mark(nowMs) {
      const bucket = this.tick(nowMs);
      this.buckets[bucket]++;
    }
    reset() {
      this.buckets = new Array(this.n).fill(0);
      this.firstBucket = 0;
    }
  }

  // Go's rand.Intn(100) -> [0,99]
  function randInt(n) {
    return Math.floor(Math.random() * n);
  }

  /////////////////////////////////////////////////////////////////////////////
  // Service — port of pkg/faces/base_provider.go chaos behavior.
  //
  // config: { errorFraction, latchFraction, maxRate, delayMs }
  /////////////////////////////////////////////////////////////////////////////

  class Service {
    constructor(name) {
      this.name = name;
      this.errorFraction = 0;
      this.latchFraction = 0;
      this.maxRate = 0;
      this.delayMs = 0;
      this.latched = false;
      this.lastRequestTime = 0;
      this.rateCounter = null;
    }

    applyChaos(c) {
      if (!c) return;
      if (typeof c.errorFraction === "number") this.errorFraction = clampPct(c.errorFraction);
      if (typeof c.latchFraction === "number") this.latchFraction = clampPct(c.latchFraction);
      if (typeof c.delayMs === "number") this.delayMs = Math.max(0, c.delayMs);
      if (typeof c.maxRate === "number") {
        this.maxRate = Math.max(0, c.maxRate);
        if (this.maxRate >= 0.1 && !this.rateCounter) this.rateCounter = new RateCounter(10);
        else if (this.maxRate < 0.1) this.rateCounter = null;
      }
    }

    // forceCalm clears the latch + rate window (like admin forceUnlatch + reset).
    forceCalm() {
      this.latched = false;
      if (this.rateCounter) this.rateCounter.reset();
    }

    checkUnlatch(nowMs) {
      if (this.latched) {
        if ((nowMs - this.lastRequestTime) / 1000 > 30) this.latched = false;
      }
    }

    // Port of CheckRequestStatus(). Returns a status object.
    checkRequestStatus(nowMs) {
      const rstat = {
        errored: false,
        ratelimited: false,
        latched: false,
        message: "",
        statusCode: 200,
        delayMs: 0,
      };

      if (this.rateCounter) {
        this.rateCounter.mark(nowMs);
        const rate = this.rateCounter.currentRate();
        if (rate >= this.maxRate) {
          rstat.ratelimited = true;
          rstat.message = `Rate limited (${rate.toFixed(1)} RPS > max ${this.maxRate.toFixed(1)} RPS)`;
        }
      }

      if (!rstat.ratelimited) {
        if (this.latched) {
          rstat.latched = true;
          rstat.errored = true;
          rstat.message = "Latched into error state";
          rstat.statusCode = 599;
        } else if (this.errorFraction > 0) {
          if (randInt(100) <= this.errorFraction) {
            rstat.errored = true;
            rstat.message = "";
            rstat.statusCode = 500;
            if (this.latchFraction > 0 && randInt(100) <= this.latchFraction) {
              this.latched = true;
              rstat.latched = true;
              rstat.message = "Latched into error state";
              rstat.statusCode = 599;
            }
          }
        }
      }

      if (this.delayMs > 0) rstat.delayMs = this.delayMs;

      return rstat;
    }

    // Port of HandleRequest(). getHandler() returns the success data object.
    // Returns { statusCode, data, delayMs }.
    handleRequest(nowMs, getHandler) {
      this.checkUnlatch(nowMs);
      const rstat = this.checkRequestStatus(nowMs);
      let statusCode, data;

      if (rstat.ratelimited) {
        statusCode = 429;
        data = { errors: [rstat.message] };
      } else if (rstat.errored) {
        statusCode = rstat.statusCode; // 500 or 599
        let msg = rstat.message;
        if (!msg) msg = `${this.name} error! (error fraction ${this.errorFraction}%)`;
        data = { errors: [msg] };
      } else {
        statusCode = 200;
        data = getHandler();
      }

      this.lastRequestTime = nowMs;
      return { statusCode, data, delayMs: rstat.delayMs };
    }
  }

  function clampPct(v) {
    v = Math.round(v);
    if (v < 0) return 0;
    if (v > 100) return 100;
    return v;
  }

  /////////////////////////////////////////////////////////////////////////////
  // The three simulated services (singletons, shared state across requests).
  /////////////////////////////////////////////////////////////////////////////

  const faceSvc = new Service("Face");
  const smileySvc = new Service("Smiley");
  const colorSvc = new Service("Color");

  // Simulated face pod pool, so the "Show Pods" column has some life. Names are
  // shaped like real pod names ("face-<hash>-<suffix>"); faces.js shortens them
  // to "<first>-<last>" => "face-N".
  const FACE_PODS = ["face-7d9c-1", "face-7d9c-2", "face-7d9c-3"];
  let podCursor = 0;
  function nextPod() {
    const p = FACE_PODS[podCursor % FACE_PODS.length];
    podCursor++;
    return p;
  }

  // Runtime defaults for the smiley/color values (configurable via settings).
  let DEFAULT_SMILEY_NAME = "Grinning";
  let DEFAULT_COLOR_NAME = "blue";

  // smiley service success handler
  function smileyGet() {
    return { smiley: lookupSmiley(DEFAULT_SMILEY_NAME) };
  }
  // color service success handler
  function colorGet() {
    return { color: lookupColor(DEFAULT_COLOR_NAME) };
  }

  // face service: port of face_provider.go Get() wrapped by base HandleRequest.
  // Returns { statusCode, body, delayMs, pod }.
  function handleFaceRequest(which) {
    const now = Date.now();

    // Face's own chaos first.
    const faceResult = faceSvc.handleRequest(now, () => {
      // Success branch: fan out to smiley + color (parallel in reality).
      const smileyResp = smileySvc.handleRequest(now, smileyGet);
      const colorResp = colorSvc.handleRequest(now, colorGet);

      const data = {};
      const errors = [];

      let smiley;
      if (smileyResp.statusCode !== 200) {
        errors.push(`smiley: ${joinErrors(smileyResp.data)}`);
        smiley = lookupSmiley(mapStatus("smiley", smileyResp.statusCode));
      } else {
        smiley = smileyResp.data.smiley;
      }

      let color;
      if (colorResp.statusCode !== 200) {
        errors.push(`color: ${joinErrors(colorResp.data)}`);
        color = lookupColor(mapStatus("color", colorResp.statusCode));
      } else {
        color = colorResp.data.color;
      }

      data.smiley = smiley;
      data.color = color;
      if (errors.length > 0) data.errors = errors;

      // Total latency the face perceives = its own delay (added below) plus the
      // parallel max of smiley/color delays.
      data.__subDelay = Math.max(smileyResp.delayMs, colorResp.delayMs);
      return data;
    });

    let body = faceResult.data;
    let delayMs = faceResult.delayMs;

    // Pull the sub-delay out of the body (it's not part of the wire response).
    if (body && typeof body === "object" && "__subDelay" in body) {
      delayMs += body.__subDelay;
      delete body.__subDelay;
    }

    return {
      statusCode: faceResult.statusCode,
      body: body,
      delayMs: delayMs,
      pod: nextPod(),
    };
  }

  function joinErrors(data) {
    if (data && Array.isArray(data.errors)) return data.errors.join(", ");
    return "error";
  }

  /////////////////////////////////////////////////////////////////////////////
  // Settings bootstrap + live chaos hooks (driven by the native Swift app).
  /////////////////////////////////////////////////////////////////////////////

  const GUI_DEFAULTS = {
    user: "unknown",
    userAgent: "faces-gui-mac-app",
    userHeader: "X-Faces-User",
    numRows: 4,
    numCols: 4,
    edgeSize: 1,
    startActive: true,
    hideKey: true,
    showPods: false,
    paintIntervalMs: 2000,
    visualMode: "classic",
    slowThresholdMs: 900,
    persistFaces: true,
  };

  // Connection mode: "simulator" (built-in fake backend) or "remote" (real face endpoint).
  const CONNECTION = { mode: "simulator", endpoint: "" };

  function applySettings(settings) {
    settings = settings || {};

    if (settings.connectionMode) CONNECTION.mode = settings.connectionMode;
    if (settings.endpoint !== undefined) CONNECTION.endpoint = settings.endpoint;

    // Default smiley/color values (simulator only).
    if (settings.defaultSmiley) DEFAULT_SMILEY_NAME = settings.defaultSmiley;
    if (settings.defaultColor) DEFAULT_COLOR_NAME = settings.defaultColor;

    // Per-service chaos (simulator only).
    const svc = settings.services || {};
    faceSvc.applyChaos(svc.face);
    smileySvc.applyChaos(svc.smiley);
    colorSvc.applyChaos(svc.color);
  }

  // Write the GUI config block that faces.js reads on load.
  function writeGuiConfig(settings) {
    settings = settings || {};
    const cfg = Object.assign({}, GUI_DEFAULTS);
    for (const k of Object.keys(GUI_DEFAULTS)) {
      if (settings[k] !== undefined && settings[k] !== null) cfg[k] = settings[k];
    }
    // Legacy mode always shows the inline key — override hideKey so faces.js
    // renders new Key($("key")) at init time instead of the popup path.
    if (cfg.visualMode === "legacy") cfg.hideKey = false;
    const el = document.getElementById("faces-config");
    if (el) el.textContent = JSON.stringify(cfg);
  }

  // Exposed to Swift via evaluateJavaScript for LIVE chaos updates (no reload).
  window.__applyFacesChaos__ = function (json) {
    try {
      const settings = typeof json === "string" ? JSON.parse(json) : json;
      applySettings(settings);
      return true;
    } catch (e) {
      console.error("applyFacesChaos failed:", e);
      return false;
    }
  };

  // Appearance / skin (background + chrome theme). See web/skin.css.
  const VALID_SKINS = ["system", "light", "dark", "gradient"];
  function applyAppearance(name) {
    if (!VALID_SKINS.includes(name)) name = "system";
    const body = document.body;
    if (!body) return;
    for (const s of VALID_SKINS) body.classList.remove("skin-" + s);
    body.classList.add("skin-" + name);
  }
  // Exposed to Swift for live appearance switching (no reload).
  window.__setAppearance__ = function (name) {
    applyAppearance(name);
    return true;
  };

  // Exposed to Swift: "calm everything" — force-unlatch + reset rate windows.
  window.__calmFaces__ = function () {
    faceSvc.forceCalm();
    smileySvc.forceCalm();
    colorSvc.forceCalm();
    return true;
  };

  // Initial settings: injected by Swift at document-start as window.__FACES_SETTINGS__.
  const initialSettings = window.__FACES_SETTINGS__ || {};
  writeGuiConfig(initialSettings);
  applySettings(initialSettings);
  applyAppearance(initialSettings.appearance || "system");

  /////////////////////////////////////////////////////////////////////////////
  // Fake XMLHttpRequest — intercepts the grid's /face/center/ and /face/edge/
  // calls. Only the surface faces.js actually uses is implemented; everything
  // else falls through to the real XMLHttpRequest.
  /////////////////////////////////////////////////////////////////////////////

  // Debug bus — every face request/response is recorded here for the debug
  // console (web/debug.js). Works for both simulator and remote modes.
  const DEBUG = {
    entries: [],
    max: 400,
    seq: 0,
    listeners: [],
    push(e) {
      e.id = ++this.seq;
      e.ts = Date.now();
      this.entries.push(e);
      if (this.entries.length > this.max) this.entries.shift();
      for (const l of this.listeners) { try { l(e); } catch (_) {} }
    },
    clear() { this.entries = []; for (const l of this.listeners) { try { l(null); } catch (_) {} } },
    subscribe(fn) { this.listeners.push(fn); },
  };
  window.__FACES_DEBUG__ = DEBUG;

  const RealXHR = window.XMLHttpRequest;

  class FakeXHR {
    constructor() {
      this._listeners = { load: [], error: [], readystatechange: [] };
      this._headers = {};
      this._responseHeaders = {};
      this.readyState = 0;
      this.status = 0;
      this.responseText = "";
      this.withCredentials = false;
      this.onload = null;
      this.onerror = null;
      this.onreadystatechange = null;
      this._real = null; // used if we need to delegate
    }

    addEventListener(type, cb) {
      if (this._real) return this._real.addEventListener(type, cb);
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(cb);
    }
    removeEventListener(type, cb) {
      if (this._real) return this._real.removeEventListener(type, cb);
      if (this._listeners[type]) {
        this._listeners[type] = this._listeners[type].filter((f) => f !== cb);
      }
    }

    open(method, url) {
      // Decide whether this is a face request we should handle.
      this._method = method;
      this._url = url;
      const fp = faceParts(url);
      this._which = fp ? fp.which : null;
      this._path = fp ? fp.path : null;   // e.g. "center/"
      this._query = fp ? fp.query : "";   // e.g. "row=0&col=1&now=..."
      if (this._which === null) {
        // Not a face call — delegate to a real XHR so nothing else breaks.
        this._real = new RealXHR();
        this._real.open.apply(this._real, arguments);
      }
    }

    setRequestHeader(name, value) {
      if (this._real) return this._real.setRequestHeader(name, value);
      this._headers[name] = value;
    }

    getResponseHeader(name) {
      if (this._real) return this._real.getResponseHeader(name);
      const key = String(name).toLowerCase();
      return key in this._responseHeaders ? this._responseHeaders[key] : null;
    }
    getAllResponseHeaders() {
      if (this._real) return this._real.getAllResponseHeaders();
      return Object.entries(this._responseHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
    }

    send(body) {
      if (this._real) {
        // Mirror handlers onto the real XHR.
        for (const type of Object.keys(this._listeners)) {
          for (const cb of this._listeners[type]) this._real.addEventListener(type, cb);
        }
        if (this.onload) this._real.onload = this.onload;
        if (this.onerror) this._real.onerror = this.onerror;
        return this._real.send(body);
      }

      this._sentAt = Date.now();
      if (CONNECTION.mode === "remote") {
        this._sendRemote();
      } else {
        this._sendSimulated();
      }
    }

    // Record a completed face request to the debug bus.
    _recordDebug(status, body, pod, error) {
      const q = this._query || "";
      const r = /(?:^|&)row=(\d+)/.exec(q);
      const c = /(?:^|&)col=(\d+)/.exec(q);
      const baseUrl = CONNECTION.mode === "remote"
        ? (CONNECTION.endpoint || "(no endpoint)")
        : "(simulator)";
      DEBUG.push({
        mode: CONNECTION.mode,
        which: this._which,
        row: r ? +r[1] : null,
        col: c ? +c[1] : null,
        url: baseUrl + "/" + (this._path || "") + (q ? "?" + q : ""),
        status: status,
        latencyMs: Date.now() - (this._sentAt || Date.now()),
        requestHeaders: Object.assign({}, this._headers),
        pod: pod || "",
        body: body || "",
        error: error || null,
      });
    }

    // Built-in simulator path.
    _sendSimulated() {
      // Per-cell response cache: fire the last known good response immediately
      // on each poll so cells never reach CellWatcher's maxSolid (2000 ms) fade
      // threshold. The real simulation result follows asynchronously and fires
      // onload again only if the data actually changed, preventing double-paints.
      const cacheKey = (this._which || "") + "/" + (this._query || "");
      const cached = window._faceResponseCache && window._faceResponseCache[cacheKey];
      if (cached) {
        setTimeout(() => {
          this.status = cached.status;
          this.readyState = 4;
          this.responseText = cached.body;
          this._responseHeaders = cached.headers;
          this._fire("readystatechange");
          this._fire("load");
        }, 0);
      }

      const result = handleFaceRequest(this._which);
      const body = result.body != null ? JSON.stringify(result.body) : "";
      const headers = {
        "content-type": "application/json",
        "x-faces-pod": result.pod,
        "x-faces-podname": result.pod,
      };

      const finish = () => {
        // Persist so the next poll can fire it immediately.
        if (!window._faceResponseCache) window._faceResponseCache = {};
        window._faceResponseCache[cacheKey] = { status: result.statusCode, body, headers };

        this._recordDebug(result.statusCode, body, result.pod, null);

        // Only fire load for the real response if it differs from the cache hit
        // we already sent above — avoids a redundant identical paint per poll.
        if (!cached || cached.status !== result.statusCode || cached.body !== body) {
          this.status = result.statusCode;
          this.readyState = 4;
          this.responseText = body;
          this._responseHeaders = headers;
          this._fire("readystatechange");
          this._fire("load");
        }
      };

      const delay = Math.max(0, result.delayMs || 0);
      setTimeout(finish, delay > 0 ? delay : 0);
    }

    // Remote path: proxy the request through the native app (Swift), exactly
    // like the real gui_provider.go does server-side. Avoids browser CORS and
    // works with plain http, IPs, and host:port.
    _sendRemote() {
      // Same cache strategy as _sendSimulated: fire cached response immediately
      // so cells stay solid during real network round-trips.
      const cacheKey = (this._which || "") + "/" + (this._query || "");
      const cached = window._faceResponseCache && window._faceResponseCache[cacheKey];
      if (cached) {
        setTimeout(() => {
          this.status = cached.status;
          this.readyState = 4;
          this.responseText = cached.body;
          this._responseHeaders = cached.headers;
          this._fire("readystatechange");
          this._fire("load");
        }, 0);
      }

      const bridge =
        window.webkit &&
        window.webkit.messageHandlers &&
        window.webkit.messageHandlers.faceProxy;

      if (!bridge) {
        // No native bridge (e.g. opened in a plain browser): signal a failure.
        setTimeout(() => this._fireNetworkError("no native proxy bridge"), 0);
        return;
      }

      const payload = { path: this._path, query: this._query, headers: this._headers };
      bridge
        .postMessage(payload)
        .then((res) => {
          if (!res || res.error != null) {
            this._fireNetworkError((res && res.error) || "proxy error");
            return;
          }
          this.status = res.status || 0;
          this.readyState = 4;
          this.responseText = res.body || "";
          this._responseHeaders = {
            "content-type": "application/json",
            "x-faces-pod": res.pod || "",
            "x-faces-podname": res.pod || "",
          };
          // Update cache with real response.
          if (!window._faceResponseCache) window._faceResponseCache = {};
          window._faceResponseCache[cacheKey] = {
            status: this.status, body: this.responseText, headers: this._responseHeaders,
          };
          this._recordDebug(this.status, this.responseText, res.pod, null);
          this._fire("readystatechange");
          this._fire("load");
        })
        .catch((err) => this._fireNetworkError(String(err && err.message ? err.message : err)));
    }

    _fireNetworkError(msg) {
      this.status = 0;
      this.readyState = 4;
      this.responseText = "";
      this._recordDebug(0, "", "", msg || "network error");
      this._fire("readystatechange");
      this._fire("error");
    }

    abort() {
      if (this._real) return this._real.abort();
    }

    _fire(type) {
      const evt = { type, target: this, currentTarget: this };
      if (type === "load" && typeof this.onload === "function") this.onload(evt);
      if (type === "error" && typeof this.onerror === "function") this.onerror(evt);
      if (type === "readystatechange" && typeof this.onreadystatechange === "function")
        this.onreadystatechange(evt);
      const cbs = this._listeners[type] || [];
      for (const cb of cbs) {
        try {
          cb.call(this, evt);
        } catch (e) {
          console.error("XHR listener error:", e);
        }
      }
    }
  }

  // faceParts splits a face request URL into { which, path, query }, or returns
  // null if it isn't a /face/ request. faces.js uses "../face/center/?row=..."
  // and "../face/edge/?row=...". `path` is everything after "/face/" up to the
  // query (e.g. "center/"); `query` is the query string (no leading "?").
  function faceParts(url) {
    const marker = "/face/";
    const i = url.indexOf(marker);
    if (i < 0) return null;
    let rest = url.slice(i + marker.length);
    let path = rest;
    let query = "";
    const q = rest.indexOf("?");
    if (q >= 0) {
      path = rest.slice(0, q);
      query = rest.slice(q + 1);
    }
    let which = "center";
    if (/^edge\b/.test(path)) which = "edge";
    return { which, path, query };
  }

  window.XMLHttpRequest = FakeXHR;

  console.log("[sim.js] faces backend simulator installed");
})();

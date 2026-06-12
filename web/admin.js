/* Faces Admin (Mac app) — the admin portal UI.
 *
 * A from-scratch reimplementation of the faces-admin browser portal
 * (docs/ADMIN_UI_DESIGN.md, ADMIN_API.md, ADMIN_IMPLEMENTATION.md,
 * CHAOS_IMPLEMENTATION.md) for embedding in the Mac app's Admin window.
 *
 * All HTTP to the admin server goes through a native Swift proxy bridge
 * (messageHandlers.adminProxy) to avoid CORS; when that bridge is absent
 * (browser preview / dev), it falls back to a direct fetch() so the same UI
 * can be exercised against the mock server same-origin.
 *
 * Emoji appear only as HTML entities (in admin.html) or codepoint tables /
 * \u escapes here — never as raw UTF-8 literals (mojibake lesson).
 */
(function () {
  "use strict";

  // ================================================================ boot

  var BOOT = (typeof window.__ADMIN_SETTINGS__ === "object" && window.__ADMIN_SETTINGS__) || {};
  var HAS_BRIDGE = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.adminProxy);

  function safeLS(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeLSSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function devEndpoint() {
    try { var q = new URLSearchParams(location.search).get("api"); if (q) return q; } catch (e) {}
    if (location.protocol === "http:" || location.protocol === "https:") return location.origin;
    return "";
  }

  var state = {
    endpoint: BOOT.endpoint || (HAS_BRIDGE ? "" : devEndpoint()),
    theme: BOOT.theme || (!HAS_BRIDGE && safeLS("faces-admin-theme")) || "dark",
    sidebarCollapsed: BOOT.sidebarCollapsed != null ? !!BOOT.sidebarCollapsed
                      : (!HAS_BRIDGE && safeLS("faces-admin-collapsed") === "1"),
    cred: { user: BOOT.username || "", pass: BOOT.password || "" },
    mode: safeLS("faces-admin-mode") || "classic",
    modeAutoDetect: safeLS("faces-admin-mode-auto") !== "0",
    page: "overview",
    active: true,
    authRequired: false,
    config: null,
    status: null,          // normalized: { name -> {healthy, latencyMs, error} }
    chaos: null,
    controls: null,
    pipeline: null,        // /api/pipeline (pub/sub Flow page)
    lastInfra: null,
    smileyMap: null,
    colorMap: null,
    podServing: { smileyPods: [], smiley: [], colorPods: [], color: [] },
    sel: { smiley: null, smileyImg: null, colorHex: null, which: "all",
           smileyPods: {}, colorPods: {} },
    fi: { scope: "all", detail: null, label: "All pods", services: {},
          error: 0, latch: 0, maxRate: 0, delays: {} },
    fiCardSel: {},         // per-service FI card pod selections: svc -> {ip: true}
    debug: { entries: [], paused: true, sel: null, filter: "" },
    showDebugPage: BOOT.showDebugPage != null ? !!BOOT.showDebugPage : (safeLS("faces-admin-show-debug") === "1"),
    fiCardDelays: {},
    ep: {},                // service-endpoint edits in Settings
    _sigs: {},
    _multiBases: {},
    _loginPending: false,
    _autoInFlight: false,  // auto-login attempt running
    _autoFailedSig: null,  // cred signature of the last failed auto-login (loop guard)
    _pendingStreak: 0,     // consecutive polls with mysql.pending > 0 (flow banner)
  };

  document.documentElement.setAttribute("data-theme", state.theme);

  var CHAOS_SERVICES_CLASSIC = ["smiley", "color", "face"];
  var CHAOS_SERVICES_PUBSUB = ["smiley", "color", "publisher", "subscriber"];
  function chaosServices() { return state.mode === "pubsub" ? CHAOS_SERVICES_PUBSUB : CHAOS_SERVICES_CLASSIC; }

  var POLL_MAIN_MS = 3000, POLL_INFRA_MS = 10000, POLL_CTRL_MS = 5000;

  // ================================================================ bridge + fetch

  function bridgeFetch(method, path, body, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var msg = {
        method: method, path: path,
        body: body == null ? null : (typeof body === "string" ? body : JSON.stringify(body)),
        binary: !!opts.binary, timeoutMs: opts.timeoutMs || 12000,
      };
      window.webkit.messageHandlers.adminProxy.postMessage(msg).then(function (reply) {
        resolve(reply || { status: 0, error: "empty reply" });
      }).catch(function (err) { resolve({ status: 0, error: String(err) }); });
    });
  }

  function directFetch(method, path, body, opts) {
    opts = opts || {};
    var headers = {};
    if (body != null) headers["Content-Type"] = "application/json";
    return fetch((state.endpoint || "") + path, {
      method: method, headers: headers, credentials: "include", redirect: "manual",
      body: body == null ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
    }).then(function (resp) {
      var hdrs = {};
      try { resp.headers.forEach(function (v, k) { hdrs[k] = v; }); } catch (e) {}
      if (opts.binary) {
        return resp.blob().then(function (blob) {
          return new Promise(function (res) {
            var fr = new FileReader();
            fr.onloadend = function () {
              var d = String(fr.result || "");
              res({ status: resp.status, bodyBase64: d.indexOf(",") >= 0 ? d.slice(d.indexOf(",") + 1) : "",
                    contentType: resp.headers.get("Content-Type") || "", headers: hdrs });
            };
            fr.readAsDataURL(blob);
          });
        });
      }
      return resp.text().then(function (text) {
        var status = resp.type === "opaqueredirect" ? 303 : resp.status;
        return { status: status, body: text, headers: hdrs };
      });
    }).catch(function (err) { return { status: 0, error: String(err) }; });
  }

  // Every admin request flows through here — record it for the Debug page/HAR.
  var dbgSeq = 0;
  var DBG_MAX = 400, DBG_BODY_CAP = 262144;

  function recordDebug(entry) {
    if (state.debug.paused) return false;
    state.debug.entries.push(entry);
    if (state.debug.entries.length > DBG_MAX) state.debug.entries.splice(0, state.debug.entries.length - DBG_MAX);
    return true;
  }

  var dbgRenderTimer = null;
  function debugDirty() {
    if (state.page !== "debug" || dbgRenderTimer) return;
    dbgRenderTimer = setTimeout(function () { dbgRenderTimer = null; renderDebug(); }, 250);
  }

  function rawFetch(method, path, body, opts) {
    var started = Date.now();
    var base = state.endpoint || (HAS_BRIDGE ? "" : location.origin);
    var entry = {
      id: ++dbgSeq,
      startedISO: new Date(started).toISOString(),
      method: method, path: path, url: base + path,
      reqBody: body == null ? null : (typeof body === "string" ? body : JSON.stringify(body)),
      status: null, durationMs: null, respBody: null, respHeaders: null,
      contentType: "", error: null, pending: true,
    };
    var recorded = recordDebug(entry);
    var p = HAS_BRIDGE ? bridgeFetch(method, path, body, opts) : directFetch(method, path, body, opts);
    return p.then(function (reply) {
      if (recorded) {
        entry.pending = false;
        entry.status = reply.status || 0;
        entry.durationMs = Date.now() - started;
        entry.respHeaders = reply.headers || null;
        entry.error = reply.error || null;
        var h = reply.headers || {};
        entry.contentType = h["Content-Type"] || h["content-type"] || reply.contentType || "";
        if (reply.body != null) {
          entry.respBody = String(reply.body).slice(0, DBG_BODY_CAP);
        } else if (reply.bodyBase64 != null) {
          entry.respBody = "(binary, " + Math.round(reply.bodyBase64.length * 3 / 4) + " bytes)";
        }
        debugDirty();
      }
      return reply;
    });
  }

  function fetchJSON(method, path, body) {
    return rawFetch(method, path, body).then(function (reply) {
      var status = reply.status || 0;
      var data = null;
      if (reply.body) { try { data = JSON.parse(reply.body); } catch (e) {} }
      // A 401 on any normal API call means the session expired → auto-login
      // with stored credentials when available, otherwise show the login card.
      // The auth endpoints handle their own 401s (bad credentials), so don't
      // hijack them: that would swallow the server's error message.
      if (status === 401 && path !== "/api/login" && path !== "/api/logout") {
        handleUnauthorized();
        return { ok: false, status: 401, data: data };
      }
      var ok = status >= 200 && status < 300;
      return { ok: ok, status: status, data: data, error: reply.error };
    });
  }

  function persistPrefs(partial) {
    if (HAS_BRIDGE && window.webkit.messageHandlers.setAdminPrefs) {
      window.webkit.messageHandlers.setAdminPrefs.postMessage(partial).then(function (r) {
        if (r && r.endpoint != null && partial.endpoint != null) state.endpoint = r.endpoint;
      }).catch(function () {});
    } else {
      if (partial.theme != null) safeLSSet("faces-admin-theme", partial.theme);
      if (partial.sidebarCollapsed != null) safeLSSet("faces-admin-collapsed", partial.sidebarCollapsed ? "1" : "0");
      if (partial.endpoint != null) state.endpoint = partial.endpoint;
      if (partial.showDebugPage != null) safeLSSet("faces-admin-show-debug", partial.showDebugPage ? "1" : "0");
    }
  }

  // ================================================================ helpers

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function decodeEntity(s) {
    if (s == null) return "";
    s = String(s);
    if (s.indexOf("&#") < 0) return s;
    return s.replace(/&#x([0-9a-fA-F]+);/g, function (_, h) {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ""; }
    }).replace(/&#(\d+);/g, function (_, d) {
      try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ""; }
    });
  }

  var HEX_RE = /^#[0-9a-fA-F]{6}$/;
  function validHex(s) { return typeof s === "string" && HEX_RE.test(s); }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function sortPods(a, b) {
    var an = a.name || "", bn = b.name || "";
    if (an !== bn) return an < bn ? -1 : 1;
    var ai = a.ip || "", bi = b.ip || "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }

  function chaosBaseSvc(key) { return String(key || "").replace(/\d+$/, ""); }

  function repaint(key, node, html) {
    if (!node) return;
    if (state._sigs[key] === html) return;
    state._sigs[key] = html;
    node.innerHTML = html;
  }

  // ================================================================ toast

  function showToast(msg, kind) {
    var stack = $("#toast-stack");
    var t = document.createElement("div");
    t.className = "toast" + (kind ? " " + kind : "");
    t.textContent = msg;
    stack.appendChild(t);
    setTimeout(function () {
      t.style.transition = "opacity .25s"; t.style.opacity = "0";
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, 3500);
  }

  // ================================================================ tooltip engine

  function initTooltips() {
    var tip = $("#js-tooltip");
    function place(e) {
      var pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
      var x = e.clientX + pad, y = e.clientY + pad;
      if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
      if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
      tip.style.left = Math.max(4, x) + "px";
      tip.style.top = Math.max(4, y) + "px";
    }
    function swatch(hex) { return '<span class="tip-swatch" style="background:' + hex + '"></span>'; }
    document.addEventListener("mouseover", function (e) {
      var node = e.target.closest("[data-tooltip]");
      if (!node) return;
      var text = node.getAttribute("data-tooltip");
      if (!text) return;
      var html = esc(text).replace(/\\n/g, "\n");
      // Color swatches are injected as DOM, not printed as hex — users need to
      // see the color. Two labelled swatches when center/edge differ; a single
      // unlabelled swatch on its own line otherwise (web-UI convention).
      var pc = node.getAttribute("data-pod-color");
      var pce = node.getAttribute("data-pod-color-edge");
      if (pc && validHex(pc)) {
        if (pce && validHex(pce)) {
          html = "Center: " + swatch(pc) + "\nEdge: " + swatch(pce) + (html ? "\n" + html : "");
        } else {
          html = swatch(pc) + (html ? "\n" + html : "");
        }
      }
      tip.innerHTML = html;
      tip.style.display = "block";
      place(e);
    });
    document.addEventListener("mousemove", function (e) {
      if (tip.style.display !== "block") return;
      var node = e.target.closest("[data-tooltip]");
      if (!node) { tip.style.display = "none"; return; }
      place(e);
    });
    document.addEventListener("mouseout", function (e) {
      if (e.target.closest("[data-tooltip]")) tip.style.display = "none";
    });
  }

  // ================================================================ confirm modal

  function confirmModal(title, body, danger) {
    return new Promise(function (resolve) {
      var ov = $("#confirm-overlay");
      $("#confirm-title").textContent = title;
      $("#confirm-body").textContent = body;
      var ok = $("#confirm-ok"), cancel = $("#confirm-cancel");
      ok.className = "btn" + (danger ? " danger" : " btn-primary");
      ov.style.display = "flex";
      function close(val) { ov.style.display = "none"; ok.onclick = cancel.onclick = ov.onclick = null; resolve(val); }
      ok.onclick = function () { close(true); };
      cancel.onclick = function () { close(false); };
      ov.onclick = function (e) { if (e.target === ov) close(false); };
    });
  }

  // ================================================================ auth

  function setAuthRequired(on) {
    state.authRequired = on;
    $("#login-overlay").style.display = on ? "flex" : "none";
    if (on) {
      $("#login-error").style.display = "none";
      stopPolling();
      // Prefill the username from stored credentials so a failed auto-login
      // only needs the password corrected.
      var u = $("#login-user");
      if (u && !u.value && state.cred.user) u.value = state.cred.user;
    } else { var u2 = $("#login-user"), p = $("#login-pass"); if (u2) u2.value = ""; if (p) p.value = ""; }
  }

  // 401 on a normal API call. If the app Settings hold credentials, sign in
  // silently (once per credential set — a failed pair is remembered so bad
  // creds can't loop). Otherwise, or after a failure, show the login card.
  function handleUnauthorized() {
    var u = state.cred.user, p = state.cred.pass;
    var sig = u + ":" + p;
    if (u && p && !state._loginPending && !state._autoInFlight && state._autoFailedSig !== sig) {
      state._autoInFlight = true;
      stopPolling();
      fetchJSON("POST", "/api/login", { username: u, password: p, rememberMe: true }).then(function (r) {
        state._autoInFlight = false;
        if (r.status >= 200 && r.status < 300) {
          state._autoFailedSig = null;
          showToast("Signed in as " + u, "success");
          setAuthRequired(false);
          pollAll();
        } else {
          state._autoFailedSig = sig;
          setAuthRequired(true);
          var errEl = $("#login-error");
          errEl.textContent = "Automatic sign-in failed" +
            ((r.data && r.data.error) ? " (" + r.data.error + ")" : "") +
            ". Check the credentials in Settings → Services → Admin, or sign in manually.";
          errEl.style.display = "block";
        }
      });
      return;
    }
    if (!state._autoInFlight) setAuthRequired(true);
  }

  function doLogin(e) {
    if (e) e.preventDefault();
    if (state._loginPending) return;
    var submit = $("#login-submit"), errEl = $("#login-error");
    state._loginPending = true; submit.disabled = true; submit.textContent = "Signing in…";
    fetchJSON("POST", "/api/login", {
      username: $("#login-user").value.trim(), password: $("#login-pass").value,
      rememberMe: $("#login-remember").checked,
    }).then(function (r) {
      state._loginPending = false; submit.disabled = false; submit.textContent = "Sign In";
      if (r.status >= 200 && r.status < 300) {
        errEl.style.display = "none";
        state._autoFailedSig = null;   // creds may have been fixed server-side
        setAuthRequired(false); pollAll();
      }
      else { errEl.textContent = (r.data && r.data.error) || "Sign-in failed"; errEl.style.display = "block"; }
    });
  }

  function signOut() { fetchJSON("POST", "/api/logout").then(function () { setAuthRequired(true); }); }

  // ================================================================ nav / theme / sidebar

  function setPage(page) {
    if (page === "flow" && state.mode !== "pubsub") page = "overview";
    if (page === "debug" && !state.showDebugPage) page = "overview";
    state.page = page;
    $all(".nav-item").forEach(function (n) { n.classList.toggle("active", n.getAttribute("data-page") === page); });
    $all(".page").forEach(function (p) { p.classList.toggle("active", p.id === "page-" + page); });
    if (location.hash !== "#" + page) { try { history.replaceState(null, "", "#" + page); } catch (e) {} }
    renderActivePage();
    if (page === "controls") pollControlsState();
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", state.theme);
    var dark = state.theme === "dark";
    // Button shows what you'll switch TO, not what you're currently in.
    $("#theme-icon").innerHTML = dark ? "&#x1F60E;" : "&#x1F913;";
    $("#theme-label").textContent = dark ? "Light Mode" : "Dork mode";
  }
  function toggleTheme() { state.theme = state.theme === "dark" ? "light" : "dark"; applyTheme(); persistPrefs({ theme: state.theme }); }

  function applyCollapse() {
    $("#sidebar").classList.toggle("collapsed", state.sidebarCollapsed);
    $("#collapse-icon").innerHTML = state.sidebarCollapsed ? "&#x25B6;" : "&#x25C0;";
  }
  function toggleCollapse() { state.sidebarCollapsed = !state.sidebarCollapsed; applyCollapse(); persistPrefs({ sidebarCollapsed: state.sidebarCollapsed }); }

  function applyDebugPageVisibility() {
    var nav = $("#nav-debug");
    if (nav) nav.style.display = state.showDebugPage ? "" : "none";
    if (!state.showDebugPage && state.page === "debug") setPage("settings");
  }

  function wireChrome() {
    $all(".nav-item").forEach(function (n) {
      n.addEventListener("click", function (e) { e.preventDefault(); setPage(n.getAttribute("data-page")); });
    });
    $("#theme-toggle").addEventListener("click", toggleTheme);
    $("#collapse-btn").addEventListener("click", toggleCollapse);
    $("#sign-out-btn").addEventListener("click", signOut);
    $("#login-form").addEventListener("submit", doLogin);
    $("#connect-submit").addEventListener("click", doConnect);
    window.addEventListener("hashchange", function () {
      var p = location.hash.replace("#", "");
      if (p && p !== state.page && $("#page-" + p)) setPage(p);
    });
  }

  function doConnect() {
    var v = $("#connect-endpoint").value.trim();
    if (!v) { var er = $("#connect-error"); er.textContent = "Enter an endpoint."; er.style.display = "block"; return; }
    persistPrefs({ endpoint: v }); state.endpoint = v;
    $("#connect-overlay").style.display = "none";
    updateEndpointLabel(); pollAll();
  }

  function updateEndpointLabel() {
    $("#endpoint-label").textContent = HAS_BRIDGE ? (state.endpoint || "no endpoint") : "";
  }

  function maybeShowConnect() {
    if (HAS_BRIDGE && !state.endpoint) { $("#connect-overlay").style.display = "flex"; return true; }
    return false;
  }

  // ================================================================ poll engine

  var timerMain = null, timerInfra = null, timerCtrl = null;

  function pollingEnabled() { return state.active && !state.authRequired && (state.endpoint || !HAS_BRIDGE); }

  function startPolling() {
    stopPolling();
    if (!pollingEnabled()) return;
    pollMain(); pollInfra();
    timerMain = setInterval(pollMain, POLL_MAIN_MS);
    timerInfra = setInterval(pollInfra, POLL_INFRA_MS);
    timerCtrl = setInterval(function () { if (state.page === "controls") pollControlsState(); }, POLL_CTRL_MS);
  }
  function stopPolling() {
    if (timerMain) clearInterval(timerMain);
    if (timerInfra) clearInterval(timerInfra);
    if (timerCtrl) clearInterval(timerCtrl);
    timerMain = timerInfra = timerCtrl = null;
  }

  function pollAll() { if (maybeShowConnect()) return; startPolling(); }

  function pollMain() {
    if (!pollingEnabled()) return;
    var jobs = [
      fetchJSON("GET", "/api/status").then(function (r) { if (r.ok && r.data) state.status = normalizeStatus(r.data); }),
      fetchJSON("GET", "/api/config").then(function (r) { if (r.ok && r.data) onConfig(r.data); }),
      fetchJSON("GET", "/api/chaos").then(function (r) { if (r.ok && r.data) state.chaos = r.data; }),
    ];
    if (state.mode === "pubsub") {
      jobs.push(fetchJSON("GET", "/api/controls").then(function (r) { if (r.ok && r.data) state.controls = r.data; }));
      jobs.push(fetchJSON("GET", "/api/pipeline").then(function (r) { if (r.ok && r.data) onPipeline(r.data); }));
    }
    Promise.all(jobs).then(function () {
      if (state.authRequired) return;
      setConnected(true); renderHeader(); renderActivePage();
    });
  }

  function onPipeline(pl) {
    state.pipeline = pl;
    // Persistent-pending detection for the Flow warning banner. Suppressed when
    // the queue is at capacity or unreachable (pending is then expected).
    var my = pl.mysql || {}, q = pl.queue || {};
    var queueFull = (q.depth || 0) >= (q.maxDepth || 5000) * 0.95;
    var queueDown = q.available === false;
    if ((my.pending || 0) > 0 && !queueFull && !queueDown) state._pendingStreak++;
    else state._pendingStreak = 0;
  }

  function pollInfra() {
    if (!pollingEnabled()) return;
    fetchJSON("GET", "/api/infrastructure").then(function (r) {
      if (r.ok && r.data) { state.lastInfra = r.data; recomputeMultiBases(); }
      if (state.page === "overview") renderInfrastructure();
      if (state.page === "faultinjection") { renderFITopology(); renderFIGlobalPanel(); renderFICards(); }
    });
  }

  function pollControlsState() {
    if (!pollingEnabled() || state.page !== "controls") return;
    Promise.all([
      fetchJSON("GET", "/api/smileypods"), fetchJSON("GET", "/api/smileystate"),
      fetchJSON("GET", "/api/colorpods"), fetchJSON("GET", "/api/colorstate"),
    ]).then(function (rs) {
      state.podServing.smileyPods = (rs[0].ok && rs[0].data) || [];
      state.podServing.smiley = (rs[1].ok && rs[1].data) || [];
      state.podServing.colorPods = (rs[2].ok && rs[2].data) || [];
      state.podServing.color = (rs[3].ok && rs[3].data) || [];
      renderPodSelectors();
    });
  }

  function setConnected(ok) {
    var dot = $("#poll-indicator");
    dot.classList.remove("idle", "ok", "err");
    dot.classList.add(ok ? "ok" : "err");
    $("#poll-label").textContent = ok ? "Polling" : "Disconnected";
  }

  function onConfig(cfg) {
    var prevMode = state.mode;
    state.config = cfg;
    if (cfg.faceMode === "classic" || cfg.faceMode === "pubsub") {
      safeLSSet("faces-admin-mode", cfg.faceMode);   // remember for next open
      if (state.modeAutoDetect) state.mode = cfg.faceMode;
    }
    $("#sign-out-btn").style.display = cfg.authEnabled ? "flex" : "none";
    $("#nav-flow").style.display = state.mode === "pubsub" ? "" : "none";
    if (state.mode !== prevMode) {
      state._sigs = {};
      if (state.page === "flow" && state.mode !== "pubsub") setPage("overview");
      pollInfra();
    }
  }

  function recomputeMultiBases() {
    var counts = {};
    if (state.lastInfra && state.lastInfra.zones) {
      state.lastInfra.zones.forEach(function (z) {
        Object.keys(z.pods || {}).forEach(function (svcKey) {
          var base = chaosBaseSvc(svcKey);
          counts[base] = (counts[base] || 0) + (z.pods[svcKey] || []).length;
        });
      });
    }
    state._multiBases = {};
    Object.keys(counts).forEach(function (b) { if (counts[b] > 1) state._multiBases[b] = true; });
  }

  // ================================================================ status adapter

  function normalizeStatus(raw) {
    var out = {};
    var src = (raw && typeof raw.services === "object" && raw.services) ? raw.services : raw;
    Object.keys(src || {}).forEach(function (k) {
      var v = src[k];
      if (v && typeof v === "object" && ("healthy" in v || "latencyMs" in v || "error" in v)) {
        out[k] = { healthy: v.healthy !== false, latencyMs: v.latencyMs || 0, error: v.error || "" };
      }
    });
    return out;
  }

  // ================================================================ header render

  function renderHeader() {
    renderPollIndicator();
    renderHealthChips();
    $("#mode-badge").textContent = state.mode === "pubsub" ? "Pub·Sub" : "Classic";
    updateEndpointLabel();
  }

  function renderPollIndicator() {
    var c = state.config || {};
    $("#poll-indicator").setAttribute("data-tooltip", [
      "Namespace: " + (c.namespace || "—"),
      "Linkerd: " + (c.linkerdMeshed ? "meshed" : "not meshed"),
      "K8s API: " + (c.k8sAvailable ? "\u2713 connected" : "\u2717 unavailable"),
      "Poll: every 3s",
    ].join("\\n"));
  }

  function renderHealthChips() {
    var s = state.status || {};
    var order = state.mode === "pubsub"
      ? ["gui", "smiley", "color", "publisher", "subscriber", "mysql", "queue"]
      : ["gui", "face", "smiley", "color"];
    var keys = order.filter(function (k) { return s[k]; })
      .concat(Object.keys(s).filter(function (k) { return order.indexOf(k) < 0; }));
    var html = keys.map(function (k) {
      var v = s[k], down = !v.healthy;
      var tip = (v.healthy ? "healthy" : "unhealthy") + (v.latencyMs ? " · " + v.latencyMs + "ms" : "") + (v.error ? "\\n" + v.error : "");
      return '<span class="health-chip' + (down ? " down" : "") + '" data-tooltip="' + esc(k + ": " + tip) +
        '"><span class="chip-dot"></span>' + esc(k) + "</span>";
    }).join("");
    repaint("chips", $("#health-chips"), html);
  }

  // ================================================================ render dispatch

  function renderActivePage() {
    if (state.authRequired) return;
    if (state.page === "overview") { renderOverviewHealth(); renderArchitecture(); renderInfrastructure(); }
    else if (state.page === "flow") renderFlow();
    else if (state.page === "controls") renderControls();
    else if (state.page === "faultinjection") { renderFITopology(); renderFIGlobalPanel(); renderFICards(); renderFIScenarios(); }
    else if (state.page === "debug") renderDebug();
    else if (state.page === "settings") renderSettings();
  }

  // ================================================================ OVERVIEW: health cards

  function renderOverviewHealth() {
    var s = state.status || {};
    var order = state.mode === "pubsub"
      ? ["gui", "smiley", "color", "publisher", "subscriber", "mysql", "queue"]
      : ["gui", "face", "smiley", "color"];
    var keys = order.filter(function (k) { return s[k]; });
    var html = keys.map(function (k) {
      var v = s[k], down = !v.healthy;
      return '<div class="health-card' + (down ? " unhealthy" : "") + '">' +
        '<div class="hc-name"><span class="hc-dot"></span>' + esc(k) + "</div>" +
        '<div class="hc-lat">' + (down ? "unhealthy" : "healthy") + (v.latencyMs ? " · " + v.latencyMs + " ms" : "") + "</div>" +
        (v.error ? '<div class="hc-err" data-tooltip="' + esc(v.error) + '">' + esc(v.error) + "</div>" : "") +
        "</div>";
    }).join("");
    repaint("ovHealth", $("#ov-health-cards"), html || '<div class="pod-empty">Waiting for status…</div>');
  }

  // ================================================================ OVERVIEW: architecture

  function nodeBox(name, sub, down, subErr) {
    return '<div class="chain-node-box' + (down ? " down" : "") + '">' +
      '<div class="node-name">' + esc(name) + "</div>" +
      (sub ? '<div class="node-sub' + (subErr ? " err" : "") + '">' + esc(sub) + "</div>" : "") + "</div>";
  }
  function lat(svc) {
    var s = (state.status || {})[svc];
    if (!s) return "";
    return s.healthy ? (s.latencyMs ? s.latencyMs + " ms" : "ok") : "down";
  }
  function down(svc) { var s = (state.status || {})[svc]; return s ? !s.healthy : false; }

  function renderArchitecture() {
    var html;
    if (state.mode === "classic") {
      var smDown = down("smiley"), coDown = down("color"), faDown = down("face");
      html =
        '<div class="classic-chain">' +
          nodeBox("GUI", lat("gui"), down("gui")) +
          '<span class="chain-arrow"><span class="arrow-lbl">HTTP</span>&#x2192;</span>' +
          nodeBox("Face", lat("face"), faDown) +
          '<div class="chain-fork">' +
            '<div class="fork-bar' + ((smDown || coDown) ? " down" : "") + '"></div>' +
            '<div class="fork-branches">' +
              '<div class="fork-branch"><span class="chain-arrow' + (smDown ? " down" : "") + '"><span class="arrow-lbl">HTTP</span>&#x2192;</span>' + nodeBox("Smiley", lat("smiley"), smDown) + "</div>" +
              '<div class="fork-branch"><span class="chain-arrow' + (coDown ? " down" : "") + '"><span class="arrow-lbl">gRPC</span>&#x2192;</span>' + nodeBox("Color", lat("color"), coDown) + "</div>" +
            "</div></div></div>";
    } else {
      html = pipelineChainHTML();
    }
    repaint("ovArch", $("#ov-arch"), html);
  }

  // The pub/sub pipeline diagram, shared by Overview and Flow. Node sub-labels
  // carry live counts from /api/pipeline when available.
  function pipelineChainHTML() {
    var pub = state.controls && state.controls.publisher, sub = state.controls && state.controls.subscriber;
    var pubPaused = pub && pub.paused, subPaused = sub && sub.paused;
    var pl = state.pipeline || {}, my = pl.mysql || {}, q = pl.queue || {};
    function arrow(paused, dn, lbl) {
      return '<span class="pipe-arrow' + (dn ? " down" : (paused ? " paused" : "")) + '">' +
        (lbl ? '<span class="arrow-lbl">' + esc(lbl) + "</span>" : "") + "&#x2192;</span>";
    }
    var pubSub = pubPaused ? "paused"
      : (pub && pub.publishIntervalMs != null ? msToRate(pub.publishIntervalMs) + " × " + (pub.publishConcurrency || 1) : lat("publisher"));
    var mysqlSub = my.available === false ? "down"
      : (my.queued != null ? my.queued + " queued" : lat("mysql"));
    var queueSub = q.available === false ? "down"
      : (q.depth != null ? q.depth + " / " + (q.maxDepth || "?") : lat("queue"));
    var subSub = subPaused ? "paused" : (my.acknowledged != null ? my.acknowledged + " acked" : lat("subscriber"));
    return '<div class="pipe-chain">' +
      nodeBox("Publisher", pubSub, down("publisher"), !!pubPaused) +
      arrow(pubPaused, down("mysql") || my.available === false, "") +
      nodeBox("MySQL", mysqlSub, down("mysql") || my.available === false) +
      arrow(pubPaused, down("queue") || q.available === false, "queue") +
      nodeBox("Queue", queueSub, down("queue") || q.available === false) +
      arrow(subPaused, down("subscriber"), "") +
      nodeBox("Subscriber", subSub, down("subscriber"), !!subPaused) +
      arrow(false, down("gui"), "") +
      nodeBox("GUI", lat("gui"), down("gui")) +
    "</div>";
  }

  // ================================================================ shared topology renderer (Overview + FI)

  // Build display groups from an infra response. Returns ordered groups, each
  // with zone/node cards. Cloud → Nodes → External Workloads → On-Premise.
  function buildTopologyGroups(infra) {
    if (!infra || !infra.zones) return [];
    var cloud = [], ext = [], onprem = [];
    infra.zones.forEach(function (z) {
      var card = { label: z.label, icon: z.icon, region: z.region, zone: z.zone, pods: z.pods || {} };
      if (z.label === "External Workload" || z.icon === "🔗") ext.push(card);
      else if (z.label === "On-Premise" || !z.zone) onprem.push(card);
      else cloud.push(card);
    });
    var groups = [];
    if (cloud.length) groups.push({ title: "🌐 Cloud", scope: "zone", cards: cloud });

    // Node subdivision of cloud zones (when pod.node labels exist).
    var nodeMap = {};
    cloud.forEach(function (c) {
      Object.keys(c.pods).forEach(function (svc) {
        c.pods[svc].forEach(function (p) {
          if (!p.node) return;
          var nc = nodeMap[p.node] || (nodeMap[p.node] = { label: p.node, icon: "🖥️", region: c.region, zone: "", node: p.node, pods: {} });
          (nc.pods[svc] || (nc.pods[svc] = [])).push(p);
        });
      });
    });
    var nodeCards = Object.keys(nodeMap).sort().map(function (k) { return nodeMap[k]; });
    if (nodeCards.length) groups.push({ title: "🖥️ Nodes", scope: "node", cards: nodeCards });
    if (ext.length) groups.push({ title: "🔗 External Workloads", scope: "node", cards: ext });
    if (onprem.length) groups.push({ title: "🏢 On-Premise", scope: "node", cards: onprem });
    return groups;
  }

  function msToRate(ms) {
    if (ms == null || ms <= 0) return "∞";
    var rps = 1000 / ms;
    return (rps >= 10 ? Math.round(rps) : Math.round(rps * 10) / 10) + "/s";
  }

  // Short pod identity for compact rows/pills (web-UI convention): the pod-name
  // suffix (e.g. "xk2j9"), or the last two IP octets when no name is known.
  // The full name lives in the tooltip.
  function podShortName(p) {
    var n = p.name || "";
    var ip = p.ip || "";
    if (!n || n === ip) {
      var oct = ip.split(".");
      return oct.length === 4 ? oct[2] + "." + oct[3] : (ip || "?");
    }
    var seg = n.split("-");
    return seg.length > 1 ? seg[seg.length - 1] : n;
  }

  var GREEN_DOT = '<span class="infra-state-dot dot-green"></span>';
  var RED_DOT = '<span class="infra-state-dot dot-red"></span>';

  // Per-pod serving-state indicator. Status is compact & unlabeled — labels live
  // in the tooltip. Ported from the web UI's infraPodStateEl:
  //  - active fault badges (per-pod truth) override the healthy glyph
  //  - smiley → emoji; color → swatch; center+edge side by side only when the
  //    *Edge field is present (§8.3)
  //  - publisher → rate / paused; subscriber → dot / paused
  //  - face / gui / anything else → health dot from pod.available
  function infraPodStateHTML(pod, base) {
    var badges = base ? fiPodFaultBadges(pod, base) : "";
    if (badges) return badges;
    if (pod.smiley != null) {
      var em = '<span class="infra-state-emoji">' + esc(decodeEntity(pod.smiley)) + "</span>";
      if (pod.smileyEdge != null) em += '<span class="infra-state-emoji">' + esc(decodeEntity(pod.smileyEdge)) + "</span>";
      return em;
    }
    if (pod.color != null && validHex(pod.color)) {
      var sw = '<span class="infra-state-color" style="background:' + pod.color + '"></span>';
      if (pod.colorEdge != null && validHex(pod.colorEdge)) sw += '<span class="infra-state-color" style="background:' + pod.colorEdge + '"></span>';
      return sw;
    }
    if (pod.publishIntervalMs != null) {       // publisher → rate / paused
      if (pod.available === false) return RED_DOT;
      if (pod.paused) return '<span class="infra-state-rate paused">&#x23F8;</span>';
      return '<span class="infra-state-rate">' + esc(msToRate(pod.publishIntervalMs)) + "</span>";
    }
    if (pod.paused != null) {                  // subscriber → dot / paused
      if (pod.available === false) return RED_DOT;
      return pod.paused ? '<span class="infra-state-rate paused">&#x23F8;</span>' : GREEN_DOT;
    }
    // face / gui / anything else → health dot from pod.available
    if (pod.available === false) return RED_DOT;
    if (pod.available === true || pod.phase === "Running") return GREEN_DOT;
    return '<span class="infra-state-unknown">?</span>';
  }

  // Per-pod fault badges with per-pod truth (§8.1). base = chaos base service.
  function fiPodFaultBadges(pod, base) {
    var ch = pod.chaos;
    if (!ch && !state._multiBases[base] && state.chaos && state.chaos[base] && state.chaos[base].available) {
      ch = state.chaos[base];   // aggregate fallback for single-instance services only
    }
    if (!ch) return "";
    var out = [];
    if (ch.errorFraction > 0) out.push('<span class="fi-fault-badge badge-err">E ' + ch.errorFraction + "%</span>");
    if (ch.delayBuckets && ch.delayBuckets.length) out.push('<span class="fi-fault-badge badge-delay">&#x23F1;</span>');
    if (ch.maxRate > 0) out.push('<span class="fi-fault-badge badge-rate">&#x1F6A6;' + ch.maxRate + "</span>");
    if (ch.latched) out.push('<span class="fi-fault-badge badge-latch">&#x1F512;</span>');
    return out.join("");
  }

  // Tooltip content, ported from the web UI's infraPodTip. Order: status first
  // (label Center/Edge only when they differ), then identity, then exact fault
  // values, then error. Color pods get NO text line — the tooltip renderer
  // injects swatch DOM from data-pod-color / data-pod-color-edge instead.
  function infraPodTip(pod) {
    var lines = [];
    if (pod.smiley != null) {
      if (pod.smileyEdge != null) {
        lines.push("Center: " + decodeEntity(pod.smiley));
        lines.push("Edge: " + decodeEntity(pod.smileyEdge));
      } else {
        lines.push(decodeEntity(pod.smiley));
      }
    }
    if (pod.publishIntervalMs != null && pod.smiley == null) {
      lines.push(pod.paused ? "Paused" : "Publishing every " + pod.publishIntervalMs + " ms (" + msToRate(pod.publishIntervalMs) + ")");
    } else if (pod.paused != null && pod.smiley == null && pod.color == null) {
      lines.push(pod.paused ? "Paused" : "Running");
    }
    if (pod.name && pod.name !== pod.ip) lines.push("Pod: " + pod.name);
    lines.push("IP: " + pod.ip);
    if (pod.node) lines.push("Node: " + pod.node);
    if (pod.zone) lines.push("Zone: " + pod.zone);
    if (pod.region) lines.push("Region: " + pod.region);
    if (pod.workloadType === "externalworkload") lines.push("Type: External Workload");
    var ch = pod.chaos;
    if (ch) {
      var f = [];
      if (ch.errorFraction > 0) f.push("• Errors: " + ch.errorFraction + "%");
      if (ch.delayBuckets && ch.delayBuckets.length) f.push("• Delay: " + ch.delayBuckets.join(", ") + " ms");
      if (ch.maxRate > 0) f.push("• Max rate: " + ch.maxRate + " RPS");
      if (ch.latchFraction > 0) f.push("• Latch chance: " + ch.latchFraction + "%");
      if (ch.latched) f.push("• Latched into 599 (active)");
      if (f.length) { lines.push("Faults:"); f.forEach(function (x) { lines.push(x); }); }
    }
    if (pod.available === false && pod.error) lines.push("Error: " + pod.error);
    return lines.join("\\n");
  }

  // Render one zone/node card. selectable=FI mode. Returns HTML string.
  function topologyCardHTML(card, selectable, group) {
    var podsHTML = "";
    var svcKeys = Object.keys(card.pods).sort();
    svcKeys.forEach(function (svcKey) {
      var base = chaosBaseSvc(svcKey);
      var rows = card.pods[svcKey].slice().sort(sortPods).map(function (pod) {
        var podSel = selectable && state.fi.scope === "pod" && state.fi.detail === pod.ip;
        var attrs = ' data-tooltip="' + esc(infraPodTip(pod)) + '"';
        if (pod.color != null && validHex(pod.color)) attrs += ' data-pod-color="' + pod.color + '"';
        if (pod.colorEdge != null && validHex(pod.colorEdge)) attrs += ' data-pod-color-edge="' + pod.colorEdge + '"';
        if (selectable) attrs += ' data-fi-scope="pod" data-fi-detail="' + esc(pod.ip) + '" data-fi-base="' + esc(base) + '"';
        // Web-UI row shape: state glyph (fault badge overrides it) leads, then
        // the short pod name. Full identity lives in the tooltip.
        return '<div class="infra-pod-row' + (selectable ? " fi-selectable" : "") + (podSel ? " fi-selected" : "") + '"' + attrs + ">" +
          '<span class="infra-pod-state">' + infraPodStateHTML(pod, base) + "</span>" +
          '<span class="infra-pod-name">' + esc(podShortName(pod)) + "</span></div>";
      }).join("");
      podsHTML += '<div class="infra-svc-block"><div class="infra-svc-name">' + esc(svcKey) + "</div>" + rows + "</div>";
    });

    var cardSel = selectable && state.fi.scope === group.scope &&
      state.fi.detail === (group.scope === "zone" ? card.zone : (card.node || card.label));
    var cardAttrs = "";
    if (selectable) {
      var detail = group.scope === "zone" ? card.zone : (card.node || card.label);
      cardAttrs = ' data-fi-scope="' + group.scope + '" data-fi-detail="' + esc(detail) + '" data-fi-label="' + esc(card.label) + '"';
    }
    return '<div class="infra-zone-card' + (selectable ? " fi-selectable" : "") + (cardSel ? " fi-selected" : "") + '"' + cardAttrs + ">" +
      '<div class="infra-zone-head"' + (selectable ? cardAttrs : "") + ">" + (card.icon || "") + " " + esc(card.label) +
      (card.region ? ' <span class="zone-region">' + esc(card.region) + "</span>" : "") + "</div>" +
      podsHTML + "</div>";
  }

  function topologyHTML(selectable) {
    var groups = buildTopologyGroups(state.lastInfra);
    if (!groups.length) return "";
    return groups.map(function (g) {
      var cards = g.cards.map(function (c) { return topologyCardHTML(c, selectable, g); }).join("");
      return '<div class="infra-group"><div class="infra-group-title">' + esc(g.title) + "</div>" +
        '<div class="infra-zone-row">' + cards + "</div></div>";
    }).join("");
  }

  function renderInfrastructure() {
    var sec = $("#infra-section");
    var html = topologyHTML(false);
    sec.style.display = html ? "block" : "none";
    repaint("ovInfra", $("#ov-infra"), html);
  }

  // ================================================================ FLOW (pub/sub)

  // ip → infra pod index, for enriching /api/controls pod lists (which only
  // carry podIP + state) with name/zone/node from the topology.
  function infraIPIndex() {
    var idx = {};
    if (state.lastInfra && state.lastInfra.zones) {
      state.lastInfra.zones.forEach(function (z) {
        Object.keys(z.pods || {}).forEach(function (svcKey) {
          (z.pods[svcKey] || []).forEach(function (p) { if (p.ip) idx[p.ip] = p; });
        });
      });
    }
    return idx;
  }

  function fmtCount(n) {
    if (n == null) return "—";
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 10000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function renderFlow() {
    renderFlowBanners();
    repaint("flowPipe", $("#flow-pipe"), pipelineChainHTML());
    renderFlowMetrics();
    renderFlowCharts();
    renderFlowControls();
    renderFlowScenarios();
    renderFlowPods();
  }

  function renderFlowBanners() {
    var pl = state.pipeline || {}, my = pl.mysql || {}, q = pl.queue || {};
    var html = "";
    if (state._pendingStreak >= 3) {
      html += '<div class="flow-banner">&#x26A0; Queue backend unreachable — the publisher is buffering ' +
        fmtCount(my.pending) + " message(s) in MySQL.</div>";
    }
    var stranded = Math.max(0, (my.queued || 0) - (q.depth || 0));
    var queueFull = (q.depth || 0) >= (q.maxDepth || 5000) * 0.95;
    if (stranded > 500 && !queueFull && q.available !== false) {
      html += '<div class="flow-banner amber">&#x26A0; ~' + fmtCount(stranded) +
        ' message(s) have been dropped from the queue (depth cap overflow).' +
        '<button class="btn" id="flow-rewarm-banner">Re-warm Queue</button></div>';
    }
    repaint("flowBanners", $("#flow-banners"), html);
  }

  function renderFlowMetrics() {
    var pl = state.pipeline || {}, my = pl.mysql || {}, q = pl.queue || {};
    var dropped = Math.max(0, (my.queued || 0) - (q.depth || 0));
    var tiles = [
      { v: fmtCount(my.queued), lbl: "DB Queued", tip: "MySQL rows in state &#39;queued&#39; — published, awaiting delivery" },
      { v: fmtCount(my.acknowledged), lbl: "Delivered", tip: "MySQL rows in state &#39;acknowledged&#39; — delivered to the GUI" },
      { v: fmtCount(q.depth), lbl: "Queue Depth", tip: "Messages currently buffered in " + (q.backend || "the queue") + " (max " + (q.maxDepth || "?") + ")" },
      { v: fmtCount(dropped), lbl: "Dropped", tip: "max(0, queued − depth): rows in MySQL no longer in the queue (cap overflow). Re-warm to re-push.", cls: dropped > 500 ? "warn" : "" },
      { v: q.readyRate != null ? q.readyRate + "/s" : "—", lbl: "Pub Rate", tip: "Queue publish (ready) rate" },
      { v: q.deliverRate != null ? q.deliverRate + "/s" : "—", lbl: "Del Rate", tip: "Queue deliver rate" },
    ];
    var html = tiles.map(function (t) {
      return '<div class="metric-card" data-tooltip="' + t.tip + '">' +
        '<div class="metric-value ' + (t.cls || "") + '">' + esc(t.v) + "</div>" +
        '<div class="metric-label">' + esc(t.lbl) + "</div></div>";
    }).join("");
    repaint("flowMetrics", $("#flow-metrics"), html);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#53d8fb";
  }

  function drawSparkline(canvas, values, color) {
    if (!canvas) return;
    var cssW = canvas.clientWidth || 300, cssH = canvas.clientHeight || 64;
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== cssW * dpr) { canvas.width = cssW * dpr; canvas.height = cssH * dpr; }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!values || values.length < 2) return;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    if (max === min) { min = Math.max(0, min - 1); max = max + 1; }
    var pad = 3, w = cssW - pad * 2, h = cssH - pad * 2;
    function xy(i) {
      return [pad + (i / (values.length - 1)) * w,
              pad + h - ((values[i] - min) / (max - min)) * h];
    }
    ctx.beginPath();
    ctx.moveTo(pad, pad + h);
    for (var i = 0; i < values.length; i++) { var p = xy(i); ctx.lineTo(p[0], p[1]); }
    ctx.lineTo(pad + w, pad + h);
    ctx.closePath();
    ctx.globalAlpha = 0.18; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath();
    for (var j = 0; j < values.length; j++) { var pj = xy(j); if (j === 0) ctx.moveTo(pj[0], pj[1]); else ctx.lineTo(pj[0], pj[1]); }
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
  }

  function renderFlowCharts() {
    var pl = state.pipeline || {};
    var hist = Array.isArray(pl.history) ? pl.history : [];
    var depth = hist.map(function (h) { return h.queueDepth || 0; });
    var acked = hist.map(function (h) { return h.acknowledged || 0; });
    drawSparkline($("#spark-depth"), depth, cssVar("--accent2"));
    drawSparkline($("#spark-acked"), acked, cssVar("--green"));
    var q = pl.queue || {}, my = pl.mysql || {};
    $("#chart-depth-cur").textContent = q.depth != null ? fmtCount(q.depth) : "";
    $("#chart-acked-cur").textContent = my.acknowledged != null ? fmtCount(my.acknowledged) : "";
  }

  // Publisher rate slider: logarithmic 1..1000 ms. t∈[0,100] → ms = 10^(3t/100).
  function rateSliderToMs(t) { return Math.max(1, Math.round(Math.pow(10, (t / 100) * 3))); }
  function msToRateSlider(ms) { return Math.max(0, Math.min(100, Math.round(Math.log(Math.max(1, ms)) / Math.LN10 / 3 * 100))); }

  function pubRateText(ms, concurrency, podCount) {
    var total = (1000 / Math.max(1, ms)) * (concurrency || 1) * (podCount || 1);
    var t = total >= 100 ? Math.round(total) : Math.round(total * 10) / 10;
    return ms + " ms<small>~" + t + " msg/s total</small>";
  }

  function renderFlowControls() {
    var node = $("#flow-controls");
    // Don't clobber the slider mid-drag or a focused control.
    if (node.contains(document.activeElement) && document.activeElement !== node) return;
    var c = state.controls || {};
    var pub = c.publisher, sub = c.subscriber;
    var html = "";

    var pubDown = !pub || pub.available === false;
    var pubMs = pub && pub.publishIntervalMs != null ? pub.publishIntervalMs : 50;
    html += '<div class="flowctl-card" data-svc="publisher">' +
      '<div class="flowctl-head">Publisher' +
      '<span class="flowctl-status ' + (pubDown ? "down" : (pub.paused ? "paused" : "")) + '">' +
      (pubDown ? "unavailable" : (pub.paused ? "PAUSED" : "RUNNING")) + "</span></div>" +
      '<div class="flowctl-rate-row"><input type="range" id="flow-pub-rate" min="0" max="100" value="' + msToRateSlider(pubMs) + '"' + (pubDown ? " disabled" : "") + ">" +
      '<span class="flowctl-rate-val" id="flow-pub-rate-val">' + pubRateText(pubMs, pub && pub.publishConcurrency, pub && pub.podCount) + "</span></div>" +
      '<div class="flowctl-note">Publish interval per goroutine · ' + (pub ? (pub.publishConcurrency || 1) + " goroutine(s) × " + (pub.podCount || 1) + " pod(s)" : "—") + "</div>" +
      '<div class="flowctl-actions">' +
      '<button class="btn" id="flow-pub-pause"' + (pubDown ? " disabled" : "") + ">" + (pub && pub.paused ? "Resume" : "Pause") + "</button>" +
      '<button class="btn" id="flow-pub-warm"' + (pubDown ? " disabled" : "") + ' data-tooltip="Re-push all pending+queued MySQL rows into the queue (no restart)">Re-warm Queue</button>' +
      "</div></div>";

    var subDown = !sub || sub.available === false;
    html += '<div class="flowctl-card" data-svc="subscriber">' +
      '<div class="flowctl-head">Subscriber' +
      '<span class="flowctl-status ' + (subDown ? "down" : (sub.paused ? "paused" : "")) + '">' +
      (subDown ? "unavailable" : (sub.paused ? "PAUSED" : "RUNNING")) + "</span></div>" +
      '<div class="flowctl-note">' + (sub ? (sub.podCount || 1) + " pod(s) serving the GUI from the queue" : "—") + "</div>" +
      '<div class="flowctl-actions">' +
      '<button class="btn" id="flow-sub-pause"' + (subDown ? " disabled" : "") + ">" + (sub && sub.paused ? "Resume" : "Pause") + "</button>" +
      "</div></div>";

    repaint("flowCtl", node, html);
    wireFlowControls();
  }

  function wireFlowControls() {
    var node = $("#flow-controls");
    if (node._wired) return;
    node._wired = true;
    node.addEventListener("input", function (e) {
      if (e.target.id !== "flow-pub-rate") return;
      var pub = state.controls && state.controls.publisher;
      var ms = rateSliderToMs(+e.target.value);
      $("#flow-pub-rate-val").innerHTML = pubRateText(ms, pub && pub.publishConcurrency, pub && pub.podCount);
    });
    node.addEventListener("change", function (e) {
      if (e.target.id !== "flow-pub-rate") return;
      var ms = rateSliderToMs(+e.target.value);
      e.target.blur();   // release the repaint guard
      fetchJSON("PUT", "/api/controls/publisher", { publishIntervalMs: ms }).then(function (r) {
        showToast(r.ok ? "Publish interval set to " + ms + " ms" : "Rate change failed", r.ok ? "success" : "error");
        state._sigs.flowCtl = null; pollMain();
      });
    });
    node.addEventListener("click", function (e) {
      var pub = state.controls && state.controls.publisher;
      var sub = state.controls && state.controls.subscriber;
      if (e.target.id === "flow-pub-pause") {
        var to = !(pub && pub.paused);
        fetchJSON("PUT", "/api/controls/publisher", { paused: to }).then(function (r) {
          showToast(r.ok ? ("Publisher " + (to ? "paused" : "resumed")) : "Failed", r.ok ? "success" : "error");
          state._sigs.flowCtl = null; pollMain();
        });
      } else if (e.target.id === "flow-pub-warm") {
        fetchJSON("PUT", "/api/controls/publisher", { warm: true }).then(function (r) {
          showToast(r.ok ? "Re-warming queue from MySQL" : "Re-warm failed", r.ok ? "success" : "error");
        });
      } else if (e.target.id === "flow-sub-pause") {
        var to2 = !(sub && sub.paused);
        fetchJSON("PUT", "/api/controls/subscriber", { paused: to2 }).then(function (r) {
          showToast(r.ok ? ("Subscriber " + (to2 ? "paused" : "resumed")) : "Failed", r.ok ? "success" : "error");
          state._sigs.flowCtl = null; pollMain();
        });
      }
    });
  }

  var FLOW_SCENARIOS = [
    { id: "drain", lbl: "Drain Queue", cls: "scn-green",
      tip: "Pause the publisher, resume the subscriber — the GUI drains the backlog",
      steps: [["publisher", { paused: true }], ["subscriber", { paused: false }]] },
    { id: "fill", lbl: "Fill Queue", cls: "scn-yellow",
      tip: "Resume the publisher, pause the subscriber — the queue fills toward its cap",
      steps: [["publisher", { paused: false }], ["subscriber", { paused: true }]] },
    { id: "freeze", lbl: "Freeze All", cls: "scn-red",
      tip: "Pause both ends of the pipeline",
      steps: [["publisher", { paused: true }], ["subscriber", { paused: true }]] },
    { id: "resume", lbl: "Resume All", cls: "scn-green",
      tip: "Resume both ends and reset the publish interval to the 50 ms default",
      steps: [["publisher", { paused: false, publishIntervalMs: 50 }], ["subscriber", { paused: false }]] },
  ];

  function renderFlowScenarios() {
    var html = '<div class="scenario-bar"><span class="scenario-label">Pipeline</span>' +
      FLOW_SCENARIOS.map(function (s) {
        return '<button class="scenario-btn ' + s.cls + '" data-flow-scn="' + s.id + '" data-tooltip="' + esc(s.tip) + '">' + esc(s.lbl) + "</button>";
      }).join("") + "</div>";
    repaint("flowScen", $("#flow-scenarios"), html);
    var panel = $("#flow-scenarios");
    if (!panel._wired) {
      panel._wired = true;
      panel.addEventListener("click", function (e) {
        var b = e.target.closest("[data-flow-scn]"); if (!b) return;
        var scn = null;
        FLOW_SCENARIOS.forEach(function (s) { if (s.id === b.getAttribute("data-flow-scn")) scn = s; });
        if (!scn) return;
        Promise.all(scn.steps.map(function (st) {
          return fetchJSON("PUT", "/api/controls/" + st[0], st[1]);
        })).then(function (rs) {
          var allOk = rs.every(function (r) { return r.ok; });
          showToast(allOk ? scn.lbl + " applied" : scn.lbl + ": some calls failed", allOk ? "success" : "warn");
          state._sigs.flowCtl = null; pollMain();
        });
      });
    }
  }

  function renderFlowPods() {
    var c = state.controls || {};
    var idx = infraIPIndex();
    function podCard(title, list, isPub) {
      var rows = (list || []).map(function (p) {
        var ip = p.podIP || p.ip;
        var info = idx[ip] || { ip: ip };
        var merged = {
          name: info.name, ip: ip, node: info.node, zone: info.zone, region: info.region,
          phase: info.phase, available: p.available !== false,
          paused: p.paused, chaos: info.chaos,
        };
        if (isPub) merged.publishIntervalMs = p.publishIntervalMs;
        var attrs = ' data-tooltip="' + esc(infraPodTip(merged)) + '"';
        return '<div class="flow-pod-row"' + attrs + ">" +
          '<span class="infra-pod-state">' + infraPodStateHTML(merged, isPub ? "publisher" : "subscriber") + "</span>" +
          '<span class="fp-name">' + esc(podShortName(merged)) + "</span>" +
          (merged.zone ? '<span class="fp-zone">&#x1F4CD; ' + esc(merged.zone) + "</span>" : "") +
          '<span class="fp-state">' + (isPub ? (p.paused ? "paused" : esc(String(p.publishIntervalMs)) + " ms") : (p.paused ? "paused" : "running")) + "</span></div>";
      }).join("");
      return '<div class="flow-pod-card"><div class="fp-title">' + esc(title) + "</div>" +
        (rows || '<div class="pod-empty">No pods discovered.</div>') + "</div>";
    }
    var html = podCard("Publisher pods", c.publisher && c.publisher.pods, true) +
               podCard("Subscriber pods", c.subscriber && c.subscriber.pods, false);
    repaint("flowPods", $("#flow-pods"), html);
  }

  // ================================================================ CONTROLS

  // Curated emoji codepoint tables (hex). Multi-codepoint joined with "-".
  var EMOJI_CATEGORIES = [
    { tab: "😃", name: "Faces", cps: ["1F600","1F603","1F604","1F601","1F606","1F605","1F602","1F923","1F60A","1F607","1F642","1F643","1F609","1F60C","1F60D","1F970","1F618","1F617","1F619","1F61A","1F60B","1F61B","1F61C","1F92A","1F61D","1F911","1F917","1F92D","1F92B","1F914","1F910","1F928","1F610","1F611","1F636","1F60F","1F612","1F644","1F62C","1F925","1F60E","1F913","1F9D0"] },
    { tab: "😢", name: "Sad", cps: ["1F615","1F61F","1F641","2639","1F62E","1F62F","1F632","1F633","1F97A","1F626","1F627","1F628","1F630","1F625","1F622","1F62D","1F631","1F616","1F623","1F61E","1F613","1F629","1F62B","1F624","1F620","1F621","1F92C","1F635","1F634","1F62A"] },
    { tab: "👾", name: "Fun", cps: ["1F608","1F47F","1F479","1F47A","1F480","2620","1F47B","1F47D","1F47E","1F916","1F4A9","1F921","1F383","1F608","1F47C","1F385","1F936","1F9B8","1F9B9","1F9D9","1F9DA","1F9DB","1F9DC","1F9DD","1F9DE","1F9DF"] },
    { tab: "❤️", name: "Hearts", cps: ["2764","1F9E1","1F49B","1F49A","1F499","1F49C","1F90E","1F5A4","1F90D","1F494","2763","1F495","1F49E","1F493","1F497","1F496","1F498","1F49D","1F49F","2665"] },
    { tab: "👍", name: "Hands", cps: ["1F44D","1F44E","1F44C","1F44A","270A","270B","1F44B","1F91A","1F590","1F596","1F44F","1F64C","1F450","1F932","1F91D","1F64F","270C","1F91E","1F918","1F919","1F448","1F449","1F446","1F447","261D","1F4AA"] },
    { tab: "🐶", name: "Animals", cps: ["1F436","1F431","1F42D","1F439","1F430","1F98A","1F43B","1F43C","1F428","1F42F","1F981","1F42E","1F437","1F438","1F435","1F648","1F649","1F64A","1F412","1F414","1F427","1F426","1F424","1F986","1F985","1F989","1F987","1F43A","1F417","1F434","1F984","1F41D","1F41B","1F98B","1F40C","1F41E"] },
    { tab: "🍕", name: "Food", cps: ["1F34F","1F34E","1F350","1F34A","1F34B","1F34C","1F349","1F347","1F353","1F352","1F351","1F34D","1F345","1F346","1F955","1F33D","1F336","1F354","1F35F","1F355","1F32D","1F32E","1F32F","1F37F","1F371","1F363","1F371","1F366","1F367","1F369","1F370","2615","1F37A"] },
    { tab: "⚡", name: "Symbols", cps: ["2B50","1F31F","26A1","1F525","1F4A5","2728","1F308","2600","26C5","2601","1F327","26C8","1F329","1F4A7","1F4AB","1F31E","1F311","1F315","2705","274C","2757","2753","1F4A4","1F4A2","1F389","1F38A","1F3C1","1F6A6","1F512","23F1"] },
  ];
  // Small keyword map for search.
  var EMOJI_NAMES = {
    "1F600":"grinning smile happy","1F602":"laugh joy tears lol","1F923":"rofl rolling laugh",
    "1F60D":"heart eyes love","1F618":"kiss love","1F60E":"cool sunglasses","1F913":"nerd geek",
    "1F914":"thinking hmm","1F621":"angry mad rage","1F622":"cry sad tears","1F62D":"sob cry",
    "1F634":"sleep tired zzz","1F92C":"curse swear angry","1F92F":"explode mind blown kaboom",
    "1F610":"neutral meh","1F644":"eyeroll rolling eyes","1F480":"skull dead","1F4A9":"poop",
    "1F525":"fire hot lit flame","2B50":"star","26A1":"lightning bolt zap","1F4A5":"boom explosion",
    "2764":"red heart love","1F44D":"thumbs up like","1F44E":"thumbs down dislike",
    "1F436":"dog puppy","1F431":"cat kitten","1F354":"burger hamburger","1F355":"pizza",
    "1F389":"party tada celebrate","1F512":"lock latch","23F1":"timer delay stopwatch","1F6A6":"traffic light rate",
  };

  function cpToStr(cp) {
    return cp.split("-").map(function (h) { return String.fromCodePoint(parseInt(h, 16)); }).join("");
  }

  var controlsBuilt = false, currentEmojiTab = 0, currentLinkys = [];

  function buildControlsOnce() {
    if (controlsBuilt) return;
    controlsBuilt = true;

    // Tabs
    var tabsEl = $("#emoji-tabs");
    tabsEl.innerHTML = EMOJI_CATEGORIES.map(function (c, i) {
      return '<button class="picker-tab' + (i === 0 ? " active" : "") + '" data-tab="' + i + '" data-tooltip="' + esc(c.name) + '">' + c.tab + "</button>";
    }).join("") + '<button class="picker-tab" data-tab="linky" data-tooltip="Linkerd">🔗</button>';
    tabsEl.addEventListener("click", function (e) {
      var b = e.target.closest(".picker-tab"); if (!b) return;
      $all(".picker-tab", tabsEl).forEach(function (t) { t.classList.remove("active"); });
      b.classList.add("active");
      var tab = b.getAttribute("data-tab");
      $("#emoji-search").value = "";
      if (tab === "linky") { currentEmojiTab = "linky"; renderEmojiGrid(); loadLinkys(); }
      else { currentEmojiTab = parseInt(tab, 10); renderEmojiGrid(); }
    });

    $("#emoji-search").addEventListener("input", renderEmojiGrid);
    $("#emoji-grid").addEventListener("click", function (e) {
      var c = e.target.closest(".picker-cell"); if (!c) return;
      if (c.getAttribute("data-img")) {
        state.sel.smileyImg = c.getAttribute("data-img"); state.sel.smiley = c.getAttribute("data-img");
      } else {
        state.sel.smiley = c.getAttribute("data-emoji"); state.sel.smileyImg = null;
      }
      $all(".picker-cell", $("#emoji-grid")).forEach(function (x) { x.classList.remove("selected"); });
      c.classList.add("selected");
      updatePreview();
    });
    $("#emoji-custom").addEventListener("input", function () {
      var v = $("#emoji-custom").value.trim();
      if (v) { state.sel.smiley = v; state.sel.smileyImg = null; $all(".picker-cell.selected").forEach(function (x) { x.classList.remove("selected"); }); updatePreview(); }
    });

    // Which toggle
    $("#ctrl-which").addEventListener("click", function (e) {
      var b = e.target.closest(".toggle-btn"); if (!b) return;
      state.sel.which = b.getAttribute("data-which");
      $all(".toggle-btn", $("#ctrl-which")).forEach(function (x) { x.classList.toggle("active", x === b); });
    });

    // Color picker
    $("#color-swatches").addEventListener("click", function (e) {
      var sw = e.target.closest(".color-swatch"); if (!sw) return;
      setColor(sw.getAttribute("data-hex"));
    });
    $("#color-hex").addEventListener("input", function () {
      var v = $("#color-hex").value.trim();
      if (validHex(v)) { state.sel.colorHex = v; $("#color-native").value = v; markSwatch(); updatePreview(); }
    });
    $("#color-native").addEventListener("input", function () { setColor($("#color-native").value); });

    $("#ctrl-apply").addEventListener("click", applyControls);
    $("#ctrl-clear").addEventListener("click", function () {
      state.sel.smiley = null; state.sel.smileyImg = null; state.sel.colorHex = null;
      $all(".picker-cell.selected").forEach(function (x) { x.classList.remove("selected"); });
      markSwatch(); updatePreview();
    });

    renderEmojiGrid();
    renderColorSwatches();
  }

  function setColor(hex) {
    if (!validHex(hex)) return;
    state.sel.colorHex = hex; $("#color-hex").value = hex; $("#color-native").value = hex;
    markSwatch(); updatePreview();
  }
  function markSwatch() {
    $all(".color-swatch").forEach(function (sw) {
      sw.classList.toggle("selected", sw.getAttribute("data-hex") === state.sel.colorHex);
    });
  }

  function renderColorSwatches() {
    var map = state.colorMap || DEFAULT_COLORS;
    var html = Object.keys(map).map(function (name) {
      var hex = map[name];
      return '<div class="color-swatch" data-hex="' + esc(hex) + '" data-tooltip="' + esc(name) + '" style="background:' + esc(hex) + '"></div>';
    }).join("");
    $("#color-swatches").innerHTML = html;
    markSwatch();
  }

  function renderEmojiGrid() {
    var grid = $("#emoji-grid");
    var q = $("#emoji-search").value.trim().toLowerCase();
    if (currentEmojiTab === "linky") {
      if (!currentLinkys.length) { grid.innerHTML = '<div class="picker-empty">Loading Linkerd images…</div>'; return; }
      grid.innerHTML = currentLinkys.map(function (l) {
        return '<div class="picker-cell" data-img="' + esc(l.dataUri) + '" data-tooltip="' + esc(l.name) + '"><img src="' + esc(l.dataUri) + '"></div>';
      }).join("");
      return;
    }
    var cps;
    if (q) {
      var seen = {};
      cps = [];
      EMOJI_CATEGORIES.forEach(function (cat) {
        cat.cps.forEach(function (cp) {
          if (seen[cp]) return;
          var kw = (EMOJI_NAMES[cp] || "") + " " + cat.name.toLowerCase();
          if (kw.indexOf(q) >= 0) { cps.push(cp); seen[cp] = 1; }
        });
      });
    } else {
      cps = EMOJI_CATEGORIES[currentEmojiTab].cps;
    }
    if (!cps.length) { grid.innerHTML = '<div class="picker-empty">No matches</div>'; return; }
    grid.innerHTML = cps.map(function (cp) {
      var g = cpToStr(cp);
      return '<div class="picker-cell" data-emoji="' + esc(g) + '">' + esc(g) + "</div>";
    }).join("");
  }

  function loadLinkys() {
    if (currentLinkys.length) { renderEmojiGrid(); return; }
    fetchJSON("GET", "/api/linkys").then(function (r) {
      var files = (r.ok && Array.isArray(r.data)) ? r.data : [];
      if (!files.length) { currentLinkys = []; if (currentEmojiTab === "linky") $("#emoji-grid").innerHTML = '<div class="picker-empty">No Linkerd images</div>'; return; }
      Promise.all(files.map(function (f) {
        return rawFetch("GET", "/linkys/" + f, null, { binary: true }).then(function (rep) {
          if (rep.bodyBase64) return { name: f, dataUri: "data:" + (rep.contentType || "image/png") + ";base64," + rep.bodyBase64 };
          return null;
        });
      })).then(function (arr) {
        currentLinkys = arr.filter(Boolean);
        if (currentEmojiTab === "linky") renderEmojiGrid();
      });
    });
  }

  function updatePreview() {
    var cell = $("#ctrl-preview");
    cell.style.background = state.sel.colorHex || "#66CCEE";
    if (state.sel.smileyImg) cell.innerHTML = '<img src="' + esc(state.sel.smileyImg) + '">';
    else cell.textContent = state.sel.smiley ? decodeEntity(state.sel.smiley) : "";
  }

  function renderControls() {
    buildControlsOnce();
    if (state.colorMap) renderColorSwatches();
    renderPodSelectors();
    // Lazy-load palettes once.
    if (!state.smileyMap) fetchJSON("GET", "/api/smiley").then(function (r) { if (r.ok && r.data) state.smileyMap = r.data; });
    if (!state.colorMap) fetchJSON("GET", "/api/color").then(function (r) { if (r.ok) { state.colorMap = normalizeColorMap(r.data); renderColorSwatches(); } });
  }

  var DEFAULT_COLORS = { grey: "#BBBBBB", darkblue: "#4477AA", blue: "#66CCEE", green: "#228833",
                         yellow: "#CCBB44", red: "#EE6677", purple: "#AA3377" };
  function normalizeColorMap(data) {
    if (data && !Array.isArray(data) && typeof data === "object") {
      var ok = Object.keys(data).every(function (k) { return validHex(data[k]); });
      if (ok && Object.keys(data).length) return data;
    }
    if (Array.isArray(data)) {
      var m = {};
      data.forEach(function (c) {
        if (typeof c === "string" && DEFAULT_COLORS[c]) m[c] = DEFAULT_COLORS[c];
        else if (c && c.name && validHex(c.hex || c.color)) m[c.name] = c.hex || c.color;
      });
      if (Object.keys(m).length) return m;
    }
    return DEFAULT_COLORS;
  }

  function applyControls() {
    var which = state.sel.which;
    var jobs = [];
    if (state.sel.smiley != null) {
      var sm = state.sel.smileyImg ? state.sel.smileyImg : decodeEntity(state.sel.smiley);
      var body = { which: which, smiley: sm };
      var pods = Object.keys(state.sel.smileyPods).filter(function (ip) { return state.sel.smileyPods[ip]; });
      if (pods.length) body.pods = pods;
      jobs.push(fetchJSON("PUT", "/api/smiley", body).then(function (r) { return { svc: "smiley", r: r }; }));
    }
    if (state.sel.colorHex != null && validHex(state.sel.colorHex)) {
      var cbody = { which: which, color: state.sel.colorHex };  // always hex
      var cpods = Object.keys(state.sel.colorPods).filter(function (ip) { return state.sel.colorPods[ip]; });
      if (cpods.length) cbody.pods = cpods;
      jobs.push(fetchJSON("PUT", "/api/color", cbody).then(function (r) { return { svc: "color", r: r }; }));
    }
    if (!jobs.length) { showToast("Pick an emoji and/or a color first.", "warn"); return; }
    Promise.all(jobs).then(function (results) {
      results.forEach(function (x) {
        if (x.r.ok) showToast(chaosPodStatusText(x.r.data) + " (" + x.svc + ")", chaosPodStatusKind(x.r.data));
        else showToast("Failed to set " + x.svc, "error");
      });
      setTimeout(pollControlsState, 400);
    });
  }

  // ----------------------------------------------------------- pod selectors

  function podServingMap(list, field) {
    var m = {};
    (list || []).forEach(function (e) { m[e.ip] = e; });
    return m;
  }

  function zoneOf(pod) {
    if (pod.workloadType === "externalworkload") return "🔗 External Workload";
    if (pod.zone) return "📍 " + pod.zone;
    return "🏢 On-Premise";
  }

  function renderPodSelector(elNode, pods, servingList, selMap, field) {
    if (!elNode) return;
    pods = (pods || []).slice().sort(sortPods);
    if (!pods.length) { elNode.innerHTML = '<div class="pod-empty">No pods discovered.</div>'; return; }
    var serving = podServingMap(servingList, field);
    var groups = {};
    pods.forEach(function (p) { (groups[zoneOf(p)] || (groups[zoneOf(p)] = [])).push(p); });
    var html = "";
    var allActive = !Object.keys(selMap).some(function (k) { return selMap[k]; });
    html += '<div class="pod-zone-group"><div class="pod-zone-label">Target</div><div class="pod-pills">' +
      '<span class="pod-pill' + (allActive ? " active" : "") + '" data-all="1">All pods</span></div></div>';
    Object.keys(groups).sort().forEach(function (z) {
      var pills = groups[z].map(function (p) {
        var s = serving[p.ip] || {};
        // Merge topology identity + live serving state into one pod view so
        // the pill glyph and tooltip match the infra rows exactly.
        var merged = {
          name: p.name, ip: p.ip, node: p.node, zone: p.zone, region: p.region,
          workloadType: p.workloadType, phase: p.phase,
          smiley: s.smiley, smileyEdge: s.smileyEdge, color: s.color, colorEdge: s.colorEdge,
        };
        var stateHTML = (s.smiley != null || s.color != null)
          ? '<span class="pod-pill-state">' + infraPodStateHTML(merged, null) + "</span>" : "";
        var attrs = ' data-ip="' + esc(p.ip) + '" data-tooltip="' + esc(infraPodTip(merged)) + '"';
        if (merged.color != null && validHex(merged.color)) attrs += ' data-pod-color="' + merged.color + '"';
        if (merged.colorEdge != null && validHex(merged.colorEdge)) attrs += ' data-pod-color-edge="' + merged.colorEdge + '"';
        return '<span class="pod-pill' + (selMap[p.ip] ? " active" : "") + '"' + attrs + ">" +
          stateHTML + esc(podShortName(p)) + "</span>";
      }).join("");
      html += '<div class="pod-zone-group"><div class="pod-zone-label">' + esc(z) + '</div><div class="pod-pills">' + pills + "</div></div>";
    });
    elNode.innerHTML = html;
  }

  function renderPodSelectors() {
    if (state.page !== "controls") return;
    renderPodSelector($("#smiley-pods"), state.podServing.smileyPods, state.podServing.smiley, state.sel.smileyPods, "smiley");
    renderPodSelector($("#color-pods"), state.podServing.colorPods, state.podServing.color, state.sel.colorPods, "color");
  }

  function wirePodSelector(elId, selMap) {
    $("#" + elId).addEventListener("click", function (e) {
      var pill = e.target.closest(".pod-pill"); if (!pill) return;
      if (pill.getAttribute("data-all")) { Object.keys(selMap).forEach(function (k) { delete selMap[k]; }); }
      else { var ip = pill.getAttribute("data-ip"); if (selMap[ip]) delete selMap[ip]; else selMap[ip] = true; }
      renderPodSelectors();
    });
  }

  // ================================================================ chaos status

  function chaosPodStatusText(d) {
    if (!d) return "Applied";
    var pods = d.pods || 0, ok = d.succeeded || 0, failed = d.failed || 0;
    if (ok > 0 && failed === 0) return "✓ Applied to " + ok + " pod(s)";
    if (ok > 0 && failed > 0) return "⚠ Applied to " + ok + "/" + pods + " pod(s)";
    if (ok === 0 && pods > 0) return "✗ No pods reached (" + pods + " attempted)";
    return "Applied";
  }
  function chaosPodStatusKind(d) {
    if (!d) return "success";
    var ok = d.succeeded || 0, failed = d.failed || 0;
    if (ok > 0 && failed === 0) return "success";
    if (ok > 0) return "warn";
    return "error";
  }

  // ================================================================ FAULT INJECTION

  function renderFITopology() {
    var html = topologyHTML(true);
    repaint("fiTopo", $("#fi-topology"), html || '<div class="pod-empty">No topology available.</div>');
    if (!$("#fi-topology")._wired) {
      $("#fi-topology")._wired = true;
      $("#fi-topology").addEventListener("click", function (e) {
        var node = e.target.closest("[data-fi-scope]"); if (!node) return;
        var scope = node.getAttribute("data-fi-scope");
        var detail = node.getAttribute("data-fi-detail");
        var label = node.getAttribute("data-fi-label") || (scope === "pod" ? detail : detail);
        if (state.fi.scope === scope && state.fi.detail === detail) {
          state.fi.scope = "all"; state.fi.detail = null; state.fi.label = "All pods";
        } else {
          state.fi.scope = scope; state.fi.detail = detail; state.fi.label = label;
        }
        state._sigs.fiTopo = null;  // force repaint for selection highlight
        renderFITopology(); renderFIGlobalPanel();
      });
    }
  }

  // Resolve current scope to {base: [ip,...]}. all → null (omit pods field).
  function resolveScopeTargets() {
    if (state.fi.scope === "all") return null;
    var map = {};
    if (!state.lastInfra || !state.lastInfra.zones) return map;
    state.lastInfra.zones.forEach(function (z) {
      Object.keys(z.pods || {}).forEach(function (svcKey) {
        var base = chaosBaseSvc(svcKey);
        z.pods[svcKey].forEach(function (p) {
          var match = false;
          if (state.fi.scope === "pod") match = p.ip === state.fi.detail;
          else if (state.fi.scope === "zone") match = z.zone === state.fi.detail;
          else if (state.fi.scope === "node") match = (p.node === state.fi.detail) || (z.label === state.fi.detail) || (z.zone === "" && state.fi.detail === z.label);
          if (match) (map[base] || (map[base] = [])).push(p.ip);
        });
      });
    });
    return map;
  }

  function fiTargetCount() {
    var map = resolveScopeTargets();
    if (map === null) return "all replicas";
    var total = 0; Object.keys(map).forEach(function (b) { total += map[b].length; });
    return total + " pod(s)";
  }

  var FI_DELAYS = [50, 100, 200, 500, 1000, 2000];

  function renderFIGlobalPanel() {
    var svcs = chaosServices();
    // default-select smiley if nothing selected yet
    if (!Object.keys(state.fi.services).some(function (k) { return state.fi.services[k]; })) {
      state.fi.services = {}; state.fi.services[svcs[0]] = true;
    }
    var pills = svcs.map(function (s) {
      return '<span class="fi-svc-pill' + (state.fi.services[s] ? " active" : "") + '" data-svc="' + esc(s) + '">' + esc(s) + "</span>";
    }).join("");
    var delays = FI_DELAYS.map(function (d) {
      return '<span class="fi-delay-bubble' + (state.fi.delays[d] ? " active" : "") + '" data-delay="' + d + '">' + d + "</span>";
    }).join("");
    var html =
      '<div class="fi-scope-line">Scope: <b>' + esc(state.fi.label) + "</b> · <span class=\"fi-target-count\">" + esc(fiTargetCount()) + "</span></div>" +
      '<div class="fi-svc-pills">' + pills + "</div>" +
      '<div class="fi-param-row"><span class="fi-param-label">Error %</span><input type="range" id="fi-g-error" min="0" max="100" value="' + state.fi.error + '"><span class="fi-param-val" id="fi-g-error-v">' + state.fi.error + "%</span></div>" +
      '<div class="fi-param-row"><span class="fi-param-label">Latch %</span><input type="range" id="fi-g-latch" min="0" max="100" value="' + state.fi.latch + '"><span class="fi-param-val" id="fi-g-latch-v">' + state.fi.latch + "%</span></div>" +
      '<div class="fi-param-row"><span class="fi-param-label">Max RPS</span><input type="range" id="fi-g-rate" min="0" max="500" step="1" value="' + state.fi.maxRate + '"><span class="fi-param-val" id="fi-g-rate-v">' + (state.fi.maxRate > 0 ? state.fi.maxRate + " RPS" : "no limit") + "</span></div>" +
      '<div class="fi-param-row"><span class="fi-param-label">Delays</span><div class="fi-delay-bubbles">' + delays + "</div></div>" +
      '<div class="fi-apply-row"><button class="btn btn-primary" id="fi-g-apply">Apply Fault</button>' +
      '<button class="btn" id="fi-g-reset-scope">↺ All pods</button></div>';
    repaint("fiGlobal", $("#fi-global-panel"), html);
    wireFIGlobalPanel();
  }

  function wireFIGlobalPanel() {
    var panel = $("#fi-global-panel");
    if (panel._wired) { return; }
    panel._wired = true;
    panel.addEventListener("input", function (e) {
      if (e.target.id === "fi-g-error") { state.fi.error = +e.target.value; $("#fi-g-error-v").textContent = state.fi.error + "%"; }
      else if (e.target.id === "fi-g-latch") { state.fi.latch = +e.target.value; $("#fi-g-latch-v").textContent = state.fi.latch + "%"; }
      else if (e.target.id === "fi-g-rate") { state.fi.maxRate = Math.max(0, +e.target.value || 0); var rv = $("#fi-g-rate-v"); if (rv) rv.textContent = state.fi.maxRate > 0 ? state.fi.maxRate + " RPS" : "no limit"; }
    });
    panel.addEventListener("click", function (e) {
      var svc = e.target.closest(".fi-svc-pill");
      if (svc) { var k = svc.getAttribute("data-svc"); state.fi.services[k] = !state.fi.services[k]; svc.classList.toggle("active", state.fi.services[k]); return; }
      var d = e.target.closest(".fi-delay-bubble");
      if (d) { var ms = d.getAttribute("data-delay"); state.fi.delays[ms] = !state.fi.delays[ms]; d.classList.toggle("active", state.fi.delays[ms]); return; }
      if (e.target.id === "fi-g-reset-scope") { state.fi.scope = "all"; state.fi.detail = null; state.fi.label = "All pods"; state._sigs.fiTopo = null; renderFITopology(); renderFIGlobalPanel(); return; }
      if (e.target.id === "fi-g-apply") applyGlobalFault();
    });
  }

  function applyGlobalFault() {
    var svcs = Object.keys(state.fi.services).filter(function (k) { return state.fi.services[k]; });
    if (!svcs.length) { showToast("Select at least one service.", "warn"); return; }
    var delays = FI_DELAYS.filter(function (d) { return state.fi.delays[d]; });
    var body = { errorFraction: state.fi.error, latchFraction: state.fi.latch, maxRate: state.fi.maxRate, delayBuckets: delays };
    var targets = resolveScopeTargets();
    applyChaosToServices(svcs, body, targets);
  }

  function applyChaosToServices(svcs, body, targets) {
    var jobs = svcs.map(function (svc) {
      var b = {};
      Object.keys(body).forEach(function (k) { b[k] = body[k]; });
      if (targets) {
        var ips = targets[svc] || [];
        if (!ips.length) return Promise.resolve({ svc: svc, skipped: true });
        b.pods = ips;
      }
      return fetchJSON("PUT", "/api/chaos/" + svc, b).then(function (r) { return { svc: svc, r: r }; });
    });
    Promise.all(jobs).then(function (results) {
      results.forEach(function (x) {
        if (x.skipped) return;
        if (x.r.ok) showToast(chaosPodStatusText(x.r.data) + " · " + x.svc, chaosPodStatusKind(x.r.data));
        else showToast("Failed: " + x.svc, "error");
      });
      refreshFITopologyBadges();
    });
  }

  function refreshFITopologyBadges() { setTimeout(pollInfra, 300); }

  // ----------------------------------------------------------- per-service cards

  // All pods of a chaos base service, flattened from the infra topology
  // (per-pod truth: each carries its own serving state + chaos).
  function infraPodsForBase(base) {
    var out = [], seen = {};
    if (state.lastInfra && state.lastInfra.zones) {
      state.lastInfra.zones.forEach(function (z) {
        Object.keys(z.pods || {}).forEach(function (svcKey) {
          if (chaosBaseSvc(svcKey) !== base) return;
          (z.pods[svcKey] || []).forEach(function (p) {
            if (p.ip && !seen[p.ip]) { seen[p.ip] = 1; out.push(p); }
          });
        });
      });
    }
    return out.sort(sortPods);
  }

  function fiCardSelectedIPs(svc) {
    var sel = state.fiCardSel[svc] || {};
    return Object.keys(sel).filter(function (ip) { return sel[ip]; });
  }

  function fiCardPodsHTML(svc) {
    var pods = infraPodsForBase(svc);
    if (!pods.length) return "";
    var sel = state.fiCardSel[svc] || (state.fiCardSel[svc] = {});
    // Drop selections for pods that no longer exist.
    Object.keys(sel).forEach(function (ip) {
      if (!pods.some(function (p) { return p.ip === ip; })) delete sel[ip];
    });
    var anySel = pods.some(function (p) { return sel[p.ip]; });
    var pills = '<span class="pod-pill' + (!anySel ? " active" : "") + '" data-allpods="1" data-tooltip="Apply to every ' + esc(svc) + ' pod">All pods</span>';
    pills += pods.map(function (p) {
      var attrs = ' data-ip="' + esc(p.ip) + '" data-tooltip="' + esc(infraPodTip(p)) + '"';
      if (p.color != null && validHex(p.color)) attrs += ' data-pod-color="' + p.color + '"';
      if (p.colorEdge != null && validHex(p.colorEdge)) attrs += ' data-pod-color-edge="' + p.colorEdge + '"';
      return '<span class="pod-pill' + (sel[p.ip] ? " active" : "") + '"' + attrs + ">" +
        '<span class="pod-pill-state">' + infraPodStateHTML(p, svc) + "</span>" + esc(podShortName(p)) + "</span>";
    }).join("");
    return '<div class="fi-pods-label">Target pods</div><div class="fi-card-pods">' + pills + "</div>";
  }

  function renderFICards() {
    var svcs = chaosServices();
    var chaos = state.chaos || {};
    var html = svcs.map(function (svc) {
      var c = chaos[svc];
      var unavailable = c && c.available === false;
      var cur = c || {};
      var badges = "";
      if (!unavailable) {
        if (cur.errorFraction > 0) badges += '<span class="fi-fault-badge badge-err">E ' + cur.errorFraction + "%</span>";
        if (cur.delayBuckets && cur.delayBuckets.length) badges += '<span class="fi-fault-badge badge-delay">&#x23F1;</span>';
        if (cur.maxRate > 0) badges += '<span class="fi-fault-badge badge-rate">&#x1F6A6;' + cur.maxRate + "</span>";
        if (cur.latched) badges += '<span class="fi-fault-badge badge-latch">&#x1F512;</span>';
      }
      if (unavailable) {
        return '<div class="fi-card"><div class="fi-card-head">' + esc(svc) + '</div><div class="fi-card-unavailable">unavailable in ' + esc(state.mode) + " mode</div></div>";
      }
      // Sync delay pill state from current chaos if the user hasn't touched it yet
      if (!state.fiCardDelays[svc]) {
        var initD = {};
        (cur.delayBuckets || []).forEach(function (d) { initD[d] = true; });
        state.fiCardDelays[svc] = initD;
      }
      var cd = state.fiCardDelays[svc];
      var delayPills = FI_DELAYS.map(function (d) {
        return '<span class="fi-delay-bubble' + (cd[d] ? " active" : "") + '" data-card-delay="' + d + '">' + d + "</span>";
      }).join("");
      return '<div class="fi-card" data-svc="' + esc(svc) + '">' +
        '<div class="fi-card-head">' + esc(svc) + '<span class="fi-card-state">' + badges + "</span></div>" +
        '<div class="fi-param-row"><span class="fi-param-label">Error %</span><input type="range" data-k="errorFraction" min="0" max="100" value="' + (cur.errorFraction || 0) + '"><span class="fi-param-val">' + (cur.errorFraction || 0) + "%</span></div>" +
        '<div class="fi-param-row"><span class="fi-param-label">Latch %</span><input type="range" data-k="latchFraction" min="0" max="100" value="' + (cur.latchFraction || 0) + '"><span class="fi-param-val">' + (cur.latchFraction || 0) + "%</span></div>" +
        '<div class="fi-param-row"><span class="fi-param-label">Max RPS</span><input type="range" data-k="maxRate" min="0" max="500" step="1" value="' + (cur.maxRate || 0) + '"><span class="fi-param-val">' + (cur.maxRate > 0 ? cur.maxRate + " RPS" : "no limit") + "</span></div>" +
        '<div class="fi-param-row"><span class="fi-param-label">Delays</span><div class="fi-delay-bubbles">' + delayPills + "</div></div>" +
        fiCardPodsHTML(svc) +
        '<div class="fi-card-actions"><button class="btn btn-primary fi-btn" data-act="apply">Apply</button>' +
        '<button class="btn fi-btn" data-act="reset">Reset</button>' +
        '<button class="btn fi-btn" data-act="unlatch">Unlatch</button></div></div>';
    }).join("");
    // Don't clobber a card whose slider/input is focused.
    var focusInCards = document.activeElement && document.activeElement.closest && document.activeElement.closest(".fi-card");
    if (focusInCards) return;
    repaint("fiCards", $("#fi-cards"), html);
    wireFICards();
  }

  function wireFICards() {
    var grid = $("#fi-cards");
    if (grid._wired) return;
    grid._wired = true;
    grid.addEventListener("input", function (e) {
      var row = e.target.closest(".fi-param-row");
      var val = row && row.querySelector(".fi-param-val");
      if (val && e.target.type === "range") {
        var k = e.target.getAttribute("data-k");
        val.textContent = k === "maxRate" ? (+e.target.value > 0 ? e.target.value + " RPS" : "no limit") : e.target.value + "%";
      }
    });
    grid.addEventListener("click", function (e) {
      var card = e.target.closest(".fi-card");
      if (!card) return;
      var svc = card.getAttribute("data-svc");
      // Pod-pill selection (scopes this card's Apply/Unlatch).
      var pill = e.target.closest(".pod-pill");
      if (pill && svc) {
        var sel = state.fiCardSel[svc] || (state.fiCardSel[svc] = {});
        if (pill.hasAttribute("data-allpods")) {
          Object.keys(sel).forEach(function (k) { delete sel[k]; });
        } else {
          var ip = pill.getAttribute("data-ip");
          if (sel[ip]) delete sel[ip]; else sel[ip] = true;
        }
        state._sigs.fiCards = null;
        renderFICards();
        return;
      }
      // Delay bubble toggle (per-card)
      var dpill = e.target.closest("[data-card-delay]");
      if (dpill && svc) {
        var ms = Number(dpill.getAttribute("data-card-delay"));
        var cd = state.fiCardDelays[svc] || (state.fiCardDelays[svc] = {});
        if (cd[ms]) delete cd[ms]; else cd[ms] = true;
        dpill.classList.toggle("active", !!cd[ms]);
        return;
      }
      var btn = e.target.closest("[data-act]"); if (!btn || !svc) return;
      var act = btn.getAttribute("data-act");
      var ips = fiCardSelectedIPs(svc);
      var targets = ips.length ? (function (m) { m[svc] = ips; return m; })({}) : null;
      if (act === "reset") {
        delete state.fiCardDelays[svc];
        applyChaosToServices([svc], { errorFraction: 0, latchFraction: 0, maxRate: 0, delayBuckets: [], forceUnlatch: true }, null);
      } else if (act === "unlatch") {
        applyChaosToServices([svc], { forceUnlatch: true }, targets);
      } else {
        var body = {};
        $all("[data-k]", card).forEach(function (inp) {
          var k = inp.getAttribute("data-k");
          if (k === "maxRate") body[k] = Math.max(0, +inp.value || 0);
          else body[k] = Math.max(0, Math.min(100, +inp.value || 0));
        });
        var cd2 = state.fiCardDelays[svc] || {};
        body.delayBuckets = Object.keys(cd2).filter(function (k) { return cd2[k]; }).map(Number).sort(function (a, b) { return a - b; });
        delete state.fiCardDelays[svc];   // re-sync from fresh chaos after apply
        applyChaosToServices([svc], body, targets);
      }
    });
  }

  // ----------------------------------------------------------- scenarios

  function renderFIScenarios() {
    var quick = [
      { lbl: "Recover All", cls: "scn-green", fn: scenarioRecoverAll },
      { lbl: "Smiley Errors", cls: "scn-red", svc: ["smiley"], body: { errorFraction: 50 } },
      { lbl: "Color Latency", cls: "scn-yellow", svc: ["color"], body: { delayBuckets: [500, 1000] } },
      { lbl: "Rate Limit", cls: "scn-yellow", svc: chaosServices(), body: { maxRate: 2 } },
      { lbl: "Latch Smiley", cls: "scn-red", svc: ["smiley"], body: { errorFraction: 30, latchFraction: 100 } },
    ];
    var quickHTML = quick.map(function (s, i) {
      return '<button class="scenario-btn ' + s.cls + '" data-quick="' + i + '">' + esc(s.lbl) + "</button>";
    }).join("");
    var rows = '<div class="scenario-bar"><span class="scenario-label">Quick Faults</span>' + quickHTML + "</div>";

    // Dynamic zone/node/ext rows from topology
    var groups = buildTopologyGroups(state.lastInfra);
    var scopeRows = [
      { title: "Zone", scope: "zone", filter: "🌐 Cloud" },
      { title: "Node", scope: "node", filter: "🖥️ Nodes" },
      { title: "Ext Workload", scope: "node", filter: "🔗 External Workloads" },
    ];
    scopeRows.forEach(function (sr) {
      var g = groups.filter(function (x) { return x.title === sr.filter; })[0];
      if (!g || !g.cards.length) return;
      var outage = g.cards.map(function (c) {
        var d = sr.scope === "zone" ? c.zone : (c.node || c.label);
        return '<button class="scenario-btn scn-red" data-scope="' + sr.scope + '" data-detail="' + esc(d) + '" data-label="' + esc(c.label) + '" data-kind="outage">' + esc(c.label) + "</button>";
      }).join("");
      var latency = g.cards.map(function (c) {
        var d = sr.scope === "zone" ? c.zone : (c.node || c.label);
        return '<button class="scenario-btn scn-yellow" data-scope="' + sr.scope + '" data-detail="' + esc(d) + '" data-label="' + esc(c.label) + '" data-kind="latency">' + esc(c.label) + "</button>";
      }).join("");
      rows += '<div class="scenario-bar"><span class="scenario-label">' + esc(sr.title) + " Outage</span>" + outage + "</div>";
      rows += '<div class="scenario-bar"><span class="scenario-label">' + esc(sr.title) + " Latency</span>" + latency + "</div>";
    });

    repaint("fiScen", $("#fi-scenarios"), rows);
    var panel = $("#fi-scenarios");
    if (!panel._wired) {
      panel._wired = true;
      panel.addEventListener("click", function (e) {
        var b = e.target.closest(".scenario-btn"); if (!b) return;
        if (b.hasAttribute("data-quick")) {
          var s = quick[+b.getAttribute("data-quick")];
          if (s.fn) s.fn();
          else applyChaosToServices(s.svc, fullChaosBody(s.body), null);
          return;
        }
        // zone/node scoped scenario
        var scope = b.getAttribute("data-scope"), detail = b.getAttribute("data-detail"), kind = b.getAttribute("data-kind");
        var savedScope = state.fi.scope, savedDetail = state.fi.detail;
        state.fi.scope = scope; state.fi.detail = detail;
        var targets = resolveScopeTargets();
        state.fi.scope = savedScope; state.fi.detail = savedDetail;
        var body = kind === "outage" ? fullChaosBody({ errorFraction: 100 }) : fullChaosBody({ delayBuckets: [1000, 2000] });
        applyChaosToServices(chaosServices(), body, targets);
      });
    }
  }

  function fullChaosBody(partial) {
    // Always include delayBuckets so a non-latency scenario clears stale delays.
    var b = { errorFraction: 0, latchFraction: 0, maxRate: 0, delayBuckets: [] };
    Object.keys(partial).forEach(function (k) { b[k] = partial[k]; });
    return b;
  }

  function scenarioRecoverAll() {
    var body = { errorFraction: 0, latchFraction: 0, maxRate: 0, delayBuckets: [], forceUnlatch: true };
    applyChaosToServices(chaosServices(), body, null);
  }

  // ================================================================ DEBUG (request log + HAR)

  var HTTP_STATUS_TEXT = {
    200: "OK", 201: "Created", 204: "No Content", 303: "See Other",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway",
    503: "Service Unavailable", 504: "Gateway Timeout", 599: "Latched Error",
  };

  function dbgFiltered() {
    var f = state.debug.filter.toLowerCase();
    var list = state.debug.entries;
    if (!f) return list;
    return list.filter(function (e) { return (e.method + " " + e.path).toLowerCase().indexOf(f) >= 0; });
  }

  function renderDebug() {
    var d = state.debug;
    var entries = dbgFiltered();
    var done = entries.filter(function (e) { return !e.pending; });
    var errs = done.filter(function (e) { return e.status === 0 || e.status >= 400; }).length;
    var avg = done.length ? Math.round(done.reduce(function (a, e) { return a + (e.durationMs || 0); }, 0) / done.length) : 0;
    $("#dbg-stats").textContent = entries.length + " request(s) · " + errs + " error(s) · avg " + avg + " ms" +
      (d.paused ? " · recording paused" : "");
    $("#dbg-pause").textContent = d.paused ? "Resume" : "Pause";

    var rows = entries.slice().reverse().slice(0, 300).map(function (e) {
      var st = e.pending ? "…" : (e.status || 0);
      var cls = e.pending ? "" : "dbg-status s" + String(Math.floor((e.status || 0) / 100));
      var t = e.startedISO.slice(11, 19);
      return '<tr data-id="' + e.id + '"' + (d.sel === e.id ? ' class="sel"' : "") + ">" +
        "<td>" + t + "</td><td>" + esc(e.method) + '</td><td class="dbg-path" title="' + esc(e.path) + '">' + esc(e.path) + "</td>" +
        '<td class="' + cls + '">' + st + "</td><td>" + (e.durationMs != null ? e.durationMs : "") + "</td></tr>";
    }).join("");
    repaint("dbgRows", $("#dbg-tbody"), rows || '<tr><td colspan="5" class="pod-empty" style="padding:10px">No requests recorded' + (state.debug.filter ? " (filter active)" : "") + ".</td></tr>");
    renderDebugDetail();
  }

  function renderDebugDetail() {
    var node = $("#dbg-detail");
    var e = null;
    state.debug.entries.forEach(function (x) { if (x.id === state.debug.sel) e = x; });
    if (!e) { repaint("dbgDetail", node, '<div class="pod-empty">Select a request to inspect it.</div>'); return; }
    function pretty(s) {
      if (s == null || s === "") return "(empty)";
      try { return JSON.stringify(JSON.parse(s), null, 2); } catch (x) { return String(s).slice(0, 6000); }
    }
    var hdrs = e.respHeaders ? Object.keys(e.respHeaders).sort().map(function (k) {
      return esc(k) + ": " + esc(String(e.respHeaders[k]));
    }).join("\n") : "(not captured)";
    var html =
      "<h4>Request</h4>" +
      '<div class="dbg-meta">' + esc(e.method) + " " + esc(e.url) + "<br>" + esc(e.startedISO) +
      (e.durationMs != null ? " · " + e.durationMs + " ms" : "") + "</div>" +
      (e.reqBody ? "<h4>Request body</h4><pre>" + esc(pretty(e.reqBody)) + "</pre>" : "") +
      "<h4>Response</h4>" +
      '<div class="dbg-meta">' + (e.pending ? "pending…" : (e.status + " " + (HTTP_STATUS_TEXT[e.status] || ""))) +
      (e.error ? " · " + esc(e.error) : "") + "</div>" +
      "<h4>Response headers</h4><pre>" + hdrs + "</pre>" +
      "<h4>Response body</h4><pre>" + esc(pretty(e.respBody)) + "</pre>";
    repaint("dbgDetail", node, html);
  }

  // HAR 1.2 export of every completed recorded request. Importable into Chrome
  // DevTools (Network → import), Charles, Proxyman, etc.
  function buildHAR() {
    var entries = state.debug.entries.filter(function (e) { return !e.pending; }).map(function (e) {
      var reqHeaders = [];
      if (e.reqBody) reqHeaders.push({ name: "Content-Type", value: "application/json" });
      var respHeaders = Object.keys(e.respHeaders || {}).map(function (k) {
        return { name: k, value: String(e.respHeaders[k]) };
      });
      var qs = [];
      var qi = e.path.indexOf("?");
      if (qi >= 0) {
        e.path.slice(qi + 1).split("&").forEach(function (kv) {
          if (!kv) return;
          var p = kv.split("=");
          try { qs.push({ name: decodeURIComponent(p[0] || ""), value: decodeURIComponent(p[1] || "") }); }
          catch (x) { qs.push({ name: p[0] || "", value: p[1] || "" }); }
        });
      }
      var bodyLen = e.respBody ? e.respBody.length : 0;
      var entry = {
        startedDateTime: e.startedISO,
        time: e.durationMs || 0,
        request: {
          method: e.method, url: e.url, httpVersion: "HTTP/1.1",
          cookies: [], headers: reqHeaders, queryString: qs,
          headersSize: -1, bodySize: e.reqBody ? e.reqBody.length : 0,
        },
        response: {
          status: e.status || 0, statusText: HTTP_STATUS_TEXT[e.status] || "",
          httpVersion: "HTTP/1.1", cookies: [], headers: respHeaders,
          content: { size: bodyLen, mimeType: e.contentType || "application/json", text: e.respBody || "" },
          redirectURL: "", headersSize: -1, bodySize: bodyLen,
        },
        cache: {},
        timings: { send: 0, wait: e.durationMs || 0, receive: 0 },
      };
      if (e.reqBody) entry.request.postData = { mimeType: "application/json", text: e.reqBody };
      if (e.error) entry.comment = "transport error: " + e.error;
      return entry;
    });
    return {
      log: {
        version: "1.2",
        creator: { name: "Faces Admin (Mac app)", version: "1.0" },
        pages: [],
        entries: entries,
      },
    };
  }

  function downloadHAR() {
    var done = state.debug.entries.filter(function (e) { return !e.pending; }).length;
    if (!done) { showToast("Nothing recorded yet.", "warn"); return; }
    var har = JSON.stringify(buildHAR(), null, 2);
    var fname = "faces-admin-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".har";
    if (HAS_BRIDGE && window.webkit.messageHandlers.adminSaveFile) {
      window.webkit.messageHandlers.adminSaveFile.postMessage({ filename: fname, content: har }).then(function (r) {
        if (r && r.ok) showToast("Saved " + (r.path || fname) + " (" + done + " request(s))", "success");
        else if (r && r.error && r.error !== "cancelled") showToast("Save failed: " + r.error, "error");
      }).catch(function () { showToast("Save failed", "error"); });
    } else {
      var blob = new Blob([har], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); if (a.parentNode) a.parentNode.removeChild(a); }, 800);
      showToast("Downloading " + fname + " (" + done + " request(s))", "success");
    }
  }

  function wireDebug() {
    $("#dbg-pause").addEventListener("click", function () {
      state.debug.paused = !state.debug.paused;
      renderDebug();
    });
    $("#dbg-clear").addEventListener("click", function () {
      state.debug.entries = []; state.debug.sel = null;
      state._sigs.dbgRows = state._sigs.dbgDetail = null;
      renderDebug();
    });
    $("#dbg-har").addEventListener("click", downloadHAR);
    $("#dbg-filter").addEventListener("input", function () {
      state.debug.filter = $("#dbg-filter").value.trim();
      renderDebug();
    });
    $("#dbg-tbody").addEventListener("click", function (e) {
      var tr = e.target.closest("tr[data-id]"); if (!tr) return;
      state.debug.sel = +tr.getAttribute("data-id");
      state._sigs.dbgRows = null;
      renderDebug();
    });
  }

  // ================================================================ SETTINGS

  function renderSettings() {
    renderMaintenance();
    renderServiceEndpoints();
    renderActiveConfig();
    renderEmojivotoSettings();
    renderDebugPageToggle();
  }

  function renderAdminConnection() {
    var sec = $("#set-conn-section");
    if (!HAS_BRIDGE) { sec.style.display = "none"; return; }
    sec.style.display = "block";
    var html = '<div class="set-card"><div class="conn-row">' +
      '<input class="text-input mono" id="conn-endpoint" type="text" value="' + esc(state.endpoint) + '" placeholder="host:8888 or http://host">' +
      '<button class="btn btn-primary" id="conn-save">Connect</button></div>' +
      '<div class="conn-note">The faces-admin service endpoint. http:// is assumed. Changes apply immediately.</div></div>';
    repaint("setConn", $("#set-conn"), html);
    if (!$("#set-conn")._wired) {
      $("#set-conn")._wired = true;
      $("#set-conn").addEventListener("click", function (e) {
        if (e.target.id !== "conn-save") return;
        var v = $("#conn-endpoint").value.trim();
        persistPrefs({ endpoint: v }); state.endpoint = v;
        updateEndpointLabel(); state._sigs = {}; pollAll();
        showToast("Endpoint updated", "success");
      });
    }
  }

  function renderMaintenance() {
    var sec = $("#set-maint-section");
    if (state.mode !== "pubsub") { sec.style.display = "none"; return; }
    sec.style.display = "block";
    var html =
      '<div class="maint-card"><div class="maint-card-head">&#x1F5C4; MySQL</div>' +
      '<div class="maint-stat" id="db-stat">Checking…</div>' +
      '<div class="maint-btn-row">' +
      '<button class="maint-btn" data-act="db-test" data-tooltip="Ping MySQL and read the 3-state counts">Test Connection</button>' +
      '<button class="maint-btn primary" data-act="db-migrate" data-tooltip="Idempotent schema migration (CREATE TABLE + ENUM)">Run Migration</button>' +
      '<button class="maint-btn danger" data-act="db-purge" data-tooltip="Delete all face_queue rows (leaves the table demo-ready)">Purge DB</button>' +
      "</div></div>" +
      '<div class="maint-card"><div class="maint-card-head">&#x1F4E6; Queue</div>' +
      '<div class="maint-stat">RabbitMQ management UI: <b>faces / faces-password</b></div>' +
      '<div class="maint-cmd">kubectl port-forward svc/rabbitmq 15672:15672</div>' +
      '<div class="maint-btn-row">' +
      '<button class="maint-btn" data-act="q-warm" data-tooltip="Re-push pending+queued MySQL rows into the queue">Re-warm Queue</button>' +
      '<button class="maint-btn danger" data-act="q-purge" data-tooltip="Remove all in-flight messages from the queue backend">Purge Queue</button>' +
      "</div></div>";
    repaint("setMaint", $("#set-maint"), html);
    if (!$("#set-maint")._wired) {
      $("#set-maint")._wired = true;
      $("#set-maint").addEventListener("click", onMaintClick);
    }
    loadDBStatus();
  }

  function loadDBStatus() {
    fetchJSON("GET", "/api/maintenance/db/status").then(function (r) {
      var node = $("#db-stat"); if (!node) return;
      if (r.ok && r.data && r.data.connected) {
        node.innerHTML = "Connected · " + (r.data.latencyMs || 0) + " ms · pending <b>" + (r.data.pending || 0) +
          "</b> queued <b>" + (r.data.queued || 0) + "</b> acked <b>" + (r.data.acknowledged || 0) + "</b>";
      } else { node.textContent = "Not connected"; }
    });
  }

  function onMaintClick(e) {
    var btn = e.target.closest("[data-act]"); if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "db-test") { loadDBStatus(); showToast("Testing MySQL…"); }
    else if (act === "db-migrate") { fetchJSON("POST", "/api/maintenance/db/migrate").then(function (r) { showToast(r.ok ? "Migration complete" : "Migration failed", r.ok ? "success" : "error"); loadDBStatus(); }); }
    else if (act === "db-purge") {
      confirmModal("Purge MySQL?", "This deletes all face_queue rows and resets the counters. The table is left demo-ready.", true).then(function (ok) {
        if (!ok) return;
        fetchJSON("POST", "/api/maintenance/db/purge").then(function (r) {
          showToast(r.ok ? ((r.data && r.data.message) || "Purged") : "Purge failed", r.ok ? "success" : "error"); loadDBStatus();
        });
      });
    } else if (act === "q-warm") {
      fetchJSON("PUT", "/api/controls/publisher", { warm: true }).then(function (r) { showToast(r.ok ? "Re-warming queue" : "Failed", r.ok ? "success" : "error"); });
    } else if (act === "q-purge") {
      confirmModal("Purge Queue?", "This removes all in-flight messages from the queue backend. MySQL rows are not touched.", true).then(function (ok) {
        if (!ok) return;
        fetchJSON("POST", "/api/maintenance/queue/purge").then(function (r) { showToast(r.ok ? "Queue purged" : "Failed", r.ok ? "success" : "error"); });
      });
    }
  }

  var EP_FIELDS = [
    { k: "smileyURL", lbl: "Smiley" }, { k: "colorURL", lbl: "Color" },
    { k: "faceURL", lbl: "Face" }, { k: "guiURL", lbl: "GUI" },
    { k: "publisherURL", lbl: "Publisher" }, { k: "subscriberURL", lbl: "Subscriber" },
  ];

  function renderServiceEndpoints() {
    var cfg = state.config || {};
    var rows = EP_FIELDS.map(function (f) {
      var cur = state.ep[f.k] != null ? state.ep[f.k] : (cfg[f.k] || "");
      var modified = state.ep[f.k] != null && state.ep[f.k] !== (cfg[f.k] || "");
      return '<div class="ep-row' + (modified ? " modified" : "") + '" data-k="' + f.k + '">' +
        '<span class="ep-label">' + esc(f.lbl) + '</span><input class="text-input mono" type="text" value="' + esc(cur) + '">' +
        '<span class="ep-badge">modified</span></div>';
    }).join("");
    var html = '<div class="set-card">' + rows +
      '<div class="set-actions"><button class="btn btn-primary" id="ep-save">Save Changes</button>' +
      '<button class="btn" id="ep-reset">Reset to Defaults</button></div></div>';
    var focusInEp = document.activeElement && document.activeElement.closest && document.activeElement.closest("#set-endpoints");
    if (focusInEp) return;
    repaint("setEp", $("#set-endpoints"), html);
    if (!$("#set-endpoints")._wired) {
      $("#set-endpoints")._wired = true;
      $("#set-endpoints").addEventListener("input", function (e) {
        var row = e.target.closest(".ep-row"); if (!row) return;
        var k = row.getAttribute("data-k"); state.ep[k] = e.target.value;
        var cfg2 = state.config || {};
        row.classList.toggle("modified", state.ep[k] !== (cfg2[k] || ""));
      });
      $("#set-endpoints").addEventListener("click", function (e) {
        if (e.target.id === "ep-save") {
          var body = {}; Object.keys(state.ep).forEach(function (k) { body[k] = state.ep[k]; });
          fetchJSON("PUT", "/api/config", body).then(function (r) { showToast(r.ok ? "Endpoints saved" : "Save failed", r.ok ? "success" : "error"); state.ep = {}; state._sigs.setEp = null; pollMain(); });
        } else if (e.target.id === "ep-reset") {
          fetchJSON("PUT", "/api/config", {}).then(function (r) { showToast(r.ok ? "Endpoints reset" : "Reset failed", r.ok ? "success" : "error"); state.ep = {}; state._sigs.setEp = null; pollMain(); });
        }
      });
    }
  }

  function renderActiveConfig() {
    var cfg = state.config || {};
    var modeToggle =
      '<label class="evoto-toggle-row" style="margin-bottom:10px"><input type="checkbox" id="mode-auto-detect"' + (state.modeAutoDetect ? " checked" : "") + '> Auto-detect mode from server <span style="color:var(--text-muted);font-size:11px">(reads <code>/api/config</code>)</span></label>' +
      '<div class="mode-toggle-row"><span class="mode-toggle-label">Admin display mode:</span>' +
      '<div class="target-toggle" id="mode-toggle">' +
      '<button class="toggle-btn' + (state.mode === "classic" ? " active" : "") + '" data-mode="classic">Classic</button>' +
      '<button class="toggle-btn' + (state.mode === "pubsub" ? " active" : "") + '" data-mode="pubsub">Pub·Sub</button></div></div>';
    var rowKeys = ["faceMode", "queueBackend", "namespace", "k8sAvailable", "linkerdMeshed", "authEnabled",
                   "smileyURL", "colorURL", "faceURL", "guiURL", "publisherURL", "subscriberURL", "maxDepth"];
    var rows = rowKeys.filter(function (k) { return cfg[k] != null; }).map(function (k) {
      return "<tr><td>" + esc(k) + "</td><td>" + esc(String(cfg[k])) + "</td></tr>";
    }).join("");
    var html = modeToggle + '<table class="cfg-table">' + rows + "</table>";
    repaint("setCfg", $("#set-config"), html);
    if (!$("#set-config")._wired) {
      $("#set-config")._wired = true;
      $("#set-config").addEventListener("change", function (e) {
        if (e.target.id !== "mode-auto-detect") return;
        state.modeAutoDetect = e.target.checked;
        safeLSSet("faces-admin-mode-auto", state.modeAutoDetect ? "1" : "0");
        if (state.modeAutoDetect) {
          // immediately apply the server's mode if we have it
          var fm = state.config && state.config.faceMode;
          if (fm === "classic" || fm === "pubsub") {
            state.mode = fm;
            state._sigs = {};
            pollMain();
          }
        }
      });
      $("#set-config").addEventListener("click", function (e) {
        var b = e.target.closest(".toggle-btn[data-mode]"); if (!b) return;
        var m = b.getAttribute("data-mode");
        fetchJSON("PUT", "/api/config", { faceMode: m }).then(function (r) {
          showToast(r.ok ? "Mode set to " + m : "Mode change failed", r.ok ? "success" : "error");
          state._sigs = {}; pollMain(); pollInfra();
        });
      });
    }
  }

  // ================================================================ SETTINGS — Emojivoto integration

  var evotoState = { config: null, pods: [], selPods: {}, loaded: false };

  function loadEvotoState() {
    if (evotoState.loaded) return;
    evotoState.loaded = true;
    fetchJSON("GET", "/api/emojivoto").then(function (r) {
      if (r.ok && r.data) {
        evotoState.config = r.data;
        evotoState.selPods = {};
        (r.data.selectedPods || []).forEach(function (ip) { evotoState.selPods[ip] = true; });
        state._sigs.evotoSec = null;
        if (state.page === "settings") renderEmojivotoSettings();
      }
    });
    fetchJSON("GET", "/api/smileypods").then(function (r) {
      if (r.ok && Array.isArray(r.data)) {
        evotoState.pods = r.data.slice().sort(sortPods);
        state._sigs.evotoSec = null;
        if (state.page === "settings") renderEmojivotoSettings();
      }
    });
  }

  function renderEmojivotoSettings() {
    var el = $("#set-emojivoto");
    if (!el) return;
    loadEvotoState();
    var c = evotoState.config || {};
    var status = c.status || "unconfigured";
    var statusCls = status === "ok" ? " dot-green" : (status === "error" ? " dot-red" : "");

    // Pod pills
    var allActive = !Object.keys(evotoState.selPods).some(function (k) { return evotoState.selPods[k]; });
    var podHtml = '<span class="pod-pill' + (allActive ? " active" : "") + '" data-evoto-all="1">All pods</span>';
    evotoState.pods.forEach(function (p) {
      podHtml += '<span class="pod-pill' + (evotoState.selPods[p.ip] ? " active" : "") + '" data-evoto-ip="' + esc(p.ip) + '" data-tooltip="' + esc(infraPodTip(p)) + '">' + esc(podShortName(p)) + "</span>";
    });

    // Leaderboard
    var lbHtml = "";
    if (Array.isArray(c.leaderboard) && c.leaderboard.length) {
      lbHtml = '<div class="evoto-lb"><div class="evoto-lb-head">Leaderboard</div>';
      c.leaderboard.slice(0, 8).forEach(function (row, i) {
        var emoji = decodeEntity(row.unicode || "");
        lbHtml += '<div class="evoto-lb-row' + (i === 0 ? " evoto-lb-winner" : "") + '">' +
          '<span class="evoto-lb-rank">' + (i + 1) + ".</span>" +
          '<span class="evoto-lb-emoji">' + esc(emoji) + "</span>" +
          '<span class="evoto-lb-name">' + esc(row.shortcode || "") + "</span>" +
          '<span class="evoto-lb-votes">' + esc(String(row.votes || "")) + " votes</span></div>";
      });
      lbHtml += "</div>";
    }

    var html = '<div class="set-card">' +
      '<div class="evoto-status-bar"><span class="infra-state-dot' + statusCls + '"></span> ' +
      '<b>' + esc(status) + "</b>" +
      (c.leader ? " &nbsp;&#x2022;&nbsp; Leader: <b>" + esc(decodeEntity(c.leader)) + "</b>" : "") +
      (c.error ? ' &mdash; <span class="evoto-err-msg">' + esc(c.error) + "</span>" : "") + "</div>" +

      '<div class="ep-row"><span class="ep-label">Endpoint</span>' +
      '<input class="text-input mono" id="evoto-endpoint" type="text" value="' + esc(c.endpoint || "http://web-svc.emojivoto:80") +
      '" placeholder="http://web-svc.emojivoto:80"></div>' +

      '<div class="evoto-toggles">' +
      '<label class="evoto-toggle-row"><input type="checkbox" id="evoto-enabled"' + (c.enabled ? " checked" : "") +
      '> Enable integration</label>' +
      '<label class="evoto-toggle-row"><input type="checkbox" id="evoto-smileys"' + (c.updateSmileys ? " checked" : "") +
      '> Push leading emoji to smiley pods automatically</label>' +
      "</div>" +

      '<div class="evoto-pods"><div class="evoto-pods-label">Target smiley pods</div>' +
      '<div class="pod-pills">' + podHtml + "</div></div>" +

      lbHtml +

      '<div class="set-actions">' +
      '<button class="btn btn-primary" id="evoto-save">Save</button>' +
      '<button class="btn" id="evoto-refresh" data-tooltip="Reload integration state from the server">Refresh</button>' +
      "</div></div>";

    repaint("evotoSec", el, html);
    wireEvotoSettings();
  }

  function wireEvotoSettings() {
    var el = $("#set-emojivoto");
    if (!el || el._wired) return;
    el._wired = true;
    el.addEventListener("click", function (e) {
      if (e.target.id === "evoto-refresh") {
        evotoState.loaded = false; evotoState.config = null;
        state._sigs.evotoSec = null;
        renderEmojivotoSettings();
      } else if (e.target.id === "evoto-save") {
        var ep = ($("#evoto-endpoint") || {}).value || "";
        var enabled = !!($("#evoto-enabled") || {}).checked;
        var updateSmileys = !!($("#evoto-smileys") || {}).checked;
        var selPods = Object.keys(evotoState.selPods).filter(function (ip) { return evotoState.selPods[ip]; });
        var body = { endpoint: ep, enabled: enabled, updateSmileys: updateSmileys };
        if (selPods.length) body.selectedPods = selPods;
        fetchJSON("PUT", "/api/emojivoto", body).then(function (r) {
          var ok = r.ok;
          showToast(ok ? "Emojivoto settings saved" : ("Save failed: " + ((r.data && r.data.error) || "unknown")), ok ? "success" : "error");
          if (ok) { evotoState.loaded = false; evotoState.config = null; state._sigs.evotoSec = null; loadEvotoState(); }
        });
      } else if (e.target.hasAttribute("data-evoto-all")) {
        evotoState.selPods = {};
        state._sigs.evotoSec = null; renderEmojivotoSettings();
      } else if (e.target.hasAttribute("data-evoto-ip")) {
        var ip = e.target.getAttribute("data-evoto-ip");
        if (evotoState.selPods[ip]) delete evotoState.selPods[ip]; else evotoState.selPods[ip] = true;
        state._sigs.evotoSec = null; renderEmojivotoSettings();
      }
    });
  }

  // ================================================================ SETTINGS — Debug page toggle

  function renderDebugPageToggle() {
    var el = $("#set-debug-toggle");
    if (!el) return;
    var html = '<div class="set-card"><div class="evoto-toggles">' +
      '<label class="evoto-toggle-row"><input type="checkbox" id="debug-page-toggle"' + (state.showDebugPage ? " checked" : "") +
      '> Show Request Log &amp; HAR export page in the sidebar</label>' +
      '<div class="conn-note">When enabled, the Debug page records every admin API request and lets you export a HAR file for offline analysis.</div>' +
      "</div></div>";
    repaint("debugToggle", el, html);
    if (!el._wired) {
      el._wired = true;
      el.addEventListener("change", function (e) {
        if (e.target.id !== "debug-page-toggle") return;
        state.showDebugPage = e.target.checked;
        persistPrefs({ showDebugPage: state.showDebugPage });
        applyDebugPageVisibility();
      });
    }
  }

  // ================================================================ native hooks

  // Exposed for scripting/tests: returns the HAR object for everything recorded.
  window.__adminBuildHAR__ = function () { return buildHAR(); };

  window.__adminSetActive__ = function (on) {
    state.active = !!on;
    if (state.active) { applyTheme(); pollAll(); }
    else stopPolling();
  };
  window.__adminApplyNativeSettings__ = function (s) {
    if (!s) return;
    if (s.endpoint != null) { state.endpoint = s.endpoint; updateEndpointLabel(); }
    if (s.theme != null) { state.theme = s.theme; applyTheme(); }
    if (s.username != null || s.password != null) {
      if (s.username != null) state.cred.user = s.username;
      if (s.password != null) state.cred.pass = s.password;
      state._autoFailedSig = null;   // new creds → allow another auto attempt
      if (state.authRequired && state.cred.user && state.cred.pass) {
        setAuthRequired(false);      // hide the card; handleUnauthorized re-shows on failure
        handleUnauthorized();
        return;
      }
    }
    state._sigs = {};
    if ($("#connect-overlay").style.display !== "none" && state.endpoint) $("#connect-overlay").style.display = "none";
    pollAll();
  };

  document.addEventListener("visibilitychange", function () {
    if (HAS_BRIDGE) return;
    if (document.hidden) stopPolling(); else startPolling();
  });

  // ================================================================ init

  function init() {
    applyTheme();
    applyCollapse();
    applyDebugPageVisibility();
    wireChrome();
    initTooltips();
    wireDebug();
    updateEndpointLabel();
    wirePodSelector("smiley-pods", state.sel.smileyPods);
    wirePodSelector("color-pods", state.sel.colorPods);
    if (location.hash) { var p = location.hash.replace("#", ""); if ($("#page-" + p)) state.page = p; }
    setPage(state.page);
    pollAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

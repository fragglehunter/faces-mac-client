// debug.js — in-app Network debug panel + pop-out window support.
//
// Features:
//   - Overview bar: total requests, success rate, avg latency, req/s, pod count
//   - Request table (last 200, sortable by click)
//   - Selected request detail (JSON)
//   - Pop Out: serializes data → sends to Swift → opens in a separate NSPanel
//
// window.__showFacesDebug__()   → show
// window.__hideFacesDebug__()   → hide
// window.__openDebugWindow__()  → pop-out to native panel

(function () {
  "use strict";

  var root, tbody, detail, summaryEl, overviewEl, pauseBtn;
  var paused = false;
  var pendingRender = false;

  function ensure() {
    if (root) return;
    root = document.createElement("div");
    root.className = "debug-panel";
    root.innerHTML =
      '<div class="debug-header">' +
        '<div>' +
          '<strong>Network Debug</strong>' +
          '<span class="debug-summary"></span>' +
        '</div>' +
        '<div class="debug-actions">' +
          '<button type="button" data-action="popout" title="Open in separate window">⬡ Pop Out</button>' +
          '<button type="button" data-action="pause">Pause</button>' +
          '<button type="button" data-action="clear">Clear</button>' +
          '<button type="button" data-action="close">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="debug-overview"></div>' +
      '<div class="debug-body">' +
        '<table>' +
          '<thead><tr><th>#</th><th>cell</th><th>edge/ctr</th><th>status</th><th>ms</th><th>pod</th></tr></thead>' +
          '<tbody></tbody>' +
        '</table>' +
        '<pre class="debug-detail">Select a request to see details.</pre>' +
      '</div>';

    document.body.appendChild(root);
    tbody    = root.querySelector("tbody");
    detail   = root.querySelector(".debug-detail");
    summaryEl = root.querySelector(".debug-summary");
    overviewEl = root.querySelector(".debug-overview");
    pauseBtn = root.querySelector("[data-action='pause']");

    root.addEventListener("click", function (e) {
      var action = e.target && e.target.getAttribute && e.target.getAttribute("data-action");
      if (action === "close")  hide();
      if (action === "pause")  togglePause();
      if (action === "popout") popOut();
      if (action === "clear")  {
        if (window.__FACES_DEBUG__) window.__FACES_DEBUG__.clear();
        render();
      }
      var row = e.target.closest && e.target.closest("tr[data-id]");
      if (row) selectRow(Number(row.dataset.id));
    });
  }

  function show() {
    // In the native app: always open as a separate NSPanel (never blocks the scene).
    var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openDebugWindow;
    if (mh) {
      mh.postMessage(JSON.stringify(entries())).catch(function () {});
      return;
    }
    // Browser dev fallback: in-page overlay.
    ensure(); root.classList.add("open"); render();
  }
  function hide() { if (root) root.classList.remove("open"); }

  function togglePause() {
    paused = !paused;
    if (pauseBtn) pauseBtn.textContent = paused ? "Resume" : "Pause";
    if (!paused && pendingRender) { pendingRender = false; render(); }
  }

  function entries() {
    return (window.__FACES_DEBUG__ && window.__FACES_DEBUG__.entries) || [];
  }

  // ── Overview stats bar ──────────────────────────────────────────────────────

  function renderOverview(list) {
    if (!overviewEl) return;
    var total   = list.length;
    var ok2xx   = list.filter(function (e) { return e.status >= 200 && e.status < 300; }).length;
    var err     = list.filter(function (e) { return e.status >= 400 || e.status === 0; }).length;
    var sumLat  = 0;
    for (var i = 0; i < list.length; i++) sumLat += (list[i].latencyMs || 0);
    var avgLat  = total ? Math.round(sumLat / total) : 0;

    // Request rate: count entries in the last 10 seconds
    var now = Date.now();
    var recent = list.filter(function (e) { return now - e.ts < 10000; }).length;
    var rps = (recent / 10).toFixed(1);

    var pods = new Set();
    list.forEach(function (e) { if (e.pod) pods.add(e.pod); });

    var pct = total ? Math.round(ok2xx * 100 / total) : 0;

    overviewEl.innerHTML =
      stat(total, "total",   "") +
      stat(ok2xx + " (" + pct + "%)", "ok",   "2xx ok") +
      stat(err,   "err",    "errors") +
      stat(avgLat + "ms",   "slow",  "avg lat") +
      stat(rps + "/s",      "rate",  "req rate") +
      stat(pods.size,       "",      "pods");
  }

  function stat(val, cls, label) {
    return '<div class="debug-overview-stat' + (cls ? ' dov-' + cls : '') + '">' +
      '<span class="dov-val">' + val + '</span>' +
      '<span class="dov-label">' + label + '</span>' +
      '</div>';
  }

  // ── Request table ───────────────────────────────────────────────────────────

  function render() {
    ensure();
    var list = entries();

    // Summary line
    var counts = new Map();
    for (var i = 0; i < list.length; i++) {
      var s = list[i].status;
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    summaryEl.textContent = " " + list.length + " req · " +
      Array.from(counts.entries()).map(function (kv) { return kv[0] + ":" + kv[1]; }).join(" ");

    renderOverview(list);

    // Table rows (newest first, capped at 300)
    tbody.innerHTML = "";
    var slice = list.slice(-300).reverse();
    var frag  = document.createDocumentFragment();
    for (var j = 0; j < slice.length; j++) {
      var e  = slice[j];
      var tr = document.createElement("tr");
      tr.dataset.id = e.id;
      var isOk = e.status >= 200 && e.status < 300;
      tr.innerHTML =
        "<td>" + e.id + "</td>" +
        "<td>" + (e.row != null ? e.row + "," + e.col : "–") + "</td>" +
        "<td>" + esc(e.which || "") + "</td>" +
        '<td class="' + (isOk ? "ok" : "bad") + '">' + e.status + "</td>" +
        "<td>" + (e.latencyMs || 0) + "</td>" +
        "<td>" + esc(e.pod || "") + "</td>";
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
  }

  function selectRow(id) {
    var e = entries().find(function (x) { return x.id === id; });
    if (!e) return;
    detail.textContent = JSON.stringify({
      id:             e.id,
      time:           new Date(e.ts).toISOString(),
      mode:           e.mode,
      url:            e.url,
      method:         "GET",
      cell:           { row: e.row, col: e.col, type: e.which },
      requestHeaders: e.requestHeaders || {},
      status:         e.status,
      latencyMs:      e.latencyMs,
      pod:            e.pod,
      error:          e.error,
      body:           tryJson(e.body),
    }, null, 2);
  }

  // ── Pop-out window ──────────────────────────────────────────────────────────

  function popOut() {
    var list = entries();
    var json = JSON.stringify(list);

    // 1. Try Swift bridge (preferred — opens a proper NSPanel).
    var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openDebugWindow;
    if (mh) {
      mh.postMessage(json).catch(function () {});
      hide();  // close the in-app overlay once the panel is opening
      return;
    }

    // 2. Fallback: window.open() with inline HTML (browser preview / no Swift).
    var w = window.open("", "FacesDebug", "width=960,height=640,menubar=no,toolbar=no");
    if (!w) { alert("Pop-out blocked. Allow pop-ups for this page."); return; }
    w.document.write(buildDebugWindowHTML(list));
    w.document.close();
    hide();  // close in-app overlay after opening the pop-out window
  }

  function buildDebugWindowHTML(list) {
    var rows = list.slice(-300).reverse().map(function (e) {
      var isOk = e.status >= 200 && e.status < 300;
      return '<tr>' +
        '<td>' + e.id + '</td>' +
        '<td>' + esc(e.which || "") + '</td>' +
        '<td class="' + (isOk ? "ok" : "bad") + '">' + e.status + '</td>' +
        '<td>' + (e.latencyMs || 0) + 'ms</td>' +
        '<td>' + esc(e.pod || "") + '</td>' +
        '</tr>';
    }).join("");

    return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
      '<title>Faces Debug</title>' +
      '<style>' +
        'body{font-family:-apple-system,sans-serif;margin:0;background:#1c1c1e;color:#f5f5f7;font-size:13px}' +
        'h2{margin:0;padding:12px 16px;background:#2c2c2e;font-size:15px}' +
        'table{width:100%;border-collapse:collapse}' +
        'th,td{padding:6px 10px;border-bottom:1px solid #3a3a3c;text-align:left}' +
        'th{background:#2c2c2e;position:sticky;top:0}' +
        '.ok{color:#30d158}.bad{color:#ff453a}' +
        'div.scroll{overflow:auto;height:calc(100vh - 52px)}' +
      '</style></head><body>' +
      '<h2>Faces Debug Snapshot — ' + list.length + ' requests</h2>' +
      '<div class="scroll"><table>' +
      '<thead><tr><th>#</th><th>type</th><th>status</th><th>latency</th><th>pod</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
      '</body></html>';
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function tryJson(s) {
    if (!s) return "";
    try { return JSON.parse(s); } catch (_) { return s; }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  window.__showFacesDebug__   = show;
  window.__hideFacesDebug__   = hide;
  window.__openDebugWindow__  = popOut;

  function boot() {
    var bus = window.__FACES_DEBUG__;
    if (!bus) { setTimeout(boot, 200); return; }
    bus.subscribe(function () {
      if (!root || !root.classList.contains("open")) return;
      if (paused) { pendingRender = true; return; }
      render();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

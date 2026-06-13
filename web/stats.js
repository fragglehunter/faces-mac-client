// stats.js — Unified request statistics for all non-Classic visual modes.
//
// Subscribes to window.__FACES_DEBUG__ and tallies every response outcome.
// All fun modes (Buoyant, Cavern, Space, Garden) share this data so their
// HUDs and scoreboards stay consistent and look identical.
//
// API  window.__FACES_STATS__
//   .data              — live counts object (mutated in place)
//   .subscribe(fn)     — fn(data) called on every update
//   .bumpInteraction() — record a click/pop/blast/pluck
//   .reset()           — clear all counts
//   .attachHUD(el)     — register a DOM element to auto-render stats into
//   .tier(n)           — return badge tier object for interaction count n
//   .TIERS             — badge tier definitions array

(function () {
  "use strict";

  var d = {
    total:        0,
    success:      0,  // clean 200 (valid color + emoji)
    partial:      0,  // 200 but errors[] present -> purple border
    errors:       0,  // 5xx face error
    timeouts:     0,  // 504 / 429 / network error
    latched:      0,  // 599 sticky error
    slow:         0,  // latencyMs >= slowThresholdMs
    interactions: 0,  // pops / blasts / plucks across all modes
    centerTotal:   0,
    edgeTotal:     0,
    centerSuccess: 0,
    edgeSuccess:   0,
    active:        0,  // live objects currently on the active scene (set by each mode)
  };

  // Mode-supplied noun for the "active" pill ("balloons", "rockets", …).
  var activeNoun = "active";

  // Sliding window of recent request timestamps (ms) for the measured req/s pill.
  var reqTimes = [];
  var RATE_WINDOW_MS = 4000;

  var subs   = [];
  var hudEls = [];

  function slowMs() {
    return ((window.__FACES_SETTINGS__ || {}).slowThresholdMs) || 300;
  }

  function notify() {
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](d); } catch (_) {}
    }
    renderAll();
  }

  // Ingest one completed request from the debug bus.
  function ingest(entry) {
    if (!entry || entry.status === undefined) return;
    var st    = entry.status;
    var which = entry.which || "center";
    var lat   = entry.latencyMs || 0;

    d.total++;
    // Measured request rate: stamp every ingested request, prune the window.
    var nowMs = (entry.ts && Number(entry.ts)) || Date.now();
    reqTimes.push(nowMs);
    while (reqTimes.length && nowMs - reqTimes[0] > RATE_WINDOW_MS) reqTimes.shift();
    if (which === "edge") d.edgeTotal++;
    else d.centerTotal++;
    if (lat >= slowMs()) d.slow++;

    if (st === 200) {
      var hasErrors = false;
      try {
        var p = JSON.parse(entry.body || "{}");
        hasErrors = !!(p.errors && p.errors.length > 0);
      } catch (_) {}
      if (hasErrors) {
        d.partial++;
        d.errors++;
      } else {
        d.success++;
        if (which === "edge") d.edgeSuccess++;
        else d.centerSuccess++;
      }
    } else if (st === 599) {
      d.latched++;
      d.errors++;
    } else if (st === 429 || st === 504 || st === 0) {
      d.timeouts++;
    } else if (st >= 500) {
      d.errors++;
    }
    notify();
  }

  // ── Interaction / badge tier system ─────────────────────────────────────
  // Shared across all fun modes so Buoyant pops + Space blasts + Garden
  // plucks + Cavern crushes all add to the same scoreboard.

  // Badge tiers climb well past 100 so heavy players keep unlocking new icons.
  var TIERS = [
    { min: 1,    emoji: "&#x1F4A5;", badge: "First hit!"   },  // 💥
    { min: 10,   emoji: "&#x1F3AF;", badge: "Sharpshooter" },  // 🎯
    { min: 25,   emoji: "&#x1F525;", badge: "On Fire"      },  // 🔥
    { min: 50,   emoji: "&#x1F3C6;", badge: "Champion"     },  // 🏆
    { min: 100,  emoji: "&#x1F451;", badge: "Legend"       },  // 👑
    { min: 200,  emoji: "&#x1F4AB;", badge: "Superstar"    },  // 💫
    { min: 350,  emoji: "&#x1F680;", badge: "Cosmic"       },  // 🚀
    { min: 500,  emoji: "&#x1F48E;", badge: "Diamond"      },  // 💎
    { min: 750,  emoji: "&#x1F525;", badge: "Inferno"      },  // 🔥 (repeats glyph, new title)
    { min: 1000, emoji: "&#x1F984;", badge: "Mythic"       },  // 🦄
    { min: 2000, emoji: "&#x1F410;", badge: "G.O.A.T."     },  // 🐐
    { min: 5000, emoji: "&#x1F308;", badge: "Transcendent" },  // 🌈
  ];

  function tier(n) {
    for (var i = TIERS.length - 1; i >= 0; i--) {
      if (n >= TIERS[i].min) return TIERS[i];
    }
    return null;
  }

  function bumpInteraction() {
    d.interactions++;
    notify();
    // Explicitly trigger score-bump animation on the score pill.
    // (notify already updated the text; fhs-in won't re-fire on existing spans.)
    hudEls.forEach(function(el) {
      var s = el.querySelector('.fhs[data-key="score"]');
      if (s) { s.classList.remove("bump"); void s.offsetWidth; s.classList.add("bump"); }
    });
  }

  function reset() {
    for (var k in d) { if (typeof d[k] === "number") d[k] = 0; }
    reqTimes.length = 0;
    notify();
  }

  // Each fun mode reports how many objects are live on its scene. Re-renders
  // only when the value actually changes (modes call this every frame).
  function setActive(count, noun) {
    count = Math.max(0, count | 0);
    noun = noun || "active";
    if (count === d.active && noun === activeNoun) return;
    d.active = count;
    activeNoun = noun;
    renderAll();
  }

  // Measured requests/sec over the sliding window (actual traffic, not the cap).
  function liveRate() {
    var nowMs = Date.now();
    while (reqTimes.length && nowMs - reqTimes[0] > RATE_WINDOW_MS) reqTimes.shift();
    if (!reqTimes.length) return 0;
    // Use the span from the oldest sample so a fresh burst reads instantly
    // instead of being divided by the full window.
    var span = Math.max(1000, nowMs - reqTimes[0]);
    return reqTimes.length / (span / 1000);
  }

  function fmtRate(r) {
    if (r <= 0) return "0/s";
    if (r < 1) return r.toFixed(1).replace(/\.0$/, "") + "/s";
    if (r >= 10) return Math.round(r) + "/s";
    return r.toFixed(1).replace(/\.0$/, "") + "/s";
  }

  // ── HUD rendering ────────────────────────────────────────────────────────

  function num(n) {
    if (n >= 10000) return Math.round(n / 1000) + "k";
    if (n >= 1000)  return (n / 1000).toFixed(1).replace(".0", "") + "k";
    return String(n);
  }

  // Mirror toolbar.js readRate/rateLabel exactly so the "max rate" pill always
  // matches the toolbar slider (same 0.5 fallback, same 0.5–20 clamp, same text).
  function rateLabel() {
    var s = window.__FACES_SETTINGS__ || {};
    var r = Number(s.funModeRatePerSec || s.buoyantRatePerSec) || 0.5;
    r = Math.max(0.5, Math.min(s.superMode ? 200 : 20, r));
    if (r < 1) return "1/" + Math.round(1 / r) + "s";
    if (r >= 10) return Math.round(r) + "/s";
    return parseFloat(r.toFixed(1)) + "/s";
  }

  // Smart HUD update — preserves existing .fhs[data-key] spans so CSS
  // animation: fhs-in only fires on FIRST appearance, not on every update.
  // innerHTML changes on the SPAN ITSELF would re-fire the span's animation;
  // instead we update innerHTML of inner children (.fhs-v / .fhs-l) only.
  function renderHUD(el) {
    if (!el) return;

    // Build ordered list of pills to display.
    var want = [];
    // Live activity on the current scene (balloons/rockets/explorers/…).
    want.push({ key:"active", cls:"fhs-active", icon:"&#x1F7E2;", val:num(d.active), lbl:activeNoun,
      title:"Objects currently live on the scene." });
    // Measured request rate — actual traffic flowing through, not the cap.
    want.push({ key:"reqs", cls:"fhs-reqs", icon:"&#x26A1;", val:fmtRate(liveRate()), lbl:"req/s",
      title:"Measured request rate — actual requests per second over the last few seconds." });
    want.push({ key:"rate", cls:"fhs-rate", icon:"&#x23F5;", val:rateLabel(), lbl:"max rate",
      title:"Scene admission rate — max events/sec visualised. Adjust via the Rate slider." });
    if (d.success > 0)
      want.push({ key:"ok", cls:"fhs-ok", icon:"&#x2705;", val:num(d.success), lbl:"ok",
        title:"Successes (HTTP 200, valid color + emoji). Both face and sub-services answered correctly." });
    if (d.partial > 0)
      want.push({ key:"partial", cls:"fhs-partial", icon:"&#x26A0;&#xFE0F;", val:num(d.partial), lbl:"partial",
        title:"Partial — face answered 200 but a sub-service (smiley or color) failed. Shows purple border in scene." });
    if (d.errors > 0)
      want.push({ key:"err", cls:"fhs-err", icon:"&#x274C;", val:num(d.errors), lbl:"errors",
        title:"Face service errors (HTTP 5xx or parse failure). Trigger via Simulator → Face → Errors %." });
    if (d.timeouts > 0)
      want.push({ key:"timeout", cls:"fhs-timeout", icon:"&#x23F1;&#xFE0F;", val:num(d.timeouts), lbl:"timeout",
        title:"Timeouts or rate-limits (HTTP 504 or 429). Trigger via Simulator → Max RPS or high Delay." });
    if (d.latched > 0)
      want.push({ key:"latch", cls:"fhs-latch", icon:"&#x1F534;", val:num(d.latched), lbl:"latched",
        title:"Latched 599 errors — sticky failure that auto-clears after 30 s idle. Trigger via Simulator → Latch %." });
    if (d.slow > 0)
      want.push({ key:"slow", cls:"fhs-slow", icon:"&#x1F422;", val:num(d.slow), lbl:"slow",
        title:"Slow responses (≥" + slowMs() + " ms). Shown as walkers/slow objects. Trigger via Simulator → Delay." });
    if (d.interactions > 0) {
      var t = tier(d.interactions);
      want.push({ key:"score", cls:"fhs-score", icon: t ? t.emoji : "&#x1F4A5;", val:num(d.interactions), lbl:"score",
        title:"Your score! Click balloons, rockets, explorers, or flowers to score points. Badge upgrades at: " +
          TIERS.map(function (x) { return x.min; }).join(", ") + "." });
    }

    // Index current pill spans by data-key.
    var cur = {};
    var spans = el.querySelectorAll(".fhs[data-key]");
    for (var i = 0; i < spans.length; i++) cur[spans[i].getAttribute("data-key")] = spans[i];

    // Remove pills that are no longer needed.
    var wantKeys = {};
    want.forEach(function(p) { wantKeys[p.key] = true; });
    for (var k in cur) { if (!wantKeys[k]) { cur[k].remove(); delete cur[k]; } }

    // Upsert — NEW pills are appended once (fhs-in fires); EXISTING pills are
    // updated in-place with no DOM position change. Calling appendChild on an
    // existing child, even when order is unchanged, is a DOM mutation that
    // triggers a browser repaint — at high request rates that repaint is
    // visible as a constant pulse. Never moving existing nodes kills the flash.
    want.forEach(function(p) {
      var span = cur[p.key];
      if (!span) {
        // First appearance — create, build, append; fhs-in animation fires once.
        span = document.createElement("span");
        span.className = "fhs " + p.cls;
        span.setAttribute("data-key", p.key);
        span.setAttribute("title", p.title);
        span.innerHTML =
          '<span class="fhs-i">' + p.icon + '</span>' +
          ' <span class="fhs-v">' + p.val + '</span>' +
          ' <small class="fhs-l">' + p.lbl + '</small>';
        el.appendChild(span);  // only for brand-new pills
      } else {
        // Existing pill — update inner children only; no DOM move, no repaint.
        var iEl = span.querySelector(".fhs-i");
        var vEl = span.querySelector(".fhs-v");
        if (!iEl || !vEl) {
          // Rebuild inner structure if missing (shouldn't happen in normal use).
          span.innerHTML =
            '<span class="fhs-i">' + p.icon + '</span>' +
            ' <span class="fhs-v">' + p.val + '</span>' +
            ' <small class="fhs-l">' + p.lbl + '</small>';
        } else {
          if (iEl.innerHTML !== p.icon) iEl.innerHTML = p.icon;
          if (vEl.textContent !== p.val) vEl.textContent = p.val;
        }
      }
    });
  }

  function renderAll() {
    for (var i = 0; i < hudEls.length; i++) renderHUD(hudEls[i]);
  }

  function attachHUD(el) {
    if (el && hudEls.indexOf(el) === -1) hudEls.push(el);
    renderHUD(el);
  }

  // ── Connect to debug bus ─────────────────────────────────────────────────

  var connected = false;
  function connect() {
    if (connected) return;
    if (!window.__FACES_DEBUG__) { setTimeout(connect, 200); return; }
    connected = true;
    window.__FACES_DEBUG__.subscribe(ingest);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", connect);
  } else {
    setTimeout(connect, 0);
  }

  // Keep the measured req/s pill decaying toward 0 when traffic stops (renders
  // are otherwise only driven by incoming requests). Cheap: one re-render/sec.
  setInterval(function () { if (hudEls.length) renderAll(); }, 1000);

  window.__FACES_STATS__ = {
    data:             d,
    subscribe:        function (fn) { subs.push(fn); },
    bumpInteraction:  bumpInteraction,
    setActive:        setActive,
    liveRate:         liveRate,
    reset:            reset,
    attachHUD:        attachHUD,
    tier:             tier,
    TIERS:            TIERS,
  };
})();

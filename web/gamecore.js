// gamecore.js — shared engine for the interactive GAME modes (Snake Duel, Slipstream Derby).
//
// One module both games depend on. Owns the single source of truth for backend
// health (so both read identical netStress), a focus-safe arrow-key manager, a
// game-loop helper (fixed-tick + rAF), canvas HUD/draw helpers, and a difficulty
// level tracker. Must load AFTER stats.js and BEFORE snake.js / derby.js.
//
// Public API: window.__FACES_GAME__ = { health, keys, loop, draw, difficulty }
//
// SPDX-License-Identifier: Apache-2.0
(function () {
  "use strict";

  // ── Math helpers (shared) ──────────────────────────────────────────
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function hexRgb(h) {
    if (typeof h !== "string" || h[0] !== "#" || h.length < 7) return [139, 155, 191];
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function rgba(h, a) { var c = hexRgb(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function lerpHex(h0, h1, t) {
    var a = hexRgb(h0), b = hexRgb(h1);
    var r = Math.round(lerp(a[0], b[0], t)), g = Math.round(lerp(a[1], b[1], t)), bl = Math.round(lerp(a[2], b[2], t));
    return "#" + (r < 16 ? "0" : "") + r.toString(16) + (g < 16 ? "0" : "") + g.toString(16) + (bl < 16 ? "0" : "") + bl.toString(16);
  }
  function hueOf(h) {
    var c = hexRgb(h), r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d === 0) return 0;
    var hh;
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60; if (hh < 0) hh += 360;
    return hh;
  }
  function hueClose(a, b, tol) { var d = Math.abs(a - b) % 360; if (d > 180) d = 360 - d; return d <= tol; }
  function nowSec() { return performance.now() / 1000; }

  // ── Color/emoji parsing (ported from claude.js) ────────────────────
  function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function validHex(s) { return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s); }
  function decodeEmoji(s) {
    if (!s || typeof s !== "string") return "";
    var d = document.createElement("div"); d.innerHTML = s;
    return (d.textContent || "").trim();
  }
  function settings() { return window.__FACES_SETTINGS__ || {}; }
  function slowThresholdMs() { var n = Number(settings().slowThresholdMs); return Number.isFinite(n) && n > 0 ? n : 300; }

  // ── HEALTH SIGNAL (single owner) ───────────────────────────────────
  var rollBuckets = new Array(10).fill(0), rollIdx = 0, rollReqs = 0, rollErrs = 0, rollTimer = 0;
  var netStress = 0, latencyEma = 0;
  var lastTierIdx = 0, recoverUntil = -10;
  var clearCbs = [];

  function tierIdx(s) { return s < 0.3 ? 0 : s < 0.6 ? 1 : 2; }
  function tierName(s) { return ["ok", "warn", "crit"][tierIdx(s)]; }

  function classify(entry) {
    var status = entry.status || 0, body = safeJson(entry.body), slowMs = slowThresholdMs();
    var out = {
      which: entry.which || "center", failed: false, timeout: false, partial: false,
      slow: (entry.latencyMs || 0) >= slowMs, color: "#8B9BBF", emoji: "❓",
      hasColor: false, hasEmoji: false, latencyMs: entry.latencyMs || 0,
    };
    if (status === 0 || (status >= 500 && status !== 599) || status === 429) out.failed = true;
    else if (status === 504 || status === 599) out.timeout = true;
    else if (status === 200 && body) {
      if (validHex(body.color)) { out.hasColor = true; out.color = body.color; }
      var em = decodeEmoji(body.smiley);
      if (em && em.length <= 16 && !/^[0-9]+$/.test(em)) { out.hasEmoji = true; out.emoji = em; }
      if (Array.isArray(body.errors) && body.errors.length) out.partial = true;
      if (body.smiley === "504" || body.color === "504") out.timeout = true;
    } else out.failed = true;
    return out;
  }

  // Always-on: flush the 1s error bucket so the rolling window never goes stale,
  // even when no game is active (cheap; mirrors stats.js's standing subscription).
  function flushBucket() {
    rollBuckets[rollIdx] = rollErrs / Math.max(1, rollReqs);
    rollIdx = (rollIdx + 1) % 10; rollReqs = 0; rollErrs = 0;
  }

  function ingest(entry) {
    if (!entry) {                       // clear signal
      rollBuckets.fill(0); rollReqs = rollErrs = 0; netStress = 0; latencyEma = 0;
      for (var i = 0; i < clearCbs.length; i++) { try { clearCbs[i](); } catch (e) {} }
      return;
    }
    var c = classify(entry);
    rollReqs++;
    if (c.failed || c.timeout) rollErrs++;
    latencyEma = latencyEma === 0 ? c.latencyMs : lerp(latencyEma, c.latencyMs, 0.15);
  }

  function subscribe() {
    if (!window.__FACES_DEBUG__) { setTimeout(subscribe, 80); return; }
    window.__FACES_DEBUG__.subscribe(ingest);
  }

  // Smooth netStress toward the bucket average each frame (asymmetric attack/decay,
  // ported from claude.js). Active game loops call this with dt.
  function tickStress(dt) {
    rollTimer += dt;
    if (rollTimer >= 1.0) { rollTimer -= 1.0; flushBucket(); }   // advance the 1s error window
    var avg = 0; for (var i = 0; i < 10; i++) avg += rollBuckets[i]; avg /= 10;
    var tgt = clamp01(avg), spd = tgt > netStress ? 0.5 : 0.12;
    netStress = clamp01(netStress + (tgt - netStress) * spd * dt);
    var ti = tierIdx(netStress);
    if (ti < lastTierIdx) recoverUntil = nowSec() + 1.2;   // health improved a tier
    lastTierIdx = ti;
  }

  var health = {
    netStress: function () { return netStress; },
    latencyMs: function () { return latencyEma; },
    slowThresholdMs: slowThresholdMs,
    tier: function () { return tierName(netStress); },
    tierIdx: function () { return tierIdx(netStress); },
    recovering: function () { return nowSec() < recoverUntil; },
    classify: classify,
    onClear: function (fn) { if (typeof fn === "function") clearCbs.push(fn); },
    tickStress: tickStress,
  };

  // ── KEYBOARD MANAGER (single-owner, focus-safe) ────────────────────
  var KEYMAP = {
    ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", " ": "dash",
    a: "left", d: "right", w: "up", s: "down",   // WASD alias
  };
  var owner = null, handlers = null;
  var down = { left: false, right: false, up: false, down: false, dash: false };
  var pressed = { left: false, right: false, up: false, down: false, dash: false };

  function inTextField() {
    var el = document.activeElement;
    if (!el) return false;
    var t = el.tagName;
    return t === "INPUT" || t === "TEXTAREA" || el.isContentEditable;
  }
  function clearKeys() {
    down.left = down.right = down.up = down.down = down.dash = false;
    pressed.left = pressed.right = pressed.up = pressed.down = pressed.dash = false;
  }

  window.addEventListener("keydown", function (e) {
    if (!owner || inTextField()) return;
    var act = KEYMAP[e.key];
    if (!act) return;
    e.preventDefault();                 // stop arrow/space page-scroll while a game owns input
    if (e.repeat) return;               // discrete actions ignore auto-repeat
    if (!down[act]) pressed[act] = true;
    down[act] = true;
    if (handlers && handlers.onDown) handlers.onDown(act);
  }, { passive: false });

  window.addEventListener("keyup", function (e) {
    if (!owner) return;
    var act = KEYMAP[e.key];
    if (!act) return;
    down[act] = false;
    if (handlers && handlers.onUp) handlers.onUp(act);
  });
  window.addEventListener("blur", clearKeys);

  var keys = {
    activate: function (modeId, h) { owner = modeId; handlers = h || null; clearKeys(); },
    deactivate: function (modeId) { if (owner === modeId) { owner = null; handlers = null; clearKeys(); } },
    isDown: function (a) { return !!down[a]; },
    pressedThisFrame: function (a) { if (pressed[a]) { pressed[a] = false; return true; } return false; },
  };

  // ── GAME LOOP HELPER (one active loop at a time) ───────────────────
  var loopRaf = 0, loopOwner = null;
  function stopLoop(modeId) {
    if (modeId && loopOwner !== modeId) return;
    if (loopRaf) cancelAnimationFrame(loopRaf);
    loopRaf = 0; loopOwner = null;
  }
  function fixedLoop(modeId, tickHz, cbs) {
    stopLoop();
    loopOwner = modeId;
    var acc = 0, last = performance.now();
    function frame(now) {
      if (loopOwner !== modeId) return;
      var dt = Math.min(0.1, (now - last) / 1000 || 0.016); last = now;
      tickStress(dt);
      var hz = typeof tickHz === "function" ? tickHz() : tickHz;
      var step = 1 / Math.max(1, hz);
      acc += dt;
      var guard = 0;
      while (acc >= step && guard++ < 8) { cbs.tick(); acc -= step; }
      cbs.render(clamp01(acc / step), dt);
      loopRaf = requestAnimationFrame(frame);
    }
    loopRaf = requestAnimationFrame(frame);
  }
  function rafLoop(modeId, cbs) {
    stopLoop();
    loopOwner = modeId;
    var last = performance.now();
    function frame(now) {
      if (loopOwner !== modeId) return;
      var dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
      tickStress(dt);
      cbs.update(dt);
      cbs.render(dt);
      loopRaf = requestAnimationFrame(frame);
    }
    loopRaf = requestAnimationFrame(frame);
  }
  var loop = { fixed: fixedLoop, raf: rafLoop, stop: stopLoop };

  // ── DRAW HELPERS ───────────────────────────────────────────────────
  var glowCache = {}, glowKeys = [];
  function glowStamp(hex) {
    if (glowCache[hex]) return glowCache[hex];
    var c = document.createElement("canvas"); c.width = c.height = 48;
    var g = c.getContext("2d"), core = lerpHex(hex, "#ffffff", 0.6);
    var grd = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    grd.addColorStop(0, rgba("#ffffff", 0.95)); grd.addColorStop(0.25, rgba(core, 0.9));
    grd.addColorStop(0.6, rgba(hex, 0.5)); grd.addColorStop(1, rgba(hex, 0));
    g.fillStyle = grd; g.fillRect(0, 0, 48, 48);
    if (glowKeys.length > 64) delete glowCache[glowKeys.shift()];
    glowKeys.push(hex); glowCache[hex] = c; return c;
  }

  var TIER_COLOR = ["#36e07a", "#ffc24b", "#ff5c6a"];
  function tierColor(s) { return TIER_COLOR[tierIdx(s)]; }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // Centered health banner: shows the service tier + a fill bar (full = healthy),
  // flashes a green "SERVICE RECOVERING" pulse when health just improved.
  function healthBanner(ctx, cx, y, w) {
    var s = netStress, col = tierColor(s);
    var label = s < 0.3 ? "SERVICE HEALTHY" : s < 0.6 ? "SERVICE LAGGING — CPU GAINING" : "SERVICE CRITICAL — CPU WINNING";
    var h = 26, x = cx - w / 2;
    ctx.save();
    ctx.globalAlpha = 0.9;
    roundRect(ctx, x, y, w, h, 13); ctx.fillStyle = "rgba(8,12,28,0.7)"; ctx.fill();
    roundRect(ctx, x + 2, y + 2, (w - 4) * (1 - s), h - 4, 11); ctx.fillStyle = rgba(col, 0.5); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = col; ctx.font = "bold 13px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(label, cx, y + h / 2);
    if (nowSec() < recoverUntil) {
      var p = clamp01((recoverUntil - nowSec()) / 1.2);
      ctx.globalAlpha = p; ctx.fillStyle = "#36e07a";
      ctx.font = "bold 15px -apple-system, sans-serif";
      ctx.fillText("✨ SERVICE RECOVERING ✨", cx, y - 14);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function scoreBar(ctx, x, y, w, h, label, value, max, color) {
    ctx.save();
    roundRect(ctx, x, y, w, h, h / 2); ctx.fillStyle = "rgba(8,12,28,0.6)"; ctx.fill();
    var fw = (w - 4) * clamp01(value / max);
    if (fw > 0) { roundRect(ctx, x + 2, y + 2, fw, h - 4, (h - 4) / 2); ctx.fillStyle = color; ctx.fill(); }
    ctx.fillStyle = "#e6edf7"; ctx.font = "bold 12px -apple-system, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(label + " " + (value | 0), x + 8, y + h / 2);
    ctx.restore();
  }

  function countdown(ctx, W, H, secsLeft) {
    var n = Math.ceil(secsLeft), txt = n <= 0 ? "GO!" : String(n);
    var frac = secsLeft - Math.floor(secsLeft), scale = 1 + (1 - frac) * 0.6;
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(scale, scale);
    ctx.globalAlpha = clamp01(frac * 1.4);
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 96px -apple-system, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(120,160,255,0.8)"; ctx.shadowBlur = 24;
    ctx.fillText(txt, 0, 0); ctx.restore();
  }

  function banner(ctx, W, H, title, sub, color) {
    ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(6,10,22,0.55)"; ctx.fillRect(0, H / 2 - 80, W, 160);
    ctx.fillStyle = color || "#ffffff"; ctx.font = "bold 54px -apple-system, sans-serif";
    ctx.shadowColor = "rgba(0,0,0,0.6)"; ctx.shadowBlur = 12;
    ctx.fillText(title, W / 2, H / 2 - 12);
    ctx.shadowBlur = 0; ctx.fillStyle = "#c9d6f0"; ctx.font = "600 18px -apple-system, sans-serif";
    if (sub) ctx.fillText(sub, W / 2, H / 2 + 34);
    ctx.restore();
  }

  var draw = {
    glowStamp: glowStamp, tierColor: tierColor, roundRect: roundRect,
    healthBanner: healthBanner, scoreBar: scoreBar, countdown: countdown, banner: banner,
    rgba: rgba, hexRgb: hexRgb, lerpHex: lerpHex, hueOf: hueOf, hueClose: hueClose,
    clamp: clamp, clamp01: clamp01, lerp: lerp, rand: rand,
  };

  // ── DIFFICULTY (level tracker only; each game maps level -> its own params) ─
  var LEVELS = ["easy", "normal", "hard"], levelOf = {};
  var difficulty = {
    LEVELS: LEVELS,
    level: function (modeId) { return levelOf[modeId] || "normal"; },
    setLevel: function (modeId, lvl) { if (LEVELS.indexOf(lvl) >= 0) levelOf[modeId] = lvl; },
    cycle: function (modeId, dir) {
      var i = LEVELS.indexOf(this.level(modeId));
      i = (i + (dir < 0 ? LEVELS.length - 1 : 1)) % LEVELS.length;
      levelOf[modeId] = LEVELS[i]; return LEVELS[i];
    },
  };

  // ── Boot ───────────────────────────────────────────────────────────
  subscribe();
  window.__FACES_GAME__ = { health: health, keys: keys, loop: loop, draw: draw, difficulty: difficulty };
})();

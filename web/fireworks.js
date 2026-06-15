// GRAND FINALE — Fireworks Mode animation system
// Each live HTTP request is a firework shell launched over a procedural night
// sky. The request COLOR is the burst; the request EMOJI ignites as the glowing
// star at the heart of the bloom. Bloom = success, fizzle/dud = failure.
//
// Fully procedural (no image asset) — modelled on claude.js / SYNAPSE.
// SPDX-License-Identifier: Apache-2.0
(function () {
  "use strict";

  // ── Constants ─────────────────────────────────────────────────────
  var FALLBACK_COLOR = "#8B9BBF";
  var FALLBACK_EMOJI = "❓"; // ❓
  var MAX_SHELLS  = 40;
  var MAX_SPARKS  = 2600;
  var MAX_SMOKE   = 220;
  var MANUAL_LIVE_CAP = 8;
  var CLICK_THROTTLE_MS = 160;
  var STREAK_N      = 10;       // grand finale needs this many request successes...
  var STREAK_WINDOW = 8;        // ...inside this rolling window (seconds)
  var MIN_FINALE_GAP = 6;       // safety floor between finales (seconds)
  var G_SPARK = 120;            // spark gravity
  var SMOKE_GREY = "#555560";
  var EMBER = "#e5484d";

  // ── Module state ──────────────────────────────────────────────────
  var root, canvas, ctx, hudCounts;
  var bgCanvas, bgCtx;          // cached static night sky (no skyline — that is dynamic)
  var liveCanvas, liveCtx;      // per-frame sky actors (for reflection blit)
  var W = 800, H = 600, dpr = 1;
  var waterTop = 480;           // logical y of the harbor horizon
  var moonX = 0, moonY = 0, moonR = 0;
  var visualMode = "classic";
  var running = false, raf = 0, lastTs = 0;
  var reduceMotion = false;

  var shells = [], sparks = [], smokes = [], bursts = [], flashes = [];
  var floaters = [], ripples = [], debris = [];
  var stars = [], buildings = [];

  var admitted = [];            // rate-limit sliding window (seconds)
  var aloft = 0;                // active shell count (HUD)
  var manualLive = 0;
  var lastClickMs = 0;
  var rechargeUntil = 0, rechargeX = 0, rechargeY = 0;

  var slowMs = 300, maxRps = 0.5;

  var successTimes = [];        // timestamps (s) of recent request successes
  var lastFinaleTime = -100;
  var finaleActive = false, finaleEndsAt = 0, finaleNextLaunch = 0;
  var finaleGlow = 0, finaleTitleBorn = -10;

  var cityScale = 1;            // 0..1 skyline height (alien attack drops it, regen lifts it)
  var regenActive = false;
  var alien = null;             // { phase, t, x, y, tx, ty, fxTimer }

  var glowCache = {}, glowKeys = [];
  var keyOverlay = null;

  // Palette + emoji used for FINALE barrage shells (those still show emoji).
  var PALETTE = ["#ff3b5c", "#ffb347", "#ffe14d", "#36d399", "#4cc9f0",
                 "#7c5cff", "#ff7ad9", "#ff5e3a", "#a0ff6a"];
  var CLICK_EMOJI = ["\u{1F600}", "\u{1F389}", "✨", "\u{1F680}",
                     "\u{1F31F}", "\u{1F60D}", "\u{1F973}", "\u{1F525}"];

  // ── Helpers ───────────────────────────────────────────────────────
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  function hexRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function rgba(h, a) { var c = hexRgb(h); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
  function lerpHex(h0, h1, t) {
    var a = hexRgb(h0), b = hexRgb(h1);
    var r = Math.round(lerp(a[0], b[0], t)), g = Math.round(lerp(a[1], b[1], t)), bl = Math.round(lerp(a[2], b[2], t));
    return "#" + (r < 16 ? "0" : "") + r.toString(16) + (g < 16 ? "0" : "") + g.toString(16) + (bl < 16 ? "0" : "") + bl.toString(16);
  }
  function luminance(h) { var c = hexRgb(h); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
  // Lift dark request colors toward white so even near-black hexes bloom.
  function burstColor(h) {
    var lum = luminance(h);
    if (lum >= 80) return h;
    return lerpHex(h, "#ffffff", ((80 - lum) / 80) * 0.55);
  }
  function validHex(s) { return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s); }
  function decodeEmoji(s) {
    if (!s || typeof s !== "string") return "";
    var d = document.createElement("div");
    d.innerHTML = s;
    return (d.textContent || "").trim();
  }
  function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

  // Deterministic PRNG so the baked starfield + skyline stay stable across resizes.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Pre-baked additive radial glow sprite, tinted + cached per color.
  function glowStamp(hex) {
    if (glowCache[hex]) return glowCache[hex];
    var c = document.createElement("canvas");
    c.width = c.height = 48;
    var g = c.getContext("2d");
    var core = lerpHex(hex, "#ffffff", 0.6);
    var grd = g.createRadialGradient(24, 24, 0, 24, 24, 24);
    grd.addColorStop(0.0, rgba("#ffffff", 0.95));
    grd.addColorStop(0.25, rgba(core, 0.9));
    grd.addColorStop(0.6, rgba(hex, 0.5));
    grd.addColorStop(1.0, rgba(hex, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, 48, 48);
    if (glowKeys.length > 64) { var old = glowKeys.shift(); delete glowCache[old]; }
    glowKeys.push(hex);
    glowCache[hex] = c;
    return c;
  }

  function settings() { return window.__FACES_SETTINGS__ || {}; }
  function maxRatePerSec() {
    var s = settings();
    return clamp(Number(s.funModeRatePerSec || s.buoyantRatePerSec || maxRps) || 0.5, 0.5, 200);   // 200 = super-mode ceiling (Swift caps stored value to 20 unless super mode)
  }

  // ── Classify a debug-bus entry into a firework "kind" ──────────────
  function classify(entry) {
    var status = entry.status || 0;
    var body = safeJson(entry.body);
    var out = {
      which: entry.which || "center",
      color: FALLBACK_COLOR, emoji: FALLBACK_EMOJI,
      hasColor: false, hasEmoji: false,
      slow: (entry.latencyMs || 0) >= slowMs,
      kind: "success", stutter: false,
    };
    if (status === 0 || (status >= 500 && status !== 599) || status === 429) {
      out.kind = "fail";
      out.color = SMOKE_GREY;
      // Rate-limited (429): stutters into several pops AND shows the 🤯
      // overwhelmed star, so it's distinguishable from a plain failure.
      if (status === 429) { out.stutter = true; out.hasEmoji = true; out.emoji = "🤯"; }
    } else if (status === 504 || status === 599) {
      out.kind = "mortar";
      out.color = SMOKE_GREY;
    } else if (status === 200 && body) {
      if (validHex(body.color)) { out.hasColor = true; out.color = body.color; }
      var em = decodeEmoji(body.smiley);
      if (em && em.length <= 16 && !/^[0-9]+$/.test(em)) { out.hasEmoji = true; out.emoji = em; }
      if (Array.isArray(body.errors) && body.errors.length) out.kind = "partial";
      else if (out.slow) out.kind = "slow";
      else out.kind = "success";
    } else {
      out.kind = "fail"; out.color = SMOKE_GREY;
    }
    return out;
  }

  // ── Spawn from a request (rate-limited visuals) ────────────────────
  function spawnFromRequest(entry) {
    var nowS = performance.now() / 1000;
    var minInterval = 1.0 / maxRatePerSec();
    var horizonS = Math.max(1.0, minInterval);  // see buoyant.js note
    admitted = admitted.filter(function (t) { return nowS - t < horizonS; });
    if (admitted.length > 0 && nowS - admitted[admitted.length - 1] < minInterval) return;
    if (admitted.length >= Math.ceil(maxRatePerSec())) return;
    if (shells.length >= MAX_SHELLS) return;
    admitted.push(nowS);
    launchShell(classify(entry), {});
  }

  function launchShell(c, opts) {
    opts = opts || {};
    var manual = !!opts.manual;
    var lowBand = (c.which === "edge");
    var targetFy = opts.targetFy != null ? opts.targetFy
                 : (lowBand ? rand(0.30, 0.48) : rand(0.12, 0.34));
    var targetY = targetFy * H;
    var x0 = opts.x != null ? opts.x : rand(W * 0.12, W * 0.88);
    var apexX = opts.apexX != null ? opts.apexX : clamp(x0 + rand(-W * 0.08, W * 0.08), 20, W - 20);

    if (reduceMotion) { explodeAt(apexX, targetY, c, manual); return; }

    var climb;
    if (c.kind === "slow") climb = rand(2.4, 3.8);
    else if (c.kind === "mortar") climb = rand(0.5, 0.8);
    else climb = rand(0.6, 0.95);

    // Gravity + launch velocity so the apex lands at targetY exactly at t=climb.
    var rise = H - targetY;
    var g = (2 * rise) / (climb * climb);
    var vy = -g * climb;
    var vx = (apexX - x0) / climb;

    shells.push({
      x: x0, y: H + 6, vx: vx, vy: vy, g: g,
      color: c.color, burst: burstColor(c.color),
      emoji: c.emoji, hasColor: c.hasColor, hasEmoji: c.hasEmoji,
      kind: c.kind, stutter: c.stutter, manual: manual,
      silent: !!c.silent, fromFinale: !!c.fromFinale,
      born: lastTs, ttl: 6.0, exploded: false,
      fuse: (c.kind === "fail") ? rand(0.45, 0.78) : 99,
      trail: [],
    });
    aloft++;
    if (manual) manualLive++;
  }

  // ── Burst ──────────────────────────────────────────────────────────
  function explode(sh) { explodeAt(sh.x, sh.y, sh, sh.manual); }

  function explodeAt(x, y, c, manual) {
    var kind = c.kind, col = c.burst || burstColor(c.color || FALLBACK_COLOR);
    var isFail = (kind === "fail" || kind === "mortar");

    if (isFail) {
      // Sad grey dud — colorless pop + smoke, no emoji star.
      flashes.push({ x: x, y: y, born: lastTs, maxLife: 0.18, color: SMOKE_GREY, r: 30 });
      var pops = c.stutter ? 5 : 1;
      for (var p = 0; p < pops; p++) {
        for (var k = 0; k < 8; k++) addSpark(x, y, SMOKE_GREY, rand(20, 70), 0.5, "fizzle");
      }
      addSpark(x, y, EMBER, 30, 0.25, "fizzle");
      for (var s = 0; s < 6; s++) addSmoke(x + rand(-12, 12), y, rand(8, 16));
      if (c.hasEmoji && !c.silent) bursts.push({ x: x, y: y, emoji: c.emoji, color: SMOKE_GREY, born: lastTs, maxLife: 1.0, vy: 40, scale: 0.5, dim: true, partial: false });
      return;
    }

    var dim = (kind === "slow");
    var n = dim ? (40 + (Math.random() * 24) | 0) : (80 + (Math.random() * 40) | 0);
    var willow = Math.random() < 0.28;
    var twin = lerpHex(col, "#ffffff", 0.15);
    flashes.push({ x: x, y: y, born: lastTs, maxLife: 0.16, color: "#ffffff", r: dim ? 36 : 54 });

    for (var i = 0; i < n; i++) {
      var ang = (i / n) * Math.PI * 2 + rand(-0.05, 0.05);
      var spd = willow ? rand(40, 120) : rand(110, 240) * (dim ? 0.7 : 1);
      spd *= 0.35 + 0.65 * Math.random();
      var sc = (kind === "partial" && Math.random() < 0.25) ? "partialfizzle" : (willow ? "willow" : "spark");
      var sp = addSpark(x, y, (Math.random() < 0.2 ? twin : col), spd, willow ? 1.6 : rand(0.9, 1.5), sc);
      if (sp) { sp.vx = Math.cos(ang) * spd; sp.vy = Math.sin(ang) * spd; }
    }

    // Emoji star at the heart — but NOT for player-launched (silent) fireworks.
    if (!c.silent) {
      bursts.push({
        x: x, y: y, emoji: c.emoji || FALLBACK_EMOJI, color: col,
        born: lastTs, maxLife: dim ? 1.6 : 2.0, vy: 18, scale: 0,
        dim: dim, partial: (kind === "partial"),
      });
    }

    // Streak toward the GRAND FINALE — only genuine request successes count
    // (player clicks and finale-barrage shells are excluded).
    if (!c.manual && !c.fromFinale) {
      successTimes.push(lastTs);
      while (successTimes.length && lastTs - successTimes[0] > STREAK_WINDOW) successTimes.shift();
      if (!finaleActive && successTimes.length >= STREAK_N && lastTs - lastFinaleTime >= MIN_FINALE_GAP) {
        successTimes.length = 0;
        triggerFinale();
      }
    }
  }

  function addSpark(x, y, color, spd, life, type) {
    if (sparks.length >= MAX_SPARKS) return null;
    var ang = rand(0, Math.PI * 2);
    var sp = {
      x: x, y: y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
      color: color, life: 0, maxLife: life * rand(0.85, 1.15),
      type: type, size: type === "willow" ? rand(1.5, 2.4) : rand(2, 3.4),
    };
    sparks.push(sp);
    return sp;
  }
  function addSmoke(x, y, r) {
    if (smokes.length >= MAX_SMOKE) return;
    smokes.push({ x: x, y: y, vx: rand(-8, 8), vy: rand(-26, -14), r: r, life: 0, maxLife: rand(1.6, 2.6) });
  }

  // ── Grand Finale ───────────────────────────────────────────────────
  function triggerFinale() {
    finaleTitleBorn = lastTs;
    lastFinaleTime = lastTs;
    if (reduceMotion) return;
    finaleActive = true;
    finaleEndsAt = lastTs + 3.6;
    finaleNextLaunch = lastTs;
  }

  // ── Alien attack (click the moon) ──────────────────────────────────
  function startAlien() {
    if (alien) return;
    alien = { phase: "descend", t: 0, x: moonX, y: moonY, tx: W * 0.5, ty: H * 0.27, fxTimer: 0 };
  }
  function effScale(b) { return clamp01((cityScale - b.d) / (1 - b.d)); }

  function spawnDebris(x, y, color) {
    if (debris.length > 260) return;
    debris.push({ x: x, y: y, vx: rand(-130, 130), vy: rand(-230, -50),
      size: rand(5, 15), rot: rand(0, 6.28), vr: rand(-7, 7),
      life: 0, maxLife: rand(1.2, 2.2), color: color });
  }

  function updateAlien(dt, now) {
    if (!alien) return;
    alien.t += dt;
    if (alien.phase === "descend") {
      alien.x += (alien.tx - alien.x) * Math.min(1, dt * 3);
      alien.y += (alien.ty - alien.y) * Math.min(1, dt * 3);
      if (alien.t > 1.3) { alien.phase = "attack"; alien.t = 0; }
    } else if (alien.phase === "attack") {
      alien.x = alien.tx + Math.sin(now * 2) * W * 0.06;
      cityScale = Math.max(0, cityScale - dt / 0.7);
      alien.fxTimer -= dt;
      if (alien.fxTimer <= 0 && buildings.length) {
        alien.fxTimer = 0.05;
        var b = buildings[(Math.random() * buildings.length) | 0];
        var top = waterTop - b.hFull * effScale(b);
        spawnDebris(b.x + Math.random() * b.w, top, b.color);
        if (Math.random() < 0.5) addSpark(b.x + b.w * 0.5, top, "#ffb347", rand(60, 140), 0.5, "spark");
        if (Math.random() < 0.4) addSmoke(b.x + b.w * 0.5, top, rand(8, 14));
      }
      if (alien.t > 1.1) { alien.phase = "leave"; alien.t = 0; regenActive = true; }
    } else if (alien.phase === "leave") {
      alien.x += 130 * dt; alien.y -= 210 * dt;
      if (alien.t > 1.4) alien = null;
    }
  }

  // ── Click → launch a celebratory shell, or zap the moon ────────────
  function onCanvasClick(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;

    // Moon → summon the alien (Easter egg)
    var dxm = mx - moonX, dym = my - moonY;
    if (moonR > 0 && Math.sqrt(dxm * dxm + dym * dym) <= moonR * 1.25) { startAlien(); return; }

    var nowMs = performance.now();
    if (nowMs - lastClickMs < CLICK_THROTTLE_MS || manualLive >= MANUAL_LIVE_CAP) {
      rechargeUntil = lastTs + 0.4; rechargeX = mx; rechargeY = my;
      return;
    }
    lastClickMs = nowMs;
    // Player fireworks are a pure colored bloom — NO emoji (keeps the emoji
    // reveal special for live requests + the grand finale).
    var c = { which: "center", color: pick(PALETTE), emoji: "", hasColor: true,
              hasEmoji: false, silent: true, manual: true, slow: false, kind: "success", stutter: false };
    launchShell(c, { manual: true, x: mx, apexX: mx, targetFy: clamp(my / H, 0.08, 0.55) });
    floaters.push({ x: mx, y: my - 18, vy: 36, text: "+1", color: c.color, life: 0, maxLife: 0.8 });
    if (window.__FACES_STATS__) window.__FACES_STATS__.bumpInteraction();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  function start() { if (running) return; resize(); running = true; lastTs = performance.now() / 1000; raf = requestAnimationFrame(frame); }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    shells.length = sparks.length = smokes.length = bursts.length = 0;
    flashes.length = floaters.length = ripples.length = debris.length = 0;
    aloft = 0; manualLive = 0; finaleActive = false;
    alien = null; regenActive = false; cityScale = 1; successTimes.length = 0;
  }

  function frame(nowMs) {
    if (!running) return;
    var now = nowMs / 1000;
    var dt = Math.min(0.05, now - lastTs || 0.016);
    lastTs = now;
    update(dt, now);
    draw(now);
    raf = requestAnimationFrame(frame);
  }

  // ── Update ─────────────────────────────────────────────────────────
  function update(dt, now) {
    // Finale barrage
    if (finaleActive) {
      finaleGlow = clamp01(finaleGlow + dt * 1.5);
      if (now < finaleEndsAt) {
        if (now >= finaleNextLaunch && shells.length < MAX_SHELLS) {
          launchShell({ which: Math.random() < 0.5 ? "center" : "edge", color: pick(PALETTE),
            emoji: pick(CLICK_EMOJI), hasColor: true, hasEmoji: true, silent: false, fromFinale: true,
            slow: false, kind: "success", stutter: false }, {});
          finaleNextLaunch = now + rand(0.06, 0.17);
        }
      } else { finaleActive = false; }
    } else {
      finaleGlow = clamp01(finaleGlow - dt * 0.8);
    }

    updateAlien(dt, now);
    if (regenActive) { cityScale = Math.min(1, cityScale + dt / 2.6); if (cityScale >= 1) regenActive = false; }

    // Shells
    for (var i = shells.length - 1; i >= 0; i--) {
      var sh = shells[i];
      sh.vy += sh.g * dt;
      sh.x += sh.vx * dt; sh.y += sh.vy * dt;
      sh.trail.push(sh.x, sh.y);
      if (sh.trail.length > 24) sh.trail.splice(0, 2);

      var done = false;
      if (sh.kind === "mortar") {
        if (sh.vy > 0 && sh.y >= waterTop) {
          ripples.push({ x: sh.x, y: waterTop, r: 4, maxR: rand(26, 46), life: 0, maxLife: 1.0, color: sh.burst });
          for (var m = 0; m < 5; m++) addSmoke(sh.x + rand(-8, 8), waterTop, rand(6, 12));
          done = true;
        }
      } else if (sh.kind === "fail") {
        sh.fuse -= dt;
        if (sh.fuse <= 0) { explode(sh); done = true; }
      } else {
        if (sh.vy >= 0) { explode(sh); done = true; }  // apogee
      }
      if (!done && (now - sh.born) > sh.ttl) { explode(sh); done = true; }   // watchdog
      if (done) { shells.splice(i, 1); aloft--; if (sh.manual) manualLive--; }
    }

    // Sparks
    for (var s = sparks.length - 1; s >= 0; s--) {
      var sp = sparks[s];
      sp.life += dt;
      if (sp.life >= sp.maxLife) { sparks.splice(s, 1); continue; }
      var drag = sp.type === "willow" ? 0.6 : 1.4;
      sp.vx -= sp.vx * drag * dt;
      sp.vy -= sp.vy * drag * dt;
      sp.vy += (sp.type === "willow" ? G_SPARK * 1.6 : G_SPARK) * dt;
      sp.x += sp.vx * dt; sp.y += sp.vy * dt;
    }

    // Smoke
    for (var k = smokes.length - 1; k >= 0; k--) {
      var sm = smokes[k];
      sm.life += dt;
      if (sm.life >= sm.maxLife) { smokes.splice(k, 1); continue; }
      sm.x += sm.vx * dt; sm.y += sm.vy * dt; sm.r += 10 * dt;
    }

    // Debris (alien demolition)
    for (var d = debris.length - 1; d >= 0; d--) {
      var db = debris[d];
      db.life += dt;
      if (db.life >= db.maxLife || db.y > H + 30) { debris.splice(d, 1); continue; }
      db.vy += 620 * dt; db.x += db.vx * dt; db.y += db.vy * dt; db.rot += db.vr * dt;
    }

    // Emoji bursts
    for (var b = bursts.length - 1; b >= 0; b--) {
      var bu = bursts[b];
      bu.life = (bu.life || 0) + dt;
      if (bu.life >= bu.maxLife) { bursts.splice(b, 1); continue; }
      bu.scale = Math.min(1, (bu.life / 0.22));
      if (bu.life > bu.maxLife * 0.5) bu.y += bu.vy * dt;
    }

    // Flashes / floaters / ripples
    for (var f = flashes.length - 1; f >= 0; f--) { if (now - flashes[f].born >= flashes[f].maxLife) flashes.splice(f, 1); }
    for (var fl = floaters.length - 1; fl >= 0; fl--) {
      var ft = floaters[fl]; ft.life += dt; ft.y -= ft.vy * dt;
      if (ft.life >= ft.maxLife) floaters.splice(fl, 1);
    }
    for (var r = ripples.length - 1; r >= 0; r--) {
      var rp = ripples[r]; rp.life += dt; rp.r = lerp(4, rp.maxR, clamp01(rp.life / rp.maxLife));
      if (rp.life >= rp.maxLife) ripples.splice(r, 1);
    }

    if (window.__FACES_STATS__) window.__FACES_STATS__.setActive(aloft, "aloft");
  }

  // ── Draw ───────────────────────────────────────────────────────────
  function draw(now) {
    // 1. live sky actors → liveCanvas (logical coords, dpr transform)
    liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    liveCtx.clearRect(0, 0, W, H);

    liveCtx.globalCompositeOperation = "source-over";
    for (var k = 0; k < smokes.length; k++) {
      var sm = smokes[k];
      liveCtx.fillStyle = rgba(SMOKE_GREY, (1 - sm.life / sm.maxLife) * 0.35);
      liveCtx.beginPath(); liveCtx.arc(sm.x, sm.y, sm.r, 0, Math.PI * 2); liveCtx.fill();
    }

    liveCtx.globalCompositeOperation = "lighter";
    for (var st = 0; st < stars.length; st++) {
      var s2 = stars[st];
      liveCtx.globalAlpha = s2.base * (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now * s2.tw + s2.ph)));
      liveCtx.fillStyle = s2.color;
      liveCtx.fillRect(s2.x, s2.y, s2.s, s2.s);
    }
    liveCtx.globalAlpha = 1;

    for (var i = 0; i < shells.length; i++) {
      var sh = shells[i];
      var headCol = (sh.kind === "fail" || sh.kind === "mortar") ? SMOKE_GREY : sh.burst;
      var tr = sh.trail, tlen = tr.length / 2;
      for (var ti = 0; ti < tlen; ti++) {
        var ta = ti / tlen, rr = 2 + 4 * ta;
        liveCtx.globalAlpha = ta * 0.6;
        liveCtx.drawImage(glowStamp(headCol), tr[ti * 2] - rr, tr[ti * 2 + 1] - rr, rr * 2, rr * 2);
      }
      liveCtx.globalAlpha = 1;
      liveCtx.drawImage(glowStamp(headCol), sh.x - 7, sh.y - 7, 14, 14);
    }

    for (var s = 0; s < sparks.length; s++) {
      var sp = sparks[s];
      var lifeT = sp.life / sp.maxLife, col = sp.color;
      if (sp.type === "willow") col = lerpHex(sp.color, EMBER, clamp01(lifeT));
      if (sp.type === "partialfizzle" && lifeT > 0.35) col = SMOKE_GREY;
      liveCtx.globalAlpha = (1 - lifeT) * (sp.type === "fizzle" ? 0.7 : 1);
      var r2 = sp.size * (1.4 - 0.6 * lifeT) * 2.4;
      liveCtx.drawImage(glowStamp(col), sp.x - r2, sp.y - r2, r2 * 2, r2 * 2);
    }
    liveCtx.globalAlpha = 1;

    for (var fi = 0; fi < flashes.length; fi++) {
      var fla = flashes[fi];
      var ft2 = clamp01((now - fla.born) / fla.maxLife);
      liveCtx.globalAlpha = (1 - ft2) * 0.9;
      liveCtx.drawImage(glowStamp(fla.color), fla.x - fla.r, fla.y - fla.r, fla.r * 2, fla.r * 2);
    }
    liveCtx.globalAlpha = 1;

    liveCtx.globalCompositeOperation = "source-over";
    for (var b = 0; b < bursts.length; b++) drawEmojiBurst(liveCtx, bursts[b], now);

    // 2. compose onto main canvas
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bgCanvas, 0, 0);
    drawSkyline(now);
    drawDebris();
    drawReflection(now);
    ctx.globalAlpha = 1;
    ctx.drawImage(liveCanvas, 0, 0);

    // 3. UI / front overlays (logical coords)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRipples();
    drawAlien(now);
    if (finaleGlow > 0.02) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = finaleGlow * 0.06; ctx.fillStyle = "#ffb347"; ctx.fillRect(0, 0, W, waterTop);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    }
    drawFloaters();
    if (rechargeUntil > now) drawRecharge(now);
    if (now - finaleTitleBorn < 2.2) drawFinaleTitle(now);
  }

  function drawEmojiBurst(g, bu, now) {
    var lifeT = bu.life / bu.maxLife;
    var alpha = bu.life < bu.maxLife * 0.6 ? 1 : (1 - (lifeT - 0.6) / 0.4);
    var size = (bu.dim ? 44 : 62) * (0.6 + 0.4 * bu.scale);
    g.save();
    g.globalAlpha = clamp01(alpha) * (bu.dim ? 0.85 : 1);
    g.globalCompositeOperation = "lighter";
    g.globalAlpha *= 0.8;
    var hr = size * 0.85;
    g.drawImage(glowStamp(bu.color), bu.x - hr, bu.y - hr, hr * 2, hr * 2);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = clamp01(alpha);
    g.font = size + "px -apple-system, BlinkMacSystemFont, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(bu.emoji, bu.x, bu.y);
    if (bu.partial) {
      g.strokeStyle = "#ffd400"; g.lineWidth = 3;
      g.beginPath(); g.arc(bu.x, bu.y, size * 0.62, 0, Math.PI * 2); g.stroke();
      g.fillStyle = "#ffd400";
      g.beginPath(); g.arc(bu.x + size * 0.5, bu.y - size * 0.5, 10, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#3a2400"; g.font = "bold 13px sans-serif";
      g.fillText("!", bu.x + size * 0.5, bu.y - size * 0.5 + 1);
    }
    g.restore();
  }

  // Dynamic skyline (so it can crumble + regenerate during an alien attack).
  function drawSkyline(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var warmA = finaleGlow > 0.02 ? finaleGlow * 0.85 : 0;
    for (var i = 0; i < buildings.length; i++) {
      var b = buildings[i];
      var s = effScale(b);
      if (s <= 0.002) continue;
      var dh = b.hFull * s, top = waterTop - dh;
      ctx.fillStyle = b.color;
      ctx.fillRect(b.x, top, b.w, dh);
      if (b.antenna && s > 0.9) ctx.fillRect(b.x + b.w * 0.5 - 1, top - 8, 2, 8);
      for (var w = 0; w < b.windows.length; w++) {
        var wn = b.windows[w];
        if (wn.fb > dh) continue;
        var wy = waterTop - wn.fb - wn.h;
        if (wy < top) continue;
        ctx.fillStyle = wn.lit ? "rgba(255,210,122,0.45)" : "rgba(120,140,200,0.10)";
        ctx.fillRect(b.x + wn.dx, wy, wn.w, wn.h);
        if (warmA > 0 && wn.warm) {
          ctx.fillStyle = "rgba(255,210,122," + warmA + ")";
          ctx.fillRect(b.x + wn.dx, wy, wn.w, wn.h);
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawDebris() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (var i = 0; i < debris.length; i++) {
      var db = debris[i];
      ctx.save();
      ctx.globalAlpha = clamp01(1 - db.life / db.maxLife);
      ctx.translate(db.x, db.y); ctx.rotate(db.rot);
      ctx.fillStyle = db.color;
      ctx.fillRect(-db.size / 2, -db.size / 2, db.size, db.size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function drawAlien(now) {
    if (!alien) return;
    // Destruction beam during the attack phase
    if (alien.phase === "attack") {
      var by = alien.y + 8, spread = 64 + 26 * Math.sin(now * 8);
      var grad = ctx.createLinearGradient(0, by, 0, waterTop);
      grad.addColorStop(0, "rgba(125,255,140,0.55)");
      grad.addColorStop(1, "rgba(125,255,140,0.04)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(alien.x - 12, by); ctx.lineTo(alien.x + 12, by);
      ctx.lineTo(alien.x + spread, waterTop); ctx.lineTo(alien.x - spread, waterTop);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = "rgba(210,255,215,0.6)"; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(alien.x, by); ctx.lineTo(alien.x, waterTop); ctx.stroke();
      // green wash
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.04 + 0.04 * (0.5 + 0.5 * Math.sin(now * 10));
      ctx.fillStyle = "#7dff8c"; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    }
    // Saucer
    ctx.save();
    ctx.translate(alien.x, alien.y);
    var underglow = ctx.createRadialGradient(0, 6, 0, 0, 6, 60);
    underglow.addColorStop(0, "rgba(125,255,140,0.35)"); underglow.addColorStop(1, "rgba(125,255,140,0)");
    ctx.fillStyle = underglow; ctx.beginPath(); ctx.arc(0, 6, 60, 0, Math.PI * 2); ctx.fill();
    var bw = 46, bh = 16;
    var bodyG = ctx.createLinearGradient(0, -bh, 0, bh);
    bodyG.addColorStop(0, "#cfd6e0"); bodyG.addColorStop(0.5, "#8b93a3"); bodyG.addColorStop(1, "#5b6270");
    ctx.fillStyle = bodyG; ctx.beginPath(); ctx.ellipse(0, 0, bw, bh, 0, 0, Math.PI * 2); ctx.fill();
    var domeG = ctx.createLinearGradient(0, -22, 0, 0);
    domeG.addColorStop(0, "rgba(190,245,255,0.96)"); domeG.addColorStop(1, "rgba(90,180,220,0.85)");
    ctx.fillStyle = domeG; ctx.beginPath(); ctx.ellipse(0, -4, 22, 18, 0, Math.PI, Math.PI * 2); ctx.fill();
    for (var i = 0; i < 7; i++) {
      var a = (i / 7) * Math.PI * 2, lx = Math.cos(a) * bw * 0.82, ly = Math.sin(a) * bh * 0.55;
      ctx.fillStyle = "rgba(125,255,140," + (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(now * 6 + i))) + ")";
      ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawReflection(now) {
    var waterTopDev = Math.floor(waterTop * dpr);
    var bandH = canvas.height - waterTopDev;
    if (bandH <= 0) return;
    var slices = 10, sh = Math.ceil(bandH / slices), amp = 3 * dpr;
    ctx.globalAlpha = 0.30;
    for (var i = 0; i < slices; i++) {
      var dy = waterTopDev + i * sh, sy = 2 * waterTopDev - dy - sh;
      if (sy < 0) continue;
      ctx.drawImage(liveCanvas, 0, sy, canvas.width, sh, Math.sin(now * 1.6 + i * 0.7) * amp, dy, canvas.width, sh);
    }
    ctx.globalAlpha = 1;
  }

  function drawRipples() {
    for (var i = 0; i < ripples.length; i++) {
      var rp = ripples[i];
      ctx.globalAlpha = (1 - rp.life / rp.maxLife) * 0.5;
      ctx.strokeStyle = rp.color; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(rp.x, rp.y, rp.r, rp.r * 0.32, 0, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "bold 20px -apple-system, BlinkMacSystemFont, sans-serif";
    for (var i = 0; i < floaters.length; i++) {
      var ft = floaters[i];
      ctx.globalAlpha = clamp01(1 - ft.life / ft.maxLife);
      ctx.fillStyle = "#ffffff"; ctx.strokeStyle = ft.color; ctx.lineWidth = 3;
      ctx.strokeText(ft.text, ft.x, ft.y); ctx.fillText(ft.text, ft.x, ft.y);
    }
    ctx.globalAlpha = 1;
  }

  function drawRecharge(now) {
    var a = clamp01((rechargeUntil - now) / 0.4);
    ctx.globalAlpha = a * 0.7;
    ctx.strokeStyle = "#cfd6ff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(rechargeX, rechargeY, 14 * (1.4 - a), 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function drawFinaleTitle(now) {
    var t = now - finaleTitleBorn;
    var inT = clamp01(t / 0.35), outT = clamp01((t - 1.6) / 0.6);
    var scale = clamp(lerp(0.7, 1.05, inT) - 0.05 * Math.max(0, t - 0.35), 0.7, 1.05);
    ctx.save();
    ctx.globalAlpha = inT * (1 - outT);
    ctx.translate(W / 2, H * 0.16);
    ctx.scale(scale, scale);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "bold 52px -apple-system, BlinkMacSystemFont, sans-serif";
    var grd = ctx.createLinearGradient(-220, 0, 220, 0);
    grd.addColorStop(0, "#ff3b5c"); grd.addColorStop(0.33, "#ffb347");
    grd.addColorStop(0.66, "#4cc9f0"); grd.addColorStop(1, "#7c5cff");
    ctx.shadowColor = "rgba(255,235,170,0.9)"; ctx.shadowBlur = 24;
    ctx.fillStyle = grd;
    ctx.fillText("GRAND FINALE", 0, 0);
    ctx.restore();
  }

  // ── Resize + procedural background ─────────────────────────────────
  function resize() {
    if (!canvas || !root) return;
    var rect = root.getBoundingClientRect();
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    W = Math.max(320, Math.floor(rect.width));
    H = Math.max(260, Math.floor(rect.height));
    waterTop = Math.floor(H * 0.80);
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    if (!liveCanvas) { liveCanvas = document.createElement("canvas"); liveCtx = liveCanvas.getContext("2d"); }
    liveCanvas.width = canvas.width; liveCanvas.height = canvas.height;
    genSkyline();
    buildBackground();
  }

  function buildBackground() {
    if (!bgCanvas) { bgCanvas = document.createElement("canvas"); bgCtx = bgCanvas.getContext("2d"); }
    bgCanvas.width = canvas.width; bgCanvas.height = canvas.height;
    var g = bgCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    var sky = g.createLinearGradient(0, 0, 0, waterTop);
    sky.addColorStop(0, "#05060f"); sky.addColorStop(0.55, "#0d1230"); sky.addColorStop(1, "#1a2148");
    g.fillStyle = sky; g.fillRect(0, 0, W, waterTop);

    var rng = mulberry32(1337);

    var aur = g.createRadialGradient(W * 0.7, H * 0.22, 0, W * 0.7, H * 0.22, W * 0.5);
    aur.addColorStop(0, "rgba(59,42,107,0.5)"); aur.addColorStop(1, "rgba(59,42,107,0)");
    g.fillStyle = aur; g.fillRect(0, 0, W, waterTop);

    // moon (store coords for the click hit-test)
    moonX = W * 0.16; moonY = H * 0.2; moonR = Math.max(26, W * 0.045);
    var halo = g.createRadialGradient(moonX, moonY, 0, moonX, moonY, moonR * 2.4);
    halo.addColorStop(0, "rgba(253,251,240,0.5)"); halo.addColorStop(1, "rgba(253,251,240,0)");
    g.fillStyle = halo; g.beginPath(); g.arc(moonX, moonY, moonR * 2.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#f4f1e4"; g.beginPath(); g.arc(moonX, moonY, moonR, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(216,212,194,0.6)";
    for (var c = 0; c < 4; c++) {
      var a = rng() * Math.PI * 2, rr = rng() * moonR * 0.6;
      g.beginPath(); g.arc(moonX + Math.cos(a) * rr, moonY + Math.sin(a) * rr, moonR * (0.12 + rng() * 0.12), 0, Math.PI * 2); g.fill();
    }

    // stars (baked dim base; twinkle subset stored for per-frame shimmer)
    stars = [];
    var starColors = ["#ffffff", "#cfd6ff", "#ffe9c0"];
    for (var si = 0; si < 200; si++) {
      var sx = rng() * W, sy = rng() * waterTop * 0.92, ss = rng() < 0.85 ? 1 : 2;
      var col = starColors[(rng() * starColors.length) | 0];
      g.globalAlpha = 0.3 + rng() * 0.4; g.fillStyle = col; g.fillRect(sx, sy, ss, ss);
      if (rng() < 0.25) stars.push({ x: sx, y: sy, s: ss, color: col, base: 0.5 + rng() * 0.4, tw: 1.5 + rng() * 3, ph: rng() * 6.28 });
    }
    g.globalAlpha = 1;

    var water = g.createLinearGradient(0, waterTop, 0, H);
    water.addColorStop(0, "#0a1230"); water.addColorStop(1, "#070a1c");
    g.fillStyle = water; g.fillRect(0, waterTop, W, H - waterTop);
    g.fillStyle = "rgba(255,255,255,0.04)"; g.fillRect(0, waterTop, W, 2);
  }

  // Generate skyline geometry (drawn dynamically each frame, not baked).
  function genSkyline() {
    buildings = [];
    var rng = mulberry32(7777);
    genBand(rng, "#080a18", 0.10, 0.22);   // distant
    genBand(rng, "#03040c", 0.16, 0.30);   // near
  }
  function genBand(rng, color, minH, maxH) {
    var x = -10;
    while (x < W + 10) {
      var bw = rng() * (W * 0.06) + W * 0.03;
      var hFull = (minH + rng() * (maxH - minH)) * H;
      var b = { x: x, w: bw, hFull: hFull, color: color, antenna: rng() < 0.3, d: rng() * 0.22, windows: [] };
      var cols = Math.max(1, Math.floor(bw / 10)), rows = Math.max(1, Math.floor(hFull / 14));
      for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
        if (rng() < 0.45) continue;
        var wx = 4 + c * 10; if (wx + 4 > bw - 2) continue;
        var fb = 8 + r * 14; if (fb > hFull - 6) continue;   // height above base of window bottom
        b.windows.push({ dx: wx, fb: fb, w: 4, h: 6, warm: rng() < 0.8, lit: rng() < 0.16 });
      }
      buildings.push(b);
      x += bw + rng() * (W * 0.02);
    }
  }

  // ── Key popup ──────────────────────────────────────────────────────
  function installKeyPopup() {
    keyOverlay = document.createElement("div");
    keyOverlay.className = "fireworks-key-overlay";
    keyOverlay.innerHTML = [
      '<div class="fireworks-key-card">',
      '<div class="fireworks-key-header"><h2>\u{1F386} Grand Finale Key</h2>',
      '<button class="fireworks-key-close">&times;</button></div>',
      '<p class="fwk-intro">Every request is a firework. The <b>color</b> is the burst; the <b>emoji</b> is the star at its heart.</p>',
      row("\u{1F386}", "Glorious bloom", "Success (HTTP 200, fast) — full burst in the request color, emoji glowing at center."),
      row("\u{1F422}", "Slow climb", "High latency (≥ slow threshold) — the shell struggles up, then a late, smaller burst."),
      row("\u{1F4A8}", "Smoky dud", "Failure (HTTP 5xx / 429) — a grey colorless fizzle, no emoji star."),
      row("\u{1F30A}", "Splashdown", "Timeout (HTTP 504 / 599) — the shell never clears the skyline and falls into the harbor."),
      rowStar("!", "Warning bloom", "Partial — a real color burst, but the emoji wears a yellow ! ring and some petals fizzle."),
      rowStar("\u{1F5B1}", "Launch one", "★ Click anywhere to fire your own (emoji-free) shell. 10 live successes in 8s sets off the GRAND FINALE!"),
      rowStar("\u{1F315}", "Zap the moon", "★ Click the moon — a UFO descends, demolishes the city, then it rebuilds."),
      '</div>',
    ].join("");
    document.body.appendChild(keyOverlay);
    keyOverlay.querySelector(".fireworks-key-close").addEventListener("click", closeKey);
    keyOverlay.addEventListener("click", function (e) { if (e.target === keyOverlay) closeKey(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeKey(); });

    var toolbar = document.getElementById("toolbar");
    if (toolbar) {
      toolbar.addEventListener("click", function (e) {
        if (visualMode !== "fireworks") return;
        var btn = e.target && e.target.id === "btnShowKey" ? e.target
                : e.target && e.target.closest && e.target.closest("#btnShowKey");
        if (!btn) return;
        e.stopImmediatePropagation(); e.preventDefault();
        keyOverlay.classList.toggle("open");
      }, true);
    }
  }
  function row(icon, title, desc) {
    return '<div class="fwk-row"><div class="fwk-icon">' + icon + '</div><div><div class="fwk-title">' + title + '</div><div class="fwk-desc">' + desc + '</div></div></div>';
  }
  function rowStar(icon, title, desc) {
    return '<div class="fwk-row fwk-star"><div class="fwk-icon">' + icon + '</div><div><div class="fwk-title">' + title + '</div><div class="fwk-desc">' + desc + '</div></div></div>';
  }
  function closeKey() { if (keyOverlay) keyOverlay.classList.remove("open"); }

  // ── Boot ───────────────────────────────────────────────────────────
  function boot() {
    root = document.getElementById("fireworks-root");
    canvas = document.getElementById("fireworks-canvas");
    hudCounts = document.getElementById("fireworks-counts");
    if (!root || !canvas) return;
    ctx = canvas.getContext("2d");
    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      reduceMotion = mq.matches;
      if (mq.addEventListener) mq.addEventListener("change", function (e) { reduceMotion = e.matches; });
    }

    resize();
    window.addEventListener("resize", resize);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(root);
    canvas.addEventListener("click", onCanvasClick);

    if (window.__FACES_STATS__) {
      var statsEl = document.createElement("div");
      statsEl.className = "fun-stats-hud";
      root.appendChild(statsEl);
      window.__FACES_STATS__.attachHUD(statsEl);
    }

    subscribeDebug();
    installKeyPopup();
    applySettings();

    if ((settings().visualMode || "classic") === "fireworks") { visualMode = "fireworks"; start(); }
  }

  function subscribeDebug() {
    if (!window.__FACES_DEBUG__) { setTimeout(subscribeDebug, 60); return; }
    window.__FACES_DEBUG__.subscribe(function (entry) {
      if (!entry) {
        shells.length = sparks.length = smokes.length = bursts.length = 0;
        flashes.length = floaters.length = ripples.length = debris.length = 0;
        aloft = 0; manualLive = 0; successTimes.length = 0;
        return;
      }
      if (visualMode !== "fireworks") return;
      spawnFromRequest(entry);
    });
  }

  function applySettings() {
    var s = settings();
    slowMs = s.slowThresholdMs || 300;
    maxRps = clamp(Number(s.funModeRatePerSec || s.buoyantRatePerSec) || 0.5, 0.5, 200);   // 200 = super-mode ceiling (Swift caps stored value to 20 unless super mode)
  }

  // ── Public hooks (called by buoyant.js dispatcher / WebController) ──
  window.__fireworksSetMode__ = function (mode) {
    visualMode = mode;
    if (mode === "fireworks") {
      start();
      var b = document.getElementById("btnShowKey");
      if (b) b.style.display = "inline-block";
    } else {
      stop();
      closeKey();
    }
  };

  window.__applyFireworksSettings__ = function (json) {
    var s = (typeof json === "string") ? (safeJson(json) || {}) : (json || {});
    slowMs = s.slowThresholdMs || 300;
    maxRps = clamp(Number(s.funModeRatePerSec || s.buoyantRatePerSec) || 0.5, 0.5, 200);   // 200 = super-mode ceiling (Swift caps stored value to 20 unless super mode)
    if (window.__syncRateControl__) window.__syncRateControl__(maxRps);
    return true;
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

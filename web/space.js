// space.js — Space visual mode for Faces request events.
//
// Every completed Faces request launches a rocket from Earth toward the Moon.
// The rocket body is painted the returned color; the returned emoji rides in
// the porthole as the pilot/passenger. Failures lose thrust and spin back.
//
// Architecture: subscribes to the shared __FACES_DEBUG__ bus (never owns
// polling), full-bleed canvas, RAF loop stops when mode is inactive.
// buoyant.js owns body-class management and calls window.__spaceSetMode__.
//
// All emoji literals are \u-escaped per BUOYANT-MODE §10.
//
// SPDX-License-Identifier: Apache-2.0

(function () {
  "use strict";

  // \u-escaped: safe regardless of charset (see BUOYANT-MODE §10)
  var FALLBACK_EMOJI  = "❓";        // ❓
  var DIZZY_EMOJI     = "😵";  // 😵
  var SLEEPY_EMOJI    = "😴";  // 😴
  var FALLBACK_COLOR  = "#8b8fa8";       // silver-grey for missing color

  var MAX_ROCKETS    = 80;
  var MAX_ASTEROIDS  = 12;

  // Anchor fractions measured from space.png (1672×941):
  //   Earth center  ~ (170, 870)  → fx=0.102, fy=0.925
  //   Moon center   ~ (1420, 215) → fx=0.849, fy=0.228
  //   Red planet    ~ (80,  185)  → fx=0.048, fy=0.197  (upper-left; alien home)
  // drawBackground cover-scales bottom-anchored, same mapping as cavern/buoyant.
  var EARTH_FX    = 0.102;
  var EARTH_FY    = 0.925;
  var MOON_FX     = 0.849;
  var MOON_FY     = 0.228;
  // Radii as fractions of image WIDTH (scale-invariant)
  var EARTH_R_FRAC = 0.130;
  var MOON_R_FRAC  = 0.115;
  // Red planet (alien ship home — upper-left of image)
  var ALIEN_FX = 0.048;
  var ALIEN_FY = 0.197;

  var root, canvas, ctx, hudCounts;
  var dpr = 1, width = 800, height = 500;
  var visualMode = "classic";
  var seq = 0, running = false, raf = 0, lastFrame = 0;
  var rockets = [];
  var asteroids = [];
  var stars = [];            // extra twinkle layer on top of the background
  var admittedTimes = [];
  var blastCount = 0;
  var blastPill = null;
  var alienShip = null;      // alien saucer attack state during blast

  var bg = new Image();
  bg.src = "space.png";

  // ===================================================================
  // Image-anchored coordinate mapping (bottom-anchored cover-scale)
  // ===================================================================

  function bgMap() {
    if (!(bg.complete && bg.naturalWidth)) return null;
    var iw = bg.naturalWidth, ih = bg.naturalHeight;
    var scale = Math.max(width / iw, height / ih);
    return { iw: iw, ih: ih, scale: scale,
             sx: (iw - width / scale) / 2,
             sy: Math.max(0, ih - height / scale) };
  }

  function mx(fx) {
    var m = bgMap();
    return m ? (fx * m.iw - m.sx) * m.scale : fx * width;
  }

  function my(fy) {
    var m = bgMap();
    return m ? (fy * m.ih - m.sy) * m.scale : fy * height;
  }

  function earthPos()  { return { x: mx(EARTH_FX),  y: my(EARTH_FY)  }; }
  function moonPos()   { return { x: mx(MOON_FX),   y: my(MOON_FY)   }; }
  function earthR()    { var m = bgMap(); return m ? EARTH_R_FRAC * m.iw * m.scale : 80; }
  function moonR()     { var m = bgMap(); return m ? MOON_R_FRAC  * m.iw * m.scale : 60; }
  function alienPos()  { return { x: mx(ALIEN_FX),  y: my(ALIEN_FY)  }; }

  // ===================================================================
  // Boot & lifecycle
  // ===================================================================

  function boot() {
    root      = document.getElementById("space-root");
    canvas    = document.getElementById("space-canvas");
    hudCounts = document.getElementById("space-counts");
    if (!root || !canvas) return;
    ctx = canvas.getContext("2d");

    resize();
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(root);

    // Click-to-blast: fire a laser at any rocket in flight
    canvas.addEventListener("click", function (e) {
      if (visualMode !== "space") return;
      var hit = rocketAt(e.offsetX, e.offsetY);
      if (hit) blastRocket(hit, e.offsetX, e.offsetY);
    });
    canvas.addEventListener("mousemove", function (e) {
      if (visualMode !== "space") return;
      canvas.style.cursor = rocketAt(e.offsetX, e.offsetY) ? "crosshair" : "default";
    });

    installKeyPopup();
    generateStars(40);
    subscribeDebug();

    // Attach shared stats HUD to the space scene root.
    if (window.__FACES_STATS__) {
      var statsEl = document.createElement("div");
      statsEl.className = "fun-stats-hud";
      root.appendChild(statsEl);
      window.__FACES_STATS__.attachHUD(statsEl);
    }

    var initMode = (window.__FACES_SETTINGS__ || {}).visualMode || "classic";
    if (initMode === "space") { visualMode = "space"; startSpace(); }
  }

  function subscribeDebug() {
    var bus = window.__FACES_DEBUG__;
    if (!bus) { setTimeout(subscribeDebug, 60); return; }
    bus.subscribe(function (entry) {
      if (!entry) { rockets.length = 0; asteroids.length = 0; return; }
      if (visualMode !== "space") return;
      // Rate limiter: minimum-interval gate (works for fractional rates like 0.5/s).
      var nowMs = performance.now();
      while (admittedTimes.length && nowMs - admittedTimes[0] > 1000) admittedTimes.shift();
      var minIntervalMs = 1000 / maxRatePerSec();
      if (admittedTimes.length > 0 && nowMs - admittedTimes[admittedTimes.length - 1] < minIntervalMs) return;
      if (admittedTimes.length >= Math.ceil(maxRatePerSec())) return;
      admittedTimes.push(nowMs);
      spawnFromRequest(entry);
    });
  }

  function maxRatePerSec() {
    var s = window.__FACES_SETTINGS__ || {};
    var r = Number(s.funModeRatePerSec || s.buoyantRatePerSec);
    return Number.isFinite(r) ? Math.max(0.5, Math.min(20, r)) : 0.5;
  }

  function generateStars(count) {
    stars = [];
    for (var i = 0; i < count; i++) {
      stars.push({
        x: Math.random(),
        y: Math.random() * 0.72,
        r: 0.5 + Math.random() * 1.5,
        phase: Math.random() * Math.PI * 2,
        speed: 0.4 + Math.random() * 1.6,
      });
    }
  }

  function resize() {
    if (!canvas || !root) return;
    var rect = root.getBoundingClientRect();
    dpr    = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    width  = Math.max(320, Math.floor(rect.width));
    height = Math.max(240, Math.floor(rect.height));
    canvas.width  = Math.floor(width  * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width  = width  + "px";
    canvas.style.height = height + "px";
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function startSpace() {
    resize();
    if (running) return;
    running   = true;
    lastFrame = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stopSpace() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function frame(now) {
    if (!running) return;
    lastFrame = now;
    var t = now / 1000;
    update(t);
    draw(t);
    raf = requestAnimationFrame(frame);
  }

  // ===================================================================
  // Classification (same logic as buoyant.js / cavern.js)
  // ===================================================================

  function classify(entry) {
    var parsed    = safeJson(entry.body, null);
    var parseFail = !!entry.body && parsed == null;
    var status    = Number(entry.status || 0);
    var hasColor  = !!(parsed && validColor(parsed.color));
    var rawEmoji  = normalizeEmoji(parsed && parsed.smiley);
    var hasEmoji  = rawEmoji !== FALLBACK_EMOJI;
    var failed    = status === 0 || status === 504 || status === 429 || status >= 500 || parseFail;
    var partial   = !failed && !!(parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0);
    var thresh    = Number((window.__FACES_SETTINGS__ || {}).slowThresholdMs) || 900;
    var slow      = Number(entry.latencyMs || 0) >= thresh;
    var timeout   = (status === 429 || status === 504 || status === 0);

    var emoji;
    if (failed && !hasEmoji) {
      emoji = timeout ? SLEEPY_EMOJI : DIZZY_EMOJI;
    } else {
      emoji = hasEmoji ? rawEmoji : FALLBACK_EMOJI;
    }

    return {
      id: ++seq,
      which: entry.which || "center",
      failed: failed, partial: partial, slow: slow, timeout: timeout,
      hasColor: hasColor, hasEmoji: hasEmoji,
      color: hasColor ? parsed.color.trim() : FALLBACK_COLOR,
      emoji: emoji,
      latencyMs: Number(entry.latencyMs || 0),
    };
  }

  // ===================================================================
  // Spawn
  // ===================================================================

  function spawnFromRequest(entry) {
    var e = classify(entry);
    if (rockets.length < MAX_ROCKETS) {
      rockets.push(makeRocket(e));
    }
    if ((e.failed || e.partial) && asteroids.length < MAX_ASTEROIDS) {
      spawnAsteroids(e.failed ? 2 : 1);
    }
  }

  // Quadratic bezier point helper (used by both makeRocket and drawFailedRocket)
  function bezier(t, p0, cp, p1) {
    var m = 1 - t;
    return m * m * p0 + 2 * m * t * cp + t * t * p1;
  }

  function makeRocket(e) {
    var ep = earthPos(), mp = moonPos();
    var er = earthR(),   mr = moonR();
    // Edge cells orbit Moon clockwise (opposite direction to center cells)
    var reverseOrbit = (e.which === "edge");

    // Launch from upper-right arc of Earth's visible surface — wider angle spread
    var launchAngle = rand(-Math.PI * 0.88, -Math.PI * 0.22);
    var launchX = ep.x + Math.cos(launchAngle) * er * 0.78;
    var launchY = ep.y + Math.sin(launchAngle) * er * 0.78;

    // Arrive near Moon surface — wider arrival angle for spread
    var arriveAngle = rand(Math.PI * 0.52, Math.PI * 1.32);
    var arriveX = mp.x + Math.cos(arriveAngle) * mr * 0.88;
    var arriveY = mp.y + Math.sin(arriveAngle) * mr * 0.88;

    // Arc control point: wide lateral + vertical spread so paths fan out clearly
    var midX = (launchX + arriveX) * 0.5 + rand(-width * 0.26, width * 0.26);
    var midY = (launchY + arriveY) * 0.5 - height * rand(0.06, 0.44);

    // Pre-compute the stall point (where failures reverse course)
    // For p < failPoint we map to bezier(p/failPoint * 0.5), so at p=failPoint
    // the rocket is at bezier(0.5) of the full arc.
    var failPoint  = e.timeout ? 0.28 : 0.46;
    var stallX     = bezier(0.5, launchX, midX, arriveX);
    var stallY     = bezier(0.5, launchY, midY, arriveY);

    var dur;
    if (e.failed)     dur = rand(4.0, 6.0);
    else if (e.slow)  dur = rand(18, 26);
    else              dur = rand(11, 17);

    return {
      id: e.id,
      born: performance.now() / 1000 + (e.failed ? 0 : rand(0, 1.0)),
      duration: dur,
      color: e.color, emoji: e.emoji,
      failed: e.failed, partial: e.partial, slow: e.slow, timeout: e.timeout,
      hasColor: e.hasColor, hasEmoji: e.hasEmoji,
      // Bezier arc
      x0: launchX, y0: launchY,
      cx: midX,    cy: midY,
      x1: arriveX, y1: arriveY,
      // Orbit (success path): Moon CCW for center, CW for edge (reverseOrbit)
      reverseOrbit:    reverseOrbit,
      orbitFrac:       0.62,
      orbitStartAngle: arriveAngle,
      // Failure reversal (pre-computed so drawFailedRocket is deterministic)
      failPoint: failPoint,
      stallX: stallX, stallY: stallY,
      failReturnX: ep.x + rand(-50, 50),
      failReturnY: ep.y - er * 0.42,
      // Per-rocket variation
      size:   rand(0.85, 1.18),
      wobble: (!e.hasColor || !e.hasEmoji || e.partial) ? rand(0.6, 1.3) : 0,
      phase:  rand(0, Math.PI * 2),
      blasted: false,
    };
  }

  function spawnAsteroids(count) {
    for (var i = 0; i < count; i++) {
      asteroids.push({
        born:      performance.now() / 1000,
        duration:  rand(3.5, 6.0),
        x: rand(0.12, 0.88), y: rand(0.06, 0.65),
        vx: rand(-0.045, 0.045), vy: rand(0.012, 0.045),
        rot: rand(0, Math.PI * 2),
        rotSpeed: rand(-2.2, 2.2),
        r: rand(6, 14),
      });
    }
  }

  // ===================================================================
  // Update
  // ===================================================================

  function update(t) {
    for (var i = rockets.length - 1; i >= 0; i--) {
      var r = rockets[i];
      if (r.blasted) {
        if (t - r.blastT > 2.8) rockets.splice(i, 1);
      } else if ((t - r.born) / r.duration > 1.08) {
        rockets.splice(i, 1);
      }
    }
    for (var j = asteroids.length - 1; j >= 0; j--) {
      if ((t - asteroids[j].born) / asteroids[j].duration > 1) asteroids.splice(j, 1);
    }
    if (hudCounts) hudCounts.textContent = rockets.length + " missions";
  }

  // ===================================================================
  // Draw
  // ===================================================================

  function draw(t) {
    ctx.clearRect(0, 0, width, height);
    drawBackground();
    drawStars(t);
    drawAsteroids(t);
    for (var i = 0; i < rockets.length; i++) {
      var r = rockets[i];
      if (t < r.born) continue;
      if (r.blasted) { drawBlastedRocket(r, t); continue; }
      var age = clamp01((t - r.born) / r.duration);
      if (r.failed) drawFailedRocket(r, age, t);
      else          drawSuccessRocket(r, age, t);
    }
    drawAlienShip(t);
  }

  function drawBackground() {
    ctx.imageSmoothingEnabled = false;
    if (bg.complete && bg.naturalWidth) {
      var m = bgMap();
      var sw = width / m.scale, sh = height / m.scale;
      ctx.drawImage(bg, m.sx, Math.max(0, m.sy), sw, sh, 0, 0, width, height);
    } else {
      var g = ctx.createLinearGradient(0, 0, 0, height);
      g.addColorStop(0, "#020818");
      g.addColorStop(0.5, "#040f2a");
      g.addColorStop(1, "#0a1440");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingEnabled = true;
  }

  function drawStars(t) {
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var tw = 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.55 * tw;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(s.x * width, s.y * height, s.r * (0.65 + 0.35 * tw), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawAsteroids(t) {
    for (var i = 0; i < asteroids.length; i++) {
      var a = asteroids[i];
      var p = clamp01((t - a.born) / a.duration);
      var ax = (a.x + a.vx * p) * width;
      var ay = (a.y + a.vy * p) * height;
      var alpha = p > 0.75 ? 1 - (p - 0.75) / 0.25 : 1;
      ctx.save();
      ctx.globalAlpha = alpha * 0.88;
      ctx.translate(ax, ay);
      ctx.rotate(a.rot + a.rotSpeed * (t - a.born));
      ctx.fillStyle   = "#7a6c58";
      ctx.strokeStyle = "#45392a";
      ctx.lineWidth   = 1.5;
      var r = a.r;
      ctx.beginPath();
      ctx.moveTo(r * 1.1, 0);
      ctx.quadraticCurveTo(r * 0.8, -r * 1.2, 0, -r);
      ctx.quadraticCurveTo(-r * 1.1, -r * 0.7, -r, r * 0.2);
      ctx.quadraticCurveTo(-r * 0.6, r * 1.1, r * 0.1, r * 0.9);
      ctx.quadraticCurveTo(r * 0.9, r * 0.8, r * 1.1, 0);
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  }

  // ===================================================================
  // Rocket pose math (shared by draw + hit-test so they can't disagree)
  // ===================================================================

  function rocketScale(r) {
    return Math.max(0.42, Math.min(0.88, Math.min(width, height) / 1000)) * r.size;
  }

  function successPose(r, p, t) {
    var x, y, angle;
    if (p < r.orbitFrac) {
      // --- Arc phase: bezier Earth → Moon surface ---
      var fp = p / r.orbitFrac;          // remap to 0..1 within the arc
      var bx = bezier(fp, r.x0, r.cx, r.x1);
      var by = bezier(fp, r.y0, r.cy, r.y1);
      var dp = 0.008;
      var nx = bezier(Math.min(1, fp + dp), r.x0, r.cx, r.x1);
      var ny = bezier(Math.min(1, fp + dp), r.y0, r.cy, r.y1);
      x = bx; y = by;
      angle = Math.atan2(ny - by, nx - bx) + Math.PI / 2;
      if (r.wobble > 0) {
        x     += Math.sin(t * 4.5 + r.phase) * r.wobble * 4;
        y     += Math.cos(t * 3.9 + r.phase) * r.wobble * 2;
        angle += Math.sin(t * 5.2 + r.phase) * r.wobble * 0.12;
      }
    } else {
      // --- Orbit phase: one loop around the Moon ---
      // Center rockets orbit CCW (decreasing θ); edge rockets orbit CW (increasing θ)
      var mp = moonPos(), mr = moonR();
      var orbitP     = (p - r.orbitFrac) / (1 - r.orbitFrac);   // 0..1
      var orbitAngle = r.reverseOrbit
        ? r.orbitStartAngle + orbitP * Math.PI * 2   // CW (edge)
        : r.orbitStartAngle - orbitP * Math.PI * 2;  // CCW (center)
      x     = mp.x + Math.cos(orbitAngle) * (mr * 0.88);
      y     = mp.y + Math.sin(orbitAngle) * (mr * 0.88);
      angle = r.reverseOrbit ? orbitAngle + Math.PI : orbitAngle;
      if (r.wobble > 0) angle += Math.sin(t * 5.2 + r.phase) * r.wobble * 0.08;
    }
    return { x: x, y: y, angle: angle, scale: rocketScale(r) };
  }

  function failedPose(r, p, t) {
    var x, y, angle;
    if (p < r.failPoint) {
      // Normal flight up to the stall point (mapped to first half of the arc)
      var fp = (p / r.failPoint) * 0.5;
      var bx = bezier(fp, r.x0, r.cx, r.x1);
      var by = bezier(fp, r.y0, r.cy, r.y1);
      var dp = 0.008;
      var nx = bezier(Math.min(1, fp + dp), r.x0, r.cx, r.x1);
      var ny = bezier(Math.min(1, fp + dp), r.y0, r.cy, r.y1);
      x = bx; y = by;
      angle = Math.atan2(ny - by, nx - bx) + Math.PI / 2;
    } else {
      // Spin off-course and fall back toward Earth
      var fp2 = (p - r.failPoint) / (1 - r.failPoint);
      x = lerp(r.stallX, r.failReturnX, easeInQuad(fp2));
      y = lerp(r.stallY, r.failReturnY, easeInQuad(fp2));
      var baseAngle = Math.atan2(r.failReturnY - r.stallY, r.failReturnX - r.stallX) + Math.PI / 2;
      angle = baseAngle + fp2 * Math.PI * 3 * (r.id % 2 ? 1 : -1);
    }
    return { x: x, y: y, angle: angle, scale: rocketScale(r) };
  }

  // ===================================================================
  // Drawing rockets
  // ===================================================================

  function drawSuccessRocket(r, p, t) {
    var inOrbit = p >= r.orbitFrac;
    var orbitP  = inOrbit ? (p - r.orbitFrac) / (1 - r.orbitFrac) : 0;
    // Visible through the whole arc + most of the orbit; fade during last 20% of orbit
    var alpha   = (inOrbit && orbitP > 0.80) ? 1 - (orbitP - 0.80) / 0.20 : 1;
    var pose    = successPose(r, p, t);

    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.angle);
    ctx.scale(pose.scale, pose.scale);

    drawRocketShape(r.color, r.emoji, r.partial, false, t, r.phase);
    if (r.partial)          drawBadge(28, -70, "!");
    else if (!r.hasEmoji)   drawBadge(28, -70, "?");

    ctx.restore();

    // Arrival sparkle fires as rocket reaches the Moon (last 12% of arc phase)
    if (!inOrbit && p > r.orbitFrac * 0.88) {
      var sp = (p - r.orbitFrac * 0.88) / (r.orbitFrac * 0.12);
      drawArrivalSparkle(pose.x, pose.y, sp, r.color);
    }

    // Faint dashed orbit ring — edge rockets show CW ring, center show CCW ring
    // (both are the same circle; direction is implied by the moving rocket)
    if (inOrbit && alpha > 0.05) {
      var moonPt = moonPos(), mRing = moonR();
      ctx.save();
      ctx.globalAlpha = 0.12 * clamp01(alpha);
      ctx.strokeStyle = r.color || "#88aaff";
      ctx.lineWidth   = 1.0;
      ctx.setLineDash([4, 9]);
      ctx.beginPath();
      ctx.arc(moonPt.x, moonPt.y, mRing * 0.88, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  function drawFailedRocket(r, p, t) {
    var alpha = p > 0.80 ? 1 - (p - 0.80) / 0.20 : 1;
    var pose  = failedPose(r, p, t);
    var tumbling = (p >= r.failPoint);

    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.angle);
    ctx.scale(pose.scale, pose.scale);

    drawRocketShape(r.color, r.emoji, false, true, t, r.phase);
    // Smoke trail when tumbling back
    if (tumbling) drawSmoke(0, 46, (p - r.failPoint) / (1 - r.failPoint));

    ctx.restore();
  }

  // ===================================================================
  // Core rocket body (all coords in rocket-local space, nose up = -y)
  // ===================================================================

  function drawRocketShape(color, emoji, partial, failed, t, phase) {
    var bH = 80, bW = 28, noseH = 32, finW = 16, finH = 24;

    // --- Exhaust / smoke ---
    if (!failed) {
      var flicker = 0.65 + 0.35 * Math.sin(t * 22 + phase);
      drawExhaust(0, bH / 2 + 6, flicker, color);
    } else {
      drawSmoke(0, bH / 2 + 4, 0.5);
    }

    // --- Fins (behind body) ---
    ctx.fillStyle   = failed ? "#6a6a7e" : darken(color, 0.18);
    ctx.strokeStyle = failed ? "#454558" : darken(color, 0.34);
    ctx.lineWidth   = 1.5;
    // Left fin
    ctx.beginPath();
    ctx.moveTo(-bW / 2,        bH / 2);
    ctx.lineTo(-bW / 2 - finW, bH / 2 + finH * 0.6);
    ctx.lineTo(-bW / 2,        bH / 2 - finH);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // Right fin
    ctx.beginPath();
    ctx.moveTo(bW / 2,        bH / 2);
    ctx.lineTo(bW / 2 + finW, bH / 2 + finH * 0.6);
    ctx.lineTo(bW / 2,        bH / 2 - finH);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // --- Body capsule ---
    ctx.fillStyle   = failed ? "#8a8a9e" : color;
    ctx.strokeStyle = "rgba(0,0,0,0.38)";
    ctx.lineWidth   = 2;
    roundRect(-bW / 2, -bH / 2, bW, bH, 9);
    ctx.fill(); ctx.stroke();

    // --- Body shading (gradient inside clip) ---
    ctx.save();
    ctx.clip();  // clips to the rounded rect path still active
    var grad = ctx.createLinearGradient(-bW / 2, 0, bW / 2, 0);
    grad.addColorStop(0,    "rgba(255,255,255,0.13)");
    grad.addColorStop(0.38, "rgba(255,255,255,0.03)");
    grad.addColorStop(1,    "rgba(0,0,0,0.14)");
    ctx.fillStyle = grad;
    ctx.fillRect(-bW / 2, -bH / 2, bW, bH);
    ctx.restore();

    // --- Nose cone ---
    ctx.fillStyle   = failed ? "#6e6e82" : darken(color, 0.15);
    ctx.strokeStyle = "rgba(0,0,0,0.32)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(0, -bH / 2 - noseH);
    ctx.quadraticCurveTo( bW / 2, -bH / 2 - noseH * 0.28,  bW / 2, -bH / 2);
    ctx.lineTo(-bW / 2, -bH / 2);
    ctx.quadraticCurveTo(-bW / 2, -bH / 2 - noseH * 0.28, 0, -bH / 2 - noseH);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    // Nose highlight
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.ellipse(-bW * 0.18, -bH / 2 - noseH * 0.62, bW * 0.18, noseH * 0.35, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // --- Porthole window ---
    var pcy = -bH / 2 + 32;
    var pr  = 11;
    ctx.fillStyle   = failed ? "#9ab0c8" : "#c5e5ff";
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    ctx.arc(0, pcy, pr, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();

    // Emoji inside porthole (clipped to circle)
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, pcy, pr - 1, 0, Math.PI * 2);
    ctx.clip();
    ctx.font = '17px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji || FALLBACK_EMOJI, 0, pcy + 1);
    ctx.restore();

    // Porthole rim glint
    ctx.strokeStyle = "rgba(180,220,255,0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, pcy, pr - 3, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawExhaust(x, y, flicker, color) {
    // Outer glow (blue-white hot)
    var g1 = ctx.createRadialGradient(x, y + 2, 1, x, y + 18 * flicker, 16 * flicker);
    g1.addColorStop(0,   "rgba(255,255,210,0.95)");
    g1.addColorStop(0.3, "rgba(100,180,255,0.72)");
    g1.addColorStop(1,   "rgba(60,100,200,0)");
    ctx.fillStyle = g1;
    ctx.beginPath();
    ctx.ellipse(x, y + 11 * flicker, 9 * flicker, 20 * flicker, 0, 0, Math.PI * 2);
    ctx.fill();
    // Inner white core
    var g2 = ctx.createRadialGradient(x, y, 0, x, y, 6 * flicker);
    g2.addColorStop(0, "rgba(255,255,255,0.98)");
    g2.addColorStop(1, "rgba(255,255,180,0)");
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(x, y + 3, 6 * flicker, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSmoke(x, y, p) {
    ctx.save();
    ctx.fillStyle = "rgba(130,120,110,0.42)";
    for (var i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(x - i * 9, y + i * 10, 5 + i * 4 + p * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawArrivalSparkle(x, y, p, color) {
    ctx.save();
    ctx.globalAlpha = clamp01(1 - p);
    var n = 8;
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2;
      var dist = p * 28;
      ctx.fillStyle = (i % 2 === 0) ? color : "#ffffff";
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * dist, y + Math.sin(a) * dist, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawAlienShip(t) {
    if (!alienShip) return;
    var ft = t - alienShip.born;
    if (ft > alienShip.duration) { alienShip = null; return; }
    var p = ft / alienShip.duration;

    // Phase timings (0..1) — total duration 1.2 s:
    //   0.00–0.07  zip in from start pos (barely visible)
    //   0.07–0.22  hover at shooting position
    //   0.22–0.48  fire green laser
    //   0.48–1.00  retreat + fade
    var shipX, shipY, alpha;
    if (p < 0.07) {
      var t1 = p / 0.07;
      shipX  = lerp(alienShip.startX, alienShip.shootX, easeOutCubic(t1));
      shipY  = lerp(alienShip.startY, alienShip.shootY, easeOutCubic(t1));
      alpha  = t1;
    } else if (p < 0.48) {
      shipX = alienShip.shootX;
      shipY = alienShip.shootY + Math.sin(ft * 11) * 3;  // hover wobble
      alpha = 1.0;
    } else {
      var t2 = (p - 0.48) / 0.52;
      shipX  = lerp(alienShip.shootX, alienShip.startX, easeInQuad(t2));
      shipY  = lerp(alienShip.shootY, alienShip.startY, easeInQuad(t2));
      alpha  = 1 - t2;
    }

    // Green laser beam during fire phase
    if (p >= 0.22 && p < 0.52) {
      var lp = (p - 0.22) / 0.30;
      ctx.save();
      ctx.globalAlpha = clamp01((1 - lp) * 0.97 * alpha);
      ctx.strokeStyle = "#22ff55";
      ctx.lineWidth   = 3.0;
      ctx.shadowColor = "#00ff44";
      ctx.shadowBlur  = 18;
      ctx.lineCap     = "round";
      ctx.beginPath();
      ctx.moveTo(shipX, shipY + 7);      // from saucer underside emitter
      ctx.lineTo(alienShip.targetX, alienShip.targetY);
      ctx.stroke();
      ctx.restore();
    }

    // Draw the saucer
    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(shipX, shipY);
    drawSaucer(t, p);
    ctx.restore();
  }

  function drawSaucer(t, p) {
    // Classic flying saucer: disc body + dome + blinking rim lights + alien eyes
    var dW = 30, dH = 9, domeH = 14;

    // Drop shadow
    ctx.save();
    ctx.fillStyle   = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(2, 5, dW * 0.9, dH * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Disc body (metallic grey-green)
    var discGrad = ctx.createLinearGradient(-dW, -dH, dW, dH);
    discGrad.addColorStop(0,   "#3a4a2e");
    discGrad.addColorStop(0.4, "#7ab060");
    discGrad.addColorStop(0.7, "#4a6030");
    discGrad.addColorStop(1,   "#22320e");
    ctx.fillStyle   = discGrad;
    ctx.strokeStyle = "#1a3010";
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, dW, dH, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Blinking rim lights (alternating green / dim)
    var nL = 8;
    for (var i = 0; i < nL; i++) {
      var la = (i / nL) * Math.PI * 2;
      var lx = Math.cos(la) * dW * 0.80;
      var ly = Math.sin(la) * dH * 0.80;
      var on = Math.sin(t * 9 + i * 1.3) > 0;
      ctx.fillStyle = on ? "#44ff66" : "#1a5522";
      ctx.beginPath();
      ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Dome (green-tinted glass, upper half)
    ctx.fillStyle   = "rgba(80,200,60,0.50)";
    ctx.strokeStyle = "rgba(120,255,100,0.55)";
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, -dH * 0.25, dW * 0.52, domeH, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Alien silhouette inside dome: head + two big dark eyes
    var eyeY = -dH * 0.25 - domeH * 0.38;
    ctx.fillStyle = "rgba(0,18,0,0.82)";
    ctx.beginPath();
    ctx.ellipse(0, eyeY - 2, 5, 6, 0, 0, Math.PI * 2);  // head
    ctx.fill();
    ctx.fillStyle = "#001a00";
    ctx.beginPath();
    ctx.ellipse(-2.8, eyeY - 2, 2.2, 3.2, -0.3, 0, Math.PI * 2);  // left eye
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse( 2.8, eyeY - 2, 2.2, 3.2,  0.3, 0, Math.PI * 2);  // right eye
    ctx.fill();

    // Bottom weapon emitter (glows green when firing)
    var firing = (p >= 0.22 && p < 0.52);
    ctx.fillStyle = firing ? "#00ff55" : "#226633";
    if (firing) {
      ctx.shadowColor = "#00ff55";
      ctx.shadowBlur  = 10;
    }
    ctx.beginPath();
    ctx.arc(0, dH * 0.6, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ===================================================================
  // Click-to-blast interaction (mirrors Buoyant pop / Cavern crush)
  // ===================================================================

  function rocketAt(px, py) {
    var t = performance.now() / 1000;
    for (var i = rockets.length - 1; i >= 0; i--) {
      var r = rockets[i];
      if (r.blasted || t < r.born) continue;
      var age = (t - r.born) / r.duration;
      if (age < 0 || age > 1) continue;
      var pose = r.failed ? failedPose(r, clamp01(age), t) : successPose(r, clamp01(age), t);
      var s = pose.scale;
      var dx = px - pose.x, dy = py - pose.y;
      // Hit box: use radial distance so rotation doesn't matter (~half-rocket radius)
      if (dx * dx + dy * dy <= (62 * s) * (62 * s)) return r;
    }
    return null;
  }

  function blastRocket(r, clickX, clickY) {
    var t   = performance.now() / 1000;
    var age = clamp01((t - r.born) / r.duration);
    var pose = r.failed ? failedPose(r, age, t) : successPose(r, age, t);
    r.blasted    = true;
    r.blastT     = t;
    r.blastX     = pose.x;
    r.blastY     = pose.y;
    r.blastScale = pose.scale;
    r.blastAngle = pose.angle;
    r.duration   = (t - r.born) + 3.2;
    // Alien ship swoops in from the red planet area and fires a green laser.
    // IMPORTANT: alienPos() can be off-screen (cover-crop clips the left edge),
    // so clamp to always-visible coords so the ship is never invisible.
    var ap       = alienPos();
    var startX   = Math.max(25, ap.x);
    var startY   = Math.max(15, Math.min(height * 0.32, ap.y));
    // Shooting position: clearly to the right of start, angled toward target
    var shootX   = startX + 85 + Math.min(70, (pose.x - startX) * 0.14);
    var shootY   = startY + (pose.y - startY) * 0.07;
    alienShip = {
      born: t, duration: 1.2,
      startX: startX, startY: startY,
      shootX: shootX, shootY: shootY,
      targetX: pose.x, targetY: pose.y,
    };
    bumpBlastCounter();
    r.blastNum = blastCount;
  }

  function drawBlastedRocket(r, t) {
    var ft      = Math.max(0, t - r.blastT);
    var s       = r.blastScale;
    var alpha   = ft > 1.6 ? Math.max(0, 1 - (ft - 1.6) / 1.1) : 1;
    if (alpha <= 0) return;

    // Explosion shards (first 0.38s)
    if (ft < 0.38) {
      var bp = ft / 0.38;
      ctx.save();
      ctx.globalAlpha = (1 - bp) * alpha;
      ctx.strokeStyle = r.color;
      ctx.lineWidth   = 4 * s;
      ctx.lineCap     = "round";
      for (var i = 0; i < 10; i++) {
        var a  = (i / 10) * Math.PI * 2 + r.phase;
        var r0 = (8  + bp * 52) * s;
        var r1 = r0 + 18 * s * (1 - bp);
        ctx.beginPath();
        ctx.moveTo(r.blastX + Math.cos(a) * r0, r.blastY + Math.sin(a) * r0);
        ctx.lineTo(r.blastX + Math.cos(a) * r1, r.blastY + Math.sin(a) * r1);
        ctx.stroke();
      }
      if (bp < 0.35) {
        ctx.globalAlpha = (1 - bp / 0.35) * 0.88;
        ctx.fillStyle   = "#ffffff";
        ctx.beginPath();
        ctx.arc(r.blastX, r.blastY, (8 + bp * 42) * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Score floater: "+1" normally, gold total on every 10th blast
    if (ft < 0.95) {
      var milestone = r.blastNum && r.blastNum % 10 === 0;
      ctx.save();
      ctx.globalAlpha = (1 - ft / 0.95) * alpha;
      ctx.font        = "bold " + (milestone ? 30 : 20) + "px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth    = 4;
      ctx.strokeStyle  = "rgba(0,10,30,0.70)";
      ctx.fillStyle    = milestone ? "#ffd93d" : "#00ffee";
      var fy    = r.blastY - 62 * s - ft * 44;
      var label = milestone ? (r.blastNum + "!") : "+1";
      ctx.strokeText(label, r.blastX, fy);
      ctx.fillText(label, r.blastX, fy);
      ctx.restore();
    }

    // Tumbling debris: a broken rocket fragment falling with the pilot visible
    var debrisVx = (r.id % 2 ? 1 : -1) * 22;
    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(r.blastX + debrisVx * ft, r.blastY + 0.5 * 580 * ft * ft);
    ctx.rotate(r.blastAngle + ft * 3.8 * (r.id % 2 ? 1 : -1));
    var ds = s * Math.max(0, 1 - ft * 0.25);
    ctx.scale(ds, ds);
    ctx.fillStyle   = darken(r.color, 0.32);
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth   = 1.5;
    roundRect(-11, -28, 22, 56, 6);
    ctx.fill(); ctx.stroke();
    ctx.font = '13px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha *= 0.9;
    ctx.fillText(r.emoji || FALLBACK_EMOJI, 0, -7);
    ctx.restore();
  }

  // ===================================================================
  // Blast scoreboard (mirrors Buoyant pop-pill / Cavern crush-pill)
  // ===================================================================

  function blastTierBadge(n) {
    if (n >= 100) return "&#x1F451;"; // 👑 crown
    if (n >= 50)  return "&#x1F3C6;"; // 🏆 trophy
    if (n >= 25)  return "&#x26A1;";  // ⚡ lightning
    if (n >= 10)  return "&#x1F3AF;"; // 🎯 bullseye
    return "&#x1F680;";               // 🚀 rocket
  }

  function bumpBlastCounter() {
    blastCount++;
    if (window.__FACES_STATS__) window.__FACES_STATS__.bumpInteraction();
    if (!blastPill) {
      var hud = document.querySelector(".space-hud");
      if (!hud) return;
      blastPill = document.createElement("span");
      blastPill.id = "spaceBlasts";
      blastPill.className = "space-blast-pill";
      hud.appendChild(blastPill);
    }
    blastPill.innerHTML = blastCount === 1
      ? blastTierBadge(1) + " First blast!"
      : blastTierBadge(blastCount) + " " + blastCount + " blasted";
    blastPill.classList.remove("bump");
    void blastPill.offsetWidth;
    blastPill.classList.add("bump");
  }

  // ===================================================================
  // Key popup (reuses .bk-* row styles from buoyant.css)
  // ===================================================================

  var KEY_ROWS = [
    ["&#x1F680;", "Rocket mission", false,
     "<b>Center-cell</b> and <b>edge-cell</b> requests both fly from Earth to the Moon. Center rockets orbit the Moon <b>counter-clockwise</b>; edge rockets orbit <b>clockwise</b> (opposite direction, distinct orbit ring). Body color = color service; pilot in porthole = smiley service.",
     "Default calm settings. Faces &#x25B8; Calm Faces (&#x2318;K) returns here."],
    ["&#x1F3AF;", "Blast a rocket!", false,
     "Click any flying rocket: a cyan laser fires, the rocket explodes into shards, and the pilot tumbles in the wreckage. Score pill appears on your first blast &#x2014; badge upgrades at 10, 25, 50, 100.",
     "Click any rocket. Cursor turns to a crosshair over targets."],
    ["&#x2753;", "Mystery pilot", false,
     "No usable emoji in the response: a &#x2753; rides the porthole and the rocket wobbles off-axis.",
     "Settings (&#x2318;,) &#x25B8; Simulator &#x25B8; Smiley &#x25B8; Error fraction."],
    ["&#x26AA;", "Unpainted rocket", false,
     "No usable color &#x2014; the body goes silver/grey, sputtering and wobbling toward the Moon.",
     "Settings &#x25B8; Simulator &#x25B8; Color &#x25B8; Error fraction."],
    ["&#x2757;", "Rocket with a \"!\" badge", false,
     "Face answered but a sub-service failed (partial error): a colored rocket with a ! badge on the nose, wobbling all the way to the Moon.",
     "Settings &#x25B8; Simulator &#x25B8; Smiley or Color &#x25B8; Error fraction."],
    ["&#x1F4A5;", "Mission abort &#x2014; spinning off-course", true,
     "The face service failed (HTTP 5xx / unparseable): the rocket flies partway, loses thrust, spins out, and falls back toward Earth trailing smoke. Asteroids appear.",
     "Settings &#x25B8; Simulator &#x25B8; Face &#x25B8; Error fraction (50&#x2013;100%) + Delay 0."],
    ["&#x1F4AB;", "Timeout &#x2014; stalls on the pad", false,
     "Rate-limit or timeout (429/504): the rocket barely leaves Earth before losing power and falling back. Pilot shows &#x1F634; or &#x1F635;.",
     "Settings &#x25B8; Simulator &#x25B8; Face &#x25B8; Max rate (small, e.g. 1 RPS), or Latch for sticky 599s."],
    ["&#x23F3;", "Slow rocket", false,
     "A successful but slow response (latency &#x2265; threshold, default 900 ms) takes a visibly longer arc to the Moon.",
     "Settings &#x25B8; Simulator &#x25B8; any service &#x25B8; Delay at/above the slow threshold."],
    ["&#x2604;&#xFE0F;", "Asteroids", false,
     "Failed requests spawn tumbling asteroids that drift across the scene and fade. The sky clears as errors stop.",
     "Any error response. Calm Faces (&#x2318;K) stops new ones immediately."],
    ["&#x2728;", "Moon arrival sparkle", false,
     "Every rocket that reaches the Moon creates a small sparkle burst on arrival.",
     "Default calm settings &#x2014; automatic on every success."],
    ["&#x1F39A;&#xFE0F;", "Rockets/sec slider", false,
     "Controls how many rockets per second are launched &#x2014; and the actual server request rate. Range: 1 every 2 sec (0.5/s) to 20/s.",
     "Drag <b>Rockets</b> in the toolbar, or Settings &#x25B8; Grid &#x25B8; Rockets/sec."],
  ];

  function installKeyPopup() {
    var toolbar = document.getElementById("toolbar");
    if (!toolbar || document.getElementById("spaceKeyPopup")) return;

    var overlay = document.createElement("div");
    overlay.id        = "spaceKeyPopup";
    overlay.className = "space-key-overlay";
    var rows = KEY_ROWS.map(function (row) {
      return '<div class="bk-row' + (row[2] ? " bk-star" : "") + '">' +
               '<div class="bk-icon">' + row[0] + '</div>' +
               '<div>' +
                 '<div class="bk-title">' + row[1] + '</div>' +
                 '<div class="bk-desc">' + row[3] + '</div>' +
                 '<div class="bk-how"><b>Make it happen:</b> ' + row[4] + '</div>' +
               '</div>' +
             '</div>';
    }).join("");
    overlay.innerHTML =
      '<div class="space-key-card" role="dialog" aria-label="Space mode key">' +
        '<div class="buoyant-key-header">' +
          '<h2>Space Mode Key</h2>' +
          '<button type="button" class="buoyant-key-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<p class="bk-intro">Every face request launches one rocket from Earth to the Moon. ' +
          '<b>Rocket color = color service, porthole pilot = smiley emoji</b>. ' +
          'Chaos knobs: Settings (&#x2318;,) &#x25B8; Simulator; with a remote backend the ' +
          'real services decide each mission\'s fate instead.</p>' +
        rows +
      '</div>';
    // Direct child of <body>: the floating .wrapper uses transform, which would
    // otherwise become the containing block for a fixed overlay (see BUOYANT-MODE §7).
    document.body.appendChild(overlay);

    // Capture phase so this intercepts before faces.js's own #btnShowKey listener.
    toolbar.addEventListener("click", function (e) {
      if (visualMode !== "space") return;
      if (e.target && e.target.id === "btnShowKey") {
        e.preventDefault();
        e.stopPropagation();
        overlay.classList.add("open");
      }
    }, true);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay ||
          (e.target.closest && e.target.closest(".buoyant-key-close"))) {
        overlay.classList.remove("open");
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") overlay.classList.remove("open");
    });
  }

  function closeSpaceKey() {
    var el = document.getElementById("spaceKeyPopup");
    if (el) el.classList.remove("open");
  }

  // ===================================================================
  // Shared drawing helpers
  // ===================================================================

  function drawBadge(x, y, text) {
    ctx.save();
    ctx.fillStyle   = "rgba(255,255,255,0.90)";
    ctx.strokeStyle = "rgba(0,20,50,0.50)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle    = "#8a1e1e";
    ctx.font         = "bold 15px -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  // roundRect: defines a rounded-rectangle path (calls beginPath; no fill/stroke)
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y,     x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x,     y + h, r);
    ctx.arcTo(x,     y + h, x,     y,     r);
    ctx.arcTo(x,     y,     x + w, y,     r);
    ctx.closePath();
  }

  function darken(hex, amount) {
    if (!hex || hex.length < 7) return "#666677";
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return "#" + toHex2(r * (1 - amount)) + toHex2(g * (1 - amount)) + toHex2(b * (1 - amount));
  }

  function toHex2(n) {
    var s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return s.length < 2 ? "0" + s : s;
  }

  // ===================================================================
  // Pure helpers
  // ===================================================================

  function safeJson(s, fallback) {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch (_) { return fallback; }
  }

  function validColor(c) {
    return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c.trim());
  }

  function normalizeEmoji(value) {
    if (typeof value !== "string" || !value.trim()) return FALLBACK_EMOJI;
    var ta = document.createElement("textarea");
    ta.innerHTML = value;
    var decoded = ta.value.trim();
    if (!decoded || decoded.length > 16 || /^[0-9]+$/.test(decoded)) return FALLBACK_EMOJI;
    return decoded;
  }

  function lerp(a, b, t)    { return a + (b - a) * t; }
  function clamp01(v)        { return Math.max(0, Math.min(1, v)); }
  function rand(a, b)        { return a + Math.random() * (b - a); }
  function easeInQuad(t)     { return t * t; }
  function easeOutCubic(t)   { return 1 - Math.pow(1 - t, 3); }

  // ===================================================================
  // Public API (called by buoyant.js setVisualMode)
  // ===================================================================

  window.__spaceSetMode__ = function (mode) {
    visualMode = mode;
    if (mode === "space") startSpace();
    else { stopSpace(); closeSpaceKey(); }
  };

  // Sync the toolbar rate slider label when switching to space mode.
  window.__applySpaceSettings__ = function () {
    if (window.__syncRateControl__) window.__syncRateControl__(maxRatePerSec());
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

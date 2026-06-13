// cavern.js — Cavern visual mode for Faces request events.
//
// Each completed Faces request spawns a tiny emoji explorer into the side-view
// cave world painted in cave.png. The emoji is the character; the returned
// color (when valid) becomes a color-matched parachute that saves the explorer
// at the cliff edge. No color means the explorer walks off and splats.
//
// The journey (matches the level layout in cave.png — nothing is drawn over
// the art, the characters just follow it):
//   1. drop in from the ceiling trapdoor
//   2. land on the upper platform, walk LEFT
//   3. bounce off the left wall, turn around
//   4. walk RIGHT the full platform to the cliff edge
//   5. color → parachute down to the lower floor;  no color → fall + splat
//   6. (rescued) walk left into the lower wall, bounce, walk right out the
//      glowing exit door and fade
//
// ALL waypoints are anchored to cave.png via the same cover-scale/bottom-
// anchored mapping drawBackground uses, so feet stay on the painted floors at
// any window size. Anchor fractions below were pixel-measured from the image
// (see BUOYANT-MODE.md §7 — measure, don't guess).
//
// Architecture mirrors buoyant.js: subscribes to the shared debug bus, never
// owns polling, full-bleed canvas, RAF loop stops when mode is inactive.
// buoyant.js owns body-class management and calls window.__cavernSetMode__.
//
// All emoji literals are \u-escaped (not literal UTF-8) per BUOYANT-MODE §10.
//
// SPDX-License-Identifier: Apache-2.0

(function () {
  "use strict";

  // \u-escaped so the file is safe even if served with a wrong charset.
  var FALLBACK_EMOJI = "❓";        // ❓
  var DIZZY_EMOJI    = "😵";  // 😵
  var SLEEPY_EMOJI   = "😴";  // 😴

  var MAX_EXPLORERS = 60;
  var FOOT = 9;   // feet are drawn down to +9 in sprite coords

  // Anchors as fractions of cave.png (1672×941), pixel-scanned:
  //   upper grass top ~y435, left wall face ~x93, cliff edge ~x1129,
  //   lower grass top ~y818, lower wall face ~x1085, door center ~x1497,
  //   ceiling trapdoor opening center ~x560.
  var A = {
    trapX:      560  / 1672,
    upperY:     435  / 941,
    leftWallX:  93   / 1672,
    cliffX:     1129 / 1672,
    lowerY:     818  / 941,
    lowerWallX: 1085 / 1672,
    doorX:      1497 / 1672,
  };

  // Path endpoints: image-fraction x + a pixel offset (stop margins so the
  // sprite's body doesn't clip into the painted rock).
  var PT = {
    SPAWN:  { fx: A.trapX,      dx: 0 },
    LSTOP:  { fx: A.leftWallX,  dx: 24 },   // stand-off from the left wall
    CSTOP:  { fx: A.cliffX,     dx: -14 },  // toes at the cliff edge
    CLIFF0: { fx: A.cliffX,     dx: 2 },    // straight below the cliff lip
    LAND:   { fx: A.cliffX,     dx: 28 },   // parachute touchdown, past the wall corner
    WSTOP:  { fx: A.lowerWallX, dx: 22 },   // stand-off from the lower wall
    DOOR:   { fx: A.doorX,      dx: 0 },
  };

  // Module-level state
  var root, canvas, ctx, hudCounts;
  var dpr = 1, width = 800, height = 500;
  var visualMode = "classic";
  var seq = 0, running = false, raf = 0, lastFrame = 0;
  var explorers = [];
  var admittedTimes = [];   // sliding 1s window for the shared Rate slider cap
  var crushCount = 0;       // click-to-crush scoreboard (session-scoped)
  var crushPill = null;

  var bg = new Image();
  bg.src = "cave.png";

  // ===================================================================
  // Image-anchored coordinate mapping (must match drawBackground exactly)
  // ===================================================================

  // FIT-WIDTH mapping (not cover-crop): this is a level, so the whole route —
  // left wall, cliff, lower wall, exit door — must ALWAYS be on screen. The
  // image spans the full canvas width, bottom-anchored; if the window is
  // taller/narrower than the image aspect, the gap above is filled with cave
  // darkness. (Cover-crop pushed the left wall off-screen at narrow aspects,
  // so explorers walked out of view and "appeared from the side".)
  function bgMap() {
    if (!(bg.complete && bg.naturalWidth)) return null;
    var scale = width / bg.naturalWidth;
    return { scale: scale, offY: height - bg.naturalHeight * scale };
  }

  function mx(fx) {
    return fx * width;
  }

  function my(fy) {
    var m = bgMap();
    if (!m) return fy * height;
    return m.offY + fy * bg.naturalHeight * m.scale;
  }

  function ptX(p) { return mx(p.fx) + p.dx; }

  // One knob for how big the characters read on screen (user: bigger!).
  function spriteSize() {
    return Math.max(26, Math.min(50, height * 0.07));
  }

  // Floor walking line (sprite translate y): feet rest on the painted grass.
  function floorAt(which) {
    return my(which === "lower" ? A.lowerY : A.upperY) - FOOT;
  }

  // ===================================================================
  // Boot & lifecycle
  // ===================================================================

  function boot() {
    root      = document.getElementById("cavern-root");
    canvas    = document.getElementById("cavern-canvas");
    hudCounts = document.getElementById("cavern-counts");
    if (!root || !canvas) return;
    ctx = canvas.getContext("2d");

    resize();
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(root);

    // Click an explorer to crush it under a boulder (pure fun — no request
    // is affected). Same arcade idea as Buoyant's balloon popping.
    canvas.addEventListener("click", function (e) {
      if (visualMode !== "cavern") return;
      var hit = explorerAt(e.offsetX, e.offsetY);
      if (hit) crushExplorer(hit);
    });
    canvas.addEventListener("mousemove", function (e) {
      if (visualMode !== "cavern") return;
      canvas.style.cursor = explorerAt(e.offsetX, e.offsetY) ? "pointer" : "default";
    });

    installKeyPopup();
    subscribeDebug();

    // Attach shared stats HUD to the cavern scene root.
    if (window.__FACES_STATS__) {
      var statsEl = document.createElement("div");
      statsEl.className = "fun-stats-hud";
      root.appendChild(statsEl);
      window.__FACES_STATS__.attachHUD(statsEl);
    }

    var initMode = (window.__FACES_SETTINGS__ || {}).visualMode || "classic";
    if (initMode === "cavern") { visualMode = "cavern"; startCavern(); }
  }

  function subscribeDebug() {
    var bus = window.__FACES_DEBUG__;
    if (!bus) { setTimeout(subscribeDebug, 60); return; }
    bus.subscribe(function (entry) {
      if (!entry) { explorers.length = 0; return; }    // clear signal
      if (visualMode !== "cavern") return;
      // Rate limiter: minimum-interval gate (works for fractional rates like 0.5/s).
      var nowMs = performance.now();
      while (admittedTimes.length && nowMs - admittedTimes[0] > 1000) admittedTimes.shift();
      var minIntervalMs = 1000 / maxRatePerSec();
      if (admittedTimes.length > 0 && nowMs - admittedTimes[admittedTimes.length - 1] < minIntervalMs) return;
      if (admittedTimes.length >= Math.ceil(maxRatePerSec())) return;
      admittedTimes.push(nowMs);
      addExplorer(makeExplorer(classify(entry)));
    });
  }

  function maxRatePerSec() {
    var s = window.__FACES_SETTINGS__ || {};
    var r = Number(s.funModeRatePerSec || s.buoyantRatePerSec);
    return Number.isFinite(r) ? Math.max(0.5, Math.min(20, r)) : 0.5;
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

  function startCavern() {
    resize();
    if (running) return;
    running   = true;
    lastFrame = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stopCavern() {
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

  function update(t) {
    for (var i = explorers.length - 1; i >= 0; i--) {
      if ((t - explorers[i].born) / explorers[i].duration > 1.04) {
        explorers.splice(i, 1);
      }
    }
    if (hudCounts) hudCounts.textContent = explorers.length + " explorers";
  }

  // ===================================================================
  // Classification (same logic as buoyant.js)
  // ===================================================================

  function classify(entry) {
    var parsed     = safeJson(entry.body, null);
    var parseFail  = !!entry.body && parsed == null;
    var status     = Number(entry.status || 0);
    var hasColor   = !!(parsed && validColor(parsed.color));
    var rawEmoji   = normalizeEmoji(parsed && parsed.smiley);
    var hasEmoji   = rawEmoji !== FALLBACK_EMOJI;
    var failed     = status === 0 || status === 504 || status === 429 || status >= 500 || parseFail;
    var partial    = !failed && !!(parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0);
    var thresh     = (window.__FACES_SETTINGS__ && Number(window.__FACES_SETTINGS__.slowThresholdMs)) || 900;
    var slow       = Number(entry.latencyMs || 0) >= thresh;

    var emoji = failed && !hasEmoji
      ? (status === 504 || status === 0 ? SLEEPY_EMOJI : DIZZY_EMOJI)
      : (hasEmoji ? rawEmoji : FALLBACK_EMOJI);

    return {
      id:       ++seq,
      which:    entry.which || "center",
      failed:   failed,
      partial:  partial,
      slow:     slow,
      hasColor: hasColor,
      color:    hasColor ? parsed.color.trim() : "#8b7355",
      emoji:    emoji,
    };
  }

  // ===================================================================
  // Factory — timeline of weighted segments
  // ===================================================================

  function makeExplorer(e) {
    var segs = buildSegments(e);
    // Normalize weights to cumulative 0..1 boundaries.
    var total = 0, i;
    for (i = 0; i < segs.length; i++) total += segs[i].w;
    var acc = 0;
    for (i = 0; i < segs.length; i++) {
      segs[i].a0 = acc / total;
      acc += segs[i].w;
      segs[i].a1 = acc / total;
    }

    var dur = e.failed ? rand(7, 10) : (e.hasColor ? rand(16, 21) : rand(11, 15));
    if (e.slow && !e.failed) dur += rand(2.5, 4.5);

    return {
      id:       e.id,
      born:     performance.now() / 1000 + (e.failed ? 0 : rand(0, 1.1)),
      duration: dur,
      emoji:    e.emoji,
      color:    e.color,
      hasColor: e.hasColor,
      failed:   e.failed,
      partial:  e.partial,
      slow:     e.slow,
      segs:     segs,
      phase0:   rand(0, Math.PI * 2),  // animation phase offset
    };
  }

  function buildSegments(e) {
    if (e.failed) return buildErrorSegments(e);

    // EVERY explorer enters the same way — drop from the trapdoor, walk left,
    // bounce off the wall, then march the full platform to the cliff edge.
    // (Explorers must never enter from the screen sides; it reads as a bug.)
    // Walk weights ∝ horizontal distance so speed stays constant.
    var segs = [
      { ph: "drop",   w: 0.07, x: PT.SPAWN, floor: "upper" },
      { ph: "walk",   w: 0.28, x0: PT.SPAWN, x1: PT.LSTOP, floor: "upper", face: -1 },
      { ph: "bounce", w: 0.04, x: PT.LSTOP, floor: "upper", f0: -1, f1: 1 },
      { ph: "walk",   w: 0.62, x0: PT.LSTOP, x1: PT.CSTOP, floor: "upper", face: 1 },
      { ph: "cliff",  w: e.slow ? 0.30 : 0.08, x: PT.CSTOP, floor: "upper", pace: e.slow },
    ];

    if (!e.hasColor) {
      // No rescue color: off the edge, splat on the lower floor.
      segs.push(
        { ph: "fall",  w: 0.10, x0: PT.CSTOP, x1: PT.LAND },
        { ph: "splat", w: 0.16, x: PT.LAND, floor: "lower" }
      );
    } else if (e.which === "edge") {
      // Edge cells take the express: a color-matched hang glider carries them
      // from the cliff straight to the exit door.
      segs.push(
        { ph: "glide", w: 0.36, x0: PT.CSTOP, x1: PT.DOOR },
        { ph: "door",  w: 0.08, x: PT.DOOR, floor: "lower" }
      );
    } else {
      // Center cells parachute gently down, then hike to the door.
      segs.push(
        { ph: "chute",  w: 0.30, x0: PT.CSTOP, x1: PT.LAND },
        { ph: "walk",   w: 0.07, x0: PT.LAND, x1: PT.WSTOP, floor: "lower", face: -1 },
        { ph: "bounce", w: 0.04, x: PT.WSTOP, floor: "lower", f0: -1, f1: 1 },
        { ph: "walk",   w: 0.25, x0: PT.WSTOP, x1: PT.DOOR, floor: "lower", face: 1 },
        { ph: "door",   w: 0.06, x: PT.DOOR, floor: "lower" }
      );
    }
    return segs;
  }

  function buildErrorSegments(e) {
    var errType = e.id % 3;   // 0=skid, 1=bonk, 2=trip
    // Failures play out AT the cliff, and crucially the mishap LAUNCHES the
    // explorer clear over the edge — the death is the SPLAT on the ground
    // below, never a crumple at the lip (lingering death-rotation at the edge
    // read as "dying on the side of the cliff, then falling").
    var PRECLIFF = { fx: A.cliffX, dx: -64 };               // run-up start
    var LIP      = { fx: A.cliffX, dx: 0 };                 // skid carries past CSTOP
    var ERRLAND  = { fx: A.cliffX, dx: 70 + errType * 35 }; // arc touchdown, clear of the wall
    var segs = [
      { ph: "drop", w: 0.12, x: PT.SPAWN, floor: "upper" },
      { ph: "walk", w: 0.46, x0: PT.SPAWN, x1: errType === 1 ? PT.CSTOP : PRECLIFF, floor: "upper", face: 1 },
    ];
    if (errType === 0) {
      // Can't stop! Leans back, heels digging in, slides right off the lip.
      segs.push({ ph: "skid", w: 0.10, x0: PRECLIFF, x1: LIP, floor: "upper" });
    } else if (errType === 1) {
      // A boulder bonks it at the edge and bats it clean over.
      segs.push({ ph: "bonk", w: 0.10, x: PT.CSTOP, floor: "upper" });
    } else {
      // Trips on the final stretch and stumbles over at speed.
      segs.push({ ph: "trip", w: 0.10, x0: PRECLIFF, x1: PT.CSTOP, floor: "upper" });
    }
    segs.push(
      { ph: "arc",   w: 0.14, x0: errType === 0 ? LIP : PT.CSTOP, x1: ERRLAND },
      { ph: "splat", w: 0.18, x: ERRLAND, floor: "lower" }
    );
    return segs;
  }

  function addExplorer(o) {
    if (explorers.length >= MAX_EXPLORERS) return;
    explorers.push(o);
  }

  // ===================================================================
  // State from timeline (everything derived from normalized age)
  // ===================================================================

  function computeState(o, age, t) {
    var segs = o.segs;
    var seg  = segs[segs.length - 1];
    for (var i = 0; i < segs.length; i++) {
      if (age < segs[i].a1) { seg = segs[i]; break; }
    }
    var p = clamp01((age - seg.a0) / Math.max(1e-6, seg.a1 - seg.a0));

    switch (seg.ph) {
      case "drop": {
        var fy = floorAt(seg.floor);
        return { ph: "drop", x: ptX(seg.x), y: lerp(-60, fy, easeOutBounce(p)),
                 facing: 1, alpha: 1, stepT: 0, p: p };
      }
      case "walk": {
        return { ph: "walk", x: lerp(ptX(seg.x0), ptX(seg.x1), p),
                 y: floorAt(seg.floor), facing: seg.face, alpha: 1,
                 stepT: t * 9 + o.phase0, p: p };
      }
      case "bounce": {
        var recoil = Math.sin(p * Math.PI) * 16 * -seg.f0;  // recoil away from wall
        return { ph: "bounce", x: ptX(seg.x) + recoil, y: floorAt(seg.floor),
                 facing: p < 0.5 ? seg.f0 : seg.f1, alpha: 1, stepT: 0, p: p };
      }
      case "cliff": {
        var x = ptX(seg.x), facing = 1, stepT = 0;
        if (seg.pace && p < 0.62) {
          var sway = Math.sin(p * Math.PI * 3.5);
          x -= Math.max(0, sway) * 44;
          facing = sway > 0.1 ? -1 : 1;
          stepT  = t * 7 + o.phase0;
        }
        return { ph: "cliff", x: x, y: floorAt(seg.floor), facing: facing,
                 alpha: 1, stepT: stepT, p: p };
      }
      case "chute": {
        // Quick initial drop while the chute opens, then a slow steady drift
        // with a gentle pendulum sway.
        var sway = Math.sin(p * Math.PI * 2.5 + o.phase0) * 8 * Math.min(1, p * 4);
        return { ph: "chute", x: lerp(ptX(seg.x0), ptX(seg.x1), p) + sway,
                 y: lerp(floorAt("upper"), floorAt("lower"), easeOutQuad(p)),
                 facing: 1, alpha: 1, stepT: 0, p: p };
      }
      case "glide": {
        // Hang glider: a long descending line from the cliff straight to the
        // door, with a gentle bob; flares flat just before touchdown.
        var bob = Math.sin(p * Math.PI * 3 + o.phase0) * 5;
        return { ph: "glide", x: lerp(ptX(seg.x0), ptX(seg.x1), p),
                 y: lerp(floorAt("upper"), floorAt("lower"), easeOutQuad(p)) + bob,
                 facing: 1, alpha: 1, stepT: 0, rot: 0.10 * (1 - p), p: p };
      }
      case "fall": {
        return { ph: "fall", x: lerp(ptX(seg.x0), ptX(seg.x1), p),
                 y: lerp(floorAt("upper"), floorAt("lower"), easeInQuad(p)),
                 facing: 1, alpha: 1, stepT: 0, rot: p * Math.PI * 0.55, p: p };
      }
      case "skid": {
        // Can't stop: leans back, heels dug in, slides right off the lip.
        return { ph: "skid", x: lerp(ptX(seg.x0), ptX(seg.x1), easeOutQuad(p)),
                 y: floorAt(seg.floor), facing: 1, alpha: 1, stepT: 0,
                 rot: -0.30 * Math.min(1, p * 2), p: p };
      }
      case "bonk": {
        // Brief boulder thwack — a recoil, NOT a death crumple; the "arc"
        // segment right after carries it over the edge.
        var stag = Math.sin(p * Math.PI * 3) * 6;
        return { ph: "bonk", x: ptX(seg.x) + stag, y: floorAt(seg.floor),
                 facing: -1, alpha: 1, stepT: 0,
                 rot: -0.12 * Math.sin(p * Math.PI), p: p };
      }
      case "trip": {
        // A stumble at speed (forward pitch + hop), still on its feet until
        // the arc takes over at the edge.
        return { ph: "trip", x: lerp(ptX(seg.x0), ptX(seg.x1), p),
                 y: floorAt(seg.floor) - Math.abs(Math.sin(p * Math.PI * 2)) * 4,
                 facing: 1, alpha: 1, stepT: 0,
                 rot: 0.40 * Math.sin(Math.min(1, p * 1.3) * Math.PI), p: p };
      }
      case "arc": {
        // Launched clear over the edge: a real projectile arc (small upward
        // hop, then accelerating fall) with airborne tumbling. Death happens
        // at the splat on the ground, never at the cliff.
        var hop = Math.sin(p * Math.PI) * 38;
        return { ph: "arc", x: lerp(ptX(seg.x0), ptX(seg.x1), p),
                 y: lerp(floorAt("upper"), floorAt("lower"), easeInQuad(p)) - hop,
                 facing: 1, alpha: 1, stepT: 0,
                 rot: p * Math.PI * (1.5 + (o.id % 3) * 0.35), p: p };
      }
      case "splat": {
        var alpha = p > 0.58 ? 1 - (p - 0.58) / 0.42 : 1;
        return { ph: "splat", x: ptX(seg.x), y: floorAt(seg.floor) + 3,
                 facing: 1, alpha: alpha, stepT: 0, p: p };
      }
      case "door": {
        // Walk into the glowing doorway and fade.
        return { ph: "door", x: ptX(seg.x) + p * 10, y: floorAt(seg.floor),
                 facing: 1, alpha: 1 - p, stepT: t * 9 + o.phase0, p: p };
      }
    }
    return { ph: "done", x: 0, y: 0, facing: 1, alpha: 0, stepT: 0, p: 0 };
  }

  // ===================================================================
  // Main draw
  // ===================================================================

  function draw(t) {
    ctx.clearRect(0, 0, width, height);
    drawBackground();

    for (var i = 0; i < explorers.length; i++) {
      var o = explorers[i];
      if (t < o.born) continue;
      if (o.crushed) { drawCrushed(o, t); continue; }
      var age   = clamp01((t - o.born) / o.duration);
      var state = computeState(o, age, t);
      if (state.alpha > 0.01) drawExplorer(o, state, t);
    }
  }

  function drawBackground() {
    ctx.imageSmoothingEnabled = false;
    if (bg.complete && bg.naturalWidth) {
      // Fit-width, bottom-anchored (must match bgMap/mx/my). Narrow windows
      // get a cave-darkness fill above the image instead of cropping the
      // level's sides; wide windows crop only the ceiling.
      var iw = bg.naturalWidth, ih = bg.naturalHeight;
      var scale = width / iw;
      var dh = ih * scale;
      var dy = height - dh;
      if (dy > 0) {
        ctx.fillStyle = "#0b0704";
        ctx.fillRect(0, 0, width, dy + 1);
      }
      ctx.drawImage(bg, 0, 0, iw, ih, 0, dy, width, dh);
    } else {
      var g = ctx.createLinearGradient(0, 0, 0, height);
      g.addColorStop(0, "#100c08");
      g.addColorStop(0.5, "#261710");
      g.addColorStop(1, "#3a2212");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingEnabled = true;
  }

  // ===================================================================
  // Explorer drawing
  // ===================================================================

  function drawExplorer(o, state, t) {
    var ph = state.ph;
    var emojiSz = spriteSize();

    ctx.save();
    ctx.globalAlpha = clamp01(state.alpha);
    ctx.translate(state.x, state.y);
    if (state.rot) ctx.rotate(state.rot);

    // --- SPLAT (symmetric, no flip/decoration) ---
    if (ph === "splat") {
      drawSplat(o.emoji, state.p, emojiSz);
      ctx.restore();
      drawPoof(state.x, state.y + FOOT, Math.min(1, state.p * 1.6));
      return;
    }

    if (state.facing === -1) ctx.scale(-1, 1);

    // --- PARACHUTE / HANG GLIDER (above character, drawn unflipped) ---
    if (ph === "chute" && o.hasColor) {
      ctx.save();
      if (state.facing === -1) ctx.scale(-1, 1);
      drawParachute(o.color, state.p, emojiSz);
      ctx.restore();
    }
    if (ph === "glide" && o.hasColor) {
      drawHangGlider(o.color, emojiSz);
    }

    // --- ARMS (behind emoji) ---
    drawArms(state.stepT || 0, ph, emojiSz);

    // --- EMOJI BODY ---
    ctx.font = emojiSz + "px \"Apple Color Emoji\", \"Segoe UI Emoji\", sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    var bodyY = -(emojiSz * 0.70);   // leaves leg room between emoji and feet
    ctx.fillText(o.emoji, 0, bodyY);

    // --- ROCK PROP: the "wrong tool" carried on the no-color path ---
    if (!o.hasColor && !o.failed &&
        (ph === "walk" || ph === "cliff" || ph === "bounce")) {
      drawRock(emojiSz * 0.66, bodyY + emojiSz * 0.36, emojiSz);
    }

    // --- FEET ---
    var falling = (ph === "fall" || ph === "arc" || ph === "bonk" || ph === "skid" ||
                   ph === "trip" || ph === "chute" || ph === "glide");
    drawFeet(state.stepT || 0, falling, emojiSz);

    // --- SHOCK BADGE at the cliff edge ---
    if (ph === "cliff" && state.p > 0.42 && !o.hasColor) {
      ctx.save();
      if (state.facing === -1) ctx.scale(-1, 1);
      drawBadge(emojiSz * 0.72, bodyY - emojiSz * 0.55, "!");
      ctx.restore();
    }

    // --- PARTIAL ERROR BADGE ---
    if (o.partial && (ph === "walk" || ph === "cliff" || ph === "chute" || ph === "glide")) {
      ctx.save();
      if (state.facing === -1) ctx.scale(-1, 1);
      drawBadge(emojiSz * 0.72, bodyY - emojiSz * 0.55, "?");
      ctx.restore();
    }

    // --- BONK ROCK falling from above ---
    if (ph === "bonk") {
      ctx.save();
      if (state.facing === -1) ctx.scale(-1, 1);
      var bry = bodyY - emojiSz * 2.0 + state.p * emojiSz * 1.7;
      drawRock(4, bry, emojiSz * 1.1);
      ctx.restore();
      if (state.p > 0.45 && state.p < 0.85) {
        ctx.save();
        if (state.facing === -1) ctx.scale(-1, 1);
        drawBadge(emojiSz * 0.72, bodyY - emojiSz * 0.55, "!");
        ctx.restore();
      }
    }

    ctx.restore();

    // --- LANDING POOF at the end of the drop ---
    if (ph === "drop" && state.p > 0.80) {
      drawPoof(state.x, state.y + FOOT, (state.p - 0.80) / 0.20 * 0.55);
    }

    // --- WALL DUST during the bounce ---
    if (ph === "bounce") {
      drawPoof(state.x, state.y + FOOT, 0.35 + state.p * 0.3);
    }

    // --- HEEL DUST during the skid off the lip ---
    if (ph === "skid") {
      drawPoof(state.x - 12, state.y + FOOT, 0.25 + state.p * 0.45);
    }
  }

  function drawArms(stepT, ph, emojiSz) {
    var walk   = ph === "walk" || ph === "door";
    var swing  = walk ? Math.sin(stepT) * 0.32 : 0.06;
    var bY     = -(emojiSz * 0.70);
    var armY   = bY + emojiSz * 0.12;
    var armLen = emojiSz * 0.55;

    ctx.save();
    ctx.strokeStyle = "#8b5c38";
    ctx.lineWidth   = Math.max(3, emojiSz * 0.09);
    ctx.lineCap     = "round";

    ctx.beginPath();
    ctx.moveTo(-emojiSz * 0.34, armY);
    ctx.lineTo(-emojiSz * 0.34 - Math.cos(swing + 0.28) * armLen * 0.60,
               armY + Math.sin(Math.abs(swing) + 0.28) * armLen);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(emojiSz * 0.34, armY);
    ctx.lineTo(emojiSz * 0.34 + Math.cos(-swing + 0.28) * armLen * 0.42,
               armY + Math.sin(Math.abs(-swing) + 0.28) * armLen);
    ctx.stroke();
    ctx.restore();
  }

  function drawFeet(stepT, falling, emojiSz) {
    // Legs run from the hip line (below the emoji body, which sits at
    // -0.70·sz) down to +FOOT. FOOT is the floor-anchor contract: feet must
    // always END at +FOOT or the sprite detaches from the painted ground.
    var k    = emojiSz / 36;
    var step = falling ? 0 : Math.sin(stepT) * 9 * k;
    var hip  = -(emojiSz * 0.22);
    ctx.save();
    ctx.strokeStyle = falling ? "#9b5030" : "#6b3c20";
    ctx.lineWidth   = Math.max(3, emojiSz * 0.10);
    ctx.lineCap     = "round";
    ctx.beginPath();
    ctx.moveTo(-emojiSz * 0.13, hip);
    ctx.lineTo(-emojiSz * 0.26 - step, FOOT);
    ctx.moveTo(emojiSz * 0.17, hip);
    ctx.lineTo(emojiSz * 0.30 + step, FOOT);
    ctx.stroke();
    ctx.restore();
  }

  function drawRock(rx, ry, emojiSz) {
    var r = Math.max(5, emojiSz * 0.22);
    ctx.save();
    ctx.fillStyle   = "#877060";
    ctx.strokeStyle = "#5a4535";
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(rx, ry, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(40,28,16,0.35)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(rx - r * 0.44, ry - r * 0.18);
    ctx.lineTo(rx + r * 0.30, ry + r * 0.28);
    ctx.stroke();
    ctx.restore();
  }

  function drawParachute(color, t, emojiSz) {
    var openT = Math.min(1, t * 2.8);   // pops open quickly
    var rx    = emojiSz * 1.5 * openT;
    var ry    = emojiSz * 1.0 * openT;
    var py    = -(emojiSz + ry + 10);
    var bY    = -(emojiSz * 0.70);

    ctx.save();

    // Suspension strings
    ctx.strokeStyle = "rgba(100, 68, 36, 0.82)";
    ctx.lineWidth   = 1.5;
    ctx.lineCap     = "round";
    ctx.beginPath();
    ctx.moveTo(-emojiSz * 0.28, bY);
    ctx.quadraticCurveTo(-rx * 0.55, py + ry * 0.5, -rx * 0.72, py + ry * 0.15);
    ctx.moveTo(emojiSz * 0.28, bY);
    ctx.quadraticCurveTo(rx * 0.55, py + ry * 0.5, rx * 0.72, py + ry * 0.15);
    ctx.stroke();

    // Dome (shaded inside a clip)
    ctx.beginPath();
    ctx.ellipse(0, py, rx, ry, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.ellipse(-rx * 0.28, py - ry * 0.22, rx * 0.52, ry * 0.64, -0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.16)";
    ctx.lineWidth   = 1.5;
    for (var k = -2; k <= 2; k++) {
      ctx.beginPath();
      ctx.moveTo(0, py + ry);
      ctx.quadraticCurveTo(k * rx * 0.44, py, 0, py - ry);
      ctx.stroke();
    }
    ctx.restore();

    // Rim
    ctx.strokeStyle = "rgba(65, 42, 22, 0.72)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.ellipse(0, py, rx, ry, 0, Math.PI, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  // Color-matched delta wing for the edge-cell express ride to the door.
  function drawHangGlider(color, emojiSz) {
    var bY   = -(emojiSz * 0.70);        // emoji body top
    var wy   = -(emojiSz * 1.6);         // wing keel height
    var span = emojiSz * 1.6;

    ctx.save();

    // Hang straps from the body to the keel.
    ctx.strokeStyle = "rgba(70, 45, 25, 0.85)";
    ctx.lineWidth   = 1.5;
    ctx.lineCap     = "round";
    ctx.beginPath();
    ctx.moveTo(-emojiSz * 0.22, bY);
    ctx.lineTo(0, wy + emojiSz * 0.14);
    ctx.moveTo(emojiSz * 0.22, bY);
    ctx.lineTo(0, wy + emojiSz * 0.14);
    ctx.stroke();

    // Delta wing: two swept panels meeting at the nose.
    ctx.fillStyle   = color;
    ctx.strokeStyle = "rgba(60, 38, 20, 0.80)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(0, wy - emojiSz * 0.30);                                          // nose
    ctx.quadraticCurveTo(-span * 0.55, wy - emojiSz * 0.05, -span, wy + emojiSz * 0.32); // left tip
    ctx.quadraticCurveTo(-span * 0.30, wy + emojiSz * 0.08, 0, wy + emojiSz * 0.14);     // trailing edge
    ctx.quadraticCurveTo(span * 0.30, wy + emojiSz * 0.08, span, wy + emojiSz * 0.32);   // right tip
    ctx.quadraticCurveTo(span * 0.55, wy - emojiSz * 0.05, 0, wy - emojiSz * 0.30);      // back to nose
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Sheen on the left panel + center keel line.
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.beginPath();
    ctx.moveTo(0, wy - emojiSz * 0.26);
    ctx.quadraticCurveTo(-span * 0.5, wy - emojiSz * 0.04, -span * 0.85, wy + emojiSz * 0.26);
    ctx.quadraticCurveTo(-span * 0.3, wy + emojiSz * 0.02, 0, wy + emojiSz * 0.08);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, wy - emojiSz * 0.30);
    ctx.lineTo(0, wy + emojiSz * 0.14);
    ctx.stroke();

    ctx.restore();
  }

  function drawSplat(emoji, t, emojiSz) {
    var squash = 1 - Math.min(0.55, t * 0.8);
    var widen  = 1 + Math.min(0.50, t * 0.75);

    ctx.save();
    if (t < 0.42) {
      ctx.fillStyle = "rgba(255, 210, 60, " + (0.85 * (1 - t / 0.42)) + ")";
      for (var i = 0; i < 7; i++) {
        var a    = (i / 7) * Math.PI * 2;
        var dist = t * emojiSz * 2.4;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * dist, Math.sin(a) * dist * 0.45 - emojiSz * 0.35,
                2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.scale(widen, squash);
    ctx.font = emojiSz + "px \"Apple Color Emoji\", \"Segoe UI Emoji\", sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(emoji, 0, -emojiSz * squash * 0.35);
    ctx.restore();
  }

  function drawPoof(x, y, t) {
    if (t <= 0) return;
    var tt = clamp01(t);
    ctx.save();
    ctx.globalAlpha = clamp01(0.65 * (1 - tt));
    ctx.fillStyle = "rgba(175, 145, 95, 0.7)";
    for (var i = 0; i < 6; i++) {
      var a    = (i / 6) * Math.PI;
      var dist = tt * 26;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * dist,
              y - Math.abs(Math.sin(a)) * dist * 0.6,
              4 + tt * 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBadge(x, y, text) {
    ctx.save();
    ctx.fillStyle   = "rgba(255,255,255,0.90)";
    ctx.strokeStyle = "rgba(80, 55, 28, 0.52)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#8a1e1e";
    ctx.font      = "bold 15px -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  // ===================================================================
  // Click-to-crush game (mirrors Buoyant's balloon popping)
  // ===================================================================

  function explorerAt(px, py) {
    var t  = performance.now() / 1000;
    var sz = spriteSize();
    for (var i = explorers.length - 1; i >= 0; i--) {
      var o = explorers[i];
      if (o.crushed || t < o.born) continue;
      var age = clamp01((t - o.born) / o.duration);
      var st  = computeState(o, age, t);
      if (st.alpha < 0.2 || st.ph === "splat" || st.ph === "done") continue;
      var dx = px - st.x, dy = py - st.y;
      if (Math.abs(dx) <= sz * 0.8 && dy >= -(sz + 16) && dy <= FOOT + 4) return o;
    }
    return null;
  }

  function crushExplorer(o) {
    var t   = performance.now() / 1000;
    var age = clamp01((t - o.born) / o.duration);
    var st  = computeState(o, age, t);
    o.crushed = true;
    o.crushT  = t;
    o.fx      = st.x;          // freeze the pose where the click landed
    o.fy      = st.y;
    o.fFacing = st.facing;
    // Keep the object alive through the whole crush sequence.
    o.duration = (t - o.born) + 3.2;
    bumpCrushCounter();
    o.crushNum = crushCount;   // for the milestone floater
  }

  // Crush scoreboard — a HUD pill that appears on the first crush and keeps
  // score for the session. (Emoji as HTML entities — ASCII-safe.)
  function crushTierBadge(n) {
    if (n >= 100) return "&#x1F451;"; // crown
    if (n >= 50)  return "&#x1F3C6;"; // trophy
    if (n >= 25)  return "&#x1F525;"; // fire
    if (n >= 10)  return "&#x1F3AF;"; // bullseye
    return "&#x1FAA8;";               // rock
  }

  function bumpCrushCounter() {
    crushCount++;
    if (window.__FACES_STATS__) window.__FACES_STATS__.bumpInteraction();
    if (!crushPill) {
      var hud = document.querySelector(".cavern-hud");
      if (!hud) return;
      crushPill = document.createElement("span");
      crushPill.id = "cavernCrushes";
      crushPill.className = "cavern-crush-pill";
      hud.appendChild(crushPill);
    }
    crushPill.innerHTML = crushCount === 1
      ? crushTierBadge(1) + " First crush!"
      : crushTierBadge(crushCount) + " " + crushCount + " crushed";
    // restart the bump animation on every crush
    crushPill.classList.remove("bump");
    void crushPill.offsetWidth;
    crushPill.classList.add("bump");
  }

  var ROCK_FALL_S = 0.45;   // boulder drop time

  // Crush sequence: the explorer freezes mid-step, a boulder drops from
  // above, flattens it with a dust poof and a "+1" floater, then both fade.
  function drawCrushed(o, t) {
    var ft = t - o.crushT;
    var sz = spriteSize();
    var rockR = sz * 0.9;
    var impact = ft >= ROCK_FALL_S;
    var sinceImpact = Math.max(0, ft - ROCK_FALL_S);
    var alpha = sinceImpact > 1.6 ? Math.max(0, 1 - (sinceImpact - 1.6) / 0.9) : 1;
    if (alpha <= 0) return;

    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(o.fx, o.fy);
    ctx.font = sz + "px \"Apple Color Emoji\", \"Segoe UI Emoji\", sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    if (!impact) {
      // Frozen in place, staring up at its fate.
      ctx.save();
      if (o.fFacing === -1) ctx.scale(-1, 1);
      drawArms(0, "frozen", sz);
      ctx.fillText(o.emoji, 0, -(sz * 0.5 + 6));
      drawFeet(0, false, sz);
      ctx.restore();
      drawBadge(sz * 0.72, -(sz * 1.1), "!");
    } else {
      // Flattened under the boulder.
      ctx.save();
      ctx.scale(1.5, 0.3);
      ctx.fillText(o.emoji, 0, -sz * 0.35);
      ctx.restore();
    }

    // The boulder: falls, then rests on the flattened explorer.
    var dropFrom = -(sz * 6);
    var rockY = impact
      ? -(rockR * 0.5)
      : lerp(dropFrom, -(rockR * 0.5), easeInQuad(ft / ROCK_FALL_S));
    drawBoulder(0, rockY, rockR);
    ctx.restore();

    if (impact) {
      drawPoof(o.fx, o.fy + FOOT, Math.min(1, sinceImpact * 1.4));
      if (sinceImpact < 0.9) {
        var milestone = o.crushNum % 10 === 0;
        ctx.save();
        ctx.globalAlpha = 1 - sinceImpact / 0.9;
        ctx.font = "bold " + (milestone ? 30 : 18) + "px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(60, 30, 5, 0.85)";
        ctx.fillStyle = milestone ? "#ffd24a" : "#fff3d0";
        var fy = o.fy - sz * 1.9 - sinceImpact * 30;
        var msg = milestone ? o.crushNum + "!" : "+1";
        ctx.strokeText(msg, o.fx, fy);
        ctx.fillText(msg, o.fx, fy);
        ctx.restore();
      }
    }
  }

  function drawBoulder(x, y, r) {
    ctx.save();
    ctx.fillStyle   = "#7d6a58";
    ctx.strokeStyle = "#4e3f30";
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    ctx.moveTo(x - r, y + r * 0.3);
    ctx.quadraticCurveTo(x - r * 1.05, y - r * 0.55, x - r * 0.35, y - r * 0.95);
    ctx.quadraticCurveTo(x + r * 0.4,  y - r * 1.1,  x + r * 0.92, y - r * 0.4);
    ctx.quadraticCurveTo(x + r * 1.1,  y + r * 0.35, x + r * 0.45, y + r * 0.7);
    ctx.quadraticCurveTo(x - r * 0.4,  y + r * 0.85, x - r,        y + r * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Top highlight + a crack line for pixel-art texture.
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.5, y - r * 0.55);
    ctx.quadraticCurveTo(x - r * 0.1, y - r * 0.8, x + r * 0.35, y - r * 0.6);
    ctx.stroke();
    ctx.strokeStyle = "rgba(40,28,16,0.5)";
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + r * 0.1, y - r * 0.2);
    ctx.lineTo(x - r * 0.2, y + r * 0.25);
    ctx.stroke();
    ctx.restore();
  }

  // ===================================================================
  // Cavern key popup (mirrors Buoyant's; reuses the .bk-* row styles that
  // buoyant.css defines globally). All emoji are HTML entities.
  // ===================================================================

  var KEY_ROWS = [
    ["&#x1F6B6;", "Emoji explorer", false,
     "Every face request drops one explorer through the ceiling chute. The emoji is the smiley service's answer. It lands, walks LEFT, bounces off the wall, then marches the full platform to the cliff edge.",
     "Default calm settings. Faces &#x25B8; Calm Faces (&#x2318;K) gets you back here."],
    ["&#x1FA82;", "Parachute rescue (center cells)", false,
     "A valid color saves the explorer. <b>Center-grid</b> requests (/face/center/) get a color-matched parachute at the cliff: a gentle drift down, then the hike past the lower wall and out the glowing exit door.",
     "Healthy responses do this automatically &#x2014; the chute is the color service's color."],
    ["&#x1FA81;", "Hang glider express (edge cells)", false,
     "<b>Edge-ring</b> requests (/face/edge/) skip the hike: a color-matched hang glider carries them from the cliff straight to the exit door in one long swoop.",
     "Automatic &#x2014; based on each request's endpoint. Edge ring thickness: Settings &#x25B8; Display &#x25B8; Edge size."],
    ["&#x1FAA8;", "Rock = wrong tool", true,
     "No usable color in the response: the explorer carries a little rock instead (wrong tool!). Nothing saves it at the cliff &#x2014; it falls and splats.",
     "Settings (&#x2318;,) &#x25B8; Simulator &#x25B8; Color &#x25B8; Error fraction."],
    ["&#x2753;", "Mystery explorer", false,
     "No usable emoji in the response: a &#x2753; walks the cave instead. A valid color still rescues it at the cliff.",
     "Settings &#x25B8; Simulator &#x25B8; Smiley &#x25B8; Error fraction."],
    ["&#x1F4A5;", "Slapstick failures at the cliff", true,
     "The face service failed fast (HTTP 5xx / unparseable): the explorer beelines to the cliff, where disaster strikes &#x2014; it skids off the lip unable to stop, a boulder bats it clean over, or it trips and stumbles over at speed. Either way it sails over the edge, tumbling, and the splat happens when it hits the ground below.",
     "Settings &#x25B8; Simulator &#x25B8; Face &#x25B8; Error fraction up (try 50&#x2013;100%) with Delay 0."],
    ["&#x1F634;", "Timeouts: &#x1F635; and &#x1F634;", false,
     "Timeout/rate-limit responses send a &#x1F635; (or sleepy &#x1F634;) explorer to a slapstick end.",
     "Settings &#x25B8; Simulator &#x25B8; Face &#x25B8; Max rate (small, e.g. 1 RPS) floods 429s; Latch makes errors stick until calmed."],
    ["&#x23F3;", "Nervous pacing at the cliff", false,
     "A slow but successful response (latency &#x2265; slow threshold, default 900 ms) hesitates &#x2014; pacing back and forth at the cliff edge before its fate resolves.",
     "Settings &#x25B8; Simulator &#x25B8; any service &#x25B8; Delay at/above the threshold. Tune it in Settings &#x25B8; Display."],
    ["&#x1F3AF;", "Crush an explorer!", false,
     "Click any explorer: it freezes in terror and a boulder flattens it with a dust poof. The scoreboard pill (top right) keeps your crush count &#x2014; badge upgrades at 10, 25, 50, and 100.",
     "Just click one. Purely visual &#x2014; no request is harmed."],
    ["&#x1F39A;&#xFE0F;", "Explorers/sec slider", false,
     "Controls how many explorers per second enter the cave &#x2014; and the actual server request rate. Range: 1 every 2 sec (0.5/s) to 20/s.",
     "Drag <b>Explorers</b> in the toolbar, or Settings &#x25B8; Grid &#x25B8; Explorers/sec."],
  ];

  function installKeyPopup() {
    var toolbar = document.getElementById("toolbar");
    if (!toolbar || document.getElementById("cavernKeyPopup")) return;

    var overlay = document.createElement("div");
    overlay.id = "cavernKeyPopup";
    overlay.className = "cavern-key-overlay";
    var rows = KEY_ROWS.map(function (r) {
      return '<div class="bk-row' + (r[2] ? " bk-star" : "") + '">' +
               '<div class="bk-icon">' + r[0] + '</div>' +
               '<div>' +
                 '<div class="bk-title">' + r[1] + '</div>' +
                 '<div class="bk-desc">' + r[3] + '</div>' +
                 '<div class="bk-how"><b>Make it happen:</b> ' + r[4] + '</div>' +
               '</div>' +
             '</div>';
    }).join("");
    overlay.innerHTML =
      '<div class="cavern-key-card" role="dialog" aria-label="Cavern mode key">' +
        '<div class="buoyant-key-header">' +
          '<h2>Cavern Mode Key</h2>' +
          '<button type="button" class="buoyant-key-close" aria-label="Close">&times;</button>' +
        '</div>' +
        '<p class="bk-intro">Every face request becomes one tiny explorer: ' +
          '<b>emoji = character, color = the parachute that saves it</b>. The chaos ' +
          'knobs live in Settings (&#x2318;,) &#x25B8; Simulator; with a remote backend, the real ' +
          'face/smiley/color services decide each explorer’s fate instead.</p>' +
        rows +
      '</div>';
    // Direct child of <body>: the floating .wrapper is transformed, which
    // would otherwise become this fixed overlay's containing block.
    document.body.appendChild(overlay);

    // Capture phase on the toolbar runs before the button's own (classic-key)
    // listener, so in Cavern mode the classic popup never opens. buoyant.js
    // has the same listener gated on its own mode — they don't collide.
    toolbar.addEventListener("click", function (e) {
      if (visualMode !== "cavern") return;
      var t = e.target;
      if (t && t.id === "btnShowKey") {
        e.preventDefault();
        e.stopPropagation();
        overlay.classList.add("open");
      }
    }, true);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay || (e.target.closest && e.target.closest(".buoyant-key-close"))) {
        overlay.classList.remove("open");
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") overlay.classList.remove("open");
    });
  }

  function closeCavernKey() {
    var o = document.getElementById("cavernKeyPopup");
    if (o) o.classList.remove("open");
  }

  // ===================================================================
  // Helpers
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
    var ta      = document.createElement("textarea");
    ta.innerHTML = value;
    var decoded = ta.value.trim();
    if (!decoded || decoded.length > 16 || /^[0-9]+$/.test(decoded)) return FALLBACK_EMOJI;
    return decoded;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(v)     { return Math.max(0, Math.min(1, v)); }
  function rand(a, b)     { return a + Math.random() * (b - a); }
  function easeInQuad(t)  { return t * t; }
  function easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }
  function easeOutCubic(t){ return 1 - Math.pow(1 - t, 3); }

  function easeOutBounce(t) {
    var n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1)        return n1 * t * t;
    if (t < 2 / d1)        { t -= 1.5  / d1; return n1 * t * t + 0.75; }
    if (t < 2.5 / d1)      { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
    t -= 2.625 / d1;        return n1 * t * t + 0.984375;
  }

  // ===================================================================
  // Public API
  // ===================================================================

  // Called by buoyant.js whenever the mode selector changes.
  window.__cavernSetMode__ = function (mode) {
    visualMode = mode;
    if (mode === "cavern") startCavern();
    else { stopCavern(); closeCavernKey(); }
  };

  // Sync the toolbar rate slider label when switching to cavern mode.
  window.__applyCavernSettings__ = function () {
    if (window.__syncRateControl__) window.__syncRateControl__(maxRatePerSec());
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

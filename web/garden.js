// garden.js — Garden visual mode for Faces request events.
//
// Every completed Faces request becomes a colored raindrop that falls into a
// soil plot and grows into a flower. Petal color = returned color; flower
// center = returned emoji. Slow requests become sleeping buds; errors grow
// weeds. Ambient hobbit-like gardeners wander between the plots.
//
// Architecture: subscribes to the shared __FACES_DEBUG__ bus (never owns
// polling), full-bleed canvas, RAF loop stops when mode is inactive.
// buoyant.js owns body-class management and calls window.__gardenSetMode__.
//
// All emoji literals are \u-escaped per BUOYANT-MODE §10.
//
// SPDX-License-Identifier: Apache-2.0

(function () {
  "use strict";

  // \u-escaped glyph literals (charset safety — see BUOYANT-MODE §10)
  var FALLBACK_EMOJI  = "❓";        // ❓
  var SLEEPY_EMOJI    = "😴";  // 😴
  var DIZZY_EMOJI     = "😵";  // 😵
  var FALLBACK_COLOR  = "#c8b89a";       // earthy soil tan

  var MAX_FLOWERS   = 80;
  var MAX_WEATHER   = 8;
  var MAX_BUTTER    = 6;

  // ===================================================================
  // Planting spots — image-fraction coordinates measured from garden.png
  // (1672×941). Arranged back-to-front for depth sorting.
  // Sky occupies fy ~0-0.28; hobbit village ~0.28-0.42; soil plots ~0.42-0.85.
  // ===================================================================

  // PLOTS — pixel-accurate centres derived by flood-filling the enclosed
  // areas in garden-green-outlines.png (1672×941). mx()/my() maps these
  // fractions to screen coordinates through the cover-scale bottom-anchor
  // transform, so flowers always land on the painted soil beds.
  // Wide/large plots are split into 2-3 sub-spots for burst traffic.
  var PLOTS = [
    // ── Background row (fy 0.44–0.49, smallest flowers) ─────────────────
    {fx:0.1023, fy:0.4655},
    {fx:0.2811, fy:0.4527},
    {fx:0.3577, fy:0.4453},
    {fx:0.4157, fy:0.4527},
    {fx:0.5520, fy:0.4750},
    {fx:0.7853, fy:0.4400},
    {fx:0.7093, fy:0.4814},
    // ── Midground row (fy 0.53–0.60) ────────────────────────────────────
    {fx:0.3947, fy:0.5845},
    {fx:0.5257, fy:0.5760},
    {fx:0.8212, fy:0.5345},
    {fx:0.9007, fy:0.5962},
    // ── Foreground row (fy 0.60–0.68) ───────────────────────────────────
    {fx:0.0502, fy:0.6079},
    {fx:0.2781, fy:0.6164},
    {fx:0.3410, fy:0.6674},  // wide centre cluster, split L
    {fx:0.4103, fy:0.6674},  // wide centre cluster, mid
    {fx:0.4796, fy:0.6674},  // wide centre cluster, split R
    {fx:0.6585, fy:0.6599},
    // ── Near foreground / big round plot (fy 0.82) ───────────────────────
    {fx:0.4190, fy:0.8172},  // round plot L
    {fx:0.5042, fy:0.8172},  // round plot centre
    {fx:0.5894, fy:0.8172},  // round plot R
  ];

  // Depth scale: further back = smaller. fy ranges ~0.44 (back) to ~0.82 (front).
  function depthScale(fy) {
    var t = Math.max(0, Math.min(1, (fy - 0.44) / (0.82 - 0.44)));
    return 0.48 + t * 0.52; // 0.48 (back) .. 1.00 (front)
  }

  var occupied = {};  // spotIdx → flowerId

  // center cells → back/mid rows (indices 0-10, smaller flowers further back)
  // edge cells   → foreground rows (indices 11-20, larger closer flowers)
  // Falls back to any available spot if the preferred zone is full.
  var CENTER_RANGE = [0, 11];   // [inclusive, exclusive)
  var EDGE_RANGE   = [11, PLOTS.length];

  function pickSpot(which) {
    var lo = (which === "edge") ? EDGE_RANGE[0] : CENTER_RANGE[0];
    var hi = (which === "edge") ? EDGE_RANGE[1] : CENTER_RANGE[1];
    var pref = [], fallback = [];
    for (var i = 0; i < PLOTS.length; i++) {
      if (occupied[i]) continue;
      if (i >= lo && i < hi) pref.push(i); else fallback.push(i);
    }
    var pool = pref.length ? pref : fallback;
    if (!pool.length) return -1;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ===================================================================
  // Module state
  // ===================================================================

  var root, canvas, ctx, hudCounts;
  var dpr = 1, width = 800, height = 500;
  var visualMode   = "classic";
  var slowThreshMs = 900;
  var seq = 0, running = false, raf = 0, lastFrame = 0;
  var admittedTimes = [];
  var maxRatePerSec = 8;
  var flowers   = [];
  var butterflies = [];
  var wclouds   = [];
  var pluckCount = 0, pluckPill = null;

  var bg = new Image();
  bg.src = "garden.png";

  // ===================================================================
  // Cover-scale bottom-anchored coordinate mapping (same as all modes)
  // ===================================================================

  function bgM() {
    if (!(bg.complete && bg.naturalWidth)) return null;
    var iw = bg.naturalWidth, ih = bg.naturalHeight;
    var s = Math.max(width / iw, height / ih);
    return {iw:iw, ih:ih, s:s, ox:(iw - width/s)/2, oy:Math.max(0, ih - height/s)};
  }

  function mx(fx) { var m = bgM(); return m ? (fx*m.iw - m.ox)*m.s : fx*width;  }
  function my(fy) { var m = bgM(); return m ? (fy*m.ih - m.oy)*m.s : fy*height; }

  // ===================================================================
  // Classification (mirrors buoyant.js classify)
  // ===================================================================

  function classify(entry) {
    var parsed     = safeJson(entry.body, null);
    var parseFail  = !!entry.body && parsed == null;
    var status     = Number(entry.status || 0);
    var hasColor   = parsed && validColor(parsed.color);
    var color      = hasColor ? parsed.color : FALLBACK_COLOR;
    var rawEmoji   = normalizeEmoji(parsed && parsed.smiley);
    var hasEmoji   = rawEmoji !== FALLBACK_EMOJI;
    var errors     = parsed && Array.isArray(parsed.errors) ? parsed.errors : [];
    var failed     = status === 0 || status === 504 || status === 429 || status >= 500 || parseFail;
    var partial    = !failed && errors.length > 0;
    var latMs      = Number(entry.latencyMs || 0);
    var slow       = latMs >= slowThreshMs;
    var emoji      = (failed && !hasEmoji)
      ? (status === 504 || status === 0 ? SLEEPY_EMOJI : DIZZY_EMOJI)
      : rawEmoji;
    return {
      id:++seq, status, latMs, slow, failed, partial, parseFail,
      hasColor, hasEmoji, color, emoji,
      which: entry.which || "face",
    };
  }

  // ===================================================================
  // Spawning
  // ===================================================================

  function spawnFromRequest(entry) {
    var now = performance.now();
    while (admittedTimes.length && now - admittedTimes[0] > 1000) admittedTimes.shift();
    if (admittedTimes.length >= maxRatePerSec) return;
    if (flowers.length >= MAX_FLOWERS) return;

    var c = classify(entry);
    var idx = pickSpot(c.which);
    if (idx < 0) return;

    admittedTimes.push(now);
    var f = makeFlower(c, idx);
    occupied[idx] = f.id;
    flowers.push(f);

    if (c.failed || c.partial) {
      spawnCloud(c.failed ? 2 : 1);
    } else if (!c.failed && !c.partial && butterflies.length < MAX_BUTTER && Math.random() < 0.12) {
      spawnButterfly();
    }
  }

  // ===================================================================
  // Flower model
  // Phases: fall → splash → sprout → [bud if slow] → grow → bloom → fade → done
  // Errors branch the drawing (weed instead of flower) but reuse the same phases.
  // ===================================================================

  function makeFlower(c, spotIdx) {
    var spot = PLOTS[spotIdx];
    var s    = depthScale(spot.fy);
    var px   = mx(spot.fx);
    var py   = my(spot.fy);
    var fail = c.failed;
    var slow = c.slow;

    // Rain starts in the sky: random x near the plot, y in the sky band.
    var skyFy  = 0.04 + Math.random() * 0.16;
    var rainX  = mx(spot.fx + rand(-0.06, 0.06));
    var rainY  = my(skyFy);

    return {
      id:       c.id,
      spotIdx:  spotIdx,
      px: px, py: py,
      scale:    s,
      color:    c.color,
      emoji:    c.emoji,
      hasColor: c.hasColor,
      hasEmoji: c.hasEmoji,
      failed:   fail,
      slow:     slow,
      partial:  c.partial,
      rainX: rainX, rainY: rainY,
      nPetals:  fail ? 4 : 6,
      petalOff: (function() {
        var a = [];
        var n = fail ? 4 : 6;
        for (var i=0;i<n;i++) a.push((i/n)*Math.PI*2 + rand(-0.15,0.15));
        return a;
      })(),
      swayPhase: rand(0, Math.PI*2),
      swaySpeed: rand(0.7, 1.3),
      // Phase timing
      born:      nowSec() + rand(0, 0.7), // entry stagger
      phase:     "fall",
      phaseStart: 0,
      // Durations (seconds)
      fallDur:   slow ? rand(1.6, 2.4) : rand(0.7, 1.1),
      splashDur: 0.38,
      sproutDur: rand(0.4, 0.7),
      budDur:    slow ? rand(2.5, 5.5) : 0,
      growDur:   slow ? rand(1.0, 1.8) : rand(0.6, 1.0),
      bloomDur:  fail ? rand(2.5, 5.0) : rand(7.0, 14.0),
      fadeDur:   rand(0.8, 1.3),
      // Pluck state
      plucked:   false,
      pluckT:    0,
    };
  }

  // ===================================================================
  // Update
  // ===================================================================

  function update(dt, t) {
    for (var i = flowers.length - 1; i >= 0; i--) {
      var f = flowers[i];
      if (f.phase === "done") {
        if (occupied[f.spotIdx] === f.id) delete occupied[f.spotIdx];
        flowers.splice(i, 1);
        continue;
      }
      var age = t - f.born;
      if (age < 0) continue;
      updatePhase(f, age, t);
    }

    butterflies = butterflies.filter(function(b){ return b.age + dt < b.life; });
    for (var bi = 0; bi < butterflies.length; bi++) butterflies[bi].age += dt;
    wclouds = wclouds.filter(function(w){ return (t - w.born) < w.life; });

    if (hudCounts) {
      var blooming = 0;
      for (var fi=0;fi<flowers.length;fi++) if (flowers[fi].phase==="bloom") blooming++;
      hudCounts.textContent = flowers.length + " growing · " + blooming + " blooming";
    }
  }

  function updatePhase(f, age, t) {
    var pt = age - f.phaseStart;
    if (f.phase === "fall") {
      if (pt >= f.fallDur) transition(f, age, "splash");
    } else if (f.phase === "splash") {
      if (pt >= f.splashDur) transition(f, age, "sprout");
    } else if (f.phase === "sprout") {
      if (pt >= f.sproutDur) transition(f, age, f.slow ? "bud" : "grow");
    } else if (f.phase === "bud") {
      if (pt >= f.budDur) transition(f, age, "grow");
    } else if (f.phase === "grow") {
      if (pt >= f.growDur) transition(f, age, "bloom");
    } else if (f.phase === "bloom") {
      if (pt >= f.bloomDur) transition(f, age, "fade");
    } else if (f.phase === "fade") {
      if (pt >= f.fadeDur) f.phase = "done";
    }
  }

  function transition(f, age, next) { f.phase = next; f.phaseStart = age; }

  // ===================================================================
  // Draw
  // ===================================================================

  function draw(t) {
    ctx.clearRect(0, 0, width, height);
    drawBg();

    // Depth sort: draw back plots first (lower fy = further back)
    var sorted = flowers.slice().sort(function(a,b){ return a.py - b.py; });

    for (var i=0;i<sorted.length;i++) drawFlower(sorted[i], t);

    for (var bi=0;bi<butterflies.length;bi++) drawButterfly(butterflies[bi], t);
    drawClouds(t);
  }

  function drawBg() {
    ctx.imageSmoothingEnabled = false;
    var m = bgM();
    if (m) {
      ctx.drawImage(bg, m.ox, m.oy, width/m.s, height/m.s, 0, 0, width, height);
    } else {
      var g = ctx.createLinearGradient(0,0,0,height);
      g.addColorStop(0, "#7ec8e3");
      g.addColorStop(0.3, "#a8d890");
      g.addColorStop(1, "#8b6642");
      ctx.fillStyle = g;
      ctx.fillRect(0,0,width,height);
    }
    ctx.imageSmoothingEnabled = true;
  }

  function drawFlower(f, t) {
    var age = t - f.born;
    if (age < 0) return;
    var pt  = age - f.phaseStart;
    var s   = f.scale;

    if (f.phase === "fall") {
      drawRaindrop(f, clamp01(pt / f.fallDur), s);
    } else if (f.phase === "splash") {
      drawSplash(f, clamp01(pt / f.splashDur), s);
    } else if (f.phase === "sprout") {
      drawStem(f, clamp01(pt / f.sproutDur), 0, s);
    } else if (f.phase === "bud") {
      drawStem(f, 1, 0, s);
      drawBud(f, 0.5 + 0.5*Math.sin(t*1.5+f.swayPhase), s, t);
    } else if (f.phase === "grow") {
      var gp = clamp01(pt / f.growDur);
      drawStem(f, 1, 0, s);
      if (f.failed) drawWeed(f, gp, s);
      else          drawBloom(f, gp, t, s);
    } else if (f.phase === "bloom") {
      var sway = Math.sin(t*f.swaySpeed+f.swayPhase) * 0.07;
      drawStem(f, 1, sway, s);
      if (f.failed) {
        drawWeed(f, 1, s);
      } else {
        drawBloom(f, 1, t, s);
        if (pt < 1.2) drawSparkle(f, pt, s); // bloom entry sparkle
      }
    } else if (f.phase === "fade") {
      var alpha = Math.max(0, 1 - pt / f.fadeDur);
      ctx.save();
      ctx.globalAlpha = alpha;
      drawStem(f, 1, 0, s);
      if (f.failed) drawWeed(f, 1, s);
      else          drawBloom(f, 1, t, s);
      if (f.plucked && pt < 0.5) drawPluckBurst(f, pt, s);
      ctx.restore();
    }
  }

  // ---------- Raindrop ----------

  function drawRaindrop(f, p, s) {
    var x = f.rainX + (f.px - f.rainX) * easeInQuad(p);
    var y = f.rainY + (f.py - f.rainY) * easeInQuad(p);
    var alpha = p > 0.82 ? 1 - (p-0.82)/0.18 : 1;

    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(x, y);

    var h = 30*s, w = 18*s;
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.bezierCurveTo( w*0.75, -h*0.25,  w, h*0.15, 0,  h*0.4);
    ctx.bezierCurveTo(-w, h*0.15, -w*0.75, -h*0.25, 0, -h);
    ctx.fillStyle = f.color;
    ctx.fill();
    // Shine
    ctx.fillStyle = "rgba(255,255,255,0.38)";
    ctx.beginPath();
    ctx.ellipse(-w*0.18, -h*0.42, w*0.18, h*0.16, -0.3, 0, Math.PI*2);
    ctx.fill();
    // Trailing droplets
    if (!f.slow) {
      ctx.fillStyle = f.color;
      for (var i=1; i<=3; i++) {
        ctx.save();
        ctx.globalAlpha = clamp01(alpha) * Math.max(0, 0.55 - i*0.18);
        ctx.translate(0, -i*14*s);
        ctx.beginPath();
        ctx.ellipse(0, 0, 3*s, 5*s, 0, 0, Math.PI*2);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // ---------- Splash ----------

  function drawSplash(f, p, s) {
    ctx.save();
    ctx.translate(f.px, f.py);
    var alpha = Math.max(0, 1 - p);
    ctx.globalAlpha = alpha;

    if (f.failed) {
      // Mud splat
      ctx.fillStyle = "#7a5c3c";
      for (var i=0;i<6;i++) {
        var a = (i/6)*Math.PI*2;
        var r = (8 + p*22)*s;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a)*r, Math.sin(a)*r*0.45, 5*s, 4*s, a, 0, Math.PI*2);
        ctx.fill();
      }
    } else {
      // Water rings + droplets
      ctx.strokeStyle = f.color;
      ctx.lineWidth = 2*s;
      ctx.beginPath();
      ctx.ellipse(0, 0, p*22*s, p*9*s, 0, 0, Math.PI*2);
      ctx.stroke();
      ctx.fillStyle = f.color;
      for (var i=0;i<6;i++) {
        var a = (i/6)*Math.PI*2;
        var r = p*18*s;
        ctx.beginPath();
        ctx.arc(Math.cos(a)*r, Math.sin(a)*r*0.5, 3*s, 0, Math.PI*2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ---------- Stem & leaves ----------

  function stemTip(f, s, sway) {
    var stemH = 90*s;
    return {
      x: f.px + Math.sin(sway||0)*stemH,
      y: f.py - stemH,
    };
  }

  function drawStem(f, p, sway, s) {
    sway = sway || 0;
    var stemH = 90*s*p;
    var tipX = f.px + Math.sin(sway)*stemH;
    var tipY = f.py - stemH;

    ctx.save();
    // Thick stem: draw a dark shadow first, then the green on top for boldness
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 9*s;
    ctx.beginPath();
    ctx.moveTo(f.px, f.py);
    ctx.quadraticCurveTo(f.px + Math.sin(sway)*stemH*0.5, f.py - stemH*0.6, tipX+1, tipY+1);
    ctx.stroke();
    ctx.strokeStyle = "#3a8228";
    ctx.lineWidth = 7*s;
    ctx.beginPath();
    ctx.moveTo(f.px, f.py);
    ctx.quadraticCurveTo(f.px + Math.sin(sway)*stemH*0.5, f.py - stemH*0.6, tipX, tipY);
    ctx.stroke();

    if (p > 0.45) {
      var lp = clamp01((p-0.45)*1.82);
      drawLeaf(f.px + Math.sin(sway)*stemH*0.38, f.py - stemH*0.45, s, lp, false);
    }
    if (p > 0.7) {
      var lp2 = clamp01((p-0.7)*3.33);
      drawLeaf(f.px + Math.sin(sway)*stemH*0.22, f.py - stemH*0.28, s, lp2, true);
    }
    ctx.restore();
  }

  function drawLeaf(x, y, s, p, flip) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(flip ? 0.65 : -0.65);
    ctx.scale(flip ? -1 : 1, 1);
    ctx.fillStyle = "#5aaa44";
    ctx.beginPath();
    ctx.moveTo(0,0);
    ctx.bezierCurveTo(9*s*p, -5*s*p, 15*s*p, 1*s*p, 9*s*p, 7*s*p);
    ctx.bezierCurveTo(4*s*p,  5*s*p, 0, 2*s*p, 0, 0);
    ctx.fill();
    ctx.restore();
  }

  // ---------- Bud (slow request waiting) ----------

  function drawBud(f, pulse, s, t) {
    var stemH = 90*s;
    var cx = f.px, cy = f.py - stemH;
    ctx.save();
    ctx.translate(cx, cy);
    var bh = (22 + pulse*6)*s;
    // Green outer
    ctx.fillStyle = "#4a8c3a";
    ctx.beginPath();
    ctx.ellipse(0, -bh*0.55, bh*0.48, bh, 0, 0, Math.PI*2);
    ctx.fill();
    // Color peek at tip
    ctx.fillStyle = f.color;
    ctx.beginPath();
    ctx.ellipse(0, -bh*1.05, bh*0.28, bh*0.28, 0, 0, Math.PI*2);
    ctx.fill();
    // Sleepy emoji floating above
    ctx.font = Math.max(12, 24*s) + "px \"Apple Color Emoji\",\"Segoe UI Emoji\",sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    var ey = -bh*2.0 + Math.sin(t*1.2+f.swayPhase)*3*s;
    ctx.fillText(SLEEPY_EMOJI, 0, ey);
    ctx.restore();
  }

  // ---------- Bloom (healthy flower) ----------

  function drawBloom(f, p, t, s) {
    var sway   = Math.sin(t*f.swaySpeed+f.swayPhase)*0.07*p;
    var stemH  = 90*s;
    var cx     = f.px + Math.sin(sway)*stemH;
    var cy     = f.py - stemH;
    var petalR = 40*s*p;
    var petalH = 54*s*p;

    ctx.save();
    ctx.translate(cx, cy);

    // Petals
    for (var i=0;i<f.nPetals;i++) {
      ctx.save();
      ctx.rotate(f.petalOff[i]);
      ctx.fillStyle = f.color;
      ctx.beginPath();
      // Ellipse pointing outward
      ctx.ellipse(0, -(petalR + petalH*0.5), petalR*0.52, petalH*0.56, 0, 0, Math.PI*2);
      ctx.fill();
      // Vein
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0,-petalR*0.2);
      ctx.lineTo(0,-(petalR+petalH));
      ctx.stroke();
      ctx.restore();
    }

    // Center disc
    var cr = 22*s*p;
    ctx.fillStyle = "#f5d060";
    ctx.beginPath(); ctx.arc(0,0,cr,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle = "rgba(180,120,0,0.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0,0,cr,0,Math.PI*2); ctx.stroke();

    // Emoji center (grows in during bloom)
    if (p > 0.45) {
      var eSize = clamp01((p-0.45)*1.82);
      var eFnt  = Math.max(12, 32*s*eSize);
      ctx.font = eFnt + "px \"Apple Color Emoji\",\"Segoe UI Emoji\",sans-serif";
      ctx.textAlign   = "center";
      ctx.textBaseline= "middle";
      ctx.fillText(f.emoji || FALLBACK_EMOJI, 0, 0);
    }

    // Partial-error badge
    if (f.partial && p > 0.6) {
      var bx = (petalR + 11*s), by = -(petalR + 11*s);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.strokeStyle = "#c04040";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(bx, by, 8*s, 0, Math.PI*2);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#c04040";
      ctx.font = "bold " + Math.max(7, 10*s) + "px -apple-system,sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("!", bx, by);
    }

    ctx.restore();
  }

  // ---------- Weed (failed request) ----------

  function drawWeed(f, p, s) {
    var stemH = 90*s;
    var cx = f.px, cy = f.py - stemH;
    ctx.save();
    ctx.translate(cx, cy);
    var n = f.nPetals + 2;
    for (var i=0;i<n;i++) {
      var a  = (i/n)*Math.PI*2 + f.swayPhase;
      var r  = (14 + (i%3)*10)*s*p;
      ctx.save();
      ctx.rotate(a);
      ctx.strokeStyle = "#3a6018"; ctx.lineWidth = 2*s;
      ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(0,-r); ctx.stroke();
      ctx.fillStyle = "#4a7020";
      ctx.beginPath(); ctx.arc(0,-r,3*s*p,0,Math.PI*2); ctx.fill();
      ctx.restore();
    }
    var cr = 14*s*p;
    ctx.fillStyle = "#2a3a12";
    ctx.beginPath(); ctx.arc(0,0,cr,0,Math.PI*2); ctx.fill();
    if (p > 0.55) {
      var es = Math.max(12, 22*s);
      ctx.font = es + "px \"Apple Color Emoji\",\"Segoe UI Emoji\",sans-serif";
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillText(f.emoji || DIZZY_EMOJI, 0, 0);
    }
    ctx.restore();
  }

  // ---------- Sparkle on bloom ----------

  function drawSparkle(f, pt, s) {
    var alpha = Math.max(0, 1 - pt/1.2);
    var stemH = 90*s;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(f.px, f.py - stemH);
    ctx.fillStyle = "#ffe066";
    var r = 20*s + pt*30*s;
    for (var i=0;i<7;i++) {
      var a = (i/7)*Math.PI*2;
      ctx.beginPath(); ctx.arc(Math.cos(a)*r, Math.sin(a)*r, 3*s, 0, Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  // ---------- Pluck burst ----------

  function drawPluckBurst(f, pt, s) {
    var alpha = Math.max(0, 1 - pt/0.5);
    var stemH = 90*s;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(f.px, f.py - stemH);
    // Petal shards fly outward
    ctx.strokeStyle = f.color;
    ctx.lineWidth = 3*s;
    ctx.lineCap = "round";
    for (var i=0;i<8;i++) {
      var a = (i/8)*Math.PI*2 + f.swayPhase;
      var r0 = (8 + pt*40)*s, r1 = r0 + 12*s*(1-pt);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a)*r0, Math.sin(a)*r0);
      ctx.lineTo(Math.cos(a)*r1, Math.sin(a)*r1);
      ctx.stroke();
    }
    // White flash
    if (pt < 0.2) {
      ctx.globalAlpha *= 1 - pt/0.2;
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(0,0,(5+pt*20)*s,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
  }

  // ===================================================================
  // Butterflies
  // ===================================================================

  var BFLY_COLORS = ["#ff88bb","#88aaff","#ffdd55","#88ffcc","#ffaa66","#cc88ff"];

  function spawnButterfly() {
    var i = Math.floor(Math.random()*(PLOTS.length/2)) + Math.floor(PLOTS.length/2);
    var p = PLOTS[Math.min(i, PLOTS.length-1)];
    butterflies.push({
      x: mx(p.fx), y: my(p.fy - 0.06),
      vx: rand(-22,22), vy: rand(-18,-8),
      color: BFLY_COLORS[Math.floor(Math.random()*BFLY_COLORS.length)],
      age: 0, life: rand(2.5, 5.5),
      phase: rand(0, Math.PI*2),
    });
  }

  function drawButterfly(b, t) {
    var life = b.life, age = b.age;
    var alpha = age < 0.4 ? age/0.4 : age > life-0.6 ? (life-age)/0.6 : 1;
    if (alpha <= 0) return;
    ctx.save();
    ctx.translate(b.x + b.vx*age, b.y + b.vy*age + Math.sin(age*5+b.phase)*9);
    ctx.globalAlpha = clamp01(alpha) * 0.85;
    var flap = 0.7 + 0.3*Math.sin(t*9+b.phase);
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.ellipse(-8*flap, 0, 7*flap, 5, 0.3, 0, Math.PI*2);
    ctx.ellipse( 8*flap, 0, 7*flap, 5,-0.3, 0, Math.PI*2);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath(); ctx.ellipse(0,0,1.5,1.5,0,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }

  // ===================================================================
  // Storm clouds (appear on errors)
  // ===================================================================

  function spawnCloud(n) {
    for (var i=0;i<n;i++) {
      wclouds.push({ born:nowSec(), life:rand(2.5,4.5), x:rand(0.1,0.9), y:rand(0.04,0.22) });
    }
    while (wclouds.length > MAX_WEATHER) wclouds.shift();
  }

  function drawClouds(t) {
    for (var i=0;i<wclouds.length;i++) {
      var w = wclouds[i];
      var age = t - w.born, p = clamp01(age / w.life);
      var alpha = p < 0.2 ? p/0.2 : p > 0.7 ? 1-(p-0.7)/0.3 : 1;
      if (alpha <= 0) continue;
      var cx = w.x*width, cy = w.y*height;
      ctx.save();
      ctx.globalAlpha = alpha * 0.55;
      ctx.fillStyle = "#8090a0";
      ctx.beginPath();
      ctx.arc(cx-18, cy+8, 17, 0, Math.PI*2);
      ctx.arc(cx,    cy,   22, 0, Math.PI*2);
      ctx.arc(cx+22, cy+10,15, 0, Math.PI*2);
      ctx.fill();
      if (p > 0.25 && p < 0.8) {
        ctx.strokeStyle = "#88aacc"; ctx.lineWidth = 1.5;
        for (var d=0;d<5;d++) {
          var rx = cx-20+d*12, ry = cy+28 + (t*38+d*14)%28;
          ctx.beginPath(); ctx.moveTo(rx,ry); ctx.lineTo(rx-2,ry+9); ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  // ===================================================================
  // Click to pluck
  // ===================================================================

  function flowerAt(px, py) {
    for (var i=flowers.length-1; i>=0; i--) {
      var f = flowers[i];
      if (f.phase !== "bloom") continue;
      var s    = f.scale;
      var stemH= 90*s;
      var cx   = f.px, cy = f.py - stemH;
      var dx   = px-cx, dy = py-cy;
      if (dx*dx + dy*dy <= (50*s)*(50*s)) return f;
    }
    return null;
  }

  function handleClick(e) {
    if (visualMode !== "garden") return;
    var f = flowerAt(e.offsetX, e.offsetY);
    if (f) pluckFlower(f, e.offsetX, e.offsetY);
  }

  function handleMouseMove(e) {
    if (visualMode !== "garden") return;
    canvas.style.cursor = flowerAt(e.offsetX, e.offsetY) ? "pointer" : "default";
  }

  function pluckFlower(f) {
    if (f.phase !== "bloom") return;
    var age = nowSec() - f.born;
    f.phase = "fade";
    f.phaseStart = age;
    f.fadeDur = 0.65;
    f.plucked = true;
    f.pluckT = age;
    bumpPluck();
  }

  // Pluck scoreboard (same pattern as buoyant popCount)
  function pluckBadge(n) {
    if (n >= 100) return "&#x1F451;"; // 👑 crown
    if (n >= 50)  return "&#x1F490;"; // 💐 bouquet
    if (n >= 25)  return "&#x1F33A;"; // 🌺 hibiscus
    if (n >= 10)  return "&#x1F33C;"; // 🌼 blossom
    return "&#x1F337;";               // 🌷 tulip
  }

  function bumpPluck() {
    pluckCount++;
    if (window.__FACES_STATS__) window.__FACES_STATS__.bumpInteraction();
    if (!pluckPill) {
      var hud = document.querySelector(".garden-hud");
      if (!hud) return;
      pluckPill = document.createElement("span");
      pluckPill.className = "garden-pluck-pill";
      hud.appendChild(pluckPill);
    }
    pluckPill.innerHTML = pluckCount === 1
      ? pluckBadge(1) + " First pluck!"
      : pluckBadge(pluckCount) + " " + pluckCount + " plucked";
    pluckPill.classList.remove("bump");
    void pluckPill.offsetWidth;
    pluckPill.classList.add("bump");
  }

  // ===================================================================
  // Key popup
  // ===================================================================

  var KEY_ROWS = [
    ["&#x1F337;", "Colored bloom", false,
     "A fast healthy response. The returned color becomes the raindrop and petal color; the returned emoji becomes the flower center.",
     "Default calm settings. Faces &#x25B8; Calm Faces (&#x2318;K)."],
    ["&#x1F33C;", "Pluck a flower!", false,
     "Click any blooming flower to pluck it. A petal burst plays and the pluck count appears top-right, with badge upgrades at 10, 25, 50, and 100.",
     "Just click a bloom. Purely visual &#x2014; no request is affected."],
    ["&#x1F4A7;", "Pale raindrop", false,
     "No usable color in the response: a neutral soil-toned raindrop and pale fallback petals.",
     "Color service errors, or malformed color data from a real backend."],
    ["&#x2753;", "&#x2753; in the center", false,
     "No usable emoji in the response: a question-mark bloom with the returned petal color.",
     "Smiley service errors, or malformed emoji data."],
    ["&#x1F634;", "Sleepy bud", false,
     "Slow response (latency &#x2265; threshold). A bud naps with &#x1F634; until the response resolves, then blooms.",
     "Settings &#x25B8; Simulator &#x25B8; any service &#x25B8; Delay at or above the threshold."],
    ["&#x1F33F;", "Weed", true,
     "The face service failed (5xx / parse error). A scraggly weed grows instead of a flower; storm clouds appear.",
     "Settings &#x25B8; Simulator &#x25B8; Face &#x25B8; Error fraction 50&#x2013;100%."],
    ["&#x2757;", "Flower with a ! badge", false,
     "Face answered but smiley or color failed behind it (partial error): a healthy bloom with a red ! badge.",
     "Settings &#x25B8; Simulator &#x25B8; Smiley or Color &#x25B8; Error fraction."],
    ["&#x26C8;&#xFE0F;", "Storm clouds", false,
     "Rain clouds gather over the garden during errors; they clear as services recover.",
     "Set error fractions back to 0, or Faces &#x25B8; Calm Faces (&#x2318;K)."],
    ["&#x1F98B;", "Butterflies", false,
     "Healthy successful blooms occasionally attract colorful butterflies drifting across the scene.",
     "Keep the garden healthy and let blooms accumulate."],
  ];

  function installKeyPopup() {
    var toolbar = document.getElementById("toolbar");
    if (!toolbar || document.getElementById("gardenKeyPopup")) return;

    var overlay = document.createElement("div");
    overlay.id = "gardenKeyPopup";
    overlay.className = "garden-key-overlay";

    var rows = KEY_ROWS.map(function(r) {
      return '<div class="gk-row' + (r[2]?" gk-star":"") + '">' +
        '<div class="gk-icon">' + r[0] + '</div>' +
        '<div><div class="gk-title">' + r[1] + '</div>' +
        '<div class="gk-desc">' + r[3] + '</div>' +
        '<div class="gk-how"><b>Make it happen:</b> ' + r[4] + '</div></div></div>';
    }).join("");

    overlay.innerHTML =
      '<div class="garden-key-card" role="dialog" aria-label="Garden mode key">' +
      '<div class="garden-key-header"><h2>Garden Mode Key</h2>' +
      '<button type="button" class="garden-key-close" aria-label="Close">&times;</button></div>' +
      '<p class="gk-intro">Every face request becomes a garden event &#x2014; raindrops fall and grow into flowers.' +
      ' The chaos knobs live in Settings (&#x2318;,) &#x25B8; Simulator.</p>' +
      rows + '</div>';

    // Overlay must be a direct <body> child (transformed .wrapper would become
    // the fixed containing block — same trap as buoyant.js key popup).
    document.body.appendChild(overlay);

    // Capture phase so we intercept before faces.js's own Show Key handler.
    toolbar.addEventListener("click", function(e) {
      if (visualMode !== "garden") return;
      if (e.target && e.target.id === "btnShowKey") {
        e.preventDefault(); e.stopPropagation();
        overlay.classList.add("open");
      }
    }, true);

    overlay.addEventListener("click", function(e) {
      if (e.target === overlay || (e.target.closest && e.target.closest(".garden-key-close")))
        overlay.classList.remove("open");
    });
    document.addEventListener("keydown", function(e) {
      if (e.key === "Escape") overlay.classList.remove("open");
    });
  }

  // ===================================================================
  // RAF loop
  // ===================================================================

  function start() {
    resize();
    if (running) return;
    running = true;
    lastFrame = performance.now();
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  function loop(now) {
    if (!running) return;
    var dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;
    var t = now / 1000;
    update(dt, t);
    draw(t);
    raf = requestAnimationFrame(loop);
  }

  function resize() {
    if (!canvas || !root) return;
    var rect = root.getBoundingClientRect();
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    width  = Math.max(320, Math.floor(rect.width));
    height = Math.max(260, Math.floor(rect.height));
    canvas.width  = Math.floor(width  * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width  = width  + "px";
    canvas.style.height = height + "px";
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ===================================================================
  // Hooks exposed to buoyant.js and Swift
  // ===================================================================

  window.__gardenSetMode__ = function(mode) {
    visualMode = mode;
    if (mode === "garden") { start(); }
    else {
      stop();
      var ov = document.getElementById("gardenKeyPopup");
      if (ov) ov.classList.remove("open");
    }
  };

  window.__applyGardenSettings__ = function(raw) {
    var cfg = typeof raw === "string" ? safeJson(raw, {}) : (raw || {});
    if (typeof cfg.slowThresholdMs === "number")
      slowThreshMs = Math.max(100, cfg.slowThresholdMs);
    var rateVal = cfg.funModeRatePerSec || cfg.buoyantRatePerSec;
    if (typeof rateVal === "number")
      maxRatePerSec = Math.max(0.1, Math.min(200, rateVal));
  };

  // ===================================================================
  // Boot
  // ===================================================================

  function boot() {
    root      = document.getElementById("garden-root");
    canvas    = document.getElementById("garden-canvas");
    hudCounts = document.getElementById("garden-counts");
    if (!root || !canvas) return;
    ctx = canvas.getContext("2d");

    resize();
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(root);

    canvas.addEventListener("click", handleClick);
    canvas.addEventListener("mousemove", handleMouseMove);

    installKeyPopup();
    subscribeDebug();

    // Attach shared stats HUD to the garden scene root.
    if (window.__FACES_STATS__) {
      var statsEl = document.createElement("div");
      statsEl.className = "fun-stats-hud";
      root.appendChild(statsEl);
      window.__FACES_STATS__.attachHUD(statsEl);
    }
  }

  function subscribeDebug() {
    var bus = window.__FACES_DEBUG__;
    if (!bus) { setTimeout(subscribeDebug, 60); return; }
    bus.subscribe(function(entry) {
      if (!entry) { flowers.length = 0; occupied = {}; return; }
      if (visualMode !== "garden") return;
      spawnFromRequest(entry);
    });
  }

  // ===================================================================
  // Utilities (duplicated from buoyant.js to keep the IIFE self-contained)
  // ===================================================================

  function safeJson(s, fallback) {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch(_) { return fallback; }
  }
  function validColor(c) {
    return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c.trim());
  }
  function normalizeEmoji(v) {
    if (typeof v !== "string" || v.trim() === "") return FALLBACK_EMOJI;
    var d = decodeEntities(v).trim();
    if (!d || d.length > 16 || /^[0-9]+$/.test(d)) return FALLBACK_EMOJI;
    return d;
  }
  function decodeEntities(s) {
    var t = document.createElement("textarea"); t.innerHTML = s; return t.value;
  }
  function nowSec() { return performance.now() / 1000; }
  function rand(a, b) { return a + Math.random()*(b-a); }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function easeInQuad(v) { return v * v; }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

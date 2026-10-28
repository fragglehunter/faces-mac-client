// BRICKWORKS — Bricks Mode animation system
// Each live HTTP request is a toy brick dropped onto a growing wall. The
// request COLOR is the brick's plastic; the request EMOJI is printed on its
// face. Success snaps into place, failures shatter and leave visible GAPS in
// the wall — and later successes repair the oldest gap first, so recovery
// literally rebuilds the wall.
//
// Fully procedural (no image asset) — modelled on fireworks.js / claude.js.
// SPDX-License-Identifier: Apache-2.0
(function () {
  "use strict";

  // ── Constants ─────────────────────────────────────────────────────
  var FALLBACK_COLOR = "#8B9BBF";
  var FALLBACK_EMOJI = "❓"; // ❓
  var MAX_FALLING   = 30;
  var MAX_PARTICLES = 420;
  var ROWS_PER_BUILDER = 5;    // MASTER BUILDER! every Nth completed row...
  var MIN_BUILDER_GAP  = 12;   // ...but never more often than this (seconds)
  var SLEEPY_GREY = "#9aa3b2";
  var FAIL_GREY   = "#6b7280";
  // Minifig mascot palette (the builder standing beside the wall)
  var FIG_HEAD = "#F6C544", FIG_TORSO = "#D01A1A", FIG_LEGS = "#1E62B0", FIG_HAND = "#F0BE3C";

  // ── Module state ──────────────────────────────────────────────────
  var root, canvas, ctx;
  var bgCanvas, bgCtx;             // cached backdrop + base plate
  var W = 800, H = 600, dpr = 1;
  var visualMode = "classic";
  var running = false, raf = 0, lastTs = 0;
  var reduceMotion = false;

  // Wall geometry (recomputed on resize)
  var bw = 80, bh = 42, studH = 12, cols = 10, maxRows = 8;
  var wallLeft = 0, plateTop = 540;
  var figX = 48, figW = 92, figH = 150, figCheerUntil = -10;   // minifig mascot

  // grid[r][c] (r=0 is the BOTTOM row): null | {reserved:true}
  //   | {gap:true, born} | brick {body, stud, edge, emoji, tilt, sticker, born, wobbleT}
  var grid = [];
  var falling = [], particles = [], floaters = [], rowFlashes = [], pops = [];
  var rowsCompleted = 0;
  var lastBuilderTime = -100, builderBannerBorn = -10, flagT = 0;

  var admitted = [];               // rate-limit sliding window (seconds)
  var slowMs = 300, maxRps = 0.5;
  var keyOverlay = null;

  // ── Helpers ───────────────────────────────────────────────────────
  function rand(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeOut(t) { return 1 - (1 - t) * (1 - t); }

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
  // Lift near-black request colors so dark bricks still read on the wall.
  function brickTint(h) {
    var lum = luminance(h);
    if (lum >= 60) return h;
    return lerpHex(h, "#ffffff", ((60 - lum) / 60) * 0.45);
  }
  function brickColors(hex) {
    var body = brickTint(hex);
    return { body: body, stud: lerpHex(body, "#ffffff", 0.28), edge: lerpHex(body, "#000000", 0.28), hi: lerpHex(body, "#ffffff", 0.4) };
  }
  function validHex(s) { return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s); }
  function decodeEmoji(s) {
    if (!s || typeof s !== "string") return "";
    var d = document.createElement("div");
    d.innerHTML = s;
    return (d.textContent || "").trim();
  }
  function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function settings() { return window.__FACES_SETTINGS__ || {}; }
  function maxRatePerSec() {
    var s = settings();
    return clamp(Number(s.funModeRatePerSec || s.buoyantRatePerSec || maxRps) || 0.5, 0.5, 200);   // 200 = super-mode ceiling
  }

  // ── Classify (shared status.js kinds: timeout 504/0 → sleepy 😴; rate-limited
  //    429 → overwhelmed 🤯, also never arrives; other hard fail → 😵 shatters) ──
  function classify(entry) {
    var status = entry.status || 0;
    var body = safeJson(entry.body);
    var out = {
      which: entry.which || "center",
      color: FALLBACK_COLOR, emoji: FALLBACK_EMOJI,
      slow: (entry.latencyMs || 0) >= slowMs,
      latencyMs: entry.latencyMs || 0,
      kind: "success",
    };
    var sk = window.__FACES_STATUS__.classify(status);
    if (sk === "timeout") {
      out.kind = "sleepy"; out.color = SLEEPY_GREY; out.emoji = window.__FACES_STATUS__.SLEEPY_EMOJI;       // 😴 never arrives
    } else if (sk === "ratelimited") {
      out.kind = "sleepy"; out.color = SLEEPY_GREY; out.emoji = window.__FACES_STATUS__.OVERWHELMED_EMOJI;  // 🤯 turned away
    } else if (sk !== "ok") {
      out.kind = "fail"; out.color = FAIL_GREY; out.emoji = "\u{1F635}";               // 😵 shatters
    } else if (status === 200 && body) {
      if (validHex(body.color)) out.color = body.color;
      var em = decodeEmoji(body.smiley);
      if (em && em.length <= 16 && !/^[0-9]+$/.test(em)) out.emoji = em;
      if (Array.isArray(body.errors) && body.errors.length) out.kind = "partial";
      else if (out.slow) out.kind = "slow";
      else out.kind = "success";
    } else {
      out.kind = "fail"; out.color = FAIL_GREY; out.emoji = "\u{1F635}";
    }
    return out;
  }

  // ── Wall model ────────────────────────────────────────────────────
  function slotX(c) { return wallLeft + c * bw; }
  function slotYTop(r) { return plateTop - (r + 1) * bh; }
  function isBrick(cell) { return !!(cell && !cell.reserved && !cell.gap); }

  function scrollWall() {
    // Wall is full: retire the bottom row so the build runs forever.
    grid.shift();
    grid.push(new Array(cols).fill(null));
    for (var i = 0; i < falling.length; i++) falling[i].row -= 1;
    falling = falling.filter(function (f) { return f.row >= 0; });
    for (var j = 0; j < rowFlashes.length; j++) rowFlashes[j].row -= 1;
    // dust along the plate as the old row is absorbed
    for (var d = 0; d < 14; d++) dust(wallLeft + rand(0, cols * bw), plateTop - rand(0, 6), 1);
  }

  function liveBrickCount() {
    var n = 0;
    for (var r = 0; r < maxRows; r++) for (var c = 0; c < cols; c++) if (isBrick(grid[r][c])) n++;
    return n;
  }

  // repair=true for bricks that will land (success/slow/partial); failures
  // never take an existing gap — they punch a NEW hole in a fresh slot.
  function findTarget(repair) {
    // 1. Repair the OLDEST gap first (recovery visibly heals the wall).
    if (repair) {
      var best = null;
      for (var r = 0; r < maxRows; r++) for (var c = 0; c < cols; c++) {
        var cell = grid[r][c];
        if (cell && cell.gap && (!best || cell.born < best.born)) best = { r: r, c: c, born: cell.born };
      }
      if (best) return { r: best.r, c: best.c };
    }
    // 2. Otherwise the lowest incomplete row, random free slot.
    for (var r2 = 0; r2 < maxRows; r2++) {
      var free = [];
      for (var c2 = 0; c2 < cols; c2++) if (!grid[r2][c2]) free.push(c2);
      if (free.length) return { r: r2, c: free[(Math.random() * free.length) | 0] };
    }
    // 3. Full → scroll and take a slot in the fresh top row.
    scrollWall();
    return { r: maxRows - 1, c: (Math.random() * cols) | 0 };
  }

  // ── Spawn from a request (rate-limited visuals) ────────────────────
  function spawnFromRequest(entry) {
    var nowS = performance.now() / 1000;
    var minInterval = 1.0 / maxRatePerSec();
    var horizonS = Math.max(1.0, minInterval);
    admitted = admitted.filter(function (t) { return nowS - t < horizonS; });
    if (admitted.length > 0 && nowS - admitted[admitted.length - 1] < minInterval) return;
    if (admitted.length >= Math.ceil(maxRatePerSec())) return;
    if (falling.length >= MAX_FALLING) return;
    admitted.push(nowS);
    spawnBrick(classify(entry));
  }

  function spawnBrick(c) {
    var t = findTarget(c.kind !== "fail" && c.kind !== "sleepy");
    grid[t.r][t.c] = { reserved: true };
    var pal = brickColors(c.color);
    var dur;
    if (c.kind === "slow") dur = clamp(c.latencyMs / 1000, 1.2, 3.2);
    else if (c.kind === "sleepy") dur = rand(2.0, 3.0);
    else dur = rand(0.5, 0.8);

    if (reduceMotion) {
      // No fall animation: place or mark instantly.
      if (c.kind === "fail" || c.kind === "sleepy") grid[t.r][t.c] = { gap: true, born: performance.now() / 1000 };
      else landBrick({ row: t.r, col: t.c, pal: pal, emoji: c.emoji, kind: c.kind });
      return;
    }

    falling.push({
      row: t.r, col: t.c, pal: pal, emoji: c.emoji, kind: c.kind,
      t: 0, dur: dur, yStart: -bh - 14, cracked: false,
      swayPhase: rand(0, Math.PI * 2),
    });
  }

  // ── Landing / effects ─────────────────────────────────────────────
  function dust(x, y, n) {
    for (var i = 0; i < (n || 4); i++) {
      if (particles.length >= MAX_PARTICLES) return;
      particles.push({ x: x + rand(-8, 8), y: y, vx: rand(-30, 30), vy: rand(-46, -10),
        r: rand(2, 4.5), life: 0, max: rand(0.35, 0.7), color: "#e8e2d4", kind: "dust" });
    }
  }
  function shatter(x, y, pal) {
    for (var i = 0; i < 16; i++) {
      if (particles.length >= MAX_PARTICLES) break;
      particles.push({ x: x + rand(-bw / 3, bw / 3), y: y + rand(-bh / 3, bh / 3),
        vx: rand(-140, 140), vy: rand(-220, -40), rot: rand(0, 6.28), vr: rand(-8, 8),
        r: rand(3, 7), life: 0, max: rand(0.6, 1.1), color: i % 3 ? pal.body : pal.stud, kind: "chip" });
    }
  }
  function confettiRain() {
    var n = reduceMotion ? 0 : 60;
    for (var i = 0; i < n; i++) {
      if (particles.length >= MAX_PARTICLES) break;
      particles.push({ x: rand(0, W), y: rand(-H * 0.3, 0), vx: rand(-24, 24), vy: rand(60, 160),
        rot: rand(0, 6.28), vr: rand(-6, 6), r: rand(3, 6), life: 0, max: rand(1.4, 2.4),
        color: ["#ff3b5c", "#ffb347", "#ffe14d", "#36d399", "#4cc9f0", "#7c5cff"][(Math.random() * 6) | 0], kind: "stud" });
    }
  }

  function landBrick(f) {
    grid[f.row][f.col] = {
      body: f.pal.body, stud: f.pal.stud, edge: f.pal.edge, hi: f.pal.hi,
      emoji: f.emoji, born: performance.now() / 1000,
      tilt: f.kind === "partial" ? rand(0.05, 0.08) * (Math.random() < 0.5 ? -1 : 1) : 0,
      sticker: f.kind === "partial",
      wobbleT: f.kind === "partial" ? 0.7 : 0.28,
    };
    dust(slotX(f.col) + bw / 2, slotYTop(f.row) + bh, 5);
    checkRow(f.row);
  }

  function checkRow(r) {
    for (var c = 0; c < cols; c++) if (!isBrick(grid[r][c])) return;
    rowFlashes.push({ row: r, t: 0 });
    rowsCompleted++;
    var now = performance.now() / 1000;
    if (rowsCompleted % ROWS_PER_BUILDER === 0 && now - lastBuilderTime >= MIN_BUILDER_GAP) {
      lastBuilderTime = now;
      builderBannerBorn = now;
      flagT = 0.0001;               // start the flag-raise
      figCheerUntil = now + 2.2;    // the builder celebrates
      confettiRain();
    }
  }

  // ── Click → pop a brick out ───────────────────────────────────────
  function onCanvasClick(e) {
    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left, my = e.clientY - rect.top;
    // Click the minifig mascot → it cheers (waves + hops).
    if (mx >= figX - figW / 2 && mx <= figX + figW / 2 && my >= plateTop - figH && my <= plateTop + 6) {
      figCheerUntil = performance.now() / 1000 + 1.4;
      return;
    }
    var c = Math.floor((mx - wallLeft) / bw);
    var r = Math.floor((plateTop - my) / bh);
    if (c < 0 || c >= cols || r < 0 || r >= maxRows) return;
    var cell = grid[r][c];
    if (!isBrick(cell)) return;

    pops.push({ x: slotX(c), y: slotYTop(r), brick: cell, t: 0, vx: rand(-40, 40), vy: rand(-320, -240), vr: rand(-7, 7), rot: 0 });
    // Bricks above settle down one slot (stop at the first non-brick).
    var rr = r;
    while (rr < maxRows - 1 && isBrick(grid[rr + 1][c])) { grid[rr][c] = grid[rr + 1][c]; rr++; }
    grid[rr][c] = null;
    dust(slotX(c) + bw / 2, slotYTop(r) + bh, 6);
    floaters.push({ x: mx, y: my - 16, vy: 40, text: "+1", life: 0, max: 0.8 });
    if (window.__FACES_STATS__) window.__FACES_STATS__.bumpInteraction();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────
  function start() {
    if (running) return;
    running = true;
    // Rebuild geometry now that the root is visible (resize() ignores the
    // 0x0 observations made while it was display:none).
    resize();
    if (grid.length !== maxRows) initGrid();
    lastTs = performance.now() / 1000;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    // FX are transient; the WALL persists across mode switches (bus clear resets it).
    falling.length = particles.length = floaters.length = rowFlashes.length = pops.length = 0;
    // In-flight bricks reserved their slot; free them or they block the wall forever.
    for (var r = 0; r < grid.length; r++)
      for (var c = 0; c < grid[r].length; c++)
        if (grid[r][c] && grid[r][c].reserved) grid[r][c] = null;
  }
  function clearWall() {
    initGrid();
    falling.length = particles.length = floaters.length = rowFlashes.length = pops.length = 0;
    rowsCompleted = 0; flagT = 0; builderBannerBorn = -10;
  }

  function frame(nowMs) {
    if (!running) return;
    var now = nowMs / 1000;
    var dt = Math.min(0.05, now - lastTs || 0.016);
    lastTs = now;
    if (bgCanvas) {          // no backdrop yet = never had a visible size
      update(dt, now);
      draw(now);
    }
    raf = requestAnimationFrame(frame);
  }

  // ── Update ────────────────────────────────────────────────────────
  function update(dt, now) {
    for (var i = falling.length - 1; i >= 0; i--) {
      var f = falling[i];
      f.t += dt;
      var p = clamp01(f.t / f.dur);
      if (f.kind === "fail" && !f.cracked && p >= 0.6) {
        f.cracked = true;
        var fx = slotX(f.col) + bw / 2, fy = lerp(f.yStart, slotYTop(f.row), easeOut(p));
        shatter(fx, fy + bh / 2, f.pal);
        grid[f.row][f.col] = { gap: true, born: now };
        falling.splice(i, 1);
        continue;
      }
      if (f.kind === "sleepy" && p >= 0.75) {
        grid[f.row][f.col] = { gap: true, born: now };
        dust(slotX(f.col) + bw / 2, lerp(f.yStart, slotYTop(f.row), p) + bh / 2, 3);
        falling.splice(i, 1);
        continue;
      }
      if (p >= 1) {
        landBrick(f);
        falling.splice(i, 1);
      }
    }

    for (var j = particles.length - 1; j >= 0; j--) {
      var q = particles[j];
      q.life += dt;
      if (q.life >= q.max) { particles.splice(j, 1); continue; }
      q.vy += (q.kind === "dust" ? 60 : 560) * dt;
      q.x += q.vx * dt; q.y += q.vy * dt;
      if (q.vr) q.rot += q.vr * dt;
    }
    for (var k = pops.length - 1; k >= 0; k--) {
      var po = pops[k];
      po.t += dt;
      if (po.t >= 0.9) { pops.splice(k, 1); continue; }
      po.vy += 700 * dt; po.x += po.vx * dt; po.y += po.vy * dt; po.rot += po.vr * dt;
    }
    for (var m = floaters.length - 1; m >= 0; m--) {
      var fl = floaters[m];
      fl.life += dt; fl.y -= fl.vy * dt;
      if (fl.life >= fl.max) floaters.splice(m, 1);
    }
    for (var n = rowFlashes.length - 1; n >= 0; n--) {
      rowFlashes[n].t += dt;
      if (rowFlashes[n].t > 0.9 || rowFlashes[n].row < 0) rowFlashes.splice(n, 1);
    }
    for (var r = 0; r < maxRows; r++) for (var c = 0; c < cols; c++) {
      var cell = grid[r][c];
      if (isBrick(cell) && cell.wobbleT > 0) cell.wobbleT = Math.max(0, cell.wobbleT - dt);
    }
    if (flagT > 0 && flagT < 1) flagT = clamp01(flagT + dt / 0.9);

    if (window.__FACES_STATS__) window.__FACES_STATS__.setActive(liveBrickCount(), "bricks");
  }

  // ── Draw ──────────────────────────────────────────────────────────
  function draw(now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bgCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Wall — draw bottom-up so upper bricks naturally cover the studs below.
    for (var r = 0; r < maxRows; r++) {
      for (var c = 0; c < cols; c++) {
        var cell = grid[r][c];
        if (!cell) continue;
        var x = slotX(c), y = slotYTop(r);
        if (cell.gap) { drawGap(x, y, now); continue; }
        if (cell.reserved) continue;
        drawBrick(x, y, cell, 1, now);
      }
    }

    // Row-complete gold flashes
    for (var rf = 0; rf < rowFlashes.length; rf++) {
      var rw = rowFlashes[rf];
      ctx.globalAlpha = 0.5 * (1 - rw.t / 0.9);
      ctx.fillStyle = "#ffd700";
      ctx.fillRect(wallLeft, slotYTop(rw.row), cols * bw, bh);
      ctx.globalAlpha = 1;
    }

    // Falling bricks (+ crane for slow ones)
    for (var i = 0; i < falling.length; i++) {
      var f = falling[i];
      var p = clamp01(f.t / f.dur);
      var x = slotX(f.col), y = lerp(f.yStart, slotYTop(f.row), f.kind === "slow" || f.kind === "sleepy" ? p : easeOut(p));
      var sway = (f.kind === "slow") ? Math.sin(now * 2 + f.swayPhase) * 3 : 0;
      var alpha = f.kind === "sleepy" ? clamp01(1 - p / 0.8) : 1;
      if (f.kind === "slow") {
        ctx.strokeStyle = "rgba(70,80,95,0.75)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x + bw / 2 + sway, 0); ctx.lineTo(x + bw / 2 + sway, y - studH + 4); ctx.stroke();
        ctx.fillStyle = "#4a5468"; ctx.fillRect(x + bw / 2 + sway - 6, y - studH, 12, 6);   // hook
      }
      drawBrick(x + sway, y, { body: f.pal.body, stud: f.pal.stud, edge: f.pal.edge, hi: f.pal.hi, emoji: f.emoji, tilt: 0, sticker: false, wobbleT: 0 }, alpha, now);
    }

    // Popped bricks flying out
    for (var pk = 0; pk < pops.length; pk++) {
      var po = pops[pk];
      ctx.save();
      ctx.globalAlpha = clamp01(1 - po.t / 0.9);
      ctx.translate(po.x + bw / 2, po.y + bh / 2);
      ctx.rotate(po.rot);
      ctx.translate(-bw / 2, -bh / 2);
      drawBrickBody(0, 0, po.brick, now);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // Particles
    for (var q = 0; q < particles.length; q++) {
      var pt = particles[q];
      ctx.globalAlpha = clamp01(1 - pt.life / pt.max);
      if (pt.kind === "dust") {
        ctx.fillStyle = pt.color;
        ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r, 0, 6.28); ctx.fill();
      } else {
        ctx.save(); ctx.translate(pt.x, pt.y); ctx.rotate(pt.rot || 0);
        ctx.fillStyle = pt.color;
        if (pt.kind === "stud") { ctx.beginPath(); ctx.arc(0, 0, pt.r, 0, 6.28); ctx.fill(); }
        else ctx.fillRect(-pt.r, -pt.r * 0.7, pt.r * 2, pt.r * 1.4);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;

    drawMinifig(now);
    drawFlag(now);
    for (var fl = 0; fl < floaters.length; fl++) {
      var f2 = floaters[fl];
      ctx.globalAlpha = clamp01(1 - f2.life / f2.max);
      ctx.font = "bold 20px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#ffffff"; ctx.strokeStyle = "#c8402a"; ctx.lineWidth = 3;
      ctx.strokeText(f2.text, f2.x, f2.y); ctx.fillText(f2.text, f2.x, f2.y);
      ctx.globalAlpha = 1;
    }
    if (now - builderBannerBorn < 2.4) drawBuilderBanner(now);
  }

  // Body-only variant (used by pop FX where transform is pre-applied).
  function drawBrickBody(x, y, b, now) {
    var r = Math.max(3, bw * 0.055);
    // ── Studs on top: little cylinders (side wall + top disc + specular) ──
    var studR = bw * 0.105, wallH = studH * 0.66, cyTop = y - wallH;
    for (var s = 0; s < 4; s++) {
      var sx = x + bw * (0.125 + s * 0.25);
      ctx.fillStyle = b.edge;                                    // shaded cylinder wall
      ctx.beginPath();
      ctx.moveTo(sx - studR, cyTop); ctx.lineTo(sx - studR, cyTop + wallH);
      ctx.arc(sx, cyTop + wallH, studR, Math.PI, 0, true); ctx.lineTo(sx + studR, cyTop); ctx.closePath();
      ctx.fill();
      ctx.fillStyle = b.stud;                                    // lit top disc
      ctx.beginPath(); ctx.ellipse(sx, cyTop, studR, studR * 0.5, 0, 0, 6.28); ctx.fill();
      ctx.strokeStyle = b.edge; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.55)";                  // specular highlight
      ctx.beginPath(); ctx.ellipse(sx - studR * 0.3, cyTop - studR * 0.12, studR * 0.34, studR * 0.15, 0, 0, 6.28); ctx.fill();
    }
    // ── Body ──
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + bw, y, x + bw, y + bh, r);
    ctx.arcTo(x + bw, y + bh, x, y + bh, r); ctx.arcTo(x, y + bh, x, y, r);
    ctx.arcTo(x, y, x + bw, y, r); ctx.closePath();
    ctx.fillStyle = b.body; ctx.fill();
    // glossy plastic sheen: bright top half, shaded bottom half
    var gl = ctx.createLinearGradient(x, y, x, y + bh);
    gl.addColorStop(0, "rgba(255,255,255,0.34)");
    gl.addColorStop(0.5, "rgba(255,255,255,0.04)");
    gl.addColorStop(0.5, "rgba(0,0,0,0.0)");
    gl.addColorStop(1, "rgba(0,0,0,0.2)");
    ctx.fillStyle = gl; ctx.fill();
    ctx.strokeStyle = b.edge; ctx.lineWidth = 1.5; ctx.stroke();
    // left highlight edge + bottom seam shadow (reads as stacked, tactile plastic)
    ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 1.6, y + r); ctx.lineTo(x + 1.6, y + bh - r); ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath(); ctx.moveTo(x + r, y + bh - 1); ctx.lineTo(x + bw - r, y + bh - 1); ctx.stroke();
    // emoji ON TOP, centered, soft shadow (readable on any color)
    ctx.font = (bh * 0.58 | 0) + "px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 2;
    ctx.fillText(b.emoji, x + bw / 2, y + bh * 0.56);
    ctx.shadowBlur = 0;
    // partial warning sticker
    if (b.sticker) {
      ctx.fillStyle = "#ffb020";
      ctx.beginPath(); ctx.arc(x + bw - 9, y + 9, 7, 0, 6.28); ctx.fill();
      ctx.fillStyle = "#3a2400"; ctx.font = "bold 11px -apple-system, sans-serif";
      ctx.fillText("!", x + bw - 9, y + 10);
    }
  }

  function drawBrick(x, y, b, alpha, now) {
    ctx.save();
    ctx.globalAlpha = alpha;
    var tilt = b.tilt || 0;
    if (b.wobbleT > 0) tilt += Math.sin(now * 24) * 0.02 * (b.wobbleT / 0.7);
    if (tilt) {
      ctx.translate(x + bw / 2, y + bh / 2);
      ctx.rotate(tilt);
      ctx.translate(-(x + bw / 2), -(y + bh / 2));
    }
    drawBrickBody(x, y, b, now);
    ctx.restore();
  }

  function drawGap(x, y, now) {
    ctx.save();
    ctx.globalAlpha = 0.5 + 0.18 * Math.sin(now * 3);
    ctx.setLineDash([5, 5]);
    ctx.strokeStyle = "#e5484d"; ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 3, y + 3, bw - 6, bh - 6);
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = "#e5484d";
    ctx.fillRect(x + 3, y + 3, bw - 6, bh - 6);
    ctx.restore();
  }

  // ── Minifig mascot (the builder, standing on the plate beside the wall) ──
  function drawArm(sx, sy, dir, cheer, now) {
    var s = figH, len = s * 0.2;
    var ang = cheer ? dir * -2.3 + Math.sin(now * 12) * 0.12 : dir * 0.32;
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(ang);
    ctx.fillStyle = FIG_TORSO;                          // sleeve
    ctx.beginPath();
    ctx.moveTo(-s * 0.05, 0); ctx.lineTo(s * 0.05, 0);
    ctx.lineTo(s * 0.045, len); ctx.lineTo(-s * 0.045, len); ctx.closePath(); ctx.fill();
    ctx.fillStyle = FIG_HAND;                           // claw hand
    ctx.beginPath(); ctx.arc(0, len + s * 0.03, s * 0.048, 0, 6.28); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }
  function drawMinifig(now) {
    var s = figH, cx = figX;
    var cheer = now < figCheerUntil;
    var footY = plateTop - 2 + Math.sin(now * 1.6) * 1.4 - (cheer ? Math.abs(Math.sin(now * 10)) * s * 0.06 : 0);
    // ground shadow
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    ctx.beginPath(); ctx.ellipse(cx, plateTop + 3, s * 0.2, s * 0.045, 0, 0, 6.28); ctx.fill();

    var legH = s * 0.3, legW = s * 0.14, hipH = s * 0.09, hipW = s * 0.32;
    var torsoH = s * 0.28, topW = s * 0.26, botW = s * 0.36;
    var ty = footY - legH - hipH;                        // torso bottom
    // legs + hips
    ctx.fillStyle = FIG_LEGS;
    ctx.fillRect(cx - legW - 1, footY - legH, legW, legH);
    ctx.fillRect(cx + 1, footY - legH, legW, legH);
    ctx.fillStyle = lerpHex(FIG_LEGS, "#000000", 0.22);
    ctx.fillRect(cx - hipW / 2, ty, hipW, hipH);
    // torso trapezoid
    ctx.fillStyle = FIG_TORSO;
    ctx.beginPath();
    ctx.moveTo(cx - topW / 2, ty - torsoH); ctx.lineTo(cx + topW / 2, ty - torsoH);
    ctx.lineTo(cx + botW / 2, ty); ctx.lineTo(cx - botW / 2, ty); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(cx - topW / 2 + 1, ty - torsoH, topW - 2, torsoH * 0.4);
    // arms
    var shY = ty - torsoH + torsoH * 0.22;
    drawArm(cx - topW / 2 + 2, shY, -1, cheer, now);
    drawArm(cx + topW / 2 - 2, shY, 1, cheer, now);
    // neck + head
    var hd = s * 0.26, hy = ty - torsoH - hd * 0.5 - 3;
    ctx.fillStyle = FIG_HEAD;
    ctx.fillRect(cx - hd * 0.18, ty - torsoH - 5, hd * 0.36, 6);
    ctx.beginPath(); ctx.arc(cx, hy, hd / 2, 0, 6.28); ctx.fill();
    ctx.strokeStyle = "rgba(120,80,0,0.35)"; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, hy - hd / 2, hd * 0.15, hd * 0.07, 0, 0, 6.28); ctx.fill(); ctx.stroke();   // head stud
    // classic minifig face
    ctx.fillStyle = "#3a2a00";
    ctx.beginPath(); ctx.arc(cx - hd * 0.15, hy - hd * 0.04, hd * 0.055, 0, 6.28); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + hd * 0.15, hy - hd * 0.04, hd * 0.055, 0, 6.28); ctx.fill();
    ctx.strokeStyle = "#3a2a00"; ctx.lineWidth = 2; ctx.lineCap = "round";
    ctx.beginPath();
    if (cheer) ctx.arc(cx, hy + hd * 0.05, hd * 0.17, 0.12 * Math.PI, 0.88 * Math.PI);
    else ctx.arc(cx, hy + hd * 0.02, hd * 0.15, 0.18 * Math.PI, 0.82 * Math.PI);
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  function topRowY() {
    for (var r = maxRows - 1; r >= 0; r--) for (var c = 0; c < cols; c++) if (isBrick(grid[r][c])) return slotYTop(r);
    return plateTop;
  }
  function drawFlag(now) {
    if (flagT <= 0) return;
    var px = wallLeft + cols * bw - bw * 0.5;
    var baseY = topRowY();
    var poleH = 60 * easeOut(flagT);
    ctx.strokeStyle = "#5a616e"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(px, baseY); ctx.lineTo(px, baseY - poleH); ctx.stroke();
    if (flagT > 0.5) {
      var wob = Math.sin(now * 6) * 3;
      ctx.fillStyle = "#ff3b5c";
      ctx.beginPath();
      ctx.moveTo(px, baseY - poleH);
      ctx.lineTo(px + 34, baseY - poleH + 7 + wob * 0.3);
      ctx.lineTo(px, baseY - poleH + 16);
      ctx.closePath(); ctx.fill();
    }
  }
  function drawBuilderBanner(now) {
    var t = now - builderBannerBorn;
    var inT = clamp01(t / 0.3), outT = clamp01((t - 1.8) / 0.6);
    ctx.save();
    ctx.globalAlpha = inT * (1 - outT);
    ctx.translate(W / 2, H * 0.2);
    ctx.scale(0.8 + 0.2 * easeOut(inT), 0.8 + 0.2 * easeOut(inT));
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.font = "bold 46px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.shadowColor = "rgba(255,210,80,0.9)"; ctx.shadowBlur = 22;
    ctx.fillStyle = "#ffd700";
    ctx.fillText("MASTER BUILDER!", 0, 0);
    ctx.shadowBlur = 0;
    ctx.font = "600 16px -apple-system, sans-serif"; ctx.fillStyle = "#fff8e6";
    ctx.fillText(rowsCompleted + " rows built", 0, 36);
    ctx.restore();
  }

  // ── Resize + cached backdrop ──────────────────────────────────────
  function initGrid() {
    grid = [];
    for (var r = 0; r < maxRows; r++) grid.push(new Array(cols).fill(null));
  }
  function resize() {
    // Hidden (display:none → 0x0) or inactive: ignore. Falling back to the
    // minimum size here would shrink the wall to 5 columns and drop bricks.
    if (!canvas || !root || !running) return;
    var rect = root.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    W = Math.max(360, Math.floor(rect.width));
    H = Math.max(320, Math.floor(rect.height));
    canvas.width = (W * dpr) | 0; canvas.height = (H * dpr) | 0;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";

    bw = clamp(Math.floor(W / 12), 54, 104);
    bh = Math.round(bw * 0.52);
    studH = Math.round(bh * 0.34);
    var plateH = clamp(Math.round(H * 0.07), 30, 48);
    plateTop = H - plateH;
    // Reserve a bay on the left for the minifig mascot; the wall fills the rest.
    figW = clamp(Math.round(W * 0.11), 64, 120);
    figH = clamp(Math.round(H * 0.26), 118, 200);
    figX = 16 + figW / 2;
    var bayR = Math.round(figW + 30);
    var availW = W - bayR - 16;
    cols = Math.max(5, Math.floor(availW / bw));
    wallLeft = bayR + Math.max(0, Math.round((availW - cols * bw) / 2));
    var newMaxRows = clamp(Math.floor((plateTop - 90) / bh), 4, 12);

    // Preserve what fits of the existing wall.
    var old = grid, oldRows = old.length;
    maxRows = newMaxRows;
    initGrid();
    for (var r = 0; r < Math.min(oldRows, maxRows); r++)
      for (var c = 0; c < Math.min(old[r] ? old[r].length : 0, cols); c++)
        if (isBrick(old[r][c]) || (old[r][c] && old[r][c].gap)) grid[r][c] = old[r][c];
    falling.length = 0;   // stale coordinates

    buildBackdrop(plateH);
  }
  function buildBackdrop(plateH) {
    if (!bgCanvas) { bgCanvas = document.createElement("canvas"); bgCtx = bgCanvas.getContext("2d"); }
    bgCanvas.width = canvas.width; bgCanvas.height = canvas.height;
    var g = bgCtx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    // playroom wall
    var sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#cfe8f7"); sky.addColorStop(0.7, "#b7dcf2"); sky.addColorStop(1, "#a8d4ee");
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    // soft vignette
    var vg = g.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.35, W / 2, H * 0.45, Math.max(W, H) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, "rgba(30,50,70,0.14)");
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
    // green studded base plate
    g.fillStyle = "#2E9E44";
    g.fillRect(0, plateTop, W, plateH);
    g.fillStyle = "#25823a";
    g.fillRect(0, plateTop + plateH * 0.55, W, plateH * 0.45);   // front edge shade
    var step = Math.max(18, bw / 3);
    for (var x = step / 2; x < W; x += step) {
      g.fillStyle = "#45b95c";
      g.beginPath(); g.ellipse(x, plateTop + plateH * 0.26, step * 0.22, plateH * 0.14, 0, 0, 6.28); g.fill();
      g.strokeStyle = "#1f7a33"; g.lineWidth = 1; g.stroke();
    }
    g.fillStyle = "rgba(255,255,255,0.25)";
    g.fillRect(0, plateTop, W, 2);
  }

  // ── Key popup ─────────────────────────────────────────────────────
  function installKeyPopup() {
    keyOverlay = document.createElement("div");
    keyOverlay.className = "bricks-key-overlay";
    keyOverlay.innerHTML = [
      '<div class="bricks-key-card">',
      '<div class="bricks-key-header"><h2>\u{1F9F1} Brickworks Key</h2>',
      '<button class="bricks-key-close">&times;</button></div>',
      '<p class="bgk-intro">Every request is a brick: the <b>color</b> is the plastic, the <b>emoji</b> is printed on its face. The wall is a living mosaic of your traffic.</p>',
      row("\u{1F9F1}", "Clean snap", "Success (HTTP 200, fast) — the brick drops in briskly and clicks into the wall."),
      row("\u{1F3D7}️", "Crane lift", "Slow (≥ slow threshold) — lowered on a swaying crane cable; the slower the response, the longer the lower."),
      row("\u{1F4A5}", "Shatter → gap", "Failure (HTTP 5xx) — the brick cracks mid-air and leaves a HOLE in the wall."),
      row("\u{1F634}", "Never arrives", "Timeout (504) shows \u{1F634}, rate-limit (429) shows \u{1F92F} — the brick dissolves before landing; the gap remains."),
      rowStar("!", "Crooked sticker", "Partial — lands tilted with an amber ! sticker; a sub-service failed."),
      rowStar("\u{1F527}", "Repairs", "★ The next success fills the OLDEST gap first — watch recovery rebuild the wall."),
      rowStar("\u{1F5B1}️", "Pop a brick", "★ Click a placed brick to pop it out (+1); the column settles down. Every " + ROWS_PER_BUILDER + " completed rows = MASTER BUILDER!"),
      '</div>',
    ].join("");
    document.body.appendChild(keyOverlay);
    keyOverlay.querySelector(".bricks-key-close").addEventListener("click", closeKey);
    keyOverlay.addEventListener("click", function (e) { if (e.target === keyOverlay) closeKey(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeKey(); });

    var toolbar = document.getElementById("toolbar");
    if (toolbar) {
      toolbar.addEventListener("click", function (e) {
        if (visualMode !== "bricks") return;
        var btn = e.target && e.target.id === "btnShowKey" ? e.target
                : e.target && e.target.closest && e.target.closest("#btnShowKey");
        if (!btn) return;
        e.stopImmediatePropagation(); e.preventDefault();
        keyOverlay.classList.toggle("open");
      }, true);
    }
  }
  function row(icon, title, desc) {
    return '<div class="bgk-row"><div class="bgk-icon">' + icon + '</div><div><div class="bgk-title">' + title + '</div><div class="bgk-desc">' + desc + '</div></div></div>';
  }
  function rowStar(icon, title, desc) {
    return '<div class="bgk-row bgk-star"><div class="bgk-icon">' + icon + '</div><div><div class="bgk-title">' + title + '</div><div class="bgk-desc">' + desc + '</div></div></div>';
  }
  function closeKey() { if (keyOverlay) keyOverlay.classList.remove("open"); }

  // ── Boot ──────────────────────────────────────────────────────────
  function boot() {
    root = document.getElementById("bricks-root");
    canvas = document.getElementById("bricks-canvas");
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

    if ((settings().visualMode || "classic") === "bricks") { visualMode = "bricks"; start(); }
  }

  function subscribeDebug() {
    if (!window.__FACES_DEBUG__) { setTimeout(subscribeDebug, 60); return; }
    window.__FACES_DEBUG__.subscribe(function (entry) {
      if (!entry) { clearWall(); return; }
      if (visualMode !== "bricks") return;
      spawnFromRequest(entry);
    });
  }

  function applySettings() {
    var s = settings();
    slowMs = s.slowThresholdMs || 300;
    maxRps = clamp(Number(s.funModeRatePerSec || s.buoyantRatePerSec) || 0.5, 0.5, 200);   // 200 = super-mode ceiling
  }

  // ── Public hooks (called by buoyant.js dispatcher / WebController) ──
  window.__bricksSetMode__ = function (mode) {
    visualMode = mode;
    if (mode === "bricks") {
      start();
      var b = document.getElementById("btnShowKey");
      if (b) b.style.display = "inline-block";
    } else {
      stop();
      closeKey();
    }
  };

  window.__applyBricksSettings__ = function (json) {
    var s = (typeof json === "string") ? (safeJson(json) || {}) : (json || {});
    slowMs = s.slowThresholdMs || 300;
    maxRps = clamp(Number(s.funModeRatePerSec || s.buoyantRatePerSec) || 0.5, 0.5, 200);   // 200 = super-mode ceiling
    if (window.__syncRateControl__) window.__syncRateControl__(maxRps);
    return true;
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

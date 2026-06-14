// derby.js — SLIPSTREAM DERBY (id "derby")
//
// A top-down oval kart duel. The track is striped into rotating color sectors;
// each successful request drops a boost chevron (color + emoji) on the racing
// line. Grab a chevron whose color matches your current sector to bank nitro;
// matching the target emoji banks more. THE TWIST: every slow/timeout request
// pours nitro into the RIVAL's "Lag Tank" (and thins your chevron supply), so a
// degraded backend literally fuels your opponent. Your handling never lags.
//
// SPDX-License-Identifier: Apache-2.0
(function () {
  "use strict";
  var G = window.__FACES_GAME__;
  if (!G) { console.warn("derby.js: gamecore missing"); return; }
  var D = G.draw, TAU = Math.PI * 2;

  var PALETTE = ["#ff3b5c", "#ffb347", "#ffe14d", "#36d399", "#4cc9f0", "#7c5cff"];
  var EMOJIS = ["\u{1F600}", "\u{1F60E}", "\u{1F916}", "\u{1F431}", "\u{1F984}", "⭐", "\u{1F525}", "\u{1F3CE}️"];
  var DIFFS = {
    easy:   { laps: 3, cpuBase: 200 },
    normal: { laps: 5, cpuBase: 238 },
    hard:   { laps: 7, cpuBase: 270 },
  };
  var COL = { pBody: "#ff7a3c", pTrim: "#ffd9b0", cBody: "#36c2e0", cTrim: "#bff0ff" };

  var visualMode = "classic", root, canvas, ctx, bg, bgctx;
  var W = 800, H = 600, dpr = 1, reduceMotion = false;
  var cx = 400, cy = 320, Rx = 300, Ry = 220, rx = 150, ry = 100, midRx = 225, midRy = 160, midR = 190;
  var cravingPool = [], stars = [];
  var round = null;
  // Persistent game settings (chosen on the start screen; survive rounds).
  var gOpts = { endless: false };
  var selCursor = 0;

  function diff() { return DIFFS[G.difficulty.level("derby")] || DIFFS.normal; }

  function newRound(phase) {
    var startA = -Math.PI / 2;   // top of the oval
    var p = {
      x: cx + midRx * Math.cos(startA), y: cy + midRy * Math.sin(startA),
      angle: 0, speed: 0, nitro: 0, boost: 0, acc: 0, prevA: startA, lap: 0, trail: [],
    };
    // face the counter-clockwise tangent at the start
    p.angle = Math.atan2(midRy * Math.cos(startA), -midRx * Math.sin(startA));
    return {
      phase: phase || "select", player: p,
      cpuParam: startA, cpuStart: startA, cpuLap: 0, cpuSpeed: 0,
      rivalNitro: 0, chevrons: [], sparks: [],
      targetEmoji: rerollEmoji(), targetUntil: performance.now() / 1000 + 8,
      countdownEnd: 0, winner: null, msg: "", lastOutcome: 0, lastSynthetic: 0,
      avgStress: 0, avgN: 0,
    };
  }
  function rerollEmoji() {
    if (cravingPool.length && Math.random() < 0.8) return cravingPool[(Math.random() * cravingPool.length) | 0];
    return EMOJIS[(Math.random() * EMOJIS.length) | 0];
  }

  // ── Chevrons from live requests ────────────────────────────────────
  function onOutcome(c) {
    if (!round) return;
    round.lastOutcome = performance.now() / 1000;
    if (c.hasEmoji) { cravingPool.push(c.emoji); if (cravingPool.length > 16) cravingPool.shift(); }
    // Slow / failed requests pour nitro into the RIVAL's Lag Tank.
    if (c.slow || c.failed || c.timeout) {
      var fill = 0.04 + 0.10 * G.health.netStress() + 0.06 * G.draw.clamp(c.latencyMs / G.health.slowThresholdMs(), 0, 2);
      round.rivalNitro = G.draw.clamp(round.rivalNitro + fill, 0, 1);
    }
    if (round.phase !== "play") return;
    if (c.failed || c.timeout) return;                       // failures give you no chevrons
    var supplyMult = G.draw.clamp(1 - G.health.netStress() * 1.1, 0.15, 1);
    if (Math.random() > supplyMult) return;                  // degraded backend thins your supply
    spawnChevron(c.color, c.emoji, false);
  }
  function spawnChevron(color, emoji, synthetic) {
    if (round.chevrons.length >= 16) return;
    round.chevrons.push({ param: Math.random() * TAU, color: color, emoji: emoji, born: performance.now() / 1000, synthetic: !!synthetic });
  }

  // ── Update ─────────────────────────────────────────────────────────
  function ptOnMid(a) { return { x: cx + midRx * Math.cos(a), y: cy + midRy * Math.sin(a) }; }

  function update(dt) {
    var t = performance.now() / 1000;
    if (round.phase === "countdown" && t >= round.countdownEnd) round.phase = "play";
    if (t > round.targetUntil) { round.targetEmoji = rerollEmoji(); round.targetUntil = t + 8; }

    if (round.phase !== "play") { return; }

    var p = round.player;
    // input -> physics (handling NEVER degrades with backend health)
    var steer = (G.keys.isDown("right") ? 1 : 0) - (G.keys.isDown("left") ? 1 : 0);
    var thr = (G.keys.isDown("up") ? 1 : 0) - (G.keys.isDown("down") ? 1 : 0);
    var maxSpeed = 250 + (p.boost > 0 ? 200 : 0);
    if (thr > 0) p.speed += 360 * dt; else if (thr < 0) p.speed -= 420 * dt; else p.speed -= p.speed * 0.8 * dt;
    p.speed = G.draw.clamp(p.speed, -90, maxSpeed);
    p.angle += steer * 2.6 * dt * G.draw.clamp(Math.abs(p.speed) / 120, 0.2, 1) * (p.speed < 0 ? -1 : 1);
    p.x += Math.cos(p.angle) * p.speed * dt;
    p.y += Math.sin(p.angle) * p.speed * dt;
    if (p.boost > 0) p.boost -= dt;

    // keep on track (soft): if outside the annulus, slow + pull toward centerline
    var ang = Math.atan2(p.y - cy, p.x - cx);
    var nxO = (p.x - cx) / Rx, nyO = (p.y - cy) / Ry, outV = nxO * nxO + nyO * nyO;
    var nxI = (p.x - cx) / rx, nyI = (p.y - cy) / ry, inV = nxI * nxI + nyI * nyI;
    if (outV > 1 || inV < 1) {
      p.speed *= Math.pow(0.25, dt);                 // grass drag
      var c2 = ptOnMid(ang); p.x += (c2.x - p.x) * Math.min(1, dt * 3); p.y += (c2.y - p.y) * Math.min(1, dt * 3);
    }
    // trail
    if (Math.abs(p.speed) > 60) { p.trail.push(p.x, p.y); if (p.trail.length > 26) p.trail.splice(0, 2); }

    // lap progress (direction-agnostic + forgiving)
    var a = Math.atan2(p.y - cy, p.x - cx), da = a - p.prevA;
    if (da > Math.PI) da -= TAU; else if (da < -Math.PI) da += TAU;
    p.acc += da; p.prevA = a; p.lap = Math.max(p.lap, Math.floor(Math.abs(p.acc) / TAU));

    // chevron pickups
    for (var i = round.chevrons.length - 1; i >= 0; i--) {
      var ch = round.chevrons[i], cp = ptOnMid(ch.param);
      if (t - ch.born > 14) { round.chevrons.splice(i, 1); continue; }
      var dx = cp.x - p.x, dy = cp.y - p.y;
      if (dx * dx + dy * dy < 30 * 30) {
        var emojiMatch = ch.emoji === round.targetEmoji;
        var gain = emojiMatch ? 0.40 : 0.16;            // matching the GATE emoji banks much more nitro
        bankNitro(gain); pickFx(cp.x, cp.y, ch.color, emojiMatch);
        round.chevrons.splice(i, 1);
      }
    }

    // RIVAL kart: rail racer; speed scales with its Lag Tank + live stress
    round.rivalNitro = G.draw.clamp(round.rivalNitro - dt * 0.05, 0, 1);   // slow leak when healthy
    var cpuTarget = diff().cpuBase * (1 + 0.7 * round.rivalNitro + 0.5 * G.health.netStress());
    round.cpuSpeed += (cpuTarget - round.cpuSpeed) * Math.min(1, dt * 2);
    round.cpuParam += (round.cpuSpeed * dt) / midR;
    round.cpuLap = Math.floor((round.cpuParam - round.cpuStart) / TAU);

    // sparks
    for (var s = round.sparks.length - 1; s >= 0; s--) { var sp = round.sparks[s]; sp.life += dt; if (sp.life >= sp.max) { round.sparks.splice(s, 1); continue; } sp.x += sp.vx * dt; sp.y += sp.vy * dt; }

    // synthetic trickle
    if (t - round.lastOutcome > 2.5 && t - round.lastSynthetic > 0.8) { round.lastSynthetic = t; spawnChevron(PALETTE[(Math.random() * PALETTE.length) | 0], EMOJIS[(Math.random() * EMOJIS.length) | 0], true); }

    round.avgStress = (round.avgStress * round.avgN + G.health.netStress()) / (round.avgN + 1); round.avgN++;

    if (!gOpts.endless) {
      var tgt = diff().laps;
      if (p.lap >= tgt) end("player", "You took the checkered flag!");
      else if (round.cpuLap >= tgt) end("cpu", "The rival's lag-nitro carried it home");
    }
  }
  // attach nitroGain after newRound (needs round closure) — simple helper:
  function bankNitro(g) { round.player.nitro = G.draw.clamp(round.player.nitro + g, 0, 1); }
  function pickFx(x, y, color, big) {
    if (reduceMotion) return;
    var n = big ? 10 : 4;
    for (var i = 0; i < n; i++) { var a = Math.random() * TAU, s = G.draw.rand(40, 140); round.sparks.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: G.draw.rand(0.3, 0.6), color: color }); }
  }
  function end(winner, msg) { if (round.phase === "over") return; round.phase = "over"; round.winner = winner; round.msg = msg; }

  // ── Input ──────────────────────────────────────────────────────────
  function onDown(action) {
    if (!round) return;
    if (round.phase === "select") {
      if (action === "up" || action === "down") selCursor = (selCursor + 1) % 2;
      else if (action === "left" || action === "right") {
        if (selCursor === 0) G.difficulty.cycle("derby", action === "right" ? 1 : -1);
        else gOpts.endless = !gOpts.endless;
      } else if (action === "dash") startCountdown();
      return;
    }
    if (round.phase === "over") { if (action === "dash") startCountdown(); return; }
    if (round.phase === "play" && action === "dash") {
      if (round.player.nitro > 0.05) { round.player.boost = 0.6 + round.player.nitro * 2.2; round.player.nitro = 0; }
    }
  }
  function startCountdown() { round = newRound("countdown"); round.nitroGain = bankNitro; round.countdownEnd = performance.now() / 1000 + 3.2; }

  // ── Render ─────────────────────────────────────────────────────────
  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawTrack();
    drawChevrons();
    drawKart(round.player.x, round.player.y, round.player.angle, COL.pBody, COL.pTrim, round.player.boost > 0, round.player.trail, "\u{1F60E}");
    var cpos = ptOnMid(round.cpuParam), cang = Math.atan2(midRy * Math.cos(round.cpuParam), -midRx * Math.sin(round.cpuParam));
    drawKart(cpos.x, cpos.y, cang, COL.cBody, COL.cTrim, round.rivalNitro > 0.3, null, "\u{1F916}");
    drawSparks();
    drawHud();
    var t = performance.now() / 1000;
    if (round.phase === "select") drawSelect();
    else if (round.phase === "countdown") D.countdown(ctx, W, H, round.countdownEnd - t);
    else if (round.phase === "over") {
      var win = round.winner === "player", grade = round.avgStress < 0.15 ? "A" : round.avgStress < 0.3 ? "B" : round.avgStress < 0.5 ? "C" : "D";
      D.banner(ctx, W, H, win ? "\u{1F3C1} YOU WIN!" : "RIVAL WINS", round.msg + "  ·  service " + grade + "   —   SPACE for rematch", win ? "#36e07a" : "#ff5c6a");
    }
    if (window.__FACES_STATS__) window.__FACES_STATS__.setActive(round.player.lap, "lap");
  }

  function ringPath() { ctx.beginPath(); ctx.ellipse(cx, cy, Rx, Ry, 0, 0, TAU); ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU, true); }
  function drawTrack() {
    ctx.save();
    // asphalt
    ringPath(); ctx.fillStyle = "#24262e"; ctx.fill("evenodd");
    // subtle sheen across the tarmac
    ctx.save(); ringPath(); ctx.clip("evenodd");
    var g = ctx.createLinearGradient(0, cy - Ry, 0, cy + Ry);
    g.addColorStop(0, "rgba(255,255,255,0.05)"); g.addColorStop(0.5, "rgba(255,255,255,0)"); g.addColorStop(1, "rgba(0,0,0,0.18)");
    ctx.fillStyle = g; ctx.fillRect(cx - Rx, cy - Ry, Rx * 2, Ry * 2);
    ctx.restore();
    // red/white kerbs (rumble strips) on the outer + inner edges
    drawKerb(Rx, Ry); drawKerb(rx, ry);
    // dashed white racing line down the middle of the track
    ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = 2; ctx.setLineDash([12, 14]);
    ctx.beginPath(); ctx.ellipse(cx, cy, midRx, midRy, 0, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    // start/finish checkered band across the track at angle 0
    var x0 = cx + rx, xe = cx + Rx, n = 7, seg = (xe - x0) / n;
    for (var c = 0; c < n; c++) { ctx.fillStyle = c % 2 ? "#f4f4f4" : "#1a1a1a"; ctx.fillRect(x0 + c * seg, cy - 6, seg, 12); }
    ctx.restore();
  }
  function drawKerb(ex, ey) {
    ctx.lineWidth = 6; ctx.setLineDash([]);
    ctx.strokeStyle = "#c63a3a"; ctx.beginPath(); ctx.ellipse(cx, cy, ex, ey, 0, 0, TAU); ctx.stroke();
    ctx.setLineDash([16, 16]); ctx.strokeStyle = "#f2f2f2"; ctx.beginPath(); ctx.ellipse(cx, cy, ex, ey, 0, 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  }
  function drawChevrons() {
    var t = performance.now() / 1000;
    for (var i = 0; i < round.chevrons.length; i++) {
      var ch = round.chevrons[i], p = ptOnMid(ch.param), sz = 26, match = ch.emoji === round.targetEmoji;
      ctx.save(); ctx.translate(p.x, p.y);
      // colored box (the request color)
      D.roundRect(ctx, -sz / 2, -sz / 2, sz, sz, 6); ctx.fillStyle = ch.color; ctx.fill();
      // emoji ON TOP — large, with a soft shadow so it pops on any color
      ctx.font = (sz * 0.82 | 0) + "px -apple-system, BlinkMacSystemFont, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 3;
      ctx.fillText(ch.emoji, 0, 0);
      ctx.shadowBlur = 0;
      // pulse outline when it matches the GATE emoji (the big-boost pickup)
      if (match) { ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 6); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; D.roundRect(ctx, -sz / 2 - 2, -sz / 2 - 2, sz + 4, sz + 4, 8); ctx.stroke(); }
      ctx.restore();
    }
  }
  function drawKart(x, y, angle, body, trim, boosting, trail, driver) {
    if (trail && trail.length > 2) {
      ctx.strokeStyle = D.rgba(body, 0.22); ctx.lineWidth = 5; ctx.beginPath();
      ctx.moveTo(trail[0], trail[1]); for (var i = 2; i < trail.length; i += 2) ctx.lineTo(trail[i], trail[i + 1]); ctx.stroke();
    }
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    if (boosting) { ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.85; ctx.drawImage(D.glowStamp("#fff2a8"), -36, -16, 32, 32); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; }
    // F1 car (nose at +x): tyres, long tapered body, front + rear wings, cockpit driver
    ctx.fillStyle = "#15171c";
    ctx.fillRect(-13, -13, 8, 5); ctx.fillRect(-13, 8, 8, 5); ctx.fillRect(5, -12, 7, 4); ctx.fillRect(5, 8, 7, 4);   // tyres
    ctx.fillStyle = trim; ctx.fillRect(-20, -10, 4, 20);                                                              // rear wing
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.moveTo(20, 0); ctx.lineTo(9, -5); ctx.lineTo(-18, -6); ctx.lineTo(-18, 6); ctx.lineTo(9, 5); ctx.closePath(); ctx.fill();   // body
    ctx.fillStyle = trim; ctx.fillRect(16, -10, 4, 20);                                                               // front wing
    ctx.fillStyle = "rgba(10,14,26,0.85)"; D.roundRect(ctx, -6, -6, 12, 12, 3); ctx.fill();                          // cockpit
    if (driver) { ctx.rotate(-angle); ctx.font = "11px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(driver, 0, 1); }
    ctx.restore();
  }
  function drawSparks() {
    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < round.sparks.length; i++) { var s = round.sparks[i]; ctx.globalAlpha = 1 - s.life / s.max; var r = 6; ctx.drawImage(D.glowStamp(s.color), s.x - r, s.y - r, r * 2, r * 2); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  }
  function nitroTank(x, y, h, frac, color, label) {
    var w = 16;
    ctx.fillStyle = "rgba(8,12,28,0.7)"; D.roundRect(ctx, x, y, w, h, 6); ctx.fill();
    var fh = (h - 4) * G.draw.clamp01(frac);
    ctx.fillStyle = color; D.roundRect(ctx, x + 2, y + h - 2 - fh, w - 4, fh, 5); ctx.fill();
    ctx.fillStyle = "#c9d6f0"; ctx.font = "bold 10px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText(label, x + w / 2, y + h + 3);
  }
  function drawHud() {
    D.healthBanner(ctx, W / 2, 14, Math.min(440, W - 40));
    var tgt = diff().laps;
    // lap scoreboard — clear pills at the edges (clear of the centered toolbar), leader outlined
    var inplay = round.phase === "play" ? 1 : 0;
    var pl = round.player.lap + inplay, cl = round.cpuLap + inplay, suf = gOpts.endless ? "" : " / " + tgt;
    if (!gOpts.endless) { pl = Math.min(tgt, pl); cl = Math.min(tgt, cl); }
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(8,12,28,0.72)"; D.roundRect(ctx, 12, 42, 172, 32, 9); ctx.fill();
    if (pl > cl) { ctx.strokeStyle = COL.pBody; ctx.lineWidth = 2; D.roundRect(ctx, 12, 42, 172, 32, 9); ctx.stroke(); }
    ctx.textAlign = "left"; ctx.fillStyle = COL.pBody; ctx.font = "bold 17px -apple-system, sans-serif";
    ctx.fillText("YOU  LAP " + pl + suf, 24, 59);
    ctx.fillStyle = "rgba(8,12,28,0.72)"; D.roundRect(ctx, W - 184, 42, 172, 32, 9); ctx.fill();
    if (cl > pl) { ctx.strokeStyle = COL.cBody; ctx.lineWidth = 2; D.roundRect(ctx, W - 184, 42, 172, 32, 9); ctx.stroke(); }
    ctx.textAlign = "right"; ctx.fillStyle = COL.cBody; ctx.font = "bold 17px -apple-system, sans-serif";
    ctx.fillText("RIVAL  LAP " + cl + suf, W - 24, 59);
    // nitro tanks (your boost vs rival lag tank), side by side bottom-center
    nitroTank(W / 2 - 44, H - 96, 70, round.player.nitro, "#ffd24a", "YOU");
    nitroTank(W / 2 + 28, H - 96, 70, round.rivalNitro, "#ff5c6a", "RIVAL");
    ctx.fillStyle = "#9aa7c8"; ctx.font = "11px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "top";
    ctx.fillText("SLOW RESPONSES → RIVAL nitro", W / 2, H - 18);
    // target emoji card (below the YOU lap pill)
    ctx.fillStyle = "rgba(8,12,28,0.6)"; D.roundRect(ctx, 12, 82, 122, 34, 8); ctx.fill();
    ctx.fillStyle = "#c9d6f0"; ctx.font = "10px -apple-system, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText("GATE", 22, 99);
    ctx.font = "20px -apple-system, sans-serif"; ctx.fillText(round.targetEmoji, 52, 100);
    if (round.player.boost > 0) { ctx.fillStyle = "#ffd24a"; ctx.font = "bold 13px -apple-system, sans-serif"; ctx.fillText("BOOST!", 88, 100); }
  }
  function drawSelect() {
    ctx.fillStyle = "rgba(6,10,22,0.66)"; ctx.fillRect(0, H / 2 - 110, W, 230);
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff";
    ctx.font = "bold 34px -apple-system, sans-serif"; ctx.fillText("\u{1F3CE}️ GRAND PRIX", W / 2, H / 2 - 72);
    var rows = [
      ["Difficulty", G.difficulty.level("derby").toUpperCase()],
      ["Win mode", gOpts.endless ? "ENDLESS" : ("FIRST TO " + diff().laps + " LAPS")],
    ];
    for (var i = 0; i < rows.length; i++) {
      var yy = H / 2 - 24 + i * 36, sel = i === selCursor;
      ctx.font = (sel ? "bold " : "") + "20px -apple-system, sans-serif";
      ctx.fillStyle = sel ? "#7be0a0" : "#9aa7c8";
      ctx.fillText(rows[i][0] + ":   " + (sel ? "◀ " + rows[i][1] + " ▶" : rows[i][1]), W / 2, yy);
    }
    ctx.font = "14px -apple-system, sans-serif"; ctx.fillStyle = "#7c89a3";
    ctx.fillText("↑↓ select · ←→ change · SPACE to start · ↑ gas ↓ brake ←→ steer in race", W / 2, H / 2 + 84);
  }

  // ── Boot / lifecycle ───────────────────────────────────────────────
  function resize() {
    if (!canvas || !root) return;
    var rect = root.getBoundingClientRect();
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    W = Math.max(360, Math.floor(rect.width)); H = Math.max(320, Math.floor(rect.height));
    canvas.width = (W * dpr) | 0; canvas.height = (H * dpr) | 0; canvas.style.width = W + "px"; canvas.style.height = H + "px";
    cx = W / 2; cy = H / 2 + 14;
    // Track scales with the window (leave a margin for the kerb + crowd ring).
    Rx = Math.min(W * 0.46, W / 2 - 40); Ry = Math.min(H * 0.42, H / 2 - 60);
    rx = Rx * 0.46; ry = Ry * 0.42;                  // smaller infield hole = wider lane
    midRx = (Rx + rx) / 2; midRy = (Ry + ry) / 2; midR = (midRx + midRy) / 2;
    buildBg();
    if (!round || round.phase === "select" || round.phase === "play") round = mkSelect();
  }
  function mkSelect() { var r = newRound("select"); r.nitroGain = bankNitro; return r; }
  function buildBg() {
    if (!bg) { bg = document.createElement("canvas"); bgctx = bg.getContext("2d"); }
    bg.width = canvas.width; bg.height = canvas.height;
    var g = bgctx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    // mowed-grass field (alternating stripes, like a circuit infield from above)
    var stripe = 40;
    for (var sx = 0; sx < W; sx += stripe) { g.fillStyle = (((sx / stripe) | 0) % 2) ? "#2f8a3a" : "#2a7d34"; g.fillRect(sx, 0, stripe, H); }
    // safety barrier + grandstand ring just outside the track
    g.lineWidth = 3; g.strokeStyle = "rgba(255,255,255,0.18)";
    g.beginPath(); g.ellipse(cx, cy, Rx + 12, Ry + 12, 0, 0, TAU); g.stroke();
    g.lineWidth = 24; g.strokeStyle = "#3f444c";
    g.beginPath(); g.ellipse(cx, cy, Rx + 26, Ry + 26, 0, 0, TAU); g.stroke();
    // packed crowd speckle on the grandstand (cached once per resize)
    var crowd = ["#ff5c6a", "#ffd24a", "#4cc9f0", "#ffffff", "#7c5cff", "#36e07a", "#ff8a5a", "#e0e6f0"];
    var seed = 1234; function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    for (var i = 0; i < 540; i++) {
      var a = rnd() * TAU, off = (rnd() - 0.5) * 24;
      var px = cx + Math.cos(a) * (Rx + 26 + off), py = cy + Math.sin(a) * (Ry + 26 + off);
      g.fillStyle = crowd[(rnd() * crowd.length) | 0]; g.fillRect(px, py, 2.4, 2.4);
    }
    // subtle darker mowed oval in the infield for depth
    g.globalAlpha = 0.12; g.fillStyle = "#1f5f28";
    g.beginPath(); g.ellipse(cx, cy, rx * 0.82, ry * 0.82, 0, 0, TAU); g.fill(); g.globalAlpha = 1;
  }
  function boot() {
    root = document.getElementById("derby-root"); canvas = document.getElementById("derby-canvas");
    if (!root || !canvas) return;
    ctx = canvas.getContext("2d");
    if (window.matchMedia) { var mq = window.matchMedia("(prefers-reduced-motion: reduce)"); reduceMotion = mq.matches; if (mq.addEventListener) mq.addEventListener("change", function (e) { reduceMotion = e.matches; }); }
    resize(); window.addEventListener("resize", resize);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(root);
    if (window.__FACES_STATS__) { var el = document.createElement("div"); el.className = "fun-stats-hud"; root.appendChild(el); window.__FACES_STATS__.attachHUD(el); }
    subscribeDebug();
    installKeyPopup();
    G.health.onClear(function () { round = mkSelect(); });
    if (((window.__FACES_SETTINGS__ || {}).visualMode || "classic") === "derby") { visualMode = "derby"; activate(); }
  }
  function subscribeDebug() {
    if (!window.__FACES_DEBUG__) { setTimeout(subscribeDebug, 60); return; }
    window.__FACES_DEBUG__.subscribe(function (entry) {
      if (!entry) { round = mkSelect(); return; }
      if (visualMode !== "derby") return;
      onOutcome(G.health.classify(entry));
    });
  }
  function activate() {
    resize();
    if (!round) round = mkSelect(); else round.phase = "select";
    G.keys.activate("derby", { onDown: onDown });
    G.loop.raf("derby", { update: update, render: render });
    var b = document.getElementById("btnShowKey"); if (b) b.style.display = "inline-block";
  }
  function deactivate() { G.keys.deactivate("derby"); G.loop.stop("derby"); closeKey(); }

  // ── Key popup ──────────────────────────────────────────────────────
  var keyOverlay = null;
  function installKeyPopup() {
    keyOverlay = document.createElement("div"); keyOverlay.className = "derby-key-overlay";
    keyOverlay.innerHTML = [
      '<div class="derby-key-card"><div class="derby-key-header"><h2>\u{1F3CE}️ Grand Prix</h2><button class="derby-key-close">&times;</button></div>',
      '<p class="dgk-intro">Race the rival F1 car around the circuit. Drive over boost pads to bank nitro; a pad whose emoji matches the <b>GATE</b> emoji banks much more.</p>',
      drow("\u{1F3CE}️", "Drive", "↑ gas · ↓ brake · ← → steer · SPACE deploys banked nitro."),
      drow("\u{1F6E2}️", "Lag = rival fuel", "Every slow or failed request pours nitro into the RIVAL's Lag Tank — watch the red tank fill as the service degrades."),
      drow("\u{1F3C1}", "Supply thins too", "A degraded backend also drops fewer boost pads for you, so keep the service healthy to out-run the rival."),
      '</div>',
    ].join("");
    document.body.appendChild(keyOverlay);
    keyOverlay.querySelector(".derby-key-close").addEventListener("click", closeKey);
    keyOverlay.addEventListener("click", function (e) { if (e.target === keyOverlay) closeKey(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeKey(); });
    var tb = document.getElementById("toolbar");
    if (tb) tb.addEventListener("click", function (e) {
      if (visualMode !== "derby") return;
      var btn = e.target && (e.target.id === "btnShowKey" ? e.target : (e.target.closest && e.target.closest("#btnShowKey")));
      if (!btn) return; e.stopImmediatePropagation(); e.preventDefault(); keyOverlay.classList.toggle("open");
    }, true);
  }
  function drow(icon, title, desc) { return '<div class="dgk-row"><div class="dgk-icon">' + icon + '</div><div><div class="dgk-title">' + title + '</div><div class="dgk-desc">' + desc + '</div></div></div>'; }
  function closeKey() { if (keyOverlay) keyOverlay.classList.remove("open"); }

  // ── Hooks ──────────────────────────────────────────────────────────
  window.__derbySetMode__ = function (mode) {
    if (mode === visualMode) return;   // settings re-applying the same mode must NOT reset a running race
    visualMode = mode;
    if (mode === "derby") activate(); else deactivate();
  };
  window.__applyDerbySettings__ = function () { if (window.__syncRateControl__) window.__syncRateControl__(); return true; };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

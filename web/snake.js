// snake.js — TINT SNAKE DUEL (id "snake")
//
// A Snake/Tron duel. Each successful request drops a colored emoji pellet; eat
// ones matching your "craving" (emoji + hue) to grow and box out a CPU snake.
// THE TWIST: food = throughput. A degraded backend throttles pellet spawns
// (scarcity) and widens the CPU's forage range, so you lose because the service
// starved you — never because your controls lagged (input is always crisp).
//
// SPDX-License-Identifier: Apache-2.0
(function () {
  "use strict";
  var G = window.__FACES_GAME__;
  if (!G) { console.warn("snake.js: gamecore missing"); return; }
  var D = G.draw;

  var PALETTE = ["#ff3b5c", "#ffb347", "#ffe14d", "#36d399", "#4cc9f0", "#7c5cff", "#ff7ad9", "#a0ff6a"];
  var EMOJIS = ["\u{1F600}", "\u{1F60E}", "\u{1F916}", "\u{1F431}", "\u{1F984}", "\u{1F340}", "⭐", "\u{1F525}", "\u{1F34E}", "\u{1F47E}"];
  var DIFFS = {
    easy:   { tickHz: 7,  target: 25, mistake: 0.25, hueTol: 45, forageBase: 6 },
    normal: { tickHz: 9,  target: 40, mistake: 0.15, hueTol: 30, forageBase: 6 },
    hard:   { tickHz: 11, target: 55, mistake: 0.06, hueTol: 22, forageBase: 8 },
  };
  var MAX_PELLETS = 60, PELLET_TTL = 12;
  var COL = {
    pBody: "#FF7A2F", pHead: "#FFB23E", pGlow: "#FFD080", pEye: "#1A0E05",
    cBody: "#1E9BD7", cHead: "#34E0D0", cGlow: "#9BF0E8", cEye: "#04181A",
    dark: "#2C3340", darkRim: "#454F63",
  };

  var visualMode = "classic", root, canvas, ctx, hudCounts, bg, bgctx;
  var W = 800, H = 600, dpr = 1, reduceMotion = false;
  var cols = 20, rows = 14, cell = 24, ox = 0, oy = 0;
  var cravingPool = [], sparks = [], pelletSpawnTimes = [];
  var round = null;
  // Persistent game settings (chosen on the start screen; survive rounds).
  var gOpts = { endless: false, forgiving: false };
  var selCursor = 0;

  function diff() { return DIFFS[G.difficulty.level("snake")] || DIFFS.normal; }

  // ── Round state ────────────────────────────────────────────────────
  function newRound(phase) {
    var midY = (rows / 2) | 0;
    var p = { cells: [{ x: 3, y: midY }, { x: 2, y: midY }, { x: 1, y: midY }], dir: { x: 1, y: 0 }, nextDir: { x: 1, y: 0 }, grow: 0, alive: true, craving: null, dashUntil: 0 };
    var c = { cells: [{ x: cols - 4, y: midY }, { x: cols - 3, y: midY }, { x: cols - 2, y: midY }], dir: { x: -1, y: 0 }, nextDir: { x: -1, y: 0 }, grow: 0, alive: true, craving: null };
    var r = {
      phase: phase || "select", player: p, cpu: c, pellets: [],
      countdownEnd: 0, winner: null, score: 0, streak: 0, streakMult: 1,
      dashSteps: 0, lastOutcome: G.draw.clamp(0, 0, 0), lastSynthetic: 0, lastRecover: 0,
      avgStressN: 0, avgStress: 0,
    };
    p.craving = rerollFrom(); c.craving = rerollFrom();
    return r;
  }
  function rerollFrom() {
    if (cravingPool.length && Math.random() < 0.85) return cravingPool[(Math.random() * cravingPool.length) | 0];
    var col = PALETTE[(Math.random() * PALETTE.length) | 0];
    return { emoji: EMOJIS[(Math.random() * EMOJIS.length) | 0], color: col, hue: D.hueOf(col) };
  }
  function rerollCraving(snake) { snake.craving = rerollFrom(); }

  // ── Grid helpers ───────────────────────────────────────────────────
  function cellsOverlap(x, y, snake, skipTail) {
    var n = snake.cells.length;
    for (var i = 0; i < n; i++) { if (skipTail && i === n - 1) continue; if (snake.cells[i].x === x && snake.cells[i].y === y) return true; }
    return false;
  }
  function blocked(x, y, snake, other) {
    if (x < 0 || x >= cols || y < 0 || y >= rows) return true;
    if (cellsOverlap(x, y, snake, snake.grow === 0)) return true;
    if (cellsOverlap(x, y, other, false)) return true;
    return false;
  }
  function solidPelletAt(x, y) {
    var t = performance.now() / 1000;
    for (var i = 0; i < round.pellets.length; i++) { var p = round.pellets[i]; if (p.x === x && p.y === y && t >= p.solidAt) return i; }
    return -1;
  }
  function freeCell(nearX, nearY, radius) {
    for (var tries = 0; tries < 40; tries++) {
      var x, y;
      if (nearX != null) { x = G.draw.clamp((nearX + (Math.random() * radius * 2 - radius)) | 0, 0, cols - 1); y = G.draw.clamp((nearY + (Math.random() * radius * 2 - radius)) | 0, 0, rows - 1); }
      else { x = (Math.random() * cols) | 0; y = (Math.random() * rows) | 0; }
      if (!cellsOverlap(x, y, round.player, false) && !cellsOverlap(x, y, round.cpu, false) && solidPelletAt(x, y) < 0) return { x: x, y: y };
    }
    return null;
  }

  // ── Pellet spawning from live requests ─────────────────────────────
  function onOutcome(c) {
    if (!round) return;
    round.lastOutcome = performance.now() / 1000;
    if (c.hasColor || c.hasEmoji) {
      cravingPool.push({ emoji: c.emoji, color: c.color, hue: D.hueOf(c.color) });
      if (cravingPool.length > 20) cravingPool.shift();
    }
    if (round.phase !== "play") return;
    if (c.failed || c.timeout) return;                 // errors give NO food (scarcity under failure)
    var supplyMult = G.draw.clamp(1 - G.health.netStress() * 1.15, 0.12, 1);
    if (Math.random() > supplyMult) return;            // throttled by backend health
    spawnPellet(c.color, c.emoji, c.which === "edge", false);
  }
  function spawnPellet(color, emoji, edge, synthetic) {
    if (round.pellets.length >= MAX_PELLETS) return;
    var spot = edge
      ? freeCell(Math.random() < 0.5 ? 1 : cols - 2, (Math.random() * rows) | 0, 3)
      : freeCell((cols / 2) | 0, (rows / 2) | 0, Math.max(4, cols / 4));
    if (!spot) spot = freeCell();
    if (!spot) return;
    var lat = G.health.latencyMs();
    round.pellets.push({
      x: spot.x, y: spot.y, color: color, emoji: emoji, hue: D.hueOf(color),
      born: performance.now() / 1000,
      solidAt: performance.now() / 1000 + G.draw.clamp(synthetic ? 120 : lat, 120, 1400) / 1000,
      synthetic: !!synthetic,
    });
    pelletSpawnTimes.push(performance.now());
  }
  function maintainPellets() {
    var t = performance.now() / 1000;
    for (var i = round.pellets.length - 1; i >= 0; i--) if (t - round.pellets[i].born > PELLET_TTL) round.pellets.splice(i, 1);
    // synthetic trickle so the board is never empty when traffic is low
    if (t - round.lastOutcome > 2.5 && t - round.lastSynthetic > 0.7) {
      round.lastSynthetic = t;
      spawnPellet(PALETTE[(Math.random() * PALETTE.length) | 0], EMOJIS[(Math.random() * EMOJIS.length) | 0], Math.random() < 0.5, true);
    }
    // recovery reward: when the service just healed, rain a guaranteed match near the player
    if (G.health.recovering() && t - round.lastRecover > 0.45) {
      round.lastRecover = t;
      var h = round.player.cells[0], spot = freeCell(h.x, h.y, 5);
      if (spot) round.pellets.push({ x: spot.x, y: spot.y, color: round.player.craving.color, emoji: round.player.craving.emoji, hue: round.player.craving.hue, born: t, solidAt: t, synthetic: true });
    }
    while (pelletSpawnTimes.length && performance.now() - pelletSpawnTimes[0] > 1000) pelletSpawnTimes.shift();
  }

  // ── Movement ───────────────────────────────────────────────────────
  function step(snake, other, isPlayer) {
    if (!snake.alive) return;
    var nd = snake.nextDir || snake.dir;
    if (snake.cells.length > 1 && nd.x === -snake.dir.x && nd.y === -snake.dir.y) nd = snake.dir;
    snake.dir = nd;
    var head = snake.cells[0], nx = head.x + nd.x, ny = head.y + nd.y;
    if (blocked(nx, ny, snake, other)) {
      if (!gOpts.forgiving) { snake.alive = false; return; }
      var sd = safeDir(snake);                       // redirect to the most open direction
      if (sd) { snake.dir = sd; snake.nextDir = sd; nx = head.x + sd.x; ny = head.y + sd.y; }
      penalize(snake, isPlayer, head);               // lose a segment + reset streak
      if (blocked(nx, ny, snake, other)) return;     // fully boxed this tick — shrank, wait
    }
    var dark = false, pi = solidPelletAt(nx, ny);
    if (pi >= 0) {
      var pel = round.pellets[pi], crav = snake.craving;
      var match = pel.emoji === crav.emoji && D.hueClose(pel.hue, crav.hue, diff().hueTol);
      if (match) {
        snake.grow += 2; rerollCraving(snake);
        if (isPlayer) { round.streak++; round.streakMult = round.streak >= 8 ? 2 : round.streak >= 5 ? 1.5 : round.streak >= 3 ? 1.25 : 1; round.score += Math.round(10 * round.streakMult); burst(nx, ny, pel.color); }
      } else {
        snake.grow += 1; dark = true;
        if (isPlayer) { round.streak = 0; round.streakMult = 1; }
      }
      round.pellets.splice(pi, 1);
    }
    snake.cells.unshift({ x: nx, y: ny, dark: dark });
    if (snake.grow > 0) snake.grow--; else snake.cells.pop();
  }

  // ── CPU planner (cheap BFS + flood-fill survival) ──────────────────
  function blockedSet(skipPlayerTail, skipCpuTail) {
    var s = {};
    var pc = round.player.cells, cc = round.cpu.cells;
    for (var i = 0; i < pc.length; i++) { if (skipPlayerTail && i === pc.length - 1) continue; s[pc[i].x + "," + pc[i].y] = 1; }
    for (var j = 0; j < cc.length; j++) { if (skipCpuTail && j === cc.length - 1) continue; s[cc[j].x + "," + cc[j].y] = 1; }
    return s;
  }
  var DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  function bfsFirstStep(head, tx, ty, walls) {
    var q = [[head.x, head.y]], seen = {}, parent = {};
    seen[head.x + "," + head.y] = 1;
    var found = false;
    while (q.length) {
      var cur = q.shift(), cx = cur[0], cy = cur[1];
      if (cx === tx && cy === ty) { found = true; break; }
      for (var d = 0; d < 4; d++) {
        var nx = cx + DIRS[d].x, ny = cy + DIRS[d].y, k = nx + "," + ny;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows || seen[k]) continue;
        if (walls[k] && !(nx === tx && ny === ty)) continue;
        seen[k] = 1; parent[k] = cx + "," + cy; q.push([nx, ny]);
      }
    }
    if (!found) return null;
    var k2 = tx + "," + ty, pk = parent[k2];
    if (pk === undefined) return null;
    while (parent[pk] !== undefined && parent[pk] !== head.x + "," + head.y) { k2 = pk; pk = parent[pk]; }
    if (pk !== head.x + "," + head.y) k2 = pk;       // first step cell
    var fc = k2.split(",");
    return { x: (+fc[0]) - head.x, y: (+fc[1]) - head.y };
  }
  function floodCount(sx, sy, walls, limit) {
    if (sx < 0 || sx >= cols || sy < 0 || sy >= rows || walls[sx + "," + sy]) return 0;
    var q = [[sx, sy]], seen = {}, n = 0; seen[sx + "," + sy] = 1;
    while (q.length && n < limit) {
      var cur = q.shift(); n++;
      for (var d = 0; d < 4; d++) {
        var nx = cur[0] + DIRS[d].x, ny = cur[1] + DIRS[d].y, k = nx + "," + ny;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows || seen[k] || walls[k]) continue;
        seen[k] = 1; q.push([nx, ny]);
      }
    }
    return n;
  }
  function safeDir(snake) {
    var head = snake.cells[0], walls = blockedSet(true, true), best = null, bestN = -1;
    for (var d = 0; d < 4; d++) {
      var dir = DIRS[d];
      if (snake.cells.length > 1 && dir.x === -snake.dir.x && dir.y === -snake.dir.y) continue;
      var nx = head.x + dir.x, ny = head.y + dir.y;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows || walls[nx + "," + ny]) continue;
      var n = floodCount(nx, ny, walls, snake.cells.length + 12);
      if (n > bestN) { bestN = n; best = dir; }
    }
    return best;
  }
  function planCpu() {
    var cpu = round.cpu; if (!cpu.alive) return;
    var head = cpu.cells[0], forage = diff().forageBase + G.health.netStress() * 22;
    var best = null, bestMatch = false, bestDist = 1e9, t = performance.now() / 1000;
    for (var i = 0; i < round.pellets.length; i++) {
      var p = round.pellets[i]; if (t < p.solidAt) continue;
      var dist = Math.abs(p.x - head.x) + Math.abs(p.y - head.y); if (dist > forage) continue;
      var m = p.emoji === cpu.craving.emoji && D.hueClose(p.hue, cpu.craving.hue, diff().hueTol);
      if ((m && !bestMatch) || (m === bestMatch && dist < bestDist)) { best = p; bestMatch = m; bestDist = dist; }
    }
    var dir = null;
    if (best) dir = bfsFirstStep(head, best.x, best.y, blockedSet(true, true));
    if (!dir || Math.random() < diff().mistake) { var sd = safeDir(cpu); if (sd) dir = sd; }
    // never commit a move that suicides if a safer one exists
    if (dir) {
      var nx = head.x + dir.x, ny = head.y + dir.y;
      if (blocked(nx, ny, cpu, round.player)) { var sd2 = safeDir(cpu); if (sd2) dir = sd2; }
    }
    if (dir) cpu.nextDir = dir;
  }

  // ── Tick (fixed timestep) ──────────────────────────────────────────
  function tick() {
    if (!round || round.phase !== "play") return;
    planCpu();
    step(round.player, round.cpu, true);
    if (round.dashSteps > 0 && round.player.alive) { step(round.player, round.cpu, true); round.dashSteps--; }
    step(round.cpu, round.player, false);
    maintainPellets();
    // rolling average health for the result grade
    round.avgStress = (round.avgStress * round.avgStressN + G.health.netStress()) / (round.avgStressN + 1); round.avgStressN++;
    checkEnd();
  }
  function checkEnd() {
    var p = round.player, c = round.cpu;
    if (!p.alive) return end("cpu", "You crashed");
    if (!c.alive) return end("player", "The CPU crashed");
    if (gOpts.endless) return;                        // no win target — play forever
    var tgt = diff().target;
    if (p.cells.length >= tgt) return end("player", "You reached " + tgt + "!");
    if (c.cells.length >= tgt) return end("cpu", "CPU reached " + tgt);
  }
  function end(winner, msg) { round.phase = "over"; round.winner = winner; round.msg = msg; }

  // ── FX ─────────────────────────────────────────────────────────────
  function burst(cx, cy, color) {
    if (reduceMotion) return;
    var px = ox + cx * cell + cell / 2, py = oy + cy * cell + cell / 2;
    for (var i = 0; i < 10; i++) { var a = Math.random() * 6.28, s = G.draw.rand(40, 160); sparks.push({ x: px, y: py, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: G.draw.rand(0.4, 0.7), color: color }); }
  }
  // Forgiving-mode penalty: lose a segment (min length 3), reset streak, red flash.
  function penalize(snake, isPlayer, head) {
    if (snake.cells.length > 3) snake.cells.pop();
    burst(head.x, head.y, "#ff4d5e");
    if (isPlayer) { round.streak = 0; round.streakMult = 1; round.score = Math.max(0, round.score - 5); }
  }

  // ── Input ──────────────────────────────────────────────────────────
  function setDir(dx, dy) {
    var p = round.player;
    if (p.cells.length > 1 && dx === -p.dir.x && dy === -p.dir.y) return;   // no instant reverse
    p.nextDir = { x: dx, y: dy };
  }
  function onDown(action) {
    if (!round) return;
    if (round.phase === "select") {
      if (action === "up") selCursor = (selCursor + 2) % 3;
      else if (action === "down") selCursor = (selCursor + 1) % 3;
      else if (action === "left" || action === "right") {
        if (selCursor === 0) G.difficulty.cycle("snake", action === "right" ? 1 : -1);
        else if (selCursor === 1) gOpts.endless = !gOpts.endless;
        else gOpts.forgiving = !gOpts.forgiving;
      } else if (action === "dash") startCountdown();
      return;
    }
    if (round.phase === "over") { if (action === "dash") startCountdown(); return; }
    if (round.phase !== "play") return;
    if (action === "left") setDir(-1, 0);
    else if (action === "right") setDir(1, 0);
    else if (action === "up") setDir(0, -1);
    else if (action === "down") setDir(0, 1);
    else if (action === "dash") {
      var t = performance.now() / 1000;
      if (t >= round.player.dashUntil) { round.dashSteps = 1; round.player.dashUntil = t + 4; }
    }
  }
  function startCountdown() { round = newRound("countdown"); round.countdownEnd = performance.now() / 1000 + 3.2; }

  // ── Render ─────────────────────────────────────────────────────────
  function render(alpha, dt) {
    var t = performance.now() / 1000;
    if (round && round.phase === "countdown" && t >= round.countdownEnd) round.phase = "play";

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // border tinted by health tier
    ctx.strokeStyle = D.rgba(D.tierColor(G.health.netStress()), 0.5); ctx.lineWidth = 3;
    ctx.strokeRect(ox - 3, oy - 3, cols * cell + 6, rows * cell + 6);

    // pellets
    for (var i = 0; i < round.pellets.length; i++) drawPellet(round.pellets[i], t);
    // snakes
    drawSnake(round.cpu, COL.cBody, COL.cHead, COL.cGlow, COL.cEye);
    drawSnake(round.player, COL.pBody, COL.pHead, COL.pGlow, COL.pEye);
    // sparks
    if (dt) for (var s = sparks.length - 1; s >= 0; s--) { var sp = sparks[s]; sp.life += dt; if (sp.life >= sp.max) { sparks.splice(s, 1); continue; } sp.x += sp.vx * dt; sp.y += sp.vy * dt; }
    ctx.globalCompositeOperation = "lighter";
    for (var k = 0; k < sparks.length; k++) { var s2 = sparks[k]; ctx.globalAlpha = 1 - s2.life / s2.max; var r = 6; ctx.drawImage(D.glowStamp(s2.color), s2.x - r, s2.y - r, r * 2, r * 2); }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";

    drawHud(t);
    if (round.phase === "select") drawSelect();
    else if (round.phase === "countdown") D.countdown(ctx, W, H, round.countdownEnd - t);
    else if (round.phase === "over") drawOver();

    if (window.__FACES_STATS__) window.__FACES_STATS__.setActive(round.player.cells.length, "len");
  }

  function cpx(x) { return ox + x * cell; }
  function drawPellet(p, t) {
    var x = cpx(p.x), y = oy + p.y * cell, ghost = t < p.solidAt;
    var mx = x + cell / 2, my = y + cell / 2, sz = cell - 3;
    ctx.save();
    ctx.globalAlpha = ghost ? (0.3 + 0.12 * Math.sin(t * 16)) : 1;
    // colored tile (the request color) = the background of the food
    D.roundRect(ctx, x + 1.5, y + 1.5, sz, sz, 6); ctx.fillStyle = p.color; ctx.fill();
    // emoji ON TOP — large, centered, with a soft shadow so it pops on any color
    ctx.font = (cell * 0.82 | 0) + "px -apple-system, BlinkMacSystemFont, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.55)"; ctx.shadowBlur = 3;
    ctx.fillText(p.emoji, mx, my);
    ctx.shadowBlur = 0;
    // pulse outline if it matches the player's craving
    if (!ghost && round.player.craving && p.emoji === round.player.craving.emoji && D.hueClose(p.hue, round.player.craving.hue, diff().hueTol)) {
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(t * 6); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
      D.roundRect(ctx, x, y, cell, cell, 7); ctx.stroke();
    }
    ctx.restore();
  }
  function drawSnake(snake, body, headC, glow, eye) {
    var n = snake.cells.length;
    for (var i = n - 1; i >= 0; i--) {
      var c = snake.cells[i], x = cpx(c.x), y = oy + c.y * cell, isHead = i === 0;
      ctx.fillStyle = c.dark ? COL.dark : (isHead ? headC : body);
      D.roundRect(ctx, x + 1, y + 1, cell - 2, cell - 2, 5); ctx.fill();
      if (c.dark) { ctx.strokeStyle = COL.darkRim; ctx.lineWidth = 1; ctx.stroke(); }
    }
    var hd = snake.cells[0], hx = cpx(hd.x), hy = oy + hd.y * cell;
    ctx.globalCompositeOperation = "lighter"; ctx.globalAlpha = 0.5;
    ctx.drawImage(D.glowStamp(glow), hx - cell * 0.4, hy - cell * 0.4, cell * 1.8, cell * 1.8);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    // eyes
    var ex = hx + cell / 2 + snake.dir.x * cell * 0.18, ey = hy + cell / 2 + snake.dir.y * cell * 0.18, off = cell * 0.16;
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(ex - (snake.dir.y ? off : 0) - (snake.dir.x ? 0 : off), ey - (snake.dir.x ? off : 0), cell * 0.12, 0, 6.28); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + (snake.dir.y ? off : 0) + (snake.dir.x ? 0 : off), ey + (snake.dir.x ? off : 0), cell * 0.12, 0, 6.28); ctx.fill();
  }

  function drawHud(t) {
    D.healthBanner(ctx, W / 2, 14, Math.min(440, W - 40));
    // craving card (top-left)
    var cv = round.player.craving;
    ctx.fillStyle = "rgba(8,12,28,0.6)"; D.roundRect(ctx, 14, 48, 150, 40, 10); ctx.fill();
    ctx.fillStyle = "#c9d6f0"; ctx.font = "11px -apple-system, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText("EAT", 24, 60);
    ctx.fillStyle = cv.color; D.roundRect(ctx, 22, 66, 16, 16, 4); ctx.fill();
    ctx.font = "20px -apple-system, sans-serif"; ctx.textAlign = "left"; ctx.fillText(cv.emoji, 44, 74);
    if (round.streak >= 3) { ctx.fillStyle = "#ffd24a"; ctx.font = "bold 13px -apple-system, sans-serif"; ctx.fillText("x" + round.streakMult + " streak", 78, 74); }
    // SCORE pill (top-right) — points from matched eats
    ctx.fillStyle = "rgba(8,12,28,0.72)"; D.roundRect(ctx, W - 168, 44, 152, 34, 9); ctx.fill();
    ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillStyle = "#ffd24a"; ctx.font = "bold 19px -apple-system, sans-serif";
    ctx.fillText("SCORE  " + round.score, W - 26, 61);
    // food/s ticker (below score)
    ctx.fillStyle = "#9aa7c8"; ctx.font = "12px -apple-system, sans-serif"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText("FOOD " + pelletSpawnTimes.length + "/s", W - 26, 90);
    // score bars (bottom)
    var bw = Math.min(220, (W - 60) / 2), tgt = diff().target;
    D.scoreBar(ctx, 20, H - 36, bw, 22, "YOU", round.player.cells.length, tgt, COL.pBody);
    D.scoreBar(ctx, W - bw - 20, H - 36, bw, 22, "CPU", round.cpu.cells.length, tgt, COL.cBody);
  }
  function drawSelect() {
    ctx.fillStyle = "rgba(6,10,22,0.66)"; ctx.fillRect(0, H / 2 - 120, W, 250);
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff"; ctx.font = "bold 34px -apple-system, sans-serif"; ctx.fillText("\u{1F40D} TINT SNAKE DUEL", W / 2, H / 2 - 80);
    var rows = [
      ["Difficulty", G.difficulty.level("snake").toUpperCase()],
      ["Win mode", gOpts.endless ? "ENDLESS" : ("FIRST TO " + diff().target)],
      ["Crashes", gOpts.forgiving ? "FORGIVING — penalize & redirect" : "LOSE ON CRASH"],
    ];
    for (var i = 0; i < rows.length; i++) {
      var yy = H / 2 - 28 + i * 36, sel = i === selCursor;
      ctx.font = (sel ? "bold " : "") + "20px -apple-system, sans-serif";
      ctx.fillStyle = sel ? "#7be0a0" : "#9aa7c8";
      ctx.fillText(rows[i][0] + ":   " + (sel ? "◀ " + rows[i][1] + " ▶" : rows[i][1]), W / 2, yy);
    }
    ctx.font = "14px -apple-system, sans-serif"; ctx.fillStyle = "#7c89a3";
    ctx.fillText("↑↓ select · ←→ change · SPACE to start", W / 2, H / 2 + 92);
  }
  function drawOver() {
    var win = round.winner === "player";
    var grade = round.avgStress < 0.15 ? "A" : round.avgStress < 0.3 ? "B" : round.avgStress < 0.5 ? "C" : "D";
    D.banner(ctx, W, H, win ? "YOU WIN!" : "CPU WINS", round.msg + "  ·  service " + grade + "   —   SPACE for rematch", win ? "#36e07a" : "#ff5c6a");
  }

  // ── Boot / lifecycle ───────────────────────────────────────────────
  function resize() {
    if (!canvas || !root) return;
    var rect = root.getBoundingClientRect();
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    W = Math.max(360, Math.floor(rect.width)); H = Math.max(320, Math.floor(rect.height));
    canvas.width = (W * dpr) | 0; canvas.height = (H * dpr) | 0; canvas.style.width = W + "px"; canvas.style.height = H + "px";
    var topPad = 96, botPad = 56, availW = W - 40, availH = H - topPad - botPad;
    cell = G.draw.clamp(Math.floor(Math.min(availW / 32, availH / 22)), 12, 40);
    cols = Math.max(12, Math.floor(availW / cell)); rows = Math.max(10, Math.floor(availH / cell));
    ox = ((W - cols * cell) / 2) | 0; oy = (topPad + (availH - rows * cell) / 2) | 0;
    buildBg();
    if (!round || round.phase === "select") round = newRound("select"); else if (round.phase === "play") round = newRound("select");
  }
  function buildBg() {
    if (!bg) { bg = document.createElement("canvas"); bgctx = bg.getContext("2d"); }
    bg.width = canvas.width; bg.height = canvas.height;
    var g = bgctx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    var grd = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    grd.addColorStop(0, "#0a0e1a"); grd.addColorStop(1, "#05070f"); g.fillStyle = grd; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(40,58,92,0.35)"; g.lineWidth = 1;
    for (var x = 0; x <= cols; x++) { g.beginPath(); g.moveTo(ox + x * cell, oy); g.lineTo(ox + x * cell, oy + rows * cell); g.stroke(); }
    for (var y = 0; y <= rows; y++) { g.beginPath(); g.moveTo(ox, oy + y * cell); g.lineTo(ox + cols * cell, oy + y * cell); g.stroke(); }
  }
  function boot() {
    root = document.getElementById("snake-root"); canvas = document.getElementById("snake-canvas");
    hudCounts = document.getElementById("snake-counts");
    if (!root || !canvas) return;
    ctx = canvas.getContext("2d");
    if (window.matchMedia) { var mq = window.matchMedia("(prefers-reduced-motion: reduce)"); reduceMotion = mq.matches; if (mq.addEventListener) mq.addEventListener("change", function (e) { reduceMotion = e.matches; }); }
    resize(); window.addEventListener("resize", resize);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(root);
    if (window.__FACES_STATS__) { var el = document.createElement("div"); el.className = "fun-stats-hud"; root.appendChild(el); window.__FACES_STATS__.attachHUD(el); }
    subscribeDebug();
    installKeyPopup();
    G.health.onClear(function () { round = newRound("select"); });
    if (((window.__FACES_SETTINGS__ || {}).visualMode || "classic") === "snake") { visualMode = "snake"; activate(); }
  }
  function subscribeDebug() {
    if (!window.__FACES_DEBUG__) { setTimeout(subscribeDebug, 60); return; }
    window.__FACES_DEBUG__.subscribe(function (entry) {
      if (!entry) { round = newRound("select"); return; }
      if (visualMode !== "snake") return;
      onOutcome(G.health.classify(entry));
    });
  }
  function activate() {
    resize();
    if (!round) round = newRound("select"); else round.phase = "select";
    G.keys.activate("snake", { onDown: onDown });
    G.loop.fixed("snake", function () { return round && round.phase === "play" ? diff().tickHz : 12; }, { tick: tick, render: render });
    var b = document.getElementById("btnShowKey"); if (b) b.style.display = "inline-block";
  }
  function deactivate() { G.keys.deactivate("snake"); G.loop.stop("snake"); closeKey(); }

  // ── Key popup ──────────────────────────────────────────────────────
  var keyOverlay = null;
  function installKeyPopup() {
    keyOverlay = document.createElement("div"); keyOverlay.className = "snake-key-overlay";
    keyOverlay.innerHTML = [
      '<div class="snake-key-card"><div class="snake-key-header"><h2>\u{1F40D} Snake Duel</h2><button class="snake-key-close">&times;</button></div>',
      '<p class="sgk-intro">Eat pellets matching your <b>EAT</b> card (emoji + color) to grow +2 and box out the CPU. Wrong pellets add dead weight.</p>',
      sgrow("⬅️", "Steer", "Arrow keys turn your snake. Space = dash (short burst, ~4s cooldown)."),
      sgrow("\u{1F37D}️", "Food = throughput", "A healthy backend rains pellets. A slow/erroring one starves the board AND lets the CPU forage from across the arena."),
      sgrow("\u{1F47B}", "Ghost pellets", "High latency makes new pellets shimmer un-grabbable for a moment before they solidify."),
      sgrow("✨", "Recovery", "Heal the service and matching pellets rain near you — keep it healthy to win."),
      '</div>',
    ].join("");
    document.body.appendChild(keyOverlay);
    keyOverlay.querySelector(".snake-key-close").addEventListener("click", closeKey);
    keyOverlay.addEventListener("click", function (e) { if (e.target === keyOverlay) closeKey(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeKey(); });
    var tb = document.getElementById("toolbar");
    if (tb) tb.addEventListener("click", function (e) {
      if (visualMode !== "snake") return;
      var btn = e.target && (e.target.id === "btnShowKey" ? e.target : (e.target.closest && e.target.closest("#btnShowKey")));
      if (!btn) return; e.stopImmediatePropagation(); e.preventDefault(); keyOverlay.classList.toggle("open");
    }, true);
  }
  function sgrow(icon, title, desc) { return '<div class="sgk-row"><div class="sgk-icon">' + icon + '</div><div><div class="sgk-title">' + title + '</div><div class="sgk-desc">' + desc + '</div></div></div>'; }
  function closeKey() { if (keyOverlay) keyOverlay.classList.remove("open"); }

  // ── Hooks ──────────────────────────────────────────────────────────
  window.__snakeSetMode__ = function (mode) {
    if (mode === visualMode) return;   // settings re-applying the same mode must NOT reset a running game
    visualMode = mode;
    if (mode === "snake") activate(); else deactivate();
  };
  window.__applySnakeSettings__ = function () { if (window.__syncRateControl__) window.__syncRateControl__(); return true; };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();

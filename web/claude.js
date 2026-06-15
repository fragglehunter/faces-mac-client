// SYNAPSE — Claude Mode animation system
// Signals = live HTTP requests traversing a 14-node neural network.
(function () {
  "use strict";

  // ── Node topology (normalized fractions of canvas width/height) ──
  const NODES = [
    { id:"I1", fx:0.09, fy:0.26, col:0 },  // INPUT upper
    { id:"I2", fx:0.09, fy:0.50, col:0 },  // INPUT mid
    { id:"I3", fx:0.09, fy:0.72, col:0 },  // INPUT lower
    { id:"A1", fx:0.31, fy:0.17, col:1 },  // PROCESS-A
    { id:"A2", fx:0.34, fy:0.40, col:1 },
    { id:"A3", fx:0.36, fy:0.60, col:1 },
    { id:"A4", fx:0.31, fy:0.81, col:1 },
    { id:"B1", fx:0.62, fy:0.22, col:2 },  // PROCESS-B
    { id:"B2", fx:0.65, fy:0.46, col:2 },
    { id:"B3", fx:0.67, fy:0.66, col:2 },
    { id:"B4", fx:0.62, fy:0.84, col:2 },
    { id:"O1", fx:0.88, fy:0.30, col:3 },  // OUTPUT
    { id:"O2", fx:0.88, fy:0.53, col:3 },
    { id:"O3", fx:0.88, fy:0.74, col:3 },
  ];
  const NI = {};
  NODES.forEach(function(n, i) { NI[n.id] = i; });

  const EDGES = [
    ["I1","A1"],["A1","B1"],["B1","O1"],
    ["I1","A2"],["A2","B1"],
    ["I2","A2"],["A2","B2"],["B2","O2"],
    ["I3","A3"],["A3","B3"],["B3","O3"],
    ["I3","A4"],["A4","B4"],["B4","O3"],
    ["A1","B2"],["A3","B2"],
    ["I2","A3"],
  ];

  // Outgoing edges map for cascade
  const OUT = {};
  NODES.forEach(function(n) { OUT[n.id] = []; });
  EDGES.forEach(function(e) { OUT[e[0]].push(e[1]); });

  // Edge index lookup
  const EI = {};
  EDGES.forEach(function(e, i) { EI[e[0]+">"+e[1]] = i; });
  function edgeIdx(a, b) { return EI[a+">"+b]; }

  const ROUTES = {
    center: [
      ["I1","A1","B1","O1"],
      ["I1","A2","B1","O1"],
      ["I2","A2","B2","O2"],
    ],
    edge: [
      ["I3","A3","B3","O3"],
      ["I3","A4","B4","O3"],
    ],
  };

  // ── Constants ────────────────────────────────────────────────────
  const MAX_SIGNALS  = 70;
  const MAX_SPARKS   = 180;
  const MAX_ARCS     = 5;
  const AMBIENT_MAX  = 5;

  // ── State ────────────────────────────────────────────────────────
  let canvas, ctx, root;
  let W = 800, H = 600;
  let running  = false;
  let rafId    = null;
  let lastTs   = 0;
  let visualMode = "classic";

  // Per-node: heatLevel 0-1, bloomT 0-1, haloScale, oscPhase
  let NS = [];
  // Per-edge: memColor, memAlpha, darkT
  let ES = [];
  // Bezier control points
  let CPs = [];

  let signals    = [];
  let sparks     = [];
  let arcList    = [];
  let cascades   = [];
  let pulseRings = [];
  let floaters   = [];
  let blooms     = [];
  let ripples    = [];
  let txMarkers  = [];   // timeout ✕ at node positions
  let ambients   = [];
  let arrivals   = [];   // emoji "releases" that float up from output nodes on completion

  // Rolling error window (10 × 1-second buckets)
  let rollBuckets  = new Array(10).fill(0);
  let rollIdx      = 0;
  let rollTimer    = 0;
  let rollReqs     = 0;
  let rollErrs     = 0;
  let netStress    = 0;   // 0→1
  let hbTimer      = 0;
  let hbPeriod     = 8.0;

  let lastArcTime    = 0;
  let lastAmbTime    = 0;

  // Admission control
  let admitted = [];

  // Settings
  let slowMs     = 300;
  let maxRps     = 0.5;

  // Interaction
  let pulseTotal = 0;
  let pulsePill  = null;
  let keyOverlay = null;

  // ── Helpers ───────────────────────────────────────────────────────
  function rand(a, b) { return a + Math.random()*(b-a); }
  function clamp(v, lo, hi) { return v<lo?lo:v>hi?hi:v; }
  function lerp(a, b, t) { return a+(b-a)*t; }
  function c01(t) { return clamp(t,0,1); }

  function hexRgb(h) {
    return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
  }
  function rgba(h, a) {
    const [r,g,b] = hexRgb(h);
    return "rgba("+r+","+g+","+b+","+a+")";
  }
  function lerpHex(h0, h1, t) {
    const [r0,g0,b0] = hexRgb(h0), [r1,g1,b1] = hexRgb(h1);
    const r=Math.round(lerp(r0,r1,t)), g=Math.round(lerp(g0,g1,t)), b=Math.round(lerp(b0,b1,t));
    return "#"+(r<16?"0":"")+r.toString(16)+(g<16?"0":"")+g.toString(16)+(b<16?"0":"")+b.toString(16);
  }

  function validHex(s) { return typeof s==="string" && /^#[0-9a-fA-F]{6}$/.test(s); }

  function decodeEmoji(s) {
    if (!s || typeof s!=="string") return "";
    const d = document.createElement("div");
    d.innerHTML = s;
    return d.textContent || "";
  }

  function safeJson(s) { try { return JSON.parse(s); } catch(e) { return null; } }

  // ── Coordinate mapping ────────────────────────────────────────────
  function px(fx) { return fx * W; }
  function py(fy) { return fy * H; }
  function npos(i) {
    // Apply oscillation in CRITICAL tier
    let x = NODES[i].fx * W;
    let y = NODES[i].fy * H;
    if (netStress > 0.6 && NS[i]) {
      const amp = lerp(0, 5, (netStress-0.6)/0.4);
      x += Math.sin(NS[i].oscPhase)       * amp;
      y += Math.cos(NS[i].oscPhase * 1.3) * amp;
    }
    return {x, y};
  }

  // ── Bezier ────────────────────────────────────────────────────────
  function qbez(x0,y0,cpx,cpy,x1,y1, t) {
    const mt = 1-t;
    return {
      x: mt*mt*x0 + 2*mt*t*cpx + t*t*x1,
      y: mt*mt*y0 + 2*mt*t*cpy + t*t*y1,
    };
  }

  function recomputeCPs() {
    CPs = EDGES.map(function(e, i) {
      const n0 = NODES[NI[e[0]]], n1 = NODES[NI[e[1]]];
      const mx = (n0.fx+n1.fx)/2*W, my = (n0.fy+n1.fy)/2*H;
      const dx = (n1.fx-n0.fx)*W, dy = (n1.fy-n0.fy)*H;
      const len = Math.sqrt(dx*dx+dy*dy)||1;
      const nx = -dy/len, ny = dx/len;
      const sign = (i%2===0)?1:-1;
      const off  = 22 + (i%4)*7;
      return { cpx: mx+nx*off*sign, cpy: my+ny*off*sign };
    });
  }

  function edgePt(ei, t) {
    const e  = EDGES[ei];
    const n0 = NODES[NI[e[0]]], n1 = NODES[NI[e[1]]];
    const cp = CPs[ei];
    return qbez(n0.fx*W, n0.fy*H, cp.cpx, cp.cpy, n1.fx*W, n1.fy*H, t);
  }

  // ── Classify debug entry ──────────────────────────────────────────
  function classify(entry) {
    const status = entry.status || 0;
    const body   = safeJson(entry.body);
    const out = {
      which:    entry.which || "center",
      failed:   false,
      timeout:  false,
      partial:  false,
      slow:     (entry.latencyMs || 0) >= slowMs,
      color:    "#8B9BBF",
      emoji:    "❓",   // ❓ escaped
      hasColor: false,
      hasEmoji: false,
      latencyMs: entry.latencyMs || 0,
    };

    if (status===0 || (status>=500 && status!==599) || status===429) {
      out.failed = true;
      if (status===429) { out.hasEmoji = true; out.emoji = "🤯"; }  // overwhelmed / rate-limited
    } else if (status===504 || status===599) {
      out.timeout = true;
    } else if (status===200 && body) {
      if (validHex(body.color)) { out.hasColor = true; out.color = body.color; }
      const em = decodeEmoji(body.smiley);
      // Same guard the other modes use: reject status-code strings ("504") and
      // over-long values so they fall back to ❓ instead of rendering literally.
      if (em && em.length <= 16 && !/^[0-9]+$/.test(em)) { out.hasEmoji = true; out.emoji = em; }
      if (Array.isArray(body.errors) && body.errors.length) out.partial = true;
      if (body.smiley==="504"||body.color==="504") out.timeout = true;
    } else {
      // A 200 with an unparseable body (or any other unexpected status) is a
      // hard failure — mirror buoyant/cavern/space/garden/fireworks.
      out.failed = true;
    }
    return out;
  }

  function maxRatePerSec() {
    const s = window.__FACES_SETTINGS__ || {};
    return clamp(Number(s.funModeRatePerSec || s.buoyantRatePerSec || maxRps) || 0.5, 0.5, 200);   // 200 = super-mode ceiling; Swift caps the stored value to 20 unless super mode
  }

  // ── Spawn signal ──────────────────────────────────────────────────
  function spawnFromRequest(entry) {
    const nowS = performance.now()/1000;
    const minIntervalS = 1.0 / maxRatePerSec();
    const horizonS = Math.max(1.0, minIntervalS);  // see buoyant.js note
    admitted = admitted.filter(function(t){ return nowS-t < horizonS; });
    if (admitted.length > 0 && nowS - admitted[admitted.length - 1] < minIntervalS) return;
    if (admitted.length >= Math.ceil(maxRatePerSec())) return;
    if (signals.length >= MAX_SIGNALS) return;
    admitted.push(nowS);

    const c = classify(entry);
    rollReqs++;
    if (c.failed || c.timeout) rollErrs++;

    const pool = ROUTES[c.which] || ROUTES.center;
    const route = pool[Math.floor(Math.random()*pool.length)].slice();

    const baseDur = rand(3.0, 5.5);
    const dur     = c.slow ? baseDur * rand(1.8, 2.6) : baseDur;
    const kind    = c.failed  ? "failure"
                  : c.timeout ? "timeout"
                  : c.slow    ? "slow"
                  : c.partial ? "partial"
                  :             "success";

    signals.push({
      route, segIdx: 0, t: 0,
      segDur:   dur / (route.length-1),
      color:    c.color,
      emoji:    c.emoji,
      kind,
      slow:     c.slow,   // gates the per-node hover in advanceSignal
      partial:  c.partial,
      alpha:    1.0,
      fadeT:    0,
      fading:   false,
      hovering: false,
      hoverElapsed: 0,
      hoverDur: c.slow ? rand(0.4, 1.1) : 0,
      fractured:false,
      stagger:  rand(0, 0.25),
    });
  }

  // ── Signal update helpers ─────────────────────────────────────────
  function signalPos(s) {
    if (s.hovering) {
      const p = npos(NI[s.route[s.segIdx+1]]);
      return { x: p.x, y: p.y };
    }
    // Fading after arrival: draw at the output node so it dissolves there, not at canvas center
    if (s.segIdx >= s.route.length-1) {
      const lastNi = NI[s.route[s.route.length-1]];
      if (lastNi !== undefined) return npos(lastNi);
    }
    const fi = edgeIdx(s.route[s.segIdx], s.route[s.segIdx+1]);
    if (fi === undefined) return { x: W/2, y: H/2 };
    return edgePt(fi, c01(s.t));
  }

  function advanceSignal(s, dt) {
    // Entry stagger
    if (s.stagger > 0) { s.stagger -= dt; return; }

    // Fading
    if (s.fading) {
      s.fadeT += dt;
      s.alpha  = 1 - c01(s.fadeT / 0.5);
      return;
    }

    // Hovering
    if (s.hovering) {
      s.hoverElapsed += dt;
      // Pulse the node amber
      const ni = NI[s.route[s.segIdx+1]];
      if (ni !== undefined) NS[ni].heatLevel = clamp(NS[ni].heatLevel + 0.8*dt, 0, 1);
      if (s.hoverElapsed >= s.hoverDur) {
        s.hovering = false;
        s.hoverElapsed = 0;
        s.segIdx++;
        s.t = 0;
      }
      return;
    }

    // Fracture check: failures shatter mid-first-segment
    if (s.kind==="failure" && s.segIdx===0 && !s.fractured && s.t >= 0.45) {
      s.fractured = true;
      doFracture(s);
      s.fading = true;
      return;
    }

    // Advance
    s.t += dt / s.segDur;
    if (s.t < 1.0) return;

    // Arrived at next node
    s.t = 0;
    const arrivedAt = s.route[s.segIdx+1];
    const arrivedNi = NI[arrivedAt];

    // Timeout: stall and vanish at first process node
    if (s.kind==="timeout" && s.segIdx===0) {
      doTimeout(s, arrivedNi);
      s.fading = true;
      return;
    }

    s.segIdx++;

    // Reached output?
    if (s.segIdx >= s.route.length-1) {
      doArrive(s);
      s.fading = true;
      return;
    }

    // Heat up intermediate node
    if (arrivedNi !== undefined) NS[arrivedNi].heatLevel = clamp(NS[arrivedNi].heatLevel + 0.25, 0, 1);

    // Hover for slow
    if (s.slow && s.hoverDur > 0) {
      s.hovering = true;
      s.hoverElapsed = 0;
      s.segIdx--;   // will re-advance after hover
    }
  }

  function doArrive(s) {
    const ni = NI[s.route[s.route.length-1]];
    if (ni===undefined) return;
    const {x, y} = npos(ni);
    blooms.push({ ni, t:0, color: s.color, kind: s.kind });
    ripples.push({ ni, r:0, alpha:0.8, color: s.color, kind: s.kind });
    NS[ni].bloomT = 1.0;
    NS[ni].heatLevel = clamp(NS[ni].heatLevel - 0.1, 0, 1);
    // Memory glow on every segment used
    if (s.kind==="success") {
      for (let i=0; i<s.route.length-1; i++) {
        const ei = edgeIdx(s.route[i], s.route[i+1]);
        if (ei!==undefined) { ES[ei].memColor = s.color; ES[ei].memAlpha = 0.28; }
      }
    }
    // Release a floating arrival bubble — emoji + color orb rises from output node
    var life = rand(3.5, 5.5);
    arrivals.push({
      x:    x + rand(-24, 24),
      y:    y + rand(-6, 6),
      vx:   rand(-22, 22),      // gentle horizontal sway (stay near output column)
      vy:   rand(-60, -100),    // rise upward
      emoji:  s.emoji || "",
      color:  s.color,
      kind:   s.kind,
      alpha:  1.0,
      life,
      maxLife: life,
    });
  }

  function doFracture(s) {
    const ei = edgeIdx(s.route[0], s.route[1]);
    const pt = ei!==undefined ? edgePt(ei, 0.45) : npos(NI[s.route[0]]);
    // Sparks
    for (let i=0; i<12 && sparks.length<MAX_SPARKS; i++) {
      const ang = Math.random()*Math.PI*2;
      const spd = rand(80, 260);
      sparks.push({ x:pt.x, y:pt.y, vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd,
                    color:s.color, alpha:1.0, life:rand(0.5,0.9), maxLife:0.9 });
    }
    // Darken pathway
    if (ei!==undefined) ES[ei].darkT = 1.8;
    // Heat input node
    const ni0 = NI[s.route[0]];
    if (ni0!==undefined) NS[ni0].heatLevel = clamp(NS[ni0].heatLevel + 0.75, 0, 1);
    // Arc
    spawnArc(s.route[0], s.route[1]);
  }

  function doTimeout(s, arrivedNi) {
    if (arrivedNi===undefined) return;
    NS[arrivedNi].heatLevel = clamp(NS[arrivedNi].heatLevel + 0.85, 0, 1);
    const {x, y} = npos(arrivedNi);
    txMarkers.push({ x, y, alpha:1.0 });
  }

  function spawnArc(fromId, toId) {
    if (arcList.length >= MAX_ARCS) return;
    const fi = NI[fromId]||0, ti = NI[toId]||0;
    const p0 = npos(fi), p1 = npos(ti);
    const steps = 9 + Math.floor(Math.random()*4);
    const pts = [];
    for (let i=0; i<=steps; i++) {
      const tt = i/steps;
      pts.push({
        x: lerp(p0.x,p1.x,tt) + (Math.random()-0.5)*34,
        y: lerp(p0.y,p1.y,tt) + (Math.random()-0.5)*34,
      });
    }
    pts[0]            = { x:p0.x, y:p0.y };
    pts[pts.length-1] = { x:p1.x, y:p1.y };
    arcList.push({ pts, flashT: 0.28, alpha:1.0,
                   color: netStress>0.6 ? "#FF7043" : "#FFB347" });
  }

  // ── Environmental stress ──────────────────────────────────────────
  function updateStress(dt) {
    rollTimer += dt;
    if (rollTimer >= 1.0) {
      rollTimer -= 1.0;
      rollBuckets[rollIdx] = rollErrs / Math.max(1, rollReqs);
      rollIdx  = (rollIdx+1) % 10;
      rollReqs = 0; rollErrs = 0;
    }
    const avg = rollBuckets.reduce(function(s,v){return s+v;},0) / 10;
    const tgt = c01(avg);
    const spd = tgt > netStress ? 0.5 : 0.12;
    netStress = c01(netStress + (tgt-netStress)*spd*dt);
    hbTimer  += dt;
    hbPeriod  = lerp(8, 2, c01((netStress-0.6)/0.4));
  }

  // ── Update loop ───────────────────────────────────────────────────
  function update(dt) {
    updateStress(dt);

    // Nodes
    const haloTgt = netStress < 0.3 ? 1.0
                  : netStress < 0.6 ? lerp(1.0, 0.65, (netStress-0.3)/0.3)
                  : lerp(0.65, 0.4, (netStress-0.6)/0.4);
    NS.forEach(function(ns) {
      ns.heatLevel  = clamp(ns.heatLevel - 0.15*dt, 0, 1);
      ns.bloomT     = clamp(ns.bloomT    - dt/0.5,  0, 1);
      ns.haloScale  = lerp(ns.haloScale, haloTgt, 5*dt);
      ns.oscPhase  += 0.8 * 2 * Math.PI * dt;
    });

    // Edges
    ES.forEach(function(es) {
      if (es.memAlpha > 0) es.memAlpha = clamp(es.memAlpha - dt/3.5, 0, 1);
      if (es.darkT    > 0) es.darkT    = clamp(es.darkT    - dt,     0, 2);
    });

    // Signals
    const alive = [];
    signals.forEach(function(s) {
      advanceSignal(s, dt);
      if (!s.fading || s.alpha > 0) alive.push(s);
    });
    signals = alive;

    // Sparks
    const sa = [];
    sparks.forEach(function(sp) {
      sp.life -= dt;
      if (sp.life <= 0) return;
      sp.vx *= 0.91; sp.vy *= 0.91;
      sp.x  += sp.vx*dt; sp.y += sp.vy*dt;
      sp.alpha = sp.life / sp.maxLife;
      sa.push(sp);
    });
    sparks = sa;

    // Arcs
    const aa = [];
    arcList.forEach(function(a) {
      a.flashT -= dt;
      a.alpha   = c01(a.flashT/0.28);
      if (a.alpha > 0) aa.push(a);
    });
    arcList = aa;

    // Environmental arcs
    if (netStress > 0.3) {
      const period = lerp(Infinity, 2.0, (netStress-0.3)/0.7);
      const nowS = performance.now()/1000;
      if (isFinite(period) && nowS - lastArcTime > period) {
        lastArcTime = nowS;
        const aC = NODES.filter(function(n){return n.col===1;});
        const bC = NODES.filter(function(n){return n.col===2;});
        if (aC.length && bC.length) {
          spawnArc(
            aC[Math.floor(Math.random()*aC.length)].id,
            bC[Math.floor(Math.random()*bC.length)].id
          );
        }
      }
    }

    // Blooms / ripples / timeout markers
    blooms   = blooms.filter(function(b)  { b.t+=dt/0.3; return b.t<1.0; });
    ripples  = ripples.filter(function(r) { r.r+=dt*110; r.alpha-=dt/0.7; return r.alpha>0; });
    txMarkers= txMarkers.filter(function(x){ x.alpha-=dt/1.0; return x.alpha>0; });

    // Cascades
    cascades = cascades.filter(function(c) {
      c.t += dt/0.4;
      if (c.t >= 1.0 && !c.fired) {
        c.fired = true;
        const ni = NI[c.to];
        if (ni!==undefined) { NS[ni].bloomT = 0.7; }
      }
      return c.t < 1.5;
    });

    // Arrival bubbles
    arrivals = arrivals.filter(function(a) {
      a.life -= dt;
      a.x   += a.vx * dt;
      a.y   += a.vy * dt;
      a.vy  *= (1 - 1.5*dt);   // decelerate rise
      a.alpha = c01(a.life / a.maxLife);
      return a.life > 0;
    });

    // Pulse rings / floaters
    pulseRings = pulseRings.filter(function(p) { p.r+=dt*210; p.alpha-=dt/0.3; return p.alpha>0; });
    floaters   = floaters.filter(function(f)   { f.y-=f.vy*dt; f.alpha-=dt/1.2; return f.alpha>0; });

    // Ambients
    if (netStress < 0.3) {
      ambients.forEach(function(a) {
        a.t += a.dir * dt * 0.09;
        if (a.t>1||a.t<0) { a.dir*=-1; a.t=c01(a.t); }
      });
      const nowS = performance.now()/1000;
      if (ambients.length < AMBIENT_MAX && nowS - lastAmbTime > 2.0) {
        lastAmbTime = nowS;
        ambients.push({ ei: Math.floor(Math.random()*EDGES.length),
                        t:  Math.random(), dir: Math.random()>0.5?1:-1 });
      }
    } else {
      ambients = [];
    }

    if (window.__FACES_STATS__) window.__FACES_STATS__.setActive(signals.length, "signals");
  }

  // ── Draw ──────────────────────────────────────────────────────────
  function nodeColor(i) {
    const h = NS[i] ? NS[i].heatLevel : 0;
    if (h < 0.5) return lerpHex("#A0B8FF","#FFB347", h*2);
    return lerpHex("#FFB347","#FF4444", (h-0.5)*2);
  }

  function draw() {
    ctx.clearRect(0,0,W,H);

    // Background
    const ctrCol = netStress > 0.6 ? "#0E0810" : "#050810";
    const bg = ctx.createRadialGradient(W/2,H/2,0, W/2,H/2, Math.max(W,H)*0.72);
    bg.addColorStop(0, ctrCol);
    bg.addColorStop(1, "#0C1428");
    ctx.fillStyle = bg;
    ctx.fillRect(0,0,W,H);

    // Quantum noise (deterministic positions, sin twinkle)
    ctx.save();
    const nowS = performance.now()/1000;
    for (let i=0; i<200; i++) {
      const x = ((i*7919+1234) % (W+1));
      const y = ((i*6571+5678) % (H+1));
      const ph = (i*0.37 + nowS*0.28) % (Math.PI*2);
      const a  = lerp(0.03, 0.18, Math.sin(ph)*0.5+0.5);
      const sz = 1 + (i%2);
      ctx.fillStyle = netStress>0.6 ? "rgba(255,220,200,"+a*0.6+")" : "rgba(255,255,255,"+a+")";
      ctx.fillRect(x, y, sz, sz);
    }
    ctx.restore();

    // Heartbeat ring
    const hbPhase = (hbTimer % hbPeriod) / hbPeriod;
    if (hbPhase < 0.38) {
      const p = hbPhase/0.38;
      const r = p * Math.min(W,H) * 0.5;
      const a = (1-p) * (netStress<0.3?0.04 : netStress<0.6?0.05 : 0.07);
      const hbC = netStress<0.3 ? "rgba(100,150,255,"+a+")"
                : netStress<0.6 ? "rgba(200,160,80,"+a+")"
                :                 "rgba(255,50,50,"+a+")";
      ctx.beginPath();
      ctx.arc(W/2,H/2,r,0,Math.PI*2);
      ctx.strokeStyle = hbC;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Memory glows + pathway lines
    EDGES.forEach(function(e, i) {
      const n0 = NODES[NI[e[0]]], n1 = NODES[NI[e[1]]];
      const cp = CPs[i];
      if (!cp) return;
      const es = ES[i];
      const x0 = n0.fx*W, y0 = n0.fy*H, x1 = n1.fx*W, y1 = n1.fy*H;

      // Memory glow
      if (es && es.memAlpha > 0.01 && es.memColor) {
        const [r,g,b] = hexRgb(es.memColor);
        ctx.beginPath();
        ctx.moveTo(x0,y0);
        ctx.quadraticCurveTo(cp.cpx,cp.cpy,x1,y1);
        ctx.strokeStyle = "rgba("+r+","+g+","+b+","+es.memAlpha+")";
        ctx.lineWidth = 4.5;
        ctx.stroke();
      }

      // Path line
      const isDark = es && es.darkT > 0.1;
      ctx.beginPath();
      ctx.moveTo(x0,y0);
      ctx.quadraticCurveTo(cp.cpx,cp.cpy,x1,y1);
      ctx.strokeStyle = isDark ? "rgba(20,20,50,0.6)" : "rgba(70,100,200,0.12)";
      ctx.lineWidth = isDark ? 2.5 : 1.5;
      ctx.stroke();
    });

    // Signal tails (drawn before nodes)
    signals.forEach(function(s) {
      if (s.stagger>0 || s.fading || s.hovering) return;
      const fi = edgeIdx(s.route[s.segIdx], s.route[s.segIdx+1]);
      if (fi===undefined) return;
      const [r,g,b] = hexRgb(s.color);
      for (let ti=8; ti>=1; ti--) {
        const tt = c01(s.t - ti*0.02);
        const pt = edgePt(fi, tt);
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI*2);
        ctx.fillStyle = "rgba("+r+","+g+","+b+","+(1-ti/8)*0.12*s.alpha+")";
        ctx.fill();
      }
    });

    // Interference arcs
    arcList.forEach(function(a) {
      ctx.beginPath();
      ctx.moveTo(a.pts[0].x, a.pts[0].y);
      for (let i=1; i<a.pts.length; i++) ctx.lineTo(a.pts[i].x, a.pts[i].y);
      ctx.strokeStyle = a.color;
      ctx.lineWidth   = 1.5;
      ctx.globalAlpha = a.alpha;
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // Ambients
    ambients.forEach(function(a) {
      if (a.ei >= EDGES.length) return;
      const pt = edgePt(a.ei, a.t);
      ctx.beginPath();
      ctx.arc(pt.x,pt.y,3,0,Math.PI*2);
      ctx.fillStyle = "rgba(100,130,200,0.22)";
      ctx.fill();
    });

    // Node halos, rings, cores
    const BASE_R = clamp(5, H*0.007, 10);
    NODES.forEach(function(n, i) {
      const {x,y} = npos(i);
      const col   = nodeColor(i);
      const hs    = NS[i] ? NS[i].haloScale : 1.0;
      const bloom = NS[i] && NS[i].bloomT > 0
                    ? 1 + 2.5*Math.sin(NS[i].bloomT*Math.PI) : 1.0;

      // Halo
      ctx.beginPath();
      ctx.arc(x,y, BASE_R*3.8*hs, 0, Math.PI*2);
      ctx.fillStyle = rgba(col, 0.08*hs);
      ctx.fill();

      // Middle ring
      ctx.beginPath();
      ctx.arc(x,y, BASE_R*2.2, 0, Math.PI*2);
      ctx.fillStyle = rgba(col, 0.35);
      ctx.fill();

      // Core
      ctx.save();
      ctx.shadowBlur  = bloom>1.1 ? 38 : 14;
      ctx.shadowColor = col;
      ctx.beginPath();
      ctx.arc(x,y, BASE_R*bloom, 0, Math.PI*2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();
    });

    // Ripples
    ripples.forEach(function(rp) {
      const {x,y} = npos(rp.ni);
      const col = rp.kind==="success" ? rp.color : "#FFB347";
      ctx.beginPath();
      ctx.arc(x,y,rp.r,0,Math.PI*2);
      ctx.strokeStyle = rgba(validHex(col)?col:"#6688CC", rp.alpha*0.55);
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // Timeout ✕ markers
    ctx.font = "bold 14px -apple-system,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    txMarkers.forEach(function(t) {
      ctx.fillStyle = "rgba(255,255,255,"+t.alpha+")";
      ctx.fillText("×", t.x, t.y);
    });

    // Signals (orb + emoji + badge) — larger for readability
    const SIG_R = clamp(14, H*0.022, 26);
    signals.forEach(function(s) {
      if (s.stagger > 0) return;
      const pt = signalPos(s);
      const a  = s.alpha;

      // Glow orb
      ctx.save();
      ctx.shadowBlur  = SIG_R * 2.8;
      ctx.shadowColor = s.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, SIG_R, 0, Math.PI*2);
      ctx.fillStyle = rgba(s.color, a * 0.7);
      ctx.fill();
      ctx.restore();

      // Emoji always centered — it IS the signal face
      if (s.emoji) {
        ctx.globalAlpha = a;
        ctx.font = Math.round(SIG_R*1.5)+"px -apple-system,sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(s.emoji, pt.x, pt.y);
        ctx.globalAlpha = 1;
      }

      // Partial "!" badge
      if (s.partial) {
        ctx.font = "bold 12px -apple-system,sans-serif";
        ctx.fillStyle = "rgba(255,179,71,"+a+")";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("!", pt.x + SIG_R*1.0, pt.y - SIG_R*0.9);
      }
    });

    // Fracture sparks
    sparks.forEach(function(sp) {
      ctx.beginPath();
      ctx.arc(sp.x,sp.y,2.2,0,Math.PI*2);
      ctx.fillStyle = rgba(sp.color, sp.alpha);
      ctx.fill();
    });

    // Cascade signals
    cascades.forEach(function(c) {
      if (c.t>=1) return;
      const cx = lerp(c.x1,c.x2,c.t), cy = lerp(c.y1,c.y2,c.t);
      ctx.save();
      ctx.shadowBlur  = 10;
      ctx.shadowColor = "rgba(160,200,255,0.9)";
      ctx.beginPath();
      ctx.arc(cx,cy,4,0,Math.PI*2);
      ctx.fillStyle = "rgba(160,200,255,0.9)";
      ctx.fill();
      ctx.restore();
    });

    // Click pulse rings
    pulseRings.forEach(function(p) {
      ctx.beginPath();
      ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.strokeStyle = "rgba(180,210,255,"+p.alpha+")";
      ctx.lineWidth = 2;
      ctx.stroke();
    });

    // Arrival bubbles — completed requests rising from output nodes
    const ARR_R = clamp(24, H*0.038, 44);
    arrivals.forEach(function(a) {
      var vis = a.alpha;   // simple linear fade

      // Colored backdrop with strong glow
      ctx.save();
      ctx.shadowBlur  = ARR_R * 2.0;
      ctx.shadowColor = a.color;
      ctx.beginPath();
      ctx.arc(a.x, a.y, ARR_R, 0, Math.PI*2);
      ctx.fillStyle = rgba(a.color, vis * 0.82);
      ctx.fill();
      ctx.restore();

      // Bright rim ring
      ctx.beginPath();
      ctx.arc(a.x, a.y, ARR_R, 0, Math.PI*2);
      ctx.strokeStyle = rgba(a.color, vis);
      ctx.lineWidth = 2;
      ctx.stroke();

      // Emoji centered in orb
      if (a.emoji) {
        ctx.globalAlpha = vis;
        ctx.font = Math.round(ARR_R*1.35)+"px -apple-system,sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(a.emoji, a.x, a.y);
        ctx.globalAlpha = 1;
      }

      // Partial error amber ring
      if (a.kind === "partial") {
        ctx.beginPath();
        ctx.arc(a.x, a.y, ARR_R+5, 0, Math.PI*2);
        ctx.strokeStyle = "rgba(255,179,71,"+(vis*0.7)+")";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    });

    // Score floaters
    ctx.font = "bold 18px -apple-system,sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    floaters.forEach(function(f) {
      ctx.fillStyle = "rgba(255,255,255,"+f.alpha+")";
      ctx.fillText(f.text, f.x, f.y);
    });
  }

  // ── RAF loop ──────────────────────────────────────────────────────
  function loop(ts) {
    if (!running) return;
    const dt = Math.min((ts - (lastTs||ts))/1000, 0.1);
    lastTs = ts;
    update(dt);
    draw();
    rafId = requestAnimationFrame(loop);
  }

  function start() {
    if (running) return;
    running = true; lastTs = 0;
    rafId = requestAnimationFrame(loop);
  }
  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  // ── Click interaction ─────────────────────────────────────────────
  function reachableCount(startIdx, maxDepth) {
    const visited = new Set();
    function dfs(ni, d) {
      if (d>maxDepth || visited.has(ni)) return;
      visited.add(ni);
      OUT[NODES[ni].id].forEach(function(toId) {
        const ti = NI[toId];
        if (ti!==undefined) dfs(ti, d+1);
      });
    }
    dfs(startIdx, 0);
    return visited.size;
  }

  function fireCascadeAnim(startIdx, depth) {
    if (depth > 4) return;
    const {x:x1, y:y1} = npos(startIdx);
    NS[startIdx].bloomT = 0.65;
    OUT[NODES[startIdx].id].forEach(function(toId) {
      const ti = NI[toId];
      if (ti===undefined) return;
      const {x:x2, y:y2} = npos(ti);
      setTimeout(function() {
        if (!running) return;
        cascades.push({ x1,y1, x2,y2, t:0, to:toId, fired:false });
        fireCascadeAnim(ti, depth+1);
      }, depth * 150);
    });
  }

  function onCanvasClick(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    pulseRings.push({ x:mx, y:my, r:0, alpha:0.8 });

    let bestI = -1, bestD = 55;
    NODES.forEach(function(n, i) {
      const {x,y} = npos(i);
      const d = Math.sqrt((x-mx)*(x-mx)+(y-my)*(y-my));
      if (d<bestD) { bestD=d; bestI=i; }
    });

    if (bestI >= 0) {
      const score = reachableCount(bestI, 4);
      fireCascadeAnim(bestI, 0);
      pulseTotal += score;
      floaters.push({ x: mx, y: my-20, text: "+"+score, alpha:1.0, vy:32 });
      bumpPulsePill(score);
    }
  }

  // Score lives in the shared bottom-right stats HUD (.fhs-score); a click can
  // light multiple nodes, so each lit node counts toward the score.
  function bumpPulsePill(score) {
    if (window.__FACES_STATS__) {
      for (var i = 0; i < Math.max(1, score | 0); i++) window.__FACES_STATS__.bumpInteraction();
    }
  }

  // ── Resize ────────────────────────────────────────────────────────
  function resize() {
    if (!canvas||!root) return;
    W = root.clientWidth  || window.innerWidth;
    H = root.clientHeight || window.innerHeight;
    canvas.width  = W;
    canvas.height = H;
    recomputeCPs();
  }

  // ── Debug bus subscription ─────────────────────────────────────────
  function subscribeDebug() {
    if (!window.__FACES_DEBUG__) { setTimeout(subscribeDebug, 60); return; }
    window.__FACES_DEBUG__.subscribe(function(entry) {
      if (visualMode !== "claude") return;
      spawnFromRequest(entry);
      // NB: stats.js auto-subscribes to the debug bus itself, so the scene must
      // NOT also forward entries (there is no __FACES_STATS__.record — that call
      // threw on every signal and would have double-counted if it existed).
    });
  }

  // ── Key popup ─────────────────────────────────────────────────────
  function installKeyPopup() {
    keyOverlay = document.createElement("div");
    keyOverlay.className = "claude-key-overlay";
    keyOverlay.style.display = "none";
    // Overlay is a direct body child to avoid the transformed .wrapper containing-block trap
    keyOverlay.innerHTML = [
      '<div class="claude-key-card">',
      '<div class="claude-key-header"><h2>SYNAPSE Key</h2>',
      '<button class="claude-key-close">&times;</button></div>',
      '<p class="claude-key-intro">Signals = live HTTP requests. Each orb travels the neural network from input → output.</p>',
      '<table class="claude-key-table"><tbody>',
      '<tr><td>\u{1F535}</td><td><b>Traveling signal</b></td><td>A request being processed — normal traffic</td></tr>',
      '<tr><td>✨</td><td><b>Node bloom + ripple</b></td><td>Success — reached the output; <em>calm mode, 0% errors</em></td></tr>',
      '<tr><td>\u{1F7E0}</td><td><b>Signal hovering</b></td><td>High latency — pauses at each processor; <em>Delay 500–2000ms</em></td></tr>',
      '<tr><td>!</td><td><b>Partial error badge</b></td><td>Sub-service failed; <em>Smiley or Color error 50–100%</em></td></tr>',
      '<tr class="bk-star"><td>⚡</td><td><b>Fracture + sparks</b></td><td>★ Hard failure — signal shatters mid-path; <em>Face error 50–100%</em></td></tr>',
      '<tr><td>×</td><td><b>Timeout at node</b></td><td>Stalls and fades; <em>Max rate low or delay buckets high</em></td></tr>',
      '<tr><td>⚡</td><td><b>Interference arc</b></td><td>Network stress ≥ 30% errors</td></tr>',
      '<tr><td>\u{1F534}</td><td><b>Nodes vibrating red</b></td><td>Critical ≥ 60% errors — network oscillates</td></tr>',
      '<tr><td>❓</td><td><b>Grey signal / ❓ emoji</b></td><td>Color or emoji service down</td></tr>',
      '<tr class="bk-star"><td>\u{1F9E0}</td><td><b>Cast a pulse</b></td><td>★ Click a node to cascade; score = nodes lit (max 14)</td></tr>',
      '</tbody></table></div>',
    ].join("");
    document.body.appendChild(keyOverlay);

    keyOverlay.querySelector(".claude-key-close").addEventListener("click", closeKey);
    keyOverlay.addEventListener("click", function(e) { if (e.target===keyOverlay) closeKey(); });
    document.addEventListener("keydown", function(e) { if (e.key==="Escape") closeKey(); });

    // Intercept the shared #btnShowKey with capture so we beat faces.js
    var toolbar = document.getElementById("toolbar");
    if (toolbar) {
      toolbar.addEventListener("click", function(e) {
        if (visualMode!=="claude") return;
        var btn = e.target && e.target.id==="btnShowKey" ? e.target
                : e.target && e.target.closest && e.target.closest("#btnShowKey");
        if (!btn) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        keyOverlay.style.display = keyOverlay.style.display==="none" ? "flex" : "none";
      }, true);
    }
  }

  function closeKey() {
    if (keyOverlay) keyOverlay.style.display = "none";
  }

  // ── Boot ──────────────────────────────────────────────────────────
  function boot() {
    root   = document.getElementById("claude-root");
    canvas = document.getElementById("claude-canvas");
    if (!root||!canvas) return;
    ctx = canvas.getContext("2d");

    NS = NODES.map(function(n, i) {
      return { heatLevel:0, bloomT:0, haloScale:1.0, oscPhase: i*(Math.PI*2/NODES.length) };
    });
    ES = EDGES.map(function() { return { memColor:null, memAlpha:0, darkT:0 }; });

    resize();
    window.addEventListener("resize", resize);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(root);

    canvas.addEventListener("click", onCanvasClick);
    canvas.addEventListener("mousemove", function(e) {
      const rect = canvas.getBoundingClientRect();
      const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      var overNode = NODES.some(function(n,i) {
        const {x,y}=npos(i); return Math.sqrt((x-mx)*(x-mx)+(y-my)*(y-my))<32;
      });
      canvas.style.cursor = overNode ? "pointer" : "default";
    });

    // Shared stats HUD — bottom-right cluster, identical to every other mode.
    if (window.__FACES_STATS__) {
      var statsEl = document.createElement("div");
      statsEl.className = "fun-stats-hud";
      root.appendChild(statsEl);
      window.__FACES_STATS__.attachHUD(statsEl);
    }

    subscribeDebug();
    installKeyPopup();
    applySettings();
  }

  function applySettings() {
    var s = window.__FACES_SETTINGS__ || {};
    slowMs  = s.slowThresholdMs || 300;
    maxRps  = clamp(Number(s.funModeRatePerSec || s.buoyantRatePerSec || 0.5) || 0.5, 0.5, 200);   // 200 = super-mode ceiling; Swift caps the stored value to 20 unless super mode
  }

  // ── Public hooks ──────────────────────────────────────────────────
  window.__claudeSetMode__ = function(mode) {
    visualMode = mode;
    if (mode==="claude") {
      start();
      var btnKey = document.getElementById("btnShowKey");
      if (btnKey) btnKey.style.display = "inline-block";
    } else {
      stop();
      closeKey();
    }
  };

  window.__applyClaudeSettings__ = function(json) {
    var s = (typeof json==="string") ? (safeJson(json)||{}) : (json||{});
    slowMs = s.slowThresholdMs || 300;
    maxRps = clamp(Number(s.funModeRatePerSec || s.buoyantRatePerSec || 0.5) || 0.5, 0.5, 200);   // 200 = super-mode ceiling; Swift caps the stored value to 20 unless super mode
    if (window.__syncRateControl__) window.__syncRateControl__(maxRps);
  };

  if (document.readyState==="loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

})();

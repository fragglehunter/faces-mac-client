// buoyant.js — animated landscape visualization for Faces request events.
//
// Classic mode keeps owning the real polling. Buoyant mode listens to the same
// completed request records and turns each response into an independent canvas
// animation with its own lifecycle.

(function () {
  "use strict";

  const FALLBACK_COLOR = "#d9d7c8";
  // Escaped (not literal) so the file survives being served with a wrong
  // charset -- index.html declares utf-8, but this is cheap insurance.
  const FALLBACK_EMOJI = "\u2753";        // question mark
  const DIZZY_EMOJI = "\ud83d\ude35";     // dizzy face
  const SLEEPY_EMOJI = "\ud83d\ude34";    // sleeping face
  const SCARED_EMOJI = "\ud83d\ude31";    // \ud83d\ude31 face screaming in fear (balloon just popped)
  const DEAD_EMOJI = "\ud83d\udc80";      // \ud83d\udc80 skull (basket has hit the ground)
  const MAX_EVENTS = 90;
  const MAX_WEATHER = 12;

  let root, canvas, ctx, hudCounts, modeSelect;
  let dpr = 1;
  let width = 1;
  let height = 1;
  let visualMode = "classic";
  let slowThresholdMs = 300;
  // Admission rate: read from shared settings (toolbar.js owns the slider DOM).
  // Range 0.5–20 requests/sec. admittedTimes is a sliding 1-second window.
  let maxRatePerSec = 0.5;
  const admittedTimes = [];
  let seq = 0;
  let running = false;
  let raf = 0;
  let lastFrame = 0;
  const objects = [];
  const weather = [];

  const bg = new Image();
  bg.src = "blue-sky.png";

  function settings() {
    return window.__FACES_SETTINGS__ || {};
  }

  function boot() {
    root = document.getElementById("buoyant-root");
    canvas = document.getElementById("buoyant-canvas");
    modeSelect = document.getElementById("visualMode");
    hudCounts = document.getElementById("buoyant-counts");
    if (!root || !canvas) return;
    ctx = canvas.getContext("2d");

    applyBuoyantSettings(settings());
    setVisualMode(settings().visualMode || readConfigMode() || "classic");

    if (modeSelect) {
      modeSelect.value = visualMode;
      modeSelect.addEventListener("change", () => {
        setVisualMode(modeSelect.value);
        persistMode(modeSelect.value);
      });
    }

    installKeyPopup();

    // Attach shared stats HUD to the buoyant scene root.
    if (window.__FACES_STATS__) {
      var statsEl = document.createElement("div");
      statsEl.className = "fun-stats-hud";
      root.appendChild(statsEl);
      window.__FACES_STATS__.attachHUD(statsEl);
    }

    // Click a balloon to pop it (pure fun — no request is affected).
    canvas.addEventListener("click", (e) => {
      if (visualMode !== "buoyant") return;
      const hit = balloonAt(e.offsetX, e.offsetY);
      if (hit) popBalloon(hit);
    });
    canvas.addEventListener("mousemove", (e) => {
      if (visualMode !== "buoyant") return;
      canvas.style.cursor = balloonAt(e.offsetX, e.offsetY) ? "pointer" : "default";
    });

    window.addEventListener("resize", resize);
    // The window resize event alone misses element-size changes (CSS clamps,
    // viewport emulation, fullscreen transitions) — observe the root directly.
    if (window.ResizeObserver) new ResizeObserver(resize).observe(root);
    resize();
    subscribeDebug();
  }

  function subscribeDebug() {
    const bus = window.__FACES_DEBUG__;
    if (!bus) {
      setTimeout(subscribeDebug, 60);
      return;
    }
    bus.subscribe((entry) => {
      if (!entry) {
        objects.length = 0;
        weather.length = 0;
        return;
      }
      if (visualMode !== "buoyant") return;
      spawnFromRequest(entry);
    });
  }

  function readConfigMode() {
    try {
      const el = document.getElementById("faces-config");
      return JSON.parse(el.textContent || "{}").visualMode;
    } catch (_) {
      return "classic";
    }
  }

  function persistMode(mode) {
    if (window.__FACES_SETTINGS__) window.__FACES_SETTINGS__.visualMode = mode;
    const bridge = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.setVisualMode;
    if (bridge) bridge.postMessage({ visualMode: mode }).catch(() => {});
  }

  function applyBuoyantSettings(raw) {
    const cfg = typeof raw === "string" ? safeJson(raw, {}) : (raw || {});
    const n = Number(cfg.slowThresholdMs);
    slowThresholdMs = Number.isFinite(n) ? Math.max(100, n) : 300;
    // Prefer funModeRatePerSec (new), fall back to buoyantRatePerSec (legacy int).
    const r = Number(cfg.funModeRatePerSec || cfg.buoyantRatePerSec);
    if (Number.isFinite(r) && r > 0) maxRatePerSec = Math.min(200, Math.max(0.5, r));
    // Sync the shared toolbar slider.
    if (window.__syncRateControl__) window.__syncRateControl__(maxRatePerSec);
    if (cfg.visualMode) setVisualMode(cfg.visualMode);
  }

  // Buoyant key popup — the classic key explains grid cells (and renders
  // inside the collapsed floating wrapper, where it gets squished). This one
  // explains every scene animation AND the chaos recipe that triggers it.
  // All emoji/symbols are HTML entities (ASCII-safe regardless of charset).
  const KEY_ROWS = [
    ["&#x1F388;", "Hot-air balloon", false,
     "A fast, healthy response crossing the sky. The envelope is the color service's color; the basket passenger is the smiley service's emoji.",
     "Default calm settings. Faces &#x25B8; Calm Faces (&#x2318;K) gets you back here."],
    ["&#x1F3AF;", "Pop a balloon!", false,
     "Click any balloon: the envelope bursts into shards and the basket (passenger still aboard) plummets to the road with a dust poof. The scoreboard pill (top right) keeps your pop count &#x2014; badge upgrades at 10, 25, 50, and 100.",
     "Just click one. Purely visual &#x2014; no request is harmed."],
    ["&#x2195;&#xFE0F;", "High flyers &amp; low flyers", false,
     "Center-grid requests (/face/center/) ride the high sky; edge requests (/face/edge/) fly the low band. Same on the road: center walkers take the back lanes, edge walkers the front.",
     "Automatic &#x2014; based on each request's endpoint. Edge ring thickness: Settings &#x25B8; Display &#x25B8; Edge size."],
    ["&#x1F6B6;", "Road walker", false,
     "A slow but successful response (latency &#x2265; slow threshold, default 300 ms) has to walk instead of fly. Its color becomes the dust trail.",
     "Settings (&#x2318;,) &#x25B8; Simulator &#x25B8; any service &#x25B8; Delay at/above the threshold. Tune the threshold in Settings &#x25B8; Display."],
    ["&#x1F4A5;", "Balloon falling out of the sky", true,
     "The face service itself failed fast (HTTP 5xx or an unparseable response): the balloon deflates, trails smoke, tumbles down and lands with a dust poof. Storm clouds roll in.",
     "Settings &#x25B8; Simulator &#x25B8; Face &#x25B8; Error fraction up (try 50&#x2013;100%) with Delay 0."],
    ["&#x2757;", "Shaky balloon with a \"!\"", false,
     "Face answered, but the smiley or color service failed behind it (partial error): a squashed balloon with a ! badge that sinks as it crosses.",
     "Settings &#x25B8; Simulator &#x25B8; Smiley or Color &#x25B8; Error fraction."],
    ["&#x26AA;", "Grey wobbly balloon", false,
     "The response had no usable color &#x2014; grey fallback envelope, underinflated, drifting downward.",
     "A side effect of Color service errors (or malformed color data from a real backend)."],
    ["&#x2753;", "Mystery passenger", false,
     "No usable emoji in the response: a &#x2753; rides the basket and the balloon zig-zags, unsure of itself.",
     "A side effect of Smiley service errors (or malformed emoji data)."],
    ["&#x1F635;", "Timeouts: &#x1F635; falls, &#x1F634; drags", false,
     "Fast timeout/rate-limit: a falling basket with &#x1F635;. Slow timeout: &#x1F634; drags along the road, then fades.",
     "Settings &#x25B8; Simulator &#x25B8; Face &#x25B8; Max rate (small, e.g. 1 RPS) floods 429s; Latch makes errors stick (599) until calmed."],
    ["&#x1F974;", "Stumbling walker", false,
     "Slow AND failed: the walker stumbles, tips over with a !, and fades out on the road.",
     "Combine Delay with Error fraction on the Face service."],
    ["&#x26C8;&#xFE0F;", "Storm clouds", false,
     "Clouds and lightning follow failures; the sky clears as soon as responses are healthy again.",
     "Set the error knobs back to 0, or Faces &#x25B8; Calm Faces (&#x2318;K)."],
    ["&#x1F39A;&#xFE0F;", "Balloons/sec slider", false,
     "Controls how many balloons per second are launched &#x2014; and the actual server request rate. Range: 1 every 2 sec (0.5/s) to 20/s.",
     "Drag <b>Balloons</b> in the toolbar, or Settings &#x25B8; Grid &#x25B8; Balloons/sec."],
  ];

  function installKeyPopup() {
    const toolbar = document.getElementById("toolbar");
    if (!toolbar || document.getElementById("buoyantKeyPopup")) return;

    const overlay = document.createElement("div");
    overlay.id = "buoyantKeyPopup";
    overlay.className = "buoyant-key-overlay";
    const rows = KEY_ROWS.map(([icon, title, star, desc, how]) =>
      `<div class="bk-row${star ? " bk-star" : ""}">
         <div class="bk-icon">${icon}</div>
         <div>
           <div class="bk-title">${title}</div>
           <div class="bk-desc">${desc}</div>
           <div class="bk-how"><b>Make it happen:</b> ${how}</div>
         </div>
       </div>`).join("");
    overlay.innerHTML =
      `<div class="buoyant-key-card" role="dialog" aria-label="Buoyant mode key">
         <div class="buoyant-key-header">
           <h2>Buoyant Mode Key</h2>
           <button type="button" class="buoyant-key-close" aria-label="Close">&times;</button>
         </div>
         <p class="bk-intro">Every face request becomes one animated event. The chaos knobs live in
           Settings (&#x2318;,) &#x25B8; Simulator; with a remote backend, the real
           face/smiley/color services decide what happens instead.</p>
         ${rows}
       </div>`;
    // Direct child of <body>: the floating .wrapper is transformed, which
    // would otherwise become this fixed overlay's containing block.
    document.body.appendChild(overlay);

    // Capture phase on the toolbar runs before the button's own (classic-key)
    // listener, so in Buoyant mode the classic popup never opens.
    toolbar.addEventListener("click", (e) => {
      if (visualMode !== "buoyant") return;
      const t = e.target;
      if (t && t.id === "btnShowKey") {
        e.preventDefault();
        e.stopPropagation();
        overlay.classList.add("open");
      }
    }, true);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || (e.target.closest && e.target.closest(".buoyant-key-close"))) {
        overlay.classList.remove("open");
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") overlay.classList.remove("open");
    });
  }

  function closeBuoyantKey() {
    const o = document.getElementById("buoyantKeyPopup");
    if (o) o.classList.remove("open");
  }

  function setVisualMode(mode) {
    const valid = ["classic", "legacy", "buoyant", "cavern", "space", "garden", "claude", "fireworks"];
    visualMode = valid.includes(mode) ? mode : "classic";
    // Keep the shared settings mode in sync FIRST so the toolbar's rate-control
    // label (currentModeLabel reads __FACES_SETTINGS__.visualMode) updates to the
    // new scene — otherwise it sticks on the previous mode's noun ("Rockets" etc).
    // Create the object if absent (browser preview has no Swift-injected one).
    (window.__FACES_SETTINGS__ || (window.__FACES_SETTINGS__ = {})).visualMode = visualMode;
    const isFun = visualMode !== "classic" && visualMode !== "legacy";
    document.body.classList.toggle("visual-fun",     isFun);
    document.body.classList.toggle("visual-classic", visualMode === "classic");
    document.body.classList.toggle("visual-legacy",  visualMode === "legacy");
    document.body.classList.toggle("visual-buoyant", visualMode === "buoyant");
    document.body.classList.toggle("visual-cavern",  visualMode === "cavern");
    document.body.classList.toggle("visual-space",   visualMode === "space");
    document.body.classList.toggle("visual-garden",  visualMode === "garden");
    document.body.classList.toggle("visual-claude",  visualMode === "claude");
    document.body.classList.toggle("visual-fireworks", visualMode === "fireworks");
    if (modeSelect && modeSelect.value !== visualMode) modeSelect.value = visualMode;
    if (visualMode === "buoyant") start();
    else stop();
    if (visualMode !== "buoyant") closeBuoyantKey();
    // Notify scene modules (load after buoyant.js, define these hooks).
    if (typeof window.__cavernSetMode__ === "function") window.__cavernSetMode__(visualMode);
    if (typeof window.__spaceSetMode__  === "function") window.__spaceSetMode__(visualMode);
    if (typeof window.__gardenSetMode__ === "function") window.__gardenSetMode__(visualMode);
    if (typeof window.__claudeSetMode__ === "function") window.__claudeSetMode__(visualMode);
    if (typeof window.__fireworksSetMode__ === "function") window.__fireworksSetMode__(visualMode);
    // Refresh the toolbar rate slider's label + position for the new mode.
    if (window.__syncRateControl__) window.__syncRateControl__();
    // Legacy live-switch: if the page loaded with hideKey=true, #key is empty.
    // Click btnShowKey (which runs new Key(keyPopupBody)) then move content inline.
    if (visualMode === "legacy") {
      var keyEl = document.getElementById("key");
      if (keyEl && keyEl.children.length === 0) {
        var btn = document.getElementById("btnShowKey");
        if (btn && btn.onclick) {
          btn.click();
          setTimeout(function () {
            var popup = document.getElementById("keyPopup");
            var popupBody = document.getElementById("keyPopupBody");
            if (popupBody && keyEl) {
              while (popupBody.firstChild) keyEl.appendChild(popupBody.firstChild);
            }
            if (popup) popup.style.display = "none";
          }, 30);
        }
      }
    }
  }

  function start() {
    // resize() AFTER the running-guard: calling it while already running
    // reallocates the canvas and blanks the scene for a frame (e.g. when a
    // live settings push re-invokes setVisualMode for the current mode).
    if (running) return;
    resize();
    running = true;
    lastFrame = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function resize() {
    if (!canvas || !root) return;
    const rect = root.getBoundingClientRect();
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    width = Math.max(320, Math.floor(rect.width));
    height = Math.max(260, Math.floor(rect.height));
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.05, (now - lastFrame) / 1000 || 0.016);
    lastFrame = now;
    update(dt, now / 1000);
    draw(now / 1000);
    raf = requestAnimationFrame(frame);
  }

  function spawnFromRequest(entry) {
    // Rate limiter: minimum-interval gate (works for fractional rates like 0.5/s).
    const nowMs = performance.now();
    const minIntervalMs = 1000 / maxRatePerSec;
    // Prune horizon must be at least the min interval, else for sub-1/s rates
    // (min interval > 1000ms) the lone timestamp is pruned too early and the
    // gate stops enforcing the gap during bursts.
    const horizon = Math.max(1000, minIntervalMs);
    while (admittedTimes.length && nowMs - admittedTimes[0] > horizon) admittedTimes.shift();
    if (admittedTimes.length > 0 && nowMs - admittedTimes[admittedTimes.length - 1] < minIntervalMs) return;
    if (admittedTimes.length >= Math.ceil(maxRatePerSec)) return;
    admittedTimes.push(nowMs);

    const parsed = classify(entry);
    const shouldWalk = parsed.slow || (parsed.failed && entry.latencyMs >= slowThresholdMs);
    if (shouldWalk) addObject(makeWalker(parsed));
    else addObject(makeBalloon(parsed));
    if (parsed.failed || parsed.partialError) spawnWeather(parsed.failed ? 2 : 1);
  }

  function classify(entry) {
    const parsed = safeJson(entry.body, null);
    const parseFailed = !!entry.body && parsed == null;
    const status = Number(entry.status || 0);
    const color = parsed && validColor(parsed.color) ? parsed.color : FALLBACK_COLOR;
    const hasColor = parsed && validColor(parsed.color);
    const emoji = normalizeEmoji(parsed && parsed.smiley);
    const hasEmoji = emoji !== FALLBACK_EMOJI;
    const errors = parsed && Array.isArray(parsed.errors) ? parsed.errors : [];
    const failed = status === 0 || status === 504 || status === 429 || status >= 500 || parseFailed;
    const partialError = !failed && errors.length > 0;
    return {
      id: ++seq,
      status,
      latencyMs: Number(entry.latencyMs || 0),
      slow: Number(entry.latencyMs || 0) >= slowThresholdMs,
      failed,
      partialError,
      parseFailed,
      hasColor,
      hasEmoji,
      color,
      // Match the shared convention (cavern/space/garden): timeout/rate-limit
      // (504/0/429) → sleepy 😴; any other hard failure → dizzy 😵.
      emoji: failed && !hasEmoji ? (status === 504 || status === 0 || status === 429 ? SLEEPY_EMOJI : DIZZY_EMOJI) : emoji,
      which: entry.which || "center",
      row: entry.row,
      col: entry.col,
      born: performance.now() / 1000,
    };
  }

  function makeBalloon(e) {
    const lane = Math.random();
    const failure = e.failed;
    const duration = failure ? rand(2.2, 3.8) : rand(7.5, 14.0);
    // Altitude encodes the endpoint: center-cell requests ride the high sky,
    // edge-cell requests fly the low band (documented in the Buoyant key).
    const high = e.which === "center";
    return {
      kind: "balloon",
      id: e.id,
      // Entry stagger: a full-grid repaint completes many requests at the
      // same instant; spreading birth times keeps them from entering as one
      // clump glued to the left edge.
      born: nowSec() + (failure ? 0 : rand(0, 1.25)),
      duration,
      color: e.color,
      emoji: e.emoji,
      failed: failure,
      partialError: e.partialError,
      unstable: !e.hasColor || !e.hasEmoji || e.partialError,
      zigzag: !e.hasEmoji,
      startY: (high ? rand(0.13, 0.33) : rand(0.40, 0.60)) + lane * 0.04,
      size: rand(0.82, 1.18),
      phase: rand(0, Math.PI * 2),
      xJitter: rand(-12, 16),
      rot: rand(-0.12, 0.12),
    };
  }

  function makeWalker(e) {
    // Center-cell walkers take the back lanes, edge-cell walkers the front.
    const lane = e.which === "center" ? (e.id % 2) : 2 + (e.id % 2);
    return {
      kind: "walker",
      id: e.id,
      born: nowSec() + rand(0, 1.0),
      duration: e.failed ? rand(4.0, 6.2) : rand(8.0, 12.0),
      color: e.color,
      emoji: e.emoji,   // classify() already resolved the right glyph (sleepy/dizzy/real)
      failed: e.failed,
      partialError: e.partialError,
      unstable: !e.hasColor || e.partialError,
      lane,
      phase: rand(0, Math.PI * 2),
    };
  }

  function addObject(o) {
    // Admission control, NOT eviction. An admitted event is guaranteed to
    // finish its full animation (balloons always cross the whole sky). When
    // the request rate outruns the cap, excess requests simply are not
    // visualized — evicting the oldest instead made balloons vanish a third
    // of the way across at high request rates.
    if (objects.length >= MAX_EVENTS) return;
    objects.push(o);
  }

  function spawnWeather(count) {
    for (let i = 0; i < count; i++) {
      weather.push({
        born: nowSec(),
        duration: rand(1.2, 2.4),
        x: rand(0.18, 0.82),
        y: rand(0.10, 0.34),
        flashAt: rand(0.25, 0.7),
      });
    }
    while (weather.length > MAX_WEATHER) weather.shift();
  }

  function update(dt, t) {
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      // Popped balloons live on a fall timer; everything else expires by age.
      const done = o.popped ? (t - o.popT > 4) : ((t - o.born) / o.duration > 1.08);
      if (done) objects.splice(i, 1);
    }
    for (let i = weather.length - 1; i >= 0; i--) {
      const w = weather[i];
      if ((t - w.born) / w.duration > 1) weather.splice(i, 1);
    }
    if (window.__FACES_STATS__) window.__FACES_STATS__.setActive(objects.length, "aloft");
  }

  function draw(t) {
    ctx.clearRect(0, 0, width, height);
    drawBackground();
    drawWeather(t, false);
    for (const o of objects) {
      const age = (t - o.born) / o.duration;
      if (age < 0) continue; // entry-staggered, not on stage yet
      if (o.kind === "walker") drawWalker(o, clamp01(age), t);
    }
    for (const o of objects) {
      const age = (t - o.born) / o.duration;
      if (age < 0) continue;
      if (o.kind !== "balloon") continue;
      if (o.popped) drawPoppedBalloon(o, t);
      else drawBalloon(o, clamp01(age), t);
    }
    drawWeather(t, true);
  }

  function drawBackground() {
    ctx.imageSmoothingEnabled = false;
    if (bg.complete && bg.naturalWidth) {
      const iw = bg.naturalWidth;
      const ih = bg.naturalHeight;
      const scale = Math.max(width / iw, height / ih);
      const sw = width / scale;
      const sh = height / scale;
      const sx = (iw - sw) / 2;
      const sy = ih - sh;
      ctx.drawImage(bg, sx, Math.max(0, sy), sw, sh, 0, 0, width, height);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, height);
      g.addColorStop(0, "#80d7ff");
      g.addColorStop(1, "#b6eb9d");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingEnabled = true;
  }

  // Shared position math — drawBalloon AND the click hit-test must agree on
  // where a balloon is, so this lives in one place.
  function balloonPose(o, p, t) {
    const failure = o.failed;
    const baseX = failure
      ? width * (0.22 + (o.id % 7) * 0.09) + Math.sin(p * 9 + o.phase) * 20
      : -90 + p * (width + 190);
    const skyY = height * o.startY;
    const bob = Math.sin(t * 2.3 + o.phase) * 10;
    const x = baseX + (o.zigzag ? Math.sin(p * 18) * 28 : 0) + o.xJitter;
    // Sized for a full-window scene: readable but not dominant. (Tuned three
    // times on user feedback: /720*1.15 huge, /1200 too small, /1050 still
    // "a lil small vs landscape".)
    const scale = Math.max(0.55, Math.min(1.18, Math.min(width, height) / 950)) * o.size;
    // Failed balloons crash-land at the road instead of falling out of frame
    // (basket bottom sits at +40 in balloon-local coordinates).
    const y = failure
      ? Math.min(skyY + easeInQuad(p) * height * 0.58, roadY() - 40 * scale)
      : skyY + bob + (o.unstable ? p * height * 0.12 : 0);
    const rot = failure ? o.rot + p * 1.9 * (o.id % 2 ? 1 : -1) : o.rot + Math.sin(t + o.phase) * 0.04;
    return { x, y, scale, rot };
  }

  // Topmost still-poppable balloon under a canvas point (CSS px). Generous
  // box covering envelope + basket so it's easy to hit mid-bob.
  function balloonAt(px, py) {
    const t = nowSec();
    for (let i = objects.length - 1; i >= 0; i--) {
      const o = objects[i];
      if (o.kind !== "balloon" || o.failed || o.popped) continue;
      const age = (t - o.born) / o.duration;
      if (age < 0 || age > 1) continue;
      const pose = balloonPose(o, clamp01(age), t);
      const dx = px - pose.x;
      const dy = py - pose.y;
      const s = pose.scale;
      if (Math.abs(dx) <= 44 * s && dy >= -110 * s && dy <= 44 * s) return o;
    }
    return null;
  }

  function popBalloon(o) {
    const t = nowSec();
    const pose = balloonPose(o, clamp01((t - o.born) / o.duration), t);
    o.popped = true;
    o.popT = t;
    o.popX = pose.x;
    o.popY = pose.y;
    o.popScale = pose.scale;
    o.popRot = pose.rot;
    o.landedAt = 0;
    // The passenger panics the instant the envelope bursts; it turns into a
    // skull once the basket slams into the road (see drawPoppedBalloon).
    o.emoji = SCARED_EMOJI;
    // Keep the object alive past its crossing age until the fall finishes.
    o.duration = Math.max(o.duration, (t - o.born) + 5);
    bumpPopCounter();
    o.popNum = popCount; // for the milestone "+N!" floater
  }

  // Pop count is kept only for the in-scene milestone floater ("+N!"); the
  // visible scoreboard is the shared bottom-right stats HUD (.fhs-score).
  let popCount = 0;

  function bumpPopCounter() {
    popCount++;
    // Shared stats module accumulates interactions across ALL fun modes.
    if (window.__FACES_STATS__) window.__FACES_STATS__.bumpInteraction();
  }

  const POP_GRAVITY = 1500; // px/s^2 — snappy arcade fall

  // After the pop: color shards burst from the envelope, then the basket
  // (passenger still aboard, ropes snapped) plummets, lands at the road with
  // a dust poof, and fades out.
  function drawPoppedBalloon(o, t) {
    const ft = Math.max(0, t - o.popT);
    const s = o.popScale;
    const groundY = roadY() - 34 * s;
    let y = o.popY + 0.5 * POP_GRAVITY * ft * ft;
    if (y >= groundY) {
      y = groundY;
      if (!o.landedAt) { o.landedAt = t; o.emoji = DEAD_EMOJI; }  // it didn't make it
    }
    const landed = !!o.landedAt;
    const x = o.popX + Math.min(ft, 0.8) * o.xJitter * 1.5;
    const rot = landed ? o.popRot : o.popRot + ft * 2.2 * (o.id % 2 ? 1 : -1);
    const sinceLand = landed ? t - o.landedAt : 0;
    const alpha = landed ? Math.max(0, 1 - sinceLand / 0.9) : 1;

    // Burst shards from where the envelope was (first 0.35s).
    if (ft < 0.35) {
      const bp = ft / 0.35;
      ctx.save();
      ctx.globalAlpha = 1 - bp;
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 5 * s;
      ctx.lineCap = "round";
      const cxp = o.popX;
      const cyp = o.popY - 64 * s; // bulb center of the round envelope
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8 + o.phase;
        const r0 = (14 + bp * 52) * s;
        const r1 = r0 + 16 * s * (1 - bp);
        ctx.beginPath();
        ctx.moveTo(cxp + Math.cos(a) * r0, cyp + Math.sin(a) * r0);
        ctx.lineTo(cxp + Math.cos(a) * r1, cyp + Math.sin(a) * r1);
        ctx.stroke();
      }
      // white pop flash at the very start
      if (bp < 0.4) {
        ctx.globalAlpha = (1 - bp / 0.4) * 0.8;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(cxp, cyp, (10 + bp * 40) * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Arcade score floater rising from the pop point: "+1" normally, the
    // running total in gold on every 10th pop.
    if (ft < 0.9) {
      const milestone = o.popNum && o.popNum % 10 === 0;
      ctx.save();
      ctx.globalAlpha = 1 - ft / 0.9;
      ctx.font = `bold ${milestone ? 30 : 20}px -apple-system, BlinkMacSystemFont, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(40, 25, 15, 0.55)";
      ctx.fillStyle = milestone ? "#ffd93d" : "#ffffff";
      const fy = o.popY - 80 * s - ft * 50;
      const label = milestone ? `${o.popNum}!` : "+1";
      ctx.strokeText(label, o.popX, fy);
      ctx.fillText(label, o.popX, fy);
      ctx.restore();
    }

    // The falling basket with its passenger and limp rope stubs.
    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(s, s);
    ctx.strokeStyle = "rgba(80, 54, 38, 0.78)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-16, 12);
    ctx.quadraticCurveTo(-24, -2, -18, -10);
    ctx.moveTo(16, 12);
    ctx.quadraticCurveTo(24, -2, 18, -8);
    ctx.stroke();
    ctx.fillStyle = "#8b5b36";
    ctx.strokeStyle = "#543421";
    roundRect(-26, 10, 52, 30, 5);
    ctx.fill();
    ctx.stroke();
    drawPassenger(o.emoji, 46);
    ctx.restore();

    if (landed && sinceLand < 0.5) drawPoof(x, roadY(), sinceLand / 0.5);
  }

  function drawBalloon(o, p, t) {
    const failure = o.failed;
    const { x, y, scale, rot } = balloonPose(o, p, t);
    const alpha = p > 0.86 ? 1 - (p - 0.86) / 0.14 : 1;

    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(scale, scale);

    if (failure) drawSmoke(-16, -42, p);
    drawBalloonShape(o.color, failure, o.unstable || o.partialError);
    drawPassenger(o.emoji, failure ? 40 : 46);
    if (o.unstable && !failure) drawBang(48, -26, o.partialError ? "!" : "?");
    ctx.restore();

    if (failure && p > 0.72) drawPoof(x, roadY(), (p - 0.72) / 0.28);
  }

  // Envelope outline: a ROUND bulb (~270° arc) tapering to the throat — like
  // a real hot-air balloon, not an upright oval (user feedback; the squashed
  // "unstable" ellipse read better than the healthy one precisely because it
  // was nearly circular).
  function envelopePath(r, cy) {
    const gx = 0.809 * r;            // bottom gap points of the bulb arc
    const gy = cy + 0.588 * r;
    const ty = -15;                  // throat (where ropes attach)
    ctx.beginPath();
    ctx.arc(0, cy, r, 0.8 * Math.PI, 0.2 * Math.PI, false);
    ctx.quadraticCurveTo(0.62 * gx, (gy + ty) * 0.5, 11, ty);
    ctx.lineTo(-11, ty);
    ctx.quadraticCurveTo(-0.62 * gx, (gy + ty) * 0.5, -gx, gy);
    ctx.closePath();
  }

  function drawBalloonShape(color, failed, unstable) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(80, 54, 38, 0.75)";
    ctx.fillStyle = failed ? "#c7b9a6" : color;
    if (failed) {
      ctx.beginPath();
      ctx.ellipse(0, -46, 34, 20, -0.18, 0, Math.PI * 2);
      ctx.moveTo(-30, -42);
      ctx.quadraticCurveTo(-8, -24, 20, -40);
      ctx.fill();
      ctx.stroke();
    } else {
      const r = unstable ? 37 : 42;  // underinflated bulbs read smaller
      const cy = unstable ? -59 : -64;
      envelopePath(r, cy);
      ctx.fill();

      // Shade INSIDE the envelope (clipped): vertical gore seams, a soft
      // light from the upper-left, and a shadowed right edge.
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "rgba(255, 255, 255, 0.20)";
      ctx.beginPath();
      ctx.ellipse(-0.38 * r, cy - 0.18 * r, 0.62 * r, 0.85 * r, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(40, 25, 15, 0.16)";
      ctx.beginPath();
      ctx.ellipse(1.08 * r, cy, 0.6 * r, 1.05 * r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(60, 38, 25, 0.28)";
      ctx.lineWidth = 1.6;
      for (const k of [-0.66, -0.33, 0, 0.33, 0.66]) {
        ctx.beginPath();
        ctx.moveTo(0, cy - r);
        ctx.quadraticCurveTo(k * r * 1.9, cy + 0.15 * r, 0, -15);
        ctx.stroke();
      }
      ctx.restore();

      // Crisp rim drawn over the shading.
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(80, 54, 38, 0.75)";
      envelopePath(r, cy);
      ctx.stroke();
    }
    // Ropes from the throat down to the basket rim.
    ctx.strokeStyle = "rgba(80, 54, 38, 0.78)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-10, -14);
    ctx.lineTo(-17, 12);
    ctx.moveTo(10, -14);
    ctx.lineTo(17, 12);
    ctx.stroke();
    ctx.fillStyle = "#8b5b36";
    ctx.strokeStyle = "#543421";
    roundRect(-26, 10, 52, 30, 5);
    ctx.fill();
    ctx.stroke();
  }

  function drawPassenger(emoji, size) {
    ctx.font = `${size}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Anchor by the glyph BOTTOM (basket interior spans y 10..40): bigger
    // passengers poke out over the rim, but never below the basket floor.
    ctx.fillText(emoji || FALLBACK_EMOJI, 0, 37 - size / 2);
  }

  function drawWalker(o, p, t) {
    const x = -56 + p * (width + 112);
    // Lanes stay within the thin road band; the sprite is anchored so the
    // feet (drawn at +20 in drawFeet) rest on the road centerline.
    const laneOffset = (o.lane - 1.5) * 4;
    const bounce = Math.sin((p * 16 + o.phase) * Math.PI) * (o.failed ? 3 : 8);
    let y = roadY() - 20 + laneOffset - Math.abs(bounce);
    let alpha = p > 0.84 ? 1 - (p - 0.84) / 0.16 : 1;
    let rot = Math.sin(p * 24 + o.phase) * 0.08;
    if (o.failed) {
      y += Math.max(0, p - 0.46) * 34;
      rot += Math.max(0, p - 0.42) * 0.8;
      alpha = p > 0.70 ? 1 - (p - 0.70) / 0.30 : 1;
    }

    ctx.save();
    ctx.globalAlpha = clamp01(alpha);
    ctx.translate(x, y);
    ctx.rotate(rot);
    drawTrail(o.color, o.unstable, p);
    ctx.font = `${Math.max(28, Math.min(46, height * 0.07))}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(o.emoji || FALLBACK_EMOJI, 0, -10);
    drawFeet(p, o.failed);
    if (o.failed && p > 0.38 && p < 0.78) drawBang(25, -34, "!");
    ctx.restore();
  }

  function drawTrail(color, unstable, p) {
    ctx.save();
    ctx.fillStyle = color || FALLBACK_COLOR;
    ctx.globalAlpha *= unstable ? 0.35 : 0.65;
    for (let i = 0; i < 4; i++) {
      const k = (p * 20 + i) % 4;
      ctx.beginPath();
      ctx.ellipse(-22 - i * 10, 8 + Math.sin(k) * 3, 4, 2.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawFeet(p, failed) {
    ctx.strokeStyle = failed ? "#6f4632" : "#5a3b2b";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    const step = Math.sin(p * Math.PI * 18);
    ctx.beginPath();
    ctx.moveTo(-6, 14);
    ctx.lineTo(-12 - step * 4, 20);
    ctx.moveTo(7, 14);
    ctx.lineTo(13 + step * 4, 20);
    ctx.stroke();
  }

  function drawWeather(t, foreground) {
    for (const w of weather) {
      const p = clamp01((t - w.born) / w.duration);
      if (foreground && p < w.flashAt) continue;
      if (!foreground && p >= w.flashAt) continue;
      const x = w.x * width;
      const y = w.y * height;
      ctx.save();
      ctx.globalAlpha = foreground ? Math.max(0, 1 - p) : 0.32 * (1 - p);
      if (foreground) drawLightning(x + 24, y + 18, p);
      else drawCloud(x, y, 1 + p * 0.25);
      ctx.restore();
    }
  }

  function drawCloud(x, y, s) {
    ctx.fillStyle = "#6d7587";
    ctx.beginPath();
    ctx.arc(x - 18 * s, y + 8 * s, 17 * s, 0, Math.PI * 2);
    ctx.arc(x, y, 23 * s, 0, Math.PI * 2);
    ctx.arc(x + 23 * s, y + 10 * s, 16 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawLightning(x, y, p) {
    ctx.strokeStyle = p % 0.18 < 0.09 ? "#fff173" : "rgba(255,255,255,0.6)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 10, y + 24);
    ctx.lineTo(x + 2, y + 21);
    ctx.lineTo(x - 8, y + 46);
    ctx.stroke();
  }

  function drawSmoke(x, y, p) {
    ctx.fillStyle = "rgba(92, 91, 89, 0.45)";
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(x - i * 13, y - i * 10, 7 + i * 3 + p * 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPoof(x, y, p) {
    ctx.save();
    ctx.globalAlpha = clamp01(1 - p);
    ctx.fillStyle = "rgba(210, 188, 145, 0.65)";
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      ctx.arc(x + (i - 2) * 13, y + Math.sin(i) * 6, 8 + p * 18, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBang(x, y, text) {
    ctx.save();
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.strokeStyle = "rgba(70, 54, 40, 0.5)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#7a2a2a";
    ctx.font = "bold 17px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x, y + 1);
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Vertical center of the brown road band in blue-sky.png, as a fraction of
  // the image height (measured from the asset: the band spans ~0.970–0.983).
  // drawBackground() cover-scales the image anchored to the bottom edge, so
  // the on-screen road position must be derived from that same mapping —
  // this keeps walkers glued to the road at any window size/aspect ratio.
  const ROAD_CENTER_FRAC = 0.9765;

  function roadY() {
    if (bg.complete && bg.naturalWidth) {
      const scale = Math.max(width / bg.naturalWidth, height / bg.naturalHeight);
      return height - (1 - ROAD_CENTER_FRAC) * bg.naturalHeight * scale;
    }
    return height * 0.93;
  }

  function safeJson(s, fallback) {
    if (!s) return fallback;
    try { return JSON.parse(s); } catch (_) { return fallback; }
  }

  function validColor(c) {
    return typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c.trim());
  }

  function normalizeEmoji(value) {
    if (typeof value !== "string" || value.trim() === "") return FALLBACK_EMOJI;
    const decoded = decodeEntities(value).trim();
    if (!decoded || decoded.length > 16) return FALLBACK_EMOJI;
    if (/^[0-9]+$/.test(decoded)) return FALLBACK_EMOJI;
    return decoded;
  }

  function decodeEntities(s) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = s;
    return textarea.value;
  }

  function nowSec() {
    return performance.now() / 1000;
  }

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp01(v) {
    return Math.max(0, Math.min(1, v));
  }

  function easeInQuad(v) {
    return v * v;
  }

  window.__setVisualMode__ = function (mode) {
    // Update __FACES_SETTINGS__ immediately so currentModeLabel() in toolbar.js
    // reads the correct mode before the applySettings callbacks fire.
    if (window.__FACES_SETTINGS__) window.__FACES_SETTINGS__.visualMode = mode;
    setVisualMode(mode);
    return true;
  };
  window.__applyBuoyantSettings__ = function (json) {
    applyBuoyantSettings(json);
    return true;
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

// toolbar.js — Mac-app UX enhancements for the faces-gui toolbar.
//
// Installs:
//   1. User pill (replaces the raw <input id="userName"> with a clickable pill +
//      inline editor; the original input stays in the DOM so upstream UserController
//      and request headers continue to work).
//   2. Debug button (opens the in-app network debug panel).
//   3. Rate control slider — shown for ALL non-Classic visual modes. Controls
//      the fun-mode event-admission rate (events/sec admitted to the scene,
//      NOT the actual HTTP request rate). Extended range: 0.1–200 events/sec.
//
// Rate control reads/writes window.__FACES_SETTINGS__.funModeRatePerSec and
// persists back to Swift via the setFunModeRate message handler.

(function () {
  "use strict";

  // ── Shared rate state ──────────────────────────────────────────────────────
  // All fun modes read from this; only the slider and __applyXSettings__
  // write to it. Legacy buoyantRatePerSec is kept as an alias.
  // Range: 0.5–20 requests/sec. This controls both animation and HTTP request rate.

  var MODE_LABELS = {
    buoyant: "Balloons",
    space:   "Rockets",
    cavern:  "Explorers",
    garden:  "Flowers",
    claude:  "Signals",
    fireworks: "Fireworks"
  };

  function currentModeLabel() {
    var s = window.__FACES_SETTINGS__ || {};
    return MODE_LABELS[s.visualMode] || "Rate";
  }

  // Toolbar button visibility prefs. Default true (shown) when unspecified so
  // older settings blobs keep both buttons. Settings (Mac menu) can hide either,
  // since both are reachable from the macOS menu bar / ⌘ shortcuts.
  function prefBool(key, dflt) {
    var v = (window.__FACES_SETTINGS__ || {})[key];
    return v == null ? dflt : !!v;
  }
  function showDebugBtnPref()    { return prefBool("showDebugButton", true); }
  function showSettingsBtnPref() { return prefBool("showSettingsButton", true); }

  // Upper bound for the rate slider/value. "Super mode" (Settings) lifts it
  // from 20/s to 200/s. Read live from settings so toggling takes effect at once.
  function rateMax() {
    return (window.__FACES_SETTINGS__ && window.__FACES_SETTINGS__.superMode) ? 200 : 20;
  }

  function readRate() {
    var s = window.__FACES_SETTINGS__ || {};
    return Math.max(0.5, Math.min(rateMax(), s.funModeRatePerSec || s.buoyantRatePerSec || 0.5));
  }

  function writeRate(val) {
    val = Math.max(0.5, Math.min(rateMax(), val));
    var s = window.__FACES_SETTINGS__ || {};
    s.funModeRatePerSec = val;
    s.buoyantRatePerSec = val;  // legacy alias (keep as Double, not rounded)
    window.__FACES_SETTINGS__ = s;

    // Notify all fun modes that use __applyXSettings__
    if (window.__applyBuoyantSettings__) window.__applyBuoyantSettings__(s);
    if (window.__applyCavernSettings__)  window.__applyCavernSettings__(s);
    if (window.__applySpaceSettings__)   window.__applySpaceSettings__(s);
    if (window.__applyGardenSettings__)  window.__applyGardenSettings__(s);
    if (window.__applyClaudeSettings__)  window.__applyClaudeSettings__(s);
    if (window.__applyFireworksSettings__) window.__applyFireworksSettings__(s);

    // Persist via Swift bridge
    var mh = window.webkit && window.webkit.messageHandlers;
    var handler = mh && (mh.setFunModeRate || mh.setBuoyantRate);
    if (handler) handler.postMessage({ ratePerSec: val }).catch(function () {});
  }

  function rateLabel(val) {
    if (val < 1) {
      return "1/" + Math.round(1 / val) + "s";
    }
    if (val >= 10) return Math.round(val) + "/s";
    return parseFloat(val.toFixed(1)) + "/s";
  }

  // Log-scale: slider position 0→1 maps to 0.5→rateMax() requests/sec.
  // logMax() is dynamic so super mode (200/s) rescales the slider live.
  var LOG_MIN = Math.log2(0.5);
  function logMax() { return Math.log2(rateMax()); }

  function sliderToRate(pos) {
    return Math.max(0.5, Math.min(rateMax(), Math.pow(2, LOG_MIN + pos * (logMax() - LOG_MIN))));
  }

  function rateToSlider(rate) {
    return (Math.log2(Math.max(0.5, rate)) - LOG_MIN) / (logMax() - LOG_MIN);
  }

  // ── Rate control DOM ────────────────────────────────────────────────────────

  var rateInput = null;
  var rateValueEl = null;

  function installRateControl() {
    var toolbar = document.getElementById("toolbar");
    if (!toolbar || document.querySelector(".rate-control")) return;

    var label = document.createElement("label");
    label.className = "rate-control";
    // Explain what the slider does (consistent with the stats-HUD pill tooltips
    // and the Settings slider's help text). "1/2s" = one event every 2 seconds.
    label.title = "Scene rate — how many events per second are admitted to the scene (and the request rate). \"1/2s\" means one every 2 seconds.";
    label.innerHTML =
      '<span class="rate-label">' + currentModeLabel() + '</span>' +
      '<input type="range" min="0" max="1" step="0.01" value="0.5">' +
      '<span class="rate-value">1/2s</span>';

    rateInput   = label.querySelector("input");
    rateValueEl = label.querySelector(".rate-value");

    var current = readRate();
    rateInput.value = rateToSlider(current);
    rateValueEl.textContent = rateLabel(current);

    rateInput.addEventListener("input", function () {
      var val = sliderToRate(parseFloat(rateInput.value));
      rateValueEl.textContent = rateLabel(val);
    });

    rateInput.addEventListener("change", function () {
      var val = sliderToRate(parseFloat(rateInput.value));
      rateValueEl.textContent = rateLabel(val);
      writeRate(val);
    });

    toolbar.appendChild(label);
  }

  // Allow external code (Settings sidebar, fun mode JS) to sync the slider and
  // label. Called with no argument on a mode switch — re-reads the current rate
  // and refreshes the mode-specific label ("Balloons", "Rockets", …).
  window.__syncRateControl__ = function (val) {
    if (!rateInput || !rateValueEl) return;
    if (val == null) val = readRate();
    val = Math.max(0.5, Math.min(rateMax(), val));
    rateInput.value = rateToSlider(val);
    rateValueEl.textContent = rateLabel(val);
    // Update the mode-specific label text (e.g. "Balloons", "Rockets").
    var labelEl = rateInput.parentElement && rateInput.parentElement.querySelector(".rate-label");
    if (labelEl) labelEl.textContent = currentModeLabel();
  };

  // Set the fun-mode rate from outside the main toolbar (e.g. the Debug window's
  // RPS control routes through Swift → here). Goes through writeRate so it clamps,
  // persists to Swift, applies to all scenes, and re-syncs the toolbar slider.
  window.__applyRateFromExternal__ = function (val) {
    var n = Number(val);
    if (!isFinite(n)) return false;
    writeRate(n);
    if (window.__syncRateControl__) window.__syncRateControl__();
    return true;
  };

  // ── User pill ───────────────────────────────────────────────────────────────

  function updateOriginalInput(value) {
    var input = document.getElementById("userName") || window.__facesUserInput;
    if (!input) return;
    input.value = value;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }

  function persistUser(value) {
    if (window.__FACES_SETTINGS__) window.__FACES_SETTINGS__.user = value || "unknown";
    var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.setUser;
    if (mh) mh.postMessage({ user: value || "unknown" }).catch(function () {});
  }

  function installUserPill() {
    var div   = document.getElementById("userDiv");
    var input = document.getElementById("userName");
    if (!div || !input || div.dataset.enhanced === "true") return;
    div.dataset.enhanced = "true";

    var initial = (input.value ||
      (window.__FACES_SETTINGS__ && window.__FACES_SETTINGS__.user) || "unknown").trim();
    window.__facesUserInput = input;

    div.innerHTML = "";
    div.className = "user-pill-wrap";
    input.style.display = "none";
    input.setAttribute("aria-hidden", "true");

    var button = document.createElement("button");
    button.type = "button";
    button.className = "user-pill";
    button.title = "Click to change request user";
    button.innerHTML =
      '<span class="user-pill-label">User</span>' +
      '<span class="user-pill-value"></span>';

    var editor = document.createElement("div");
    editor.className = "user-editor";
    editor.innerHTML =
      '<label for="user-editor-input">Request user</label>' +
      '<input id="user-editor-input" type="text" autocomplete="off" spellcheck="false" placeholder="e.g. alice" aria-label="Request user">' +
      '<div class="user-editor-actions">' +
      '<button type="button" data-action="cancel">Cancel</button>' +
      '<button type="button" data-action="apply">Apply</button>' +
      '</div>';

    var editorInput = editor.querySelector("input");
    var valueSpan   = button.querySelector(".user-pill-value");

    function set(value) {
      var next    = (value || "unknown").trim() || "unknown";
      var isUnset = next === "unknown";
      valueSpan.textContent = isUnset ? "" : next;
      valueSpan.style.display = isUnset ? "none" : "";
      button.classList.toggle("user-pill-unset", isUnset);
      // No user set → don't show anything in the toolbar at all. The user is
      // still settable from Settings (which calls __setRequestUser__).
      button.style.display = isUnset ? "none" : "";
      editorInput.value = isUnset ? "" : next;
      updateOriginalInput(next);
      persistUser(next);
    }

    // Let native Settings drive the request user even while the pill is hidden.
    window.__setRequestUser__ = function (v) { set(v); closeEditor(); };

    function openEditor()  { editor.classList.add("open"); editorInput.focus(); editorInput.select(); }
    function closeEditor() { editor.classList.remove("open"); }

    button.addEventListener("click", openEditor);
    editorInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter")  { e.preventDefault(); set(editorInput.value); closeEditor(); }
      if (e.key === "Escape") { closeEditor(); }
    });
    editor.addEventListener("click", function (e) {
      var action = e.target && e.target.getAttribute && e.target.getAttribute("data-action");
      if (action === "apply")  { set(editorInput.value); closeEditor(); }
      if (action === "cancel") { closeEditor(); }
    });
    document.addEventListener("click", function (e) {
      if (!div.contains(e.target)) closeEditor();
    });

    div.appendChild(input);
    div.appendChild(button);
    div.appendChild(editor);
    set(initial);
  }

  // ── Settings button ─────────────────────────────────────────────────────────

  function installSettingsButton() {
    var toolbar = document.getElementById("toolbar");
    if (!toolbar || document.getElementById("btnSettings")) return;
    if (!showSettingsBtnPref()) return;
    var btn = document.createElement("input");
    btn.id = "btnSettings";
    btn.type = "button";
    btn.value = "Settings";
    btn.className = "roundedButton";
    btn.addEventListener("click", function () {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openSettings;
      if (mh) mh.postMessage("").catch(function () {});
    });
    insertToolbarButton(toolbar, btn);
  }

  // Insert a toolbar button before the rate-control (so live re-adds keep the
  // Settings/Debug/rate ordering), falling back to append.
  function insertToolbarButton(toolbar, btn) {
    var rate = toolbar.querySelector(".rate-control");
    if (rate) toolbar.insertBefore(btn, rate);
    else toolbar.appendChild(btn);
  }

  // ── Debug button ────────────────────────────────────────────────────────────

  function installDebugButton() {
    var toolbar = document.getElementById("toolbar");
    if (!toolbar || document.getElementById("btnDebug")) return;
    if (!showDebugBtnPref()) return;
    var btn = document.createElement("input");
    btn.id = "btnDebug";
    btn.type = "button";
    btn.value = "Debug";
    btn.className = "roundedButton";
    btn.addEventListener("click", function () {
      if (window.__showFacesDebug__) window.__showFacesDebug__();
    });
    insertToolbarButton(toolbar, btn);
  }

  // Live toolbar-button visibility — called by Swift (pushLiveSettings) when the
  // "Show … in toolbar" toggles change, so it takes effect without a reload.
  function applyToolbarButtonVisibility() {
    var sBtn = document.getElementById("btnSettings");
    if (showSettingsBtnPref()) { if (!sBtn) installSettingsButton(); }
    else if (sBtn) sBtn.remove();

    var dBtn = document.getElementById("btnDebug");
    if (showDebugBtnPref()) { if (!dBtn) installDebugButton(); }
    else if (dBtn) dBtn.remove();
  }

  window.__applyToolbarPrefs__ = function (raw) {
    var s = raw;
    if (typeof raw === "string") { try { s = JSON.parse(raw); } catch (_) { s = null; } }
    var st = window.__FACES_SETTINGS__ || (window.__FACES_SETTINGS__ = {});
    if (s) {
      if ("showDebugButton" in s)    st.showDebugButton    = s.showDebugButton;
      if ("showSettingsButton" in s) st.showSettingsButton = s.showSettingsButton;
      // Keep superMode current so rateMax()/the slider rescale on a live toggle.
      if ("superMode" in s)          st.superMode          = s.superMode;
    }
    applyToolbarButtonVisibility();
    if (window.__syncRateControl__) window.__syncRateControl__();
    return true;
  };

  // ── Boot ─────────────────────────────────────────────────────────────────────

  function boot() {
    installUserPill();
    installSettingsButton();
    installDebugButton();
    installRateControl();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

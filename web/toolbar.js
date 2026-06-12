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
  // All fun modes read from this; only the slider and __applyBuoyantSettings__
  // write to it. Legacy buoyantRatePerSec is kept as an alias.

  function readRate() {
    var s = window.__FACES_SETTINGS__ || {};
    return Math.max(0.1, Math.min(200, s.funModeRatePerSec || s.buoyantRatePerSec || 8));
  }

  function writeRate(val) {
    val = Math.max(0.1, Math.min(200, val));
    var s = window.__FACES_SETTINGS__ || {};
    s.funModeRatePerSec = val;
    s.buoyantRatePerSec = Math.round(val);  // legacy alias
    window.__FACES_SETTINGS__ = s;

    // Notify all fun modes that use __applyBuoyantSettings__
    if (window.__applyBuoyantSettings__) window.__applyBuoyantSettings__(s);
    if (window.__applyCavernSettings__)  window.__applyCavernSettings__(s);
    if (window.__applySpaceSettings__)   window.__applySpaceSettings__(s);
    if (window.__applyGardenSettings__)  window.__applyGardenSettings__(s);

    // Persist via Swift bridge
    var mh = window.webkit && window.webkit.messageHandlers;
    var handler = mh && (mh.setFunModeRate || mh.setBuoyantRate);
    if (handler) handler.postMessage({ ratePerSec: val }).catch(function () {});
  }

  function rateLabel(val) {
    if (val < 0.5) {
      return "1/" + Math.round(1 / val) + "s";
    }
    if (val >= 100) return Math.round(val) + "/s";
    if (val >= 10)  return val.toFixed(0) + "/s";
    return val.toFixed(1).replace(".0", "") + "/s";
  }

  // Log-scale: slider position 0→1 maps to 0.1→200 events/sec.
  var LOG_MIN = Math.log2(0.1);
  var LOG_MAX = Math.log2(200);

  function sliderToRate(pos) {
    return Math.max(0.1, Math.min(200, Math.pow(2, LOG_MIN + pos * (LOG_MAX - LOG_MIN))));
  }

  function rateToSlider(rate) {
    return (Math.log2(Math.max(0.1, rate)) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  }

  // ── Rate control DOM ────────────────────────────────────────────────────────

  var rateInput = null;
  var rateValueEl = null;

  function installRateControl() {
    var toolbar = document.getElementById("toolbar");
    if (!toolbar || document.querySelector(".rate-control")) return;

    var label = document.createElement("label");
    label.className = "rate-control";
    label.innerHTML =
      '<span class="rate-label">Rate</span>' +
      '<input type="range" min="0" max="1" step="0.01" value="0.5">' +
      '<span class="rate-value">8/s</span>';

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

  // Allow external code (Settings sidebar, buoyant.js) to sync the slider.
  window.__syncRateControl__ = function (val) {
    if (!rateInput || !rateValueEl) return;
    rateInput.value = rateToSlider(Math.max(0.1, Math.min(200, val)));
    rateValueEl.textContent = rateLabel(val);
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
      '<label>Request user</label>' +
      '<input type="text" autocomplete="off" spellcheck="false">' +
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
      editorInput.value = isUnset ? "" : next;
      updateOriginalInput(next);
      persistUser(next);
    }

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
    var btn = document.createElement("input");
    btn.id = "btnSettings";
    btn.type = "button";
    btn.value = "Settings";
    btn.className = "roundedButton";
    btn.addEventListener("click", function () {
      var mh = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.openSettings;
      if (mh) mh.postMessage("").catch(function () {});
    });
    toolbar.appendChild(btn);
  }

  // ── Debug button ────────────────────────────────────────────────────────────

  function installDebugButton() {
    var toolbar = document.getElementById("toolbar");
    if (!toolbar || document.getElementById("btnDebug")) return;
    var btn = document.createElement("input");
    btn.id = "btnDebug";
    btn.type = "button";
    btn.value = "Debug";
    btn.className = "roundedButton";
    btn.addEventListener("click", function () {
      if (window.__showFacesDebug__) window.__showFacesDebug__();
    });
    toolbar.appendChild(btn);
  }

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

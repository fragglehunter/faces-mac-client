// status.js — the ONE place that decides what an HTTP status from the face
// service means. The grid, every fun mode, stats and both debug views read it,
// so a 429 / 504 / 599 looks the same everywhere.
//
//   kind          statuses      look
//   ok            2xx           (body decides)
//   ratelimited   429           🤯 overwhelmed, yellow / "warn"
//   timeout       504, 0        😴 never answered
//   latched       599           sticky error (yellow / "warn" in the grid)
//   error         anything else hard failure
//
// Loaded before every other page script (and by debug-window.html).
//
// SPDX-License-Identifier: Apache-2.0

(function () {
  "use strict";

  function classify(status) {
    var s = Number(status) || 0;
    if (s >= 200 && s < 300) return "ok";
    if (s === 429) return "ratelimited";
    if (s === 504 || s === 0) return "timeout";
    if (s === 599) return "latched";
    return "error";
  }

  // Color tone for status chips / table cells: "ok" | "warn" | "bad".
  function tone(status) {
    var s = Number(status) || 0;
    var k = classify(s);
    if (k === "ok") return "ok";
    if (k === "ratelimited" || k === "latched" || (s >= 300 && s < 400)) return "warn";
    return "bad";
  }

  // Face to show for a failed request that carried no smiley of its own.
  function failureEmoji(status) {
    var k = classify(status);
    if (k === "ratelimited") return "\u{1F92F}";  // 🤯 overwhelmed
    if (k === "timeout") return "\u{1F634}";      // 😴 never answered
    return "\u{1F635}";                           // 😵 any other hard failure
  }

  window.__FACES_STATUS__ = {
    classify: classify,
    tone: tone,
    failureEmoji: failureEmoji,
    OVERWHELMED_EMOJI: "\u{1F92F}",   // 🤯
    SLEEPY_EMOJI: "\u{1F634}",        // 😴
  };
})();

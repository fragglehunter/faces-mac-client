// layout.js — responsive grid sizing for the Mac app shell.
//
// The upstream faces-gui assumes fixed 120px cells. That is fine for 4x4, but
// larger demo grids need to fit the current window. This script computes a
// CSS scale factor from the grid size and viewport; skin.css applies it.

(function () {
  "use strict";

  function number(v, fallback) {
    return Number.isFinite(v) ? v : fallback;
  }

  function config() {
    try {
      const el = document.getElementById("faces-config");
      return el ? JSON.parse(el.textContent) : {};
    } catch (_) {
      return {};
    }
  }

  function setScale() {
    const cfg = config();
    const rows = Math.max(1, number(cfg.numRows, 4));
    const cols = Math.max(1, number(cfg.numCols, 4));
    const col2 = document.getElementById("column2");
    const col3 = document.getElementById("column3");
    const podsVisible = col2 && getComputedStyle(col2).display !== "none";
    const keyVisible = col3 && getComputedStyle(col3).display !== "none";

    const gridW = cols * 128;
    const gridH = rows * 128;
    const sideW = (podsVisible ? 286 : 0) + (keyVisible ? Math.max(240, col3.offsetWidth || 260) : 0);
    const gaps = (podsVisible ? 16 : 0) + (keyVisible ? 16 : 0);
    const chromeH = 160;
    const availableW = Math.max(220, window.innerWidth - sideW - gaps - 80);
    const availableH = Math.max(180, window.innerHeight - chromeH);
    const scaleW = availableW / gridW;
    const scaleH = availableH / gridH;
    // Allow upscaling to 1.5× so grids fill large/HiDPI screens; cap to avoid
    // comically oversized cells on very large displays.
    const scale = Math.max(0.22, Math.min(1.5, scaleW, scaleH));

    document.documentElement.style.setProperty("--cell-scale", scale.toFixed(3));
    document.documentElement.style.setProperty("--grid-width", `${gridW}px`);
    document.documentElement.style.setProperty("--grid-height", `${gridH}px`);

    // Wrapper width is content-driven (fit-content in skin.css); --wrapper-max
    // is kept as a content-based fallback for faces.css's width formula.
    const scaledGridW = Math.round(gridW * scale);
    const wrapPad = 72; // approx 2 × 1.8em padding + small buffer
    document.documentElement.style.setProperty(
      "--wrapper-max",
      `${Math.max(420, scaledGridW + sideW + gaps + wrapPad)}px`
    );
  }

  function schedule() {
    requestAnimationFrame(setScale);
  }

  window.__updateFacesLayout__ = schedule;
  window.addEventListener("resize", schedule);
  window.addEventListener("load", schedule);

  new MutationObserver(schedule).observe(document.body, {
    attributes: true,
    childList: true,
    subtree: true,
    attributeFilter: ["style", "class"],
  });

  schedule();
})();

// theme.js — emoji rendering themes for faces-gui-mac-app.
//
// NOT part of the original faces-demo. Different platforms (Apple, Google,
// Microsoft, Twitter) draw the same emoji codepoint differently. This layer
// lets you preview those renderings by swapping each emoji glyph for the
// corresponding platform's image — without modifying the verbatim faces.js.
//
// Approach (the Twemoji pattern): a MutationObserver watches the grid / pods /
// legend containers; whenever faces.js writes an emoji glyph, we replace it with
// an <img> for the active theme. "native" disables the layer and lets the OS
// font render (on a Mac, that's Apple Color Emoji).
//
// SPDX-License-Identifier: Apache-2.0

(function () {
  "use strict";

  // theme id -> { dir, ext, cdn }. "native" => no images.
  // `cdn` (when present) is a codepoint-addressable fallback so the theme can
  // render ANY emoji the face service returns, not just the vendored set.
  const THEMES = {
    native: null,
    google: {
      dir: "emoji/google", ext: "png",
      cdn: (hex) => `https://cdn.jsdelivr.net/npm/emoji-datasource-google/img/google/64/${hex}.png`,
    },
    twitter: {
      dir: "emoji/twitter", ext: "png",
      cdn: (hex) => `https://cdn.jsdelivr.net/npm/emoji-datasource-twitter/img/twitter/64/${hex}.png`,
    },
    // Fluent isn't codepoint-addressable from any CDN, so only the vendored set
    // is themed; other emoji fall back to the native glyph.
    microsoft: { dir: "emoji/microsoft", ext: "svg", cdn: null },
  };

  const SELECTORS = ["#cells", "#pods", "#key", "#keyPopupBody"];

  let currentTheme = "native";
  let suppress = false;          // ignore mutations we cause ourselves
  let scheduled = false;
  let observer = null;
  const missing = new Set();     // "theme:cp" we know we have no art for (avoid loops)

  function isEmojiChar(ch) {
    try {
      return /\p{Extended_Pictographic}/u.test(ch);
    } catch (e) {
      // Fallback for engines without Unicode property escapes.
      const cp = ch.codePointAt(0);
      return cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf);
    }
  }

  // Build a fragment where emoji runs in `text` become <img> for the theme.
  function buildFragment(text, theme) {
    const frag = document.createDocumentFragment();
    let buf = "";
    const flush = () => {
      if (buf) {
        frag.appendChild(document.createTextNode(buf));
        buf = "";
      }
    };
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 0xfe0f || cp === 0x200d) continue; // variation selector / ZWJ
      if (isEmojiChar(ch)) {
        const hex = cp.toString(16);
        const key = currentTheme + ":" + hex;
        if (missing.has(key)) {
          buf += ch; // no art — keep the glyph
          continue;
        }
        flush();
        const img = document.createElement("img");
        img.className = "emoji-img";
        img.src = theme.dir + "/" + hex + "." + theme.ext; // local vendored first
        img.alt = ch;
        img.setAttribute("data-emoji", ch);
        img.dataset.stage = "local";
        img.draggable = false;
        img.onerror = function () {
          // Fallback chain: local vendored -> CDN (if any) -> native glyph.
          if (this.dataset.stage === "local" && theme.cdn) {
            this.dataset.stage = "cdn";
            this.src = theme.cdn(hex);
            return;
          }
          missing.add(key); // give up: render the native glyph instead
          const t = document.createTextNode(this.getAttribute("data-emoji") || "");
          if (this.parentNode) this.parentNode.replaceChild(t, this);
        };
        frag.appendChild(img);
      } else {
        buf += ch;
      }
    }
    flush();
    return frag;
  }

  function parseElement(root) {
    if (currentTheme === "native") return;
    const theme = THEMES[currentTheme];
    if (!theme) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const tn of nodes) {
      const text = tn.nodeValue;
      if (!text) continue;
      let hasEmoji = false;
      for (const ch of text) {
        if (isEmojiChar(ch)) {
          hasEmoji = true;
          break;
        }
      }
      if (!hasEmoji) continue;
      const frag = buildFragment(text, theme);
      if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
    }
  }

  function parseAll() {
    suppress = true;
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el) parseElement(el);
    }
    suppress = false;
  }

  function scheduleParse() {
    if (scheduled || currentTheme === "native") return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      parseAll();
    });
  }

  // Replace every themed <img> with its original glyph (used when switching
  // themes or back to native).
  function revertAll() {
    suppress = true;
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      el.querySelectorAll("img.emoji-img").forEach((img) => {
        const t = document.createTextNode(img.getAttribute("data-emoji") || img.alt || "");
        if (img.parentNode) img.parentNode.replaceChild(t, img);
      });
    }
    suppress = false;
  }

  function setupObserver() {
    observer = new MutationObserver(() => {
      if (suppress) return;
      scheduleParse();
    });
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        observer.observe(el, { childList: true, subtree: true, characterData: true });
      }
    }
  }

  // Exposed to Swift for live theme switching (no reload).
  window.__setEmojiTheme__ = function (name) {
    if (!(name in THEMES)) name = "native";
    if (name === currentTheme) return true;
    currentTheme = name;
    missing.clear();        // re-select always retries art (no permanent skips)
    revertAll();            // clear old imgs / glyphs
    if (name !== "native") scheduleParse();
    return true;
  };

  function init() {
    const settings = window.__FACES_SETTINGS__ || {};
    const t = settings.emojiTheme;
    if (t && t in THEMES) currentTheme = t;
    setupObserver();
    if (currentTheme !== "native") scheduleParse();
    console.log("[theme.js] emoji theme:", currentTheme);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

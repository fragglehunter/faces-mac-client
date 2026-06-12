# faces-gui-mac-app

A self-contained **native macOS app** (Apple Silicon) for demoing the
[faces-demo](../faces-demo-copy) project. It replicates the faces-gui web UI
as a native Swift app, runs its own built-in backend simulator, and can also
connect to a real deployed `face` endpoint with no cluster-side changes needed.

![the grid](web/logo-128.png)

---

## What it does

**Faces** visualizes the health of a microservice mesh in real time. The demo
drives a grid of cells — each cell polls the `face` service and displays the
returned emoji on a color background. Healthy services show a grinning face on
blue; chaos (errors, latency, rate limits, stuck faults) produces a variety of
failing faces, colors, and borders, matching the original demo's legend exactly.

### Two backends

| Mode | How |
|------|-----|
| **Built-in simulator** | A faithful JS port of the demo's backend — chaos engine, rate limits, latency, smiley/color services — all in-browser. Zero setup. |
| **Remote endpoint** | Point at a real `face` service (IP, host, or host:port). Requests are proxied natively in Swift (like the real GUI does server-side), so there's no CORS. |

Switch between them in **Settings → Connection**.

### Six visual modes

Select from the toolbar **Mode** dropdown or **Settings → Display**:

| Mode | Scene |
|------|-------|
| **Classic** | The original faces-gui grid of colored emoji tiles, pixel-faithful to the real demo. |
| **Buoyant** | Full-window sky landscape. Successful responses float across as hot-air balloons (envelope color = returned color, passenger = returned emoji). Slow responses walk the road below. Failures fall from the sky with smoke and a dust poof on landing. Click a balloon to pop it. |
| **Cavern** | Underground cave level. Explorers drop from a ceiling trapdoor, walk the upper platform, and either parachute (center cells) or hang-glide (edge cells) to the glowing exit door. Failures sail off the cliff edge and splat on the lower floor. |
| **Space** | Rocket launches from Earth to the Moon. Successful missions arc across the starfield; failures stall and fall back, spawning tumbling asteroids. Click a rocket to blast it. |
| **Claude** | A neural network (SYNAPSE) of 14 nodes in 4 columns. Face requests become glowing color orbs traveling the network. Failed signals fracture mid-path; stressed nodes heat from blue through amber to red; interference arcs fire at high error rates. Click a node to cascade a pulse through the network. |
| **Garden** | A garden scene where responses bloom as flowers. |

Every fun mode shows a **stats HUD** (bottom-right) with request counts, error
rates, and latency. A **Rate** slider controls how many events per second are
animated (independent of the real request rate). Click interactions track a
cumulative score with badge tiers.

### Admin window (Cmd+Shift+A)

A full reproduction of the **faces-admin** portal inside the app. Connects to a
deployed `faces-admin` server (point it at a port-forward or a real endpoint in
**Settings → Services → ADMIN**). All HTTP goes through a native Swift proxy
with a persistent in-memory session cookie — no CORS, no browser, just the app.

| Page | What you can do |
|------|-----------------|
| **Overview** | Live health cards for all services; per-pod topology with center/edge status |
| **Controls** | Set the default emoji and color returned by smiley/color services, per-pod |
| **Fault Injection** | Apply error fractions, latency, rate limits, and latch per service and per pod; run named chaos scenarios |
| **Settings** | Toggle classic/pubsub mode; edit service endpoints; manage maintenance windows |

Supports both classic and pub/sub pipeline modes. Auth-aware: shows a login
overlay on 401 and handles session cookies and Sign Out. Polling pauses when the
window is closed.

To test locally without a real cluster:
```bash
python3 tools/mock-admin-server.py --port 8899 [--auth] [--mode classic|pubsub]
# credentials: faces-admin / welovetosmile
```

### Other features

- **Emoji themes** — preview how emoji render on Apple (native), Google (Noto),
  Twitter (Twemoji), or Microsoft (Fluent). The full Smileys & Emotion set is
  vendored offline for Google and Twitter; arbitrary codepoints fall back to CDN
  then native glyph. Microsoft covers a curated set with native fallback.
- **Appearances** — System (follows macOS light/dark), Light, Dark, Buoyant
  gradient. Applies live without reloading the grid.
- **Network debug panel** — per-request status codes, latency, pod headers, and
  response bodies. Also available as a pop-out window from the Debug tab.
- **User pill** — click the toolbar pill to set the username sent as the
  `X-Faces-User` header.

---

## Build & run

Requires Apple Silicon + Xcode command-line tools:

```bash
./build-app.sh     # compiles Swift + assembles Faces.app
open Faces.app     # or double-click it
```

`./run.sh` builds if needed and launches. `./run.sh --rebuild` forces a clean
rebuild first.

> The app is ad-hoc code-signed. Because you built it locally (no quarantine),
> it opens without a Gatekeeper prompt. If macOS ever complains, right-click →
> Open once, or run `xattr -dr com.apple.quarantine Faces.app`.

---

## Settings (Cmd+,)

**Connection** — simulator vs. remote endpoint; endpoint entry with connection
status pill, normalized URL preview, and last-response metadata.

**Display** — grid size (rows/cols/edge), start active, legend, pods column,
request rate, visual mode, appearance, emoji theme, and Buoyant slow threshold.

**Simulator** — per-service chaos knobs (error %, latch %, max rate, delay) and
a default healthy smiley/color. Dimmed/disabled in remote mode. **Calm
Everything** (also Cmd+K) clears all faults instantly.

**Services** — Admin window endpoint and quick-launch button.

**Debug** — opens the network debug panel; shows last remote connection details.

---

## How simulator faults map to the grid

| Inject | What you see |
|--------|--------------|
| Smiley error | 🤬 cursing face, blue bg, purple border |
| Color error | 😃 grinning, grey bg, purple border |
| Face error | 😕 confused face, purple bg |
| Face latch | 😐 neutral face, yellow bg (sticky ~30s) |
| Face rate-limit | 😴 sleeping face, red bg |
| Any delay | cells fade ("slow service") |
| Calm | 😃 grinning face, blue bg — Success! |

---

## Project layout

```
faces-gui-mac-app/
├── build-app.sh          compile Swift + assemble Faces.app
├── run.sh                build if needed + launch
├── vendor-emoji.sh       (re)download vendored emoji art into web/emoji/
├── Sources/
│   ├── FacesApp.swift              @main: window scenes + Faces menu
│   ├── FacesConfig.swift           settings model + UserDefaults persistence
│   ├── WebController.swift         WKWebView: settings injection, face proxy, live updates
│   ├── AdminWindowController.swift Admin portal window + native HTTP proxy bridge
│   ├── SidebarView.swift           Settings sidebar navigation
│   └── SettingsView.swift          SwiftUI settings tabs
├── web/                  bundled into Faces.app/Contents/Resources/web/
│   ├── index.html              main page (faces.js + all scene scripts)
│   ├── faces.js / faces.css    copied from faces-demo (faces.css verbatim)
│   ├── sim.js                  built-in backend simulator + fake XHR
│   ├── admin.html/css/js       Admin portal SPA
│   ├── debug-window.html       pop-out network debug panel
│   ├── buoyant.js/css          Buoyant sky mode
│   ├── cavern.js/css           Cavern mode
│   ├── space.js/css            Space mode
│   ├── claude.js/css           SYNAPSE / Claude mode
│   ├── garden.js/css           Garden mode
│   ├── stats.js/css            shared fun-mode stats HUD
│   ├── skin.css                macOS-native chrome + appearances
│   ├── theme.js/css            emoji platform theming
│   ├── layout.js               responsive grid scaling
│   ├── toolbar.js              user pill + debug button
│   ├── debug.js                in-app network panel
│   ├── emoji/                  vendored art: google/ twitter/ microsoft/
│   └── *.png                   scene backgrounds (blue-sky, cave, space, garden)
└── tools/
    ├── mock-admin-server.py    dev mock for the Admin portal
    └── jscheck.sh              JS syntax check (via JavaScriptCore)
```

See [CLAUDE.md](CLAUDE.md) for the full architecture and session history, and
[BUOYANT-MODE.md](BUOYANT-MODE.md) for a guide to adding new visual modes.

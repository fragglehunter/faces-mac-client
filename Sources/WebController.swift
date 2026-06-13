// WebController — owns the WKWebView that renders the faces-gui UI.
//
// SPDX-License-Identifier: Apache-2.0

import Foundation
import SwiftUI
import WebKit

final class WebController: NSObject, ObservableObject,
    WKNavigationDelegate, WKScriptMessageHandlerWithReply, WKUIDelegate
{
    let webView: WKWebView
    @Published var connectionStatus: String     = "Not connected"
    @Published var connectionStatusKind: String = "idle"
    @Published var lastRemoteStatusCode: Int    = 0
    @Published var lastRemoteLatencyMs: Int     = 0
    @Published var lastRemoteURL: String        = ""

    private let config: FacesConfig
    private var reloadWorkItem: DispatchWorkItem?
    private var debugWindowController: DebugWindowController?
    private var settingsWindowController: SettingsWindowController?
    private var adminWindowController: AdminWindowController?
    private var dragMonitor: Any?

    init(config: FacesConfig) {
        self.config = config

        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        // Required so window.open() calls (debug pop-out) create a new WKWebView
        // that we can host in an NSPanel via the WKUIDelegate.
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = true

        self.webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()

        webView.navigationDelegate = self
        webView.uiDelegate        = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false

        // Message handlers (reply-variant for round-trip JS↔Swift calls).
        let handlers = ["faceProxy", "setUser", "setVisualMode", "setFunModeRate", "openDebugWindow", "openSettings"]
        for name in handlers {
            cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: name)
        }
        // Legacy name kept for buoyant.js compatibility.
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "setBuoyantRate")

        installUserScript()

        // AppKit resets titlebarAppearsTransparent in its own render cycle after the
        // window/app regains focus. asyncAfter(0.05) runs AFTER that cycle so our
        // settings win. Two events cover the two ways focus returns:
        //   didBecomeActiveNotification — user switches back from another app
        //   didBecomeKeyNotification    — window gains focus within the app
        for name in [NSApplication.didBecomeActiveNotification,
                     NSWindow.didBecomeKeyNotification] {
            NotificationCenter.default.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    self?.configureWindowAppearance()
                }
            }
        }

        installDragMonitor()
    }

    // MARK: - Resource location

    private var webDirURL: URL? {
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") {
            return url.deletingLastPathComponent()
        }
        let exeDir = Bundle.main.bundleURL.deletingLastPathComponent()
        let candidate = exeDir.appendingPathComponent("web/index.html")
        if FileManager.default.fileExists(atPath: candidate.path) {
            return candidate.deletingLastPathComponent()
        }
        return nil
    }

    private var indexURL: URL? { webDirURL?.appendingPathComponent("index.html") }

    // MARK: - Settings injection

    private func installUserScript() {
        let ucc = webView.configuration.userContentController
        ucc.removeAllUserScripts()
        let json = config.settingsJSON()
        ucc.addUserScript(WKUserScript(
            source: "window.__FACES_SETTINGS__ = \(json);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
    }

    // MARK: - Load / reload

    func load() {
        guard let index = indexURL, let dir = webDirURL else { loadErrorPage(); return }
        webView.loadFileURL(index, allowingReadAccessTo: dir)
    }

    // Re-applies every time it's called — safe to call repeatedly.
    func configureWindowAppearance() {
        guard let window = webView.window else { return }
        window.titlebarAppearsTransparent = true
        window.titleVisibility            = .hidden
        if !window.styleMask.contains(.fullSizeContentView) {
            window.styleMask.insert(.fullSizeContentView)
        }
        window.isMovableByWindowBackground = true
    }

    /// Make the colored top strip drag the window.
    ///
    /// The full-bleed WKWebView swallows mouse events, so `isMovableByWindowBackground`
    /// never fires over the web content, and CSS `-webkit-app-region: drag` is
    /// Electron-only (does nothing in WKWebView). A transparent overlay NSView also
    /// fails here: SwiftUI's hosting view keeps the WKWebView above anything we add to
    /// the content view, so the hit-test never reaches the overlay.
    ///
    /// Robust fix that doesn't depend on view z-ordering: a LOCAL event monitor sees
    /// every left-mouse-down BEFORE it's dispatched to the web view. When the press
    /// lands in the top title-bar strip (and clear of the traffic-light buttons), we
    /// kick off a native window drag and consume the event so the web view never sees
    /// it. `performDrag(with:)` is designed to be called synchronously in response to
    /// a mouse-down and runs its own drag-tracking loop.
    private func installDragMonitor() {
        guard dragMonitor == nil else { return }
        dragMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            guard let self,
                  let window = self.webView.window,
                  event.window === window,             // main window only — not Settings/Debug panels
                  let contentView = window.contentView
            else { return event }

            // Top strip height (px). Modern mode keeps this area empty; fun-mode
            // toolbars start at 42px, so 34 never overlaps an interactive control.
            let strip: CGFloat = 34
            let loc = event.locationInWindow         // base coords, origin bottom-left
            let nearTop  = loc.y >= contentView.bounds.height - strip
            let clearOfTrafficLights = loc.x > 82    // Close/Min/Zoom live at ~13–73px

            if nearTop && clearOfTrafficLights {
                window.performDrag(with: event)
                return nil                            // consume — keep it from the web view
            }
            return event
        }
    }

    func reloadWithSettings() {
        installUserScript()
        if config.connectionMode == ConnectionMode.remote.rawValue {
            setStatus("Connecting…", kind: "checking", code: 0, ms: 0, url: config.normalizedEndpoint())
        } else {
            setStatus("Using built-in simulator", kind: "simulator", code: 0, ms: 0, url: "")
        }
        load()
    }

    func scheduleReload() {
        reloadWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.reloadWithSettings() }
        reloadWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3, execute: item)
    }

    // MARK: - Live settings push (no reload)

    func pushLiveSettings() {
        let json = config.settingsJSON()
        let js = [
            "window.__applyFacesChaos__   && window.__applyFacesChaos__(\(json));",
            "window.__setEmojiTheme__     && window.__setEmojiTheme__('\(safe(config.emojiTheme))');",
            "window.__setAppearance__     && window.__setAppearance__('\(safe(config.appearance))');",
            "window.__setVisualMode__     && window.__setVisualMode__('\(safe(config.visualMode))');",
            "window.__applyBuoyantSettings__  && window.__applyBuoyantSettings__(\(json));",
            "window.__applyCavernSettings__   && window.__applyCavernSettings__(\(json));",
            "window.__applySpaceSettings__    && window.__applySpaceSettings__(\(json));",
            "window.__applyGardenSettings__   && window.__applyGardenSettings__(\(json));",
            "window.__applyClaudeSettings__   && window.__applyClaudeSettings__(\(json));",
            "window.__applyFireworksSettings__ && window.__applyFireworksSettings__(\(json));",
        ].joined(separator: "\n")
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func calm() {
        webView.evaluateJavaScript("window.__calmFaces__ && window.__calmFaces__();", completionHandler: nil)
    }

    func showDebugPanel() {
        openDebugWindow()  // always use native NSPanel — never blocks the scene view
    }

    func openSettings() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.settingsWindowController == nil {
                self.settingsWindowController = SettingsWindowController()
            }
            self.settingsWindowController?.toggle(config: self.config, webController: self)
        }
    }

    // Opens the faces-admin portal UI in its own window (separate WKWebView,
    // talks to config.adminEndpoint via the AdminWindowController's native proxy).
    func openAdminWindow() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.adminWindowController == nil {
                self.adminWindowController = AdminWindowController(config: self.config, webDirURL: self.webDirURL)
            }
            self.adminWindowController?.show()
        }
    }

    /// Push an admin-endpoint edit from Settings into an already-open Admin window.
    func pushAdminNativeSettings() {
        adminWindowController?.pushNativeSettings()
    }

    // Opens the debug data in a separate floating NSPanel.
    func openDebugWindow() {
        // Serialize current debug entries from the JS side, then open the window.
        webView.evaluateJavaScript(
            "(function(){ var d = window.__FACES_DEBUG__; return JSON.stringify(d ? d.entries : []); })()"
        ) { [weak self] result, _ in
            let json = (result as? String) ?? "[]"
            DispatchQueue.main.async {
                self?.showDebugWindowWith(json: json)
            }
        }
    }

    private func showDebugWindowWith(json: String) {
        if debugWindowController == nil {
            debugWindowController = DebugWindowController(webDirURL: webDirURL)
        }
        debugWindowController?.show(initialDataJSON: json, mainWebView: webView)
    }

    // MARK: - Connection test

    func testConnection() {
        let base = config.normalizedEndpoint()
        guard !base.isEmpty,
              let url = buildFaceURL(base: base, path: "center/",
                                     query: "row=0&col=0")
        else {
            setStatus("Enter a valid endpoint", kind: "error", code: 0, ms: 0, url: base)
            return
        }
        setStatus("Checking…", kind: "checking", code: 0, ms: 0, url: url.absoluteString)
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 8
        req.setValue("no-cache, no-store, max-age=0", forHTTPHeaderField: "Cache-Control")
        req.setValue(config.user, forHTTPHeaderField: "X-Faces-User")
        let started = Date()
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            if let err = err {
                self?.setStatus("Failed: \(err.localizedDescription)", kind: "error", code: 0, ms: ms, url: url.absoluteString)
                return
            }
            let code  = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let body  = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let looks = body.contains("smiley") || body.contains("color")
            if (200...299).contains(code) && looks {
                self?.setStatus("Connected", kind: "ok", code: code, ms: ms, url: url.absoluteString)
            } else {
                self?.setStatus("Unexpected response (HTTP \(code))", kind: "warning", code: code, ms: ms, url: url.absoluteString)
            }
        }.resume()
    }

    private func setStatus(_ text: String, kind: String, code: Int, ms: Int, url: String) {
        DispatchQueue.main.async {
            self.connectionStatus     = text
            self.connectionStatusKind = kind
            self.lastRemoteStatusCode = code
            self.lastRemoteLatencyMs  = ms
            self.lastRemoteURL        = url
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Every page load (including reloads triggered by settings changes) must
        // re-apply the transparent title bar — AppKit resets it on WKWebView redraws.
        configureWindowAppearance()
    }

    private func loadErrorPage() {
        let html = """
        <html><body style="font-family:-apple-system,sans-serif;padding:2em;">
        <h2>Could not find bundled web assets.</h2>
        <p>Expected <code>web/index.html</code> inside the app bundle Resources.</p>
        </body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    // MARK: - WKUIDelegate — window.open() support for debug pop-out

    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Allow the debug panel's window.open() to create a hosted pop-out.
        if debugWindowController == nil {
            debugWindowController = DebugWindowController(webDirURL: webDirURL)
        }
        return debugWindowController?.createWebView(configuration: configuration)
    }

    // MARK: - WKScriptMessageHandlerWithReply

    func userContentController(_ ucc: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void)
    {
        func reply(_ v: [String: Any]) { DispatchQueue.main.async { replyHandler(v, nil) } }

        switch message.name {

        case "setUser":
            if let body = message.body as? [String: Any] {
                let next = ((body["user"] as? String) ?? "unknown")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                config.user = next.isEmpty ? "unknown" : next
                config.save()
            }
            reply(["ok": true])

        case "setVisualMode":
            if let body = message.body as? [String: Any] {
                let next    = (body["visualMode"] as? String) ?? "classic"
                let allowed = ["classic", "legacy", "buoyant", "cavern", "space", "garden", "claude", "fireworks"]
                config.visualMode = allowed.contains(next) ? next : "classic"
                config.save()
            }
            reply(["ok": true])

        case "setFunModeRate", "setBuoyantRate":
            if let body = message.body as? [String: Any] {
                let raw = body["ratePerSec"]
                let n   = (raw as? Double) ?? Double((raw as? Int) ?? 1)
                config.funModeRatePerSec = min(20, max(0.5, n))
                config.save()
                // Reload so faces.js picks up the new effective paintIntervalMs.
                let mode = config.visualMode
                if mode != "classic" && mode != "legacy" { scheduleReload() }
            }
            reply(["ok": true])

        case "openDebugWindow":
            let json = (message.body as? String) ?? "[]"
            DispatchQueue.main.async { self.showDebugWindowWith(json: json) }
            reply(["ok": true])

        case "openSettings":
            openSettings()
            reply(["ok": true])

        case "faceProxy":
            guard let body = message.body as? [String: Any] else {
                reply(["error": "bad message"]); return
            }
            handleFaceProxy(body: body, reply: reply)

        default:
            reply(["error": "unknown handler: \(message.name)"])
        }
    }

    // MARK: - Remote face proxy

    private func handleFaceProxy(body: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        let path    = (body["path"]    as? String) ?? ""
        let query   = (body["query"]   as? String) ?? ""
        let headers = (body["headers"] as? [String: String]) ?? [:]

        let base = config.normalizedEndpoint()
        guard !base.isEmpty, let url = buildFaceURL(base: base, path: path, query: query) else {
            reply(["error": "no/invalid endpoint"]); return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 10
        req.setValue("no-cache, no-store, max-age=0", forHTTPHeaderField: "Cache-Control")
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }

        let started = Date()
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, err in
            let ms      = Int(Date().timeIntervalSince(started) * 1000)
            let http    = resp as? HTTPURLResponse
            let status  = http?.statusCode ?? 0
            let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let pod     = http?.value(forHTTPHeaderField: "X-Faces-Pod") ?? ""
            if let err = err {
                self?.setStatus("Connection failed: \(err.localizedDescription)",
                                kind: "error", code: 0, ms: ms, url: url.absoluteString)
                reply(["error": err.localizedDescription]); return
            }
            if (200...299).contains(status) {
                self?.setStatus("Connected", kind: "ok", code: status, ms: ms, url: url.absoluteString)
            } else {
                self?.setStatus("HTTP \(status)", kind: "warning", code: status, ms: ms, url: url.absoluteString)
            }
            reply(["status": status, "body": bodyStr, "pod": pod])
        }.resume()
    }

    private func buildFaceURL(base: String, path: String, query: String) -> URL? {
        var s = base + "/" + path
        if !query.isEmpty { s += "?" + query }
        if let u = URL(string: s) { return u }
        let enc = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        return URL(string: base + "/" + path + (query.isEmpty ? "" : "?" + enc))
    }

    private func safe(_ s: String) -> String {
        s.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
    }
}

// MARK: - Debug window controller

final class DebugWindowController: NSObject, WKNavigationDelegate {
    private var panel: NSPanel?
    private var debugWebView: WKWebView?
    private let webDirURL: URL?
    private var refreshTimer: Timer?

    init(webDirURL: URL?) {
        self.webDirURL = webDirURL
        super.init()
    }

    /// Called by WKUIDelegate to host window.open() in a panel.
    func createWebView(configuration: WKWebViewConfiguration) -> WKWebView {
        let wv = WKWebView(frame: .zero, configuration: configuration)
        wv.navigationDelegate = self
        setup(webView: wv)
        return wv
    }

    /// Called from Swift side (menu / button) with serialized data.
    func show(initialDataJSON: String, mainWebView: WKWebView) {
        if debugWebView == nil {
            let cfg = WKWebViewConfiguration()
            cfg.defaultWebpagePreferences.allowsContentJavaScript = true
            if let dir = webDirURL {
                cfg.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
                let wv = WKWebView(frame: .zero, configuration: cfg)
                wv.navigationDelegate = self
                debugWebView = wv
                if let indexURL = dir.appendingPathComponent("debug-window.html") as URL?,
                   FileManager.default.fileExists(atPath: indexURL.path) {
                    wv.loadFileURL(indexURL, allowingReadAccessTo: dir)
                }
            }
        }
        setup(webView: debugWebView!)
        pushData(json: initialDataJSON)
        startRefresh(source: mainWebView)
    }

    private func setup(webView: WKWebView) {
        debugWebView = webView

        if panel == nil {
            let p = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 960, height: 640),
                styleMask: [.titled, .closable, .resizable, .miniaturizable, .utilityWindow],
                backing: .buffered,
                defer: false)
            p.title = "Faces Debug"
            p.contentView = webView
            p.isReleasedWhenClosed = false
            p.center()
            panel = p
        } else {
            panel?.contentView = webView
        }
        panel?.orderFront(nil)
    }

    private func pushData(json: String) {
        // Pass json as a named argument so WKWebView handles all escaping.
        debugWebView?.callAsyncJavaScript(
            "if (window.__refresh__) window.__refresh__(json)",
            arguments: ["json": json],
            in: nil,
            in: .page,
            completionHandler: nil)
    }

    private func startRefresh(source: WKWebView) {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self, weak source] _ in
            guard let self, let src = source else { return }
            src.evaluateJavaScript(
                "(function(){ var d=window.__FACES_DEBUG__; return JSON.stringify(d?d.entries:[]); })()"
            ) { result, _ in
                if let json = result as? String {
                    DispatchQueue.main.async { self.pushData(json: json) }
                }
            }
        }
    }

    deinit { refreshTimer?.invalidate() }
}

// MARK: - Settings window controller

final class SettingsWindowController: NSObject {
    private var panel: NSPanel?

    /// Toggle the settings panel open/closed.
    func toggle(config: FacesConfig, webController: WebController) {
        if let p = panel, p.isVisible {
            p.close()
        } else {
            show(config: config, webController: webController)
        }
    }

    private func show(config: FacesConfig, webController: WebController) {
        if panel == nil {
            let view = SidebarView(config: config, controller: webController)
            let hc = NSHostingController(rootView: view)
            // preferredContentSize MUST be set before assigning as contentViewController.
            // macOS overrides the NSPanel contentRect to fit the view controller's preferred
            // size at assignment time, so setting it afterwards (or relying on contentRect
            // alone) results in the panel collapsing to a tiny strip.
            hc.preferredContentSize = NSSize(width: 580, height: 720)
            let p = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 580, height: 720),
                styleMask: [.titled, .closable, .resizable, .utilityWindow],
                backing: .buffered,
                defer: false)
            p.title = "Settings"
            p.contentViewController = hc
            p.isReleasedWhenClosed = false
            p.minSize = NSSize(width: 460, height: 500)
            p.maxSize = NSSize(width: 900, height: 1400)
            p.center()
            panel = p
        }
        // makeKeyAndOrderFront (not orderFront) so SwiftUI controls receive
        // focus immediately — without this, buttons render in the inactive/
        // unfocused state and require an extra click to engage.
        panel?.makeKeyAndOrderFront(nil)
    }
}

// MARK: - SwiftUI WebView wrapper

struct WebView: NSViewRepresentable {
    let controller: WebController
    func makeNSView(context: Context) -> WKWebView {
        controller.load()
        // First-shot: configure as soon as the view lands in the window hierarchy.
        // didFinish + didBecomeKey observers keep it applied through reloads/focus cycles.
        DispatchQueue.main.async { controller.configureWindowAppearance() }
        return controller.webView
    }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}

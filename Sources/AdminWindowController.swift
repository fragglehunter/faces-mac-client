// AdminWindowController — owns the standalone Admin window (a WKWebView that
// renders web/admin.html, the faces-admin portal UI) and bridges its HTTP calls
// to the configured admin endpoint via a native URLSession proxy.
//
// The bridge mirrors WebController's faceProxy pattern (avoids CORS, mirrors how
// the real gui proxies). It uses an ephemeral URLSession so the faces-admin
// session cookie is held in-memory for the app run, and a no-redirect delegate so
// the /api/logout 303 surfaces to JS instead of being followed.
//
// SPDX-License-Identifier: Apache-2.0

import AppKit
import Foundation
import WebKit

final class AdminWindowController: NSObject,
    WKNavigationDelegate, WKScriptMessageHandlerWithReply, URLSessionTaskDelegate
{
    private let config: FacesConfig
    private let webDirURL: URL?
    private var window: NSWindow?
    private var adminWebView: WKWebView?

    // Ephemeral so the faces-admin-session cookie lives only for this app run
    // (it dies on pod restart anyway), and so admin traffic never touches the
    // shared URLCache. .always cookie policy keeps Set-Cookie from being dropped.
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        cfg.timeoutIntervalForRequest = 15
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    }()

    init(config: FacesConfig, webDirURL: URL?) {
        self.config = config
        self.webDirURL = webDirURL
        super.init()
    }

    // MARK: - Show / lifecycle

    func show() {
        if adminWebView == nil { buildWebView() }
        if window == nil { buildWindow() }
        window?.makeKeyAndOrderFront(nil)
        // Resume polling (paused on close to avoid hammering /api/infrastructure,
        // which pings every pod, after the window is dismissed).
        adminWebView?.evaluateJavaScript("window.__adminSetActive__ && __adminSetActive__(true)", completionHandler: nil)
    }

    /// Push a live endpoint/credentials change from Settings into an open window.
    func pushNativeSettings() {
        guard let wv = adminWebView else { return }
        let dict: [String: Any] = [
            "endpoint": config.normalizedAdminEndpoint(),
            "username": config.adminUsername,
            "password": config.adminPassword,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return }
        wv.evaluateJavaScript("window.__adminApplyNativeSettings__ && __adminApplyNativeSettings__(\(json))", completionHandler: nil)
    }

    private func buildWebView() {
        let cfg = WKWebViewConfiguration()
        cfg.defaultWebpagePreferences.allowsContentJavaScript = true
        cfg.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")

        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "adminProxy")
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "setAdminPrefs")
        cfg.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "adminSaveFile")
        installUserScript(into: cfg.userContentController)

        let wv = WKWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = self
        adminWebView = wv

        if let dir = webDirURL {
            let indexURL = dir.appendingPathComponent("admin.html")
            if FileManager.default.fileExists(atPath: indexURL.path) {
                wv.loadFileURL(indexURL, allowingReadAccessTo: dir)
            } else {
                loadMissingAssetsPage(into: wv)
            }
        } else {
            loadMissingAssetsPage(into: wv)
        }
    }

    private func buildWindow() {
        // Size to 88% of the available screen with no hard upper cap so the
        // window fills large displays properly (14" laptop → ~1160×820;
        // 27" 4K → ~2250×1260; 34" ultrawide → ~3030×1260).
        let screenFrame = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let ww = max(1100, Int(screenFrame.width  * 0.88))
        let wh = max(700,  Int(screenFrame.height * 0.88))

        // Scale the web content so text and cards stay comfortably readable on
        // large displays. 1600 CSS pt is the "1× baseline"; anything wider gets
        // proportionally bigger up to 2×. Clamp min to 1 so small screens are
        // never shrunk.
        let zoom = min(2.0, max(1.0, Double(screenFrame.width) / 1600.0))
        adminWebView?.pageZoom = zoom
        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: CGFloat(ww), height: CGFloat(wh)),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        w.title = "Faces Admin"
        w.minSize = NSSize(width: 980, height: 640)
        w.isReleasedWhenClosed = false   // reuse the controller's singleton webview
        w.contentView = adminWebView
        w.center()
        window = w

        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: w, queue: .main
        ) { [weak self] _ in
            self?.adminWebView?.evaluateJavaScript(
                "window.__adminSetActive__ && __adminSetActive__(false)", completionHandler: nil)
        }
    }

    private func installUserScript(into ucc: WKUserContentController) {
        ucc.removeAllUserScripts()
        let dict: [String: Any] = [
            "endpoint": config.normalizedAdminEndpoint(),
            "theme": config.adminTheme,
            "sidebarCollapsed": config.adminSidebarCollapsed,
            "showDebugPage": config.adminShowDebugPage,
            "username": config.adminUsername,
            "password": config.adminPassword,
            "app": "faces-gui-mac-app",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let json = String(data: data, encoding: .utf8) else { return }
        ucc.addUserScript(WKUserScript(
            source: "window.__ADMIN_SETTINGS__ = \(json);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
    }

    private func loadMissingAssetsPage(into wv: WKWebView) {
        wv.loadHTMLString("""
        <html><body style="font-family:-apple-system,sans-serif;padding:2em;background:#13131f;color:#e8e8f2;">
        <h2>Could not find bundled admin assets.</h2>
        <p>Expected <code>web/admin.html</code> inside the app bundle Resources.</p>
        </body></html>
        """, baseURL: nil)
    }

    // MARK: - WKScriptMessageHandlerWithReply

    func userContentController(_ ucc: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void)
    {
        func reply(_ v: [String: Any]) { DispatchQueue.main.async { replyHandler(v, nil) } }

        switch message.name {
        case "adminProxy":
            guard let body = message.body as? [String: Any] else { reply(["status": 0, "error": "bad message"]); return }
            handleAdminProxy(body: body, reply: reply)

        case "setAdminPrefs":
            if let body = message.body as? [String: Any] {
                if let ep = body["endpoint"] as? String { config.adminEndpoint = ep }
                if let th = body["theme"] as? String { config.adminTheme = th }
                if let sc = body["sidebarCollapsed"] as? Bool { config.adminSidebarCollapsed = sc }
                if let sd = body["showDebugPage"] as? Bool { config.adminShowDebugPage = sd }
                config.save()
                installUserScript(into: ucc)   // keep next reload current
            }
            reply(["ok": true, "endpoint": config.normalizedAdminEndpoint()])

        case "adminSaveFile":
            guard let body = message.body as? [String: Any],
                  let content = body["content"] as? String else {
                reply(["ok": false, "error": "bad message"]); return
            }
            let filename = (body["filename"] as? String).flatMap {
                $0.isEmpty ? nil : ($0 as NSString).lastPathComponent   // no path smuggling
            } ?? "faces-admin.har"
            DispatchQueue.main.async {
                let panel = NSSavePanel()
                panel.nameFieldStringValue = filename
                panel.canCreateDirectories = true
                panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
                if panel.runModal() == .OK, let url = panel.url {
                    do {
                        try content.write(to: url, atomically: true, encoding: .utf8)
                        reply(["ok": true, "path": url.path])
                    } catch {
                        reply(["ok": false, "error": error.localizedDescription])
                    }
                } else {
                    reply(["ok": false, "error": "cancelled"])
                }
            }

        default:
            reply(["status": 0, "error": "unknown handler: \(message.name)"])
        }
    }

    // MARK: - Admin HTTP proxy

    private static let allowedMethods: Set<String> = ["GET", "PUT", "POST"]

    private func handleAdminProxy(body: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        let method = (body["method"] as? String ?? "GET").uppercased()
        let path = (body["path"] as? String) ?? ""
        let bodyStr = body["body"] as? String
        let binary = (body["binary"] as? Bool) ?? false
        let timeoutMs = (body["timeoutMs"] as? Int) ?? 12000

        guard AdminWindowController.allowedMethods.contains(method) else {
            reply(["status": 0, "error": "method not allowed"]); return
        }
        // Path must be server-absolute and must not smuggle a scheme or traversal.
        guard path.hasPrefix("/"), !path.contains(".."),
              !path.lowercased().hasPrefix("//"), !path.contains("://") else {
            reply(["status": 0, "error": "bad path"]); return
        }
        let base = config.normalizedAdminEndpoint()
        guard !base.isEmpty, let url = URL(string: base + path) else {
            reply(["status": 0, "error": "no endpoint"]); return
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = min(Double(timeoutMs) / 1000.0, 20)
        req.setValue("no-cache, no-store, max-age=0", forHTTPHeaderField: "Cache-Control")
        if let bodyStr = bodyStr, !bodyStr.isEmpty {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = Data(bodyStr.utf8)
        }

        session.dataTask(with: req) { data, resp, err in
            if let err = err { reply(["status": 0, "error": err.localizedDescription]); return }
            let http = resp as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            // Response headers ride along for the Debug page's HAR export.
            var headers: [String: String] = [:]
            for (k, v) in http?.allHeaderFields ?? [:] {
                headers[String(describing: k)] = String(describing: v)
            }
            if binary {
                let b64 = data?.base64EncodedString() ?? ""
                let ctype = http?.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream"
                reply(["status": status, "bodyBase64": b64, "contentType": ctype, "headers": headers])
            } else {
                let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                reply(["status": status, "body": bodyStr, "headers": headers])
            }
        }.resume()
    }

    // MARK: - URLSessionTaskDelegate

    // Do NOT follow redirects: the admin's /api/logout replies 303 → /login and
    // the auth middleware 303s unauthenticated navigations. The SPA needs to see
    // the literal 3xx (it's a file:// app, there is no /login page to land on).
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// FacesConfig — settings model for faces-gui-mac-app.
//
// SPDX-License-Identifier: Apache-2.0

import Foundation
import Combine

struct ServiceChaos: Codable, Equatable {
    var errorFraction: Int = 0
    var latchFraction: Int = 0
    var maxRate: Double = 0
    var delayMs: Int = 0

    func asDict() -> [String: Any] {
        ["errorFraction": errorFraction, "latchFraction": latchFraction,
         "maxRate": maxRate, "delayMs": delayMs]
    }
}

enum FacesData {
    static let smileyNames = [
        "Grinning", "Sleeping", "Cursing", "Kaboom", "HeartEyes",
        "Neutral", "RollingEyes", "Screaming", "Vomiting",
    ]
    static let colorNames = [
        "blue", "green", "yellow", "red", "purple",
        "darkblue", "grey", "black", "white",
    ]
    static let emojiThemes: [(id: String, label: String)] = [
        ("native",    "Native (Apple)"),
        ("google",    "Google (Noto)"),
        ("twitter",   "Twitter (Twemoji)"),
        ("microsoft", "Microsoft (Fluent)"),
    ]
    static let appearances: [(id: String, label: String)] = [
        ("system",   "System (light/dark)"),
        ("light",    "Light"),
        ("dark",     "Dark"),
        ("gradient", "Gradient"),
    ]
    static let modes: [(id: String, label: String, icon: String)] = [
        ("legacy",  "Legacy",  "clock.arrow.circlepath"),
        ("classic", "Modern",  "square.grid.3x3"),
        ("buoyant", "Buoyant", "cloud.sun"),
        ("space",   "Space",   "star"),
        ("cavern",  "Cavern",  "mountain.2"),
        ("garden",  "Garden",  "leaf"),
        ("claude",  "Claude",  "brain"),
        ("fireworks", "Fireworks", "sparkles"),
        ("snake",   "Snake Duel",      "gamecontroller"),
        ("derby",   "Grand Prix", "flag.checkered"),
    ]
}

enum ConnectionMode: String {
    case simulator
    case remote
}

final class FacesConfig: ObservableObject {
    // MARK: Connection
    @Published var connectionMode: String = ConnectionMode.simulator.rawValue
    @Published var endpoint: String = ""

    // MARK: Admin window (faces-admin portal — independent of the GUI endpoint)
    @Published var adminEndpoint: String = ""
    @Published var adminTheme: String = "dark"
    @Published var adminSidebarCollapsed: Bool = false
    // Optional auto-sign-in credentials. Stored in UserDefaults (demo creds, not
    // secrets-grade storage); when set, the Admin window signs in on 401 without
    // showing the login overlay.
    @Published var adminUsername: String = ""
    @Published var adminPassword: String = ""
    @Published var adminShowDebugPage: Bool = false

    // MARK: GUI layout
    @Published var numRows: Int = 4
    @Published var numCols: Int = 4
    @Published var edgeSize: Int = 1
    @Published var startActive: Bool = true
    @Published var hideKey: Bool = true
    @Published var showPods: Bool = false
    /// Grid modes (legacy/classic): keep each cell's last face on screen until a
    /// new response replaces it, instead of fading out by age.
    @Published var persistFaces: Bool = true
    /// Grid modes (legacy/classic): briefly pulse a cell when it repaints, so updates are easy to spot.
    @Published var cellPulse: Bool = true
    @Published var user: String = "unknown"
    /// Toolbar buttons that are also reachable from the macOS menu bar, so they
    /// can be hidden from the in-web toolbar to declutter it.
    @Published var showDebugButton: Bool = true
    @Published var showSettingsButton: Bool = true

    // MARK: Rates
    /// Per-cell poll interval in ms. Total req/s ≈ (rows×cols×1000)/paintIntervalMs.
    @Published var paintIntervalMs: Int = 2000
    /// Max events/sec admitted to any fun mode scene. Stored as Double for sub-1/s support.
    @Published var funModeRatePerSec: Double = 0.5
    /// "Super mode" lifts the fun-mode rate ceiling from 20/s to 200/s.
    @Published var superMode: Bool = false

    /// Upper bound for funModeRatePerSec given the current mode.
    var funRateCap: Double { superMode ? 200 : 20 }

    // MARK: Visual / appearance
    @Published var emojiTheme: String = "native"
    @Published var appearance: String = "system"
    @Published var visualMode: String = "classic"
    @Published var slowThresholdMs: Int = 300

    // MARK: Crash reporting
    @Published var crashReportingEnabled: Bool = true

    // MARK: Simulator backend
    @Published var defaultSmiley: String = "Grinning"
    @Published var defaultColor: String = "blue"
    @Published var face: ServiceChaos = ServiceChaos()
    @Published var smiley: ServiceChaos = ServiceChaos()
    @Published var color: ServiceChaos = ServiceChaos()

    private let defaultsKey = "facesConfig.v2"

    init() { load() }

    // MARK: - Serialization for JS

    func settingsDict() -> [String: Any] {
        // In fun modes, derive the actual poll interval from funModeRatePerSec so the
        // request rate matches what the slider shows (balloons/rockets/etc. per second).
        let isFunMode = !["legacy", "classic"].contains(visualMode)
        let effectivePaintIntervalMs: Int
        if isFunMode {
            let cells = max(1, numRows * numCols)
            effectivePaintIntervalMs = max(50, Int((Double(cells) * 1000.0 / max(0.5, funModeRatePerSec)).rounded()))
        } else {
            effectivePaintIntervalMs = paintIntervalMs
        }
        return [
            "connectionMode":    connectionMode,
            "endpoint":          endpoint,
            "numRows":           numRows,
            "numCols":           numCols,
            "edgeSize":          edgeSize,
            "startActive":       startActive,
            "hideKey":           hideKey,
            "showPods":          showPods,
            "persistFaces":      persistFaces,
            "cellPulse":         cellPulse,
            "paintIntervalMs":   effectivePaintIntervalMs,
            "user":              user,
            "showDebugButton":    showDebugButton,
            "showSettingsButton": showSettingsButton,
            "userHeader":        "X-Faces-User",
            "userAgent":         "faces-gui-mac-app",
            "emojiTheme":        emojiTheme,
            "appearance":        appearance,
            "visualMode":        visualMode,
            "slowThresholdMs":   slowThresholdMs,
            "funModeRatePerSec": funModeRatePerSec,
            "superMode":         superMode,
            // Legacy alias — buoyant.js still reads buoyantRatePerSec
            "buoyantRatePerSec": funModeRatePerSec,
            "defaultSmiley":     defaultSmiley,
            "defaultColor":      defaultColor,
            "services": [
                "face":   face.asDict(),
                "smiley": smiley.asDict(),
                "color":  color.asDict(),
            ],
        ]
    }

    func settingsJSON() -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: settingsDict()),
              let str  = String(data: data, encoding: .utf8) else { return "{}" }
        return str
    }

    // MARK: - Persistence

    private struct Persisted: Codable {
        var connectionMode: String?
        var endpoint: String?
        var adminEndpoint: String?
        var adminTheme: String?
        var adminSidebarCollapsed: Bool?
        var adminUsername: String?
        var adminPassword: String?
        var adminShowDebugPage: Bool?
        var numRows: Int
        var numCols: Int
        var edgeSize: Int
        var startActive: Bool
        var hideKey: Bool
        var showPods: Bool
        var persistFaces: Bool?
        var cellPulse: Bool?
        var paintIntervalMs: Int?
        var user: String
        var showDebugButton: Bool?
        var showSettingsButton: Bool?
        var emojiTheme: String?
        var appearance: String?
        var visualMode: String?
        var slowThresholdMs: Int?
        // Supports both old Int and new Double via Double? decode
        var funModeRatePerSec: Double?
        var buoyantRatePerSec: Int?   // legacy — migrated on load
        var superMode: Bool?
        var crashReportingEnabled: Bool?
        var defaultSmiley: String
        var defaultColor: String
        var face: ServiceChaos
        var smiley: ServiceChaos
        var color: ServiceChaos
    }

    func save() {
        let p = Persisted(
            connectionMode: connectionMode, endpoint: endpoint,
            adminEndpoint: adminEndpoint, adminTheme: adminTheme,
            adminSidebarCollapsed: adminSidebarCollapsed,
            adminUsername: adminUsername, adminPassword: adminPassword,
            adminShowDebugPage: adminShowDebugPage,
            numRows: numRows, numCols: numCols, edgeSize: edgeSize,
            startActive: startActive, hideKey: hideKey, showPods: showPods,
            persistFaces: persistFaces, cellPulse: cellPulse,
            paintIntervalMs: paintIntervalMs, user: user,
            showDebugButton: showDebugButton, showSettingsButton: showSettingsButton,
            emojiTheme: emojiTheme, appearance: appearance,
            visualMode: visualMode, slowThresholdMs: slowThresholdMs,
            funModeRatePerSec: funModeRatePerSec, buoyantRatePerSec: nil,
            superMode: superMode,
            crashReportingEnabled: crashReportingEnabled,
            defaultSmiley: defaultSmiley, defaultColor: defaultColor,
            face: face, smiley: smiley, color: color
        )
        if let data = try? JSONEncoder().encode(p) {
            UserDefaults.standard.set(data, forKey: defaultsKey)
        }
        // Also save to old key so old builds still work
        UserDefaults.standard.set(data(forKey: defaultsKey), forKey: "facesConfig.v1")
    }

    private func data(forKey key: String) -> Data? {
        UserDefaults.standard.data(forKey: key)
    }

    func load() {
        // Try v2 first, then fall back to v1
        let raw = UserDefaults.standard.data(forKey: defaultsKey)
            ?? UserDefaults.standard.data(forKey: "facesConfig.v1")
        guard let raw, let p = try? JSONDecoder().decode(Persisted.self, from: raw) else { return }
        connectionMode = p.connectionMode ?? ConnectionMode.simulator.rawValue
        endpoint       = p.endpoint ?? ""
        adminEndpoint  = p.adminEndpoint ?? ""
        adminTheme     = p.adminTheme ?? "dark"
        adminSidebarCollapsed = p.adminSidebarCollapsed ?? false
        adminUsername  = p.adminUsername ?? ""
        adminPassword  = p.adminPassword ?? ""
        adminShowDebugPage = p.adminShowDebugPage ?? false
        numRows        = p.numRows
        numCols        = p.numCols
        edgeSize       = p.edgeSize
        startActive    = p.startActive
        hideKey        = p.hideKey
        showPods       = p.showPods
        persistFaces   = p.persistFaces ?? true
        cellPulse      = p.cellPulse ?? true
        paintIntervalMs = p.paintIntervalMs ?? 2000
        user           = p.user
        showDebugButton    = p.showDebugButton ?? true
        showSettingsButton = p.showSettingsButton ?? true
        emojiTheme     = p.emojiTheme ?? "native"
        appearance     = p.appearance ?? "system"
        visualMode     = p.visualMode ?? "classic"
        slowThresholdMs = p.slowThresholdMs ?? 300
        superMode      = p.superMode ?? false
        // Migrate legacy Int buoyantRatePerSec to funModeRatePerSec Double.
        // Clamp to the current cap (20, or 200 in super mode) so saved values
        // can't exceed what's allowed for the active mode.
        if let r = p.funModeRatePerSec { funModeRatePerSec = min(funRateCap, max(0.5, r)) }
        else if let r = p.buoyantRatePerSec { funModeRatePerSec = min(funRateCap, max(0.5, Double(r))) }
        crashReportingEnabled = p.crashReportingEnabled ?? true
        defaultSmiley  = p.defaultSmiley
        defaultColor   = p.defaultColor
        face           = p.face
        smiley         = p.smiley
        color          = p.color
    }

    func normalizedEndpoint() -> String {
        var e = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        if e.isEmpty { return "" }
        if !e.hasPrefix("http://") && !e.hasPrefix("https://") { e = "http://" + e }
        while e.hasSuffix("/") { e.removeLast() }
        return e
    }

    func normalizedAdminEndpoint() -> String {
        var e = adminEndpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        if e.isEmpty { return "" }
        if !e.hasPrefix("http://") && !e.hasPrefix("https://") { e = "http://" + e }
        while e.hasSuffix("/") { e.removeLast() }
        return e
    }

    func resetChaos() {
        face   = ServiceChaos()
        smiley = ServiceChaos()
        color  = ServiceChaos()
        save()
    }

    func resetAll() {
        connectionMode   = ConnectionMode.simulator.rawValue
        endpoint         = ""
        adminEndpoint    = ""
        adminTheme       = "dark"
        adminSidebarCollapsed = false
        adminUsername    = ""
        adminPassword    = ""
        adminShowDebugPage = false
        numRows = 4; numCols = 4; edgeSize = 1
        startActive = true; hideKey = true; showPods = false
        persistFaces = true
        cellPulse = true
        paintIntervalMs  = 2000
        user             = "unknown"
        showDebugButton    = true
        showSettingsButton = true
        emojiTheme       = "native"
        appearance       = "system"
        visualMode       = "classic"
        slowThresholdMs  = 300
        funModeRatePerSec = 0.5
        superMode        = false
        crashReportingEnabled = true
        defaultSmiley    = "Grinning"
        defaultColor     = "blue"
        resetChaos()
    }
}

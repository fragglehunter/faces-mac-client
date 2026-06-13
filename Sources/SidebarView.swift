// SidebarView — Settings popup for faces-gui-mac-app.
//
// Four-tab layout: Visual · Grid · Services · Advanced
// Hosted in a floating NSPanel (SettingsWindowController in WebController.swift).
//
// SPDX-License-Identifier: Apache-2.0

import SwiftUI

struct SidebarView: View {
    @ObservedObject var config: FacesConfig
    let controller: WebController

    var body: some View {
        TabView {
            VisualTab(config: config, controller: controller)
                .tabItem { Label("Visual",   systemImage: "sparkles") }
            GridTab(config: config, controller: controller)
                .tabItem { Label("Grid",     systemImage: "grid") }
            ServicesTab(config: config, controller: controller)
                .tabItem { Label("Services", systemImage: "network") }
            AdvancedTab(config: config, controller: controller)
                .tabItem { Label("Advanced", systemImage: "gearshape") }
        }
        .frame(minWidth: 460, maxWidth: .infinity, minHeight: 500, maxHeight: .infinity)
    }
}

// MARK: - Section header

private struct TabSectionHeader: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundColor(.secondary)
    }
}

// MARK: - Visual tab

private struct VisualTab: View {
    @ObservedObject var config: FacesConfig
    let controller: WebController

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {

                VStack(alignment: .leading, spacing: 12) {
                    TabSectionHeader("VISUALIZATION MODE")
                    LazyVGrid(
                        columns: Array(repeating: GridItem(.flexible()), count: 3),
                        spacing: 10
                    ) {
                        ForEach(FacesData.modes, id: \.id) { mode in
                            ModeButton(mode: mode, isSelected: config.visualMode == mode.id) {
                                config.visualMode = mode.id
                                config.save()
                                controller.pushLiveSettings()
                            }
                        }
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 14) {
                    TabSectionHeader("APPEARANCE")
                    PickerRow(title: "Theme", selection: $config.appearance) {
                        ForEach(FacesData.appearances, id: \.id) { Text($0.label).tag($0.id) }
                    }
                    .help("Visual theme for the app chrome. System follows macOS light/dark mode.")

                    PickerRow(title: "Emoji style", selection: $config.emojiTheme) {
                        ForEach(FacesData.emojiThemes, id: \.id) { Text($0.label).tag($0.id) }
                    }
                    .help("Preview how emoji render on other platforms. Native uses this Mac's Apple font.")
                }

                Spacer(minLength: 0)
            }
            .padding(20)
        }
        .onChange(of: config.emojiTheme) { _ in live() }
        .onChange(of: config.appearance) { _ in live() }
    }

    private func live() { config.save(); controller.pushLiveSettings() }
}

// MARK: - Grid tab

private struct GridTab: View {
    @ObservedObject var config: FacesConfig
    let controller: WebController

    private var isClassic: Bool  { config.visualMode == "classic" }
    private var isLegacy:  Bool  { config.visualMode == "legacy"  }
    private var isFunMode: Bool  { !isClassic && !isLegacy        }

    private var reqPerSec: Double {
        let cells = max(1, config.numRows * config.numCols)
        return Double(cells) * 1000.0 / Double(max(1, config.paintIntervalMs))
    }

    private var reqLabel: String {
        let rps = reqPerSec
        if rps >= 100 { return String(format: "%.0f req/s", rps) }
        if rps >= 10  { return String(format: "%.1f req/s", rps) }
        return String(format: "%.2f req/s", rps)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {

                if isClassic || isLegacy {
                    VStack(alignment: .leading, spacing: 14) {
                        TabSectionHeader("GRID SIZE")
                        HStack(alignment: .top, spacing: 20) {
                            MiniGridPicker(rows: $config.numRows, cols: $config.numCols)
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(config.numRows) × \(config.numCols)")
                                    .font(.system(size: 24, weight: .semibold).monospacedDigit())
                                Text("Interior cells → /center")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                Text("Edge ring (1 cell) → /edge")
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                            }
                            .padding(.top, 4)
                        }
                        .help("Click a cell to set grid size. Edge cells call the edge endpoint; interior cells call center.")
                    }

                    Divider()

                    VStack(alignment: .leading, spacing: 12) {
                        TabSectionHeader("DISPLAY OPTIONS")
                        HStack(spacing: 6) {
                            Text("Edge ring")
                                .font(.system(size: 13))
                                .frame(width: 110, alignment: .leading)
                            Stepper(
                                value: $config.edgeSize,
                                in: 1...max(1, min(config.numRows, config.numCols) / 2)
                            ) {
                                Text("\(config.edgeSize) cell\(config.edgeSize == 1 ? "" : "s") thick")
                                    .font(.system(size: 13).monospacedDigit())
                                    .foregroundColor(.secondary)
                            }
                        }
                        .help("Thickness of the edge ring. Edge cells call /edge; interior cells call /center.")
                        ToggleRow("Start active", isOn: $config.startActive)
                            .help("Begin polling the face service immediately on launch.")
                        ToggleRow("Show pods column", isOn: $config.showPods)
                            .help("Show the per-pod status column alongside the grid.")
                        ToggleRow("Keep faces until replaced", isOn: $config.persistFaces)
                            .help("Each cell keeps its last face on screen until a new response replaces it, instead of fading out.")
                        if !isLegacy {
                            ToggleRow("Hide legend", isOn: $config.hideKey)
                                .help("Hide the legend — a 'Show Key' button appears to reveal it on demand.")
                        }
                    }

                    Divider()
                }

                VStack(alignment: .leading, spacing: 12) {
                    TabSectionHeader("RATES")
                    if !isFunMode {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text("Request rate")
                                    .font(.system(size: 13))
                                    .frame(width: 110, alignment: .leading)
                                Slider(value: logBinding, in: log2(50)...log2(30000), step: 0.05)
                                    .help("How often each grid cell polls. Drag left = faster.")
                                Text(reqLabel)
                                    .font(.system(size: 12).monospacedDigit())
                                    .foregroundColor(.secondary)
                                    .frame(width: 80, alignment: .trailing)
                            }
                            Text("\(config.paintIntervalMs) ms / cell · total ≈ \(reqLabel)")
                                .font(.caption.monospacedDigit())
                                .foregroundColor(.secondary)
                                .padding(.leading, 114)
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text(funModeRateLabel)
                                    .font(.system(size: 13))
                                    .frame(width: 110, alignment: .leading)
                                Slider(value: funRateLog, in: log2(0.5)...log2(20), step: 0.05)
                                Text(funRateValueLabel)
                                    .font(.system(size: 12).monospacedDigit())
                                    .foregroundColor(.secondary)
                                    .frame(width: 80, alignment: .trailing)
                            }
                            .help("Requests per second — controls both the animation rate and actual server request rate.")

                            HStack {
                                Text("Slow at")
                                    .font(.system(size: 13))
                                    .frame(width: 110, alignment: .leading)
                                Slider(
                                    value: Binding<Double>(
                                        get: { Double(config.slowThresholdMs) },
                                        set: { config.slowThresholdMs = Int($0.rounded()) }
                                    ),
                                    in: 100...5000, step: 50
                                )
                                Text("\(config.slowThresholdMs) ms")
                                    .font(.system(size: 12).monospacedDigit())
                                    .foregroundColor(.secondary)
                                    .frame(width: 80, alignment: .trailing)
                            }
                            .help("Responses at or above this latency show as walkers / slow-moving objects.")
                        }
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(20)
        }
        .onChange(of: config.numRows)           { _ in reload() }
        .onChange(of: config.numCols)           { _ in reload() }
        .onChange(of: config.edgeSize)          { _ in reload() }
        .onChange(of: config.startActive)       { _ in reload() }
        .onChange(of: config.showPods)          { _ in reload() }
        .onChange(of: config.hideKey)           { _ in reload() }
        .onChange(of: config.persistFaces)      { _ in reload() }
        .onChange(of: config.paintIntervalMs)   { _ in config.save(); controller.scheduleReload() }
        .onChange(of: config.funModeRatePerSec) { _ in
            config.save()
            controller.pushLiveSettings()
            let mode = config.visualMode
            if mode != "classic" && mode != "legacy" { controller.scheduleReload() }
        }
        .onChange(of: config.slowThresholdMs)   { _ in config.save(); controller.pushLiveSettings() }
    }

    private func reload() { config.save(); controller.scheduleReload() }

    private var logBinding: Binding<Double> {
        Binding<Double>(
            get: { log2(Double(max(50, config.paintIntervalMs))) },
            set: { config.paintIntervalMs = Int(pow(2.0, $0).rounded()) }
        )
    }

    private var funRateLog: Binding<Double> {
        Binding<Double>(
            get: { log2(max(0.5, config.funModeRatePerSec)) },
            set: { config.funModeRatePerSec = min(20, max(0.5, pow(2.0, $0))) }
        )
    }

    private var funModeRateLabel: String {
        switch config.visualMode {
        case "buoyant": return "Balloons/sec"
        case "space":   return "Rockets/sec"
        case "cavern":  return "Explorers/sec"
        case "garden":  return "Flowers/sec"
        case "claude":  return "Signals/sec"
        case "fireworks": return "Fireworks/sec"
        default:        return "Scene rate"
        }
    }

    private var funRateValueLabel: String {
        let r = config.funModeRatePerSec
        if r < 1.0  { return String(format: "1/%.0fs", (1.0 / r).rounded()) }
        if r >= 10  { return String(format: "%.0f/s", r) }
        return String(format: "%.1f/s", r).replacingOccurrences(of: ".0", with: "")
    }
}

// MARK: - Services tab

private struct ServicesTab: View {
    @ObservedObject var config: FacesConfig
    @ObservedObject var controller: WebController

    private var isRemote: Bool { config.connectionMode == ConnectionMode.remote.rawValue }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {

                VStack(alignment: .leading, spacing: 12) {
                    TabSectionHeader("BACKEND")
                    Picker("", selection: $config.connectionMode) {
                        Text("Simulator").tag(ConnectionMode.simulator.rawValue)
                        Text("Remote").tag(ConnectionMode.remote.rawValue)
                    }
                    .pickerStyle(.segmented)
                    .help("Simulator: built-in fake services (no cluster needed). Remote: a real face endpoint.")

                    if config.connectionMode == ConnectionMode.remote.rawValue {
                        TextField("host:port or http://...", text: $config.endpoint)
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.body, design: .monospaced))
                            .help("The face service endpoint. http:// is assumed if omitted.")
                            .onSubmit { connect() }

                        HStack(spacing: 8) {
                            Button("Connect") { connect() }
                                .help("Save endpoint and reload")
                            Button("Test") { config.save(); controller.testConnection() }
                                .help("Send a test request and show the response")
                            Spacer()
                            StatusPill(kind: controller.connectionStatusKind,
                                       text: controller.connectionStatus)
                        }
                        if controller.lastRemoteStatusCode > 0 {
                            Text("HTTP \(controller.lastRemoteStatusCode) · \(controller.lastRemoteLatencyMs) ms")
                                .font(.caption.monospacedDigit())
                                .foregroundColor(.secondary)
                        }
                    } else {
                        StatusPill(kind: "simulator", text: "Built-in simulator active")
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 12) {
                    TabSectionHeader("SIMULATOR")
                    if isRemote {
                        Label("Using remote endpoint — simulator settings are ignored.", systemImage: "info.circle")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    } else {
                        HStack(spacing: 8) {
                            Text("Default")
                                .font(.system(size: 13))
                                .frame(width: 60, alignment: .leading)
                            Picker("", selection: $config.defaultSmiley) {
                                ForEach(FacesData.smileyNames, id: \.self) { Text($0).tag($0) }
                            }
                            .labelsHidden()
                            .help("Emoji returned by a healthy simulated smiley service.")
                            Picker("", selection: $config.defaultColor) {
                                ForEach(FacesData.colorNames, id: \.self) { Text($0).tag($0) }
                            }
                            .labelsHidden()
                            .help("Background color returned by a healthy simulated color service.")
                        }

                        CompactChaosEditor(title: "Face",   chaos: $config.face)
                            .help("Chaos for the face aggregator service.")
                        CompactChaosEditor(title: "Smiley", chaos: $config.smiley)
                            .help("Chaos for the smiley sub-service.")
                        CompactChaosEditor(title: "Color",  chaos: $config.color)
                            .help("Chaos for the color sub-service.")

                        Button("Calm Everything") {
                            config.resetChaos()
                            controller.pushLiveSettings()
                            controller.calm()
                        }
                        .help("Zero out all chaos knobs and force-unlatch any stuck 599 services.")
                    }
                }
                .disabled(isRemote)
                .opacity(isRemote ? 0.45 : 1)

                Divider()

                VStack(alignment: .leading, spacing: 12) {
                    TabSectionHeader("ADMIN")
                    Text("Operate a deployed faces-admin server (health, controls, fault injection) in a separate window.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    TextField("host:8888 or http://host", text: $config.adminEndpoint)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))
                        .help("The faces-admin service endpoint (port 8888, or the K8s Service on 80). http:// is assumed.")
                        .onSubmit { saveAdmin() }
                    HStack(spacing: 8) {
                        TextField("Username", text: $config.adminUsername)
                            .textFieldStyle(.roundedBorder)
                            .help("faces-admin username (only needed when the server has auth enabled).")
                        SecureField("Password", text: $config.adminPassword)
                            .textFieldStyle(.roundedBorder)
                            .help("faces-admin password. Stored in app preferences for automatic sign-in.")
                    }
                    Text("With credentials set, the Admin window signs in automatically — no login prompt.")
                        .font(.caption2)
                        .foregroundColor(.secondary)
                    Button("Open Admin Window") {
                        saveAdmin()
                        controller.openAdminWindow()
                    }
                    .help("Open the admin portal. You can also use ⌘⇧A.")
                }

                Spacer(minLength: 0)
            }
            .padding(20)
        }
        .onChange(of: config.connectionMode) { _ in config.save(); controller.scheduleReload() }
        .onChange(of: config.defaultSmiley)  { _ in live() }
        .onChange(of: config.defaultColor)   { _ in live() }
        .onChange(of: config.adminEndpoint)  { _ in saveAdmin() }
        .onChange(of: config.adminUsername)  { _ in saveAdmin() }
        .onChange(of: config.adminPassword)  { _ in saveAdmin() }
    }

    private func connect() { config.save(); controller.scheduleReload(); controller.testConnection() }
    private func live()    { config.save(); controller.pushLiveSettings() }
    private func saveAdmin() { config.save(); controller.pushAdminNativeSettings() }
}

// MARK: - Advanced tab

private struct AdvancedTab: View {
    @ObservedObject var config: FacesConfig
    let controller: WebController

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {

                VStack(alignment: .leading, spacing: 12) {
                    TabSectionHeader("DEBUG")
                    Button("Open Debug Window") { controller.openDebugWindow() }
                        .help("Open the network debug panel in a separate floating window.")

                    ToggleRow("Crash reporting", isOn: $config.crashReportingEnabled)
                        .help("Write crash logs to ~/Library/Application Support/Faces/CrashLogs/.")

                    Button("Show Crash Logs…") {
                        if let dir = CrashReporter.crashLogDirectory() {
                            NSWorkspace.shared.open(dir)
                        }
                    }
                    .help("Open the crash log folder in Finder.")
                }

                Divider()

                VStack(alignment: .leading, spacing: 12) {
                    TabSectionHeader("ACTIONS")
                    Button("Reload  ⌘R") { controller.reloadWithSettings() }

                    Button("Reset All to Defaults") {
                        config.resetAll()
                        controller.reloadWithSettings()
                    }
                    .foregroundColor(.red)
                    .help("Restore every setting to factory defaults and reload.")
                }

                Spacer(minLength: 0)
            }
            .padding(20)
        }
        .onChange(of: config.crashReportingEnabled) { _ in config.save() }
    }
}

// MARK: - Mode button

private struct ModeButton: View {
    let mode: (id: String, label: String, icon: String)
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Image(systemName: mode.icon)
                    .font(.system(size: 22))
                    .frame(height: 26)
                Text(mode.label)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(isSelected ? Color.accentColor.opacity(0.15) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(isSelected ? Color.accentColor : Color.secondary.opacity(0.18), lineWidth: 1.5)
            )
            // Without contentShape the hit-test only covers visible pixels (icon + text),
            // leaving the transparent padding area unresponsive. Rectangle() fills the frame.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundColor(isSelected ? .accentColor : .primary)
        .help("Switch to \(mode.label) mode")
    }
}

// MARK: - Compact chaos editor

private struct CompactChaosEditor: View {
    let title: String
    @Binding var chaos: ServiceChaos
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(spacing: 6) {
                CompactSlider(label: "Errors", value: intBinding($chaos.errorFraction),
                              range: 0...100, display: "\(chaos.errorFraction)%")
                    .help("Percentage of requests this service returns 500.")
                CompactSlider(label: "Latch", value: intBinding($chaos.latchFraction),
                              range: 0...100, display: "\(chaos.latchFraction)%")
                    .help("When an error fires, probability it latches into a sticky 599 (auto-clears after 30 s idle).")
                CompactSlider(label: "Max RPS", value: $chaos.maxRate,
                              range: 0...50, step: 0.5,
                              display: chaos.maxRate < 0.1 ? "off" : String(format: "%.1f", chaos.maxRate))
                    .help("Rate limit: requests above this rate/s get a 429.")
                CompactSlider(label: "Delay", value: intBinding($chaos.delayMs),
                              range: 0...3000, step: 50,
                              display: "\(chaos.delayMs) ms")
                    .help("Added latency per request. Enough delay → slow walkers in fun modes.")
            }
            .padding(.top, 4)
        } label: {
            HStack {
                Text(title).font(.system(size: 12, weight: .semibold))
                Spacer()
                if chaos != ServiceChaos() {
                    Text("active")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.orange)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.12), in: Capsule())
                }
            }
        }
        .onChange(of: chaos) { _ in
            (NSApp.keyWindow?.firstResponder as? NSControl)?.abortEditing()
            NotificationCenter.default.post(name: .chaosChanged, object: nil)
        }
    }

    private func intBinding(_ b: Binding<Int>) -> Binding<Double> {
        Binding<Double>(get: { Double(b.wrappedValue) }, set: { b.wrappedValue = Int($0.rounded()) })
    }
}

private struct CompactSlider: View {
    let label: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var step: Double = 1
    let display: String

    var body: some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 11))
                .frame(width: 56, alignment: .leading)
                .foregroundColor(.secondary)
            Slider(value: $value, in: range, step: step)
            Text(display)
                .font(.system(size: 11).monospacedDigit())
                .frame(width: 46, alignment: .trailing)
        }
    }

    init(label: String, value: Binding<Double>, range: ClosedRange<Double>,
         step: Double = 1, display: String) {
        self.label  = label
        self._value = value
        self.range  = range
        self.step   = step
        self.display = display
    }
}

extension Notification.Name {
    static let chaosChanged = Notification.Name("FacesConfigChaosChanged")
}

// MARK: - Reusable helpers

private struct ToggleRow: View {
    let label: String
    @Binding var isOn: Bool
    init(_ label: String, isOn: Binding<Bool>) {
        self.label = label; self._isOn = isOn
    }
    var body: some View {
        Toggle(label, isOn: $isOn)
            .font(.system(size: 13))
            .toggleStyle(.checkbox)
    }
}

private struct PickerRow<Content: View>: View {
    let title: String
    @Binding var selection: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        HStack {
            Text(title)
                .font(.system(size: 13))
                .frame(width: 82, alignment: .leading)
            Picker("", selection: $selection, content: content)
                .labelsHidden()
        }
    }
}

// Mini 12×12 grid picker — click a cell to set rows × cols.
private struct MiniGridPicker: View {
    @Binding var rows: Int
    @Binding var cols: Int
    private let max = 12
    @State private var hoverRow = 0
    @State private var hoverCol = 0
    @State private var hovering = false

    private var activeRows: Int { hovering ? hoverRow : rows }
    private var activeCols: Int { hovering ? hoverCol : cols }

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 1) {
                ForEach(1...max, id: \.self) { r in
                    HStack(spacing: 1) {
                        ForEach(1...max, id: \.self) { c in
                            RoundedRectangle(cornerRadius: 1)
                                .fill(r <= activeRows && c <= activeCols
                                    ? Color.accentColor : Color.secondary.opacity(0.15))
                                .frame(width: 9, height: 9)
                                .onHover { inside in
                                    if inside { hoverRow = r; hoverCol = c; hovering = true }
                                }
                                .onTapGesture { rows = r; cols = c }
                        }
                    }
                }
            }
            .onHover { if !$0 { hovering = false } }

            Text(hovering ? "\(hoverRow)×\(hoverCol)" : "\(rows)×\(cols)")
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundColor(hovering ? .accentColor : .secondary)
                .padding(.top, 4)
        }
    }
}

// Connection status pill.
struct StatusPill: View {
    let kind: String
    let text: String

    private var color: Color {
        switch kind {
        case "ok":        return .green
        case "warning":   return .orange
        case "error":     return .red
        case "checking":  return .blue
        case "simulator": return .purple
        default:          return .secondary
        }
    }

    var body: some View {
        Label(text, systemImage: kind == "ok" ? "checkmark.circle.fill" : "circle.fill")
            .font(.caption.weight(.semibold))
            .foregroundColor(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(color.opacity(0.12), in: Capsule())
    }
}

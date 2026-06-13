// FacesApp — entry point for faces-gui-mac-app.
//
// The main window is the full-bleed WebView. Settings live in a floating
// NSPanel (SettingsWindowController in WebController.swift), opened via
// ⌘, or the "Settings" button in the web toolbar.
//
// SPDX-License-Identifier: Apache-2.0

import SwiftUI

@main
struct FacesApp: App {
    @StateObject private var config: FacesConfig
    @StateObject private var controller: WebController

    init() {
        let cfg = FacesConfig()
        _config     = StateObject(wrappedValue: cfg)
        _controller = StateObject(wrappedValue: WebController(config: cfg))
        CrashReporter.install()
    }

    var body: some Scene {
        Window("Faces", id: "main") {
            WebView(controller: controller)
                .ignoresSafeArea()
                .frame(minWidth: 800, minHeight: 600)
        }
        .defaultSize(width: 1400, height: 900)
        .commands {
            // Remove "New Window" from File menu (single-window app).
            CommandGroup(replacing: .newItem) {}

            CommandMenu("Faces") {
                Button("Settings") {
                    controller.openSettings()
                }
                .keyboardShortcut(",", modifiers: .command)

                Divider()

                Button("Reload") {
                    controller.reloadWithSettings()
                }
                .keyboardShortcut("r", modifiers: .command)

                Button("Calm Faces") {
                    config.resetChaos()
                    controller.pushLiveSettings()
                    controller.calm()
                }
                .keyboardShortcut("k", modifiers: .command)

                Divider()

                Button("Admin Window") {
                    controller.openAdminWindow()
                }
                .keyboardShortcut("a", modifiers: [.command, .shift])

                Button("Debug Window") {
                    controller.openDebugWindow()
                }
                .keyboardShortcut("d", modifiers: [.command, .option])
            }

            // Visualization modes, switchable with ⌘1…⌘8 (in dropdown order).
            // The active mode shows a checkmark; switching is live (no reload).
            CommandMenu("Mode") {
                ForEach(FacesData.modes.indices, id: \.self) { idx in
                    let mode = FacesData.modes[idx]
                    Button(action: { selectMode(mode.id) }) {
                        // Leading checkmark marks the current mode (plain space keeps alignment).
                        Text((config.visualMode == mode.id ? "✓ " : "   ") + mode.label)
                    }
                    .keyboardShortcut(KeyEquivalent(Character("\(idx + 1)")), modifiers: .command)
                }
            }
        }
    }

    private func selectMode(_ id: String) {
        config.visualMode = id
        config.save()
        controller.pushLiveSettings()   // live switch — no reload
    }
}

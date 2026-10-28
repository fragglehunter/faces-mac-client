// CrashReporter — writes crash logs to ~/Library/Application Support/Faces/CrashLogs/
//
// Records uncaught Objective-C exceptions (NSException) only. Swift runtime
// traps — fatalError, force-unwrapping nil, array index out of range — and
// signal crashes (EXC_BAD_ACCESS) are NOT exceptions and never reach this
// handler; macOS writes those to ~/Library/Logs/DiagnosticReports/ (see
// Console.app). Note too that AppKit catches and logs most exceptions raised
// during event handling itself, so only ones that escape it land here.
//
// Gated by Settings › Advanced › Crash reporting (FacesConfig.crashReportingEnabled).
//
// SPDX-License-Identifier: Apache-2.0

import Foundation

enum CrashReporter {

    private static var logDir: URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("Faces/CrashLogs")
    }

    /// Install or remove the uncaught-exception handler to match the setting.
    static func setEnabled(_ on: Bool) {
        if on {
            NSSetUncaughtExceptionHandler { exception in
                CrashReporter.write(exception: exception)
            }
        } else {
            NSSetUncaughtExceptionHandler(nil)
        }
    }

    private static func write(exception: NSException) {
        guard let dir = logDir else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let ts = fmt.string(from: Date())
        let file = dir.appendingPathComponent("crash_\(ts).log")

        let body = """
        FACES APP CRASH REPORT
        ======================
        Date:      \(Date())
        Exception: \(exception.name.rawValue)
        Reason:    \(exception.reason ?? "(none)")

        User Info:
        \(exception.userInfo?.map { "  \($0.key): \($0.value)" }.joined(separator: "\n") ?? "  (none)")

        Call Stack:
        \(exception.callStackSymbols.joined(separator: "\n"))
        """

        try? body.write(to: file, atomically: true, encoding: .utf8)

        // Keep at most 20 crash logs to avoid unbounded growth.
        if let files = try? FileManager.default.contentsOfDirectory(at: dir,
            includingPropertiesForKeys: [.creationDateKey], options: [])
        {
            let sorted = files
                .compactMap { url -> (URL, Date)? in
                    let d = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate
                    return d.map { (url, $0) }
                }
                .sorted { $0.1 < $1.1 }
            if sorted.count > 20 {
                sorted.prefix(sorted.count - 20).forEach { try? FileManager.default.removeItem(at: $0.0) }
            }
        }
    }

    /// Returns the URL of the crash log directory (creates it if needed).
    static func crashLogDirectory() -> URL? {
        guard let dir = logDir else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

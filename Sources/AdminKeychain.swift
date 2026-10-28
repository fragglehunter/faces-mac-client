// AdminKeychain — stores the faces-admin auto-sign-in password in the user's
// login Keychain (generic-password item) instead of plaintext UserDefaults.
//
// SPDX-License-Identifier: Apache-2.0

import Foundation
import Security

enum AdminKeychain {
    static let service = "io.buoyant.facesguimacapp.admin"
    static let account = "adminPassword"

    private static func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    /// The stored password, or nil when there is none (or it can't be read).
    static func read() -> String? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Store `password`; an empty string removes the item.
    @discardableResult
    static func write(_ password: String) -> Bool {
        if password.isEmpty { return delete() }
        let data = Data(password.utf8)
        let status = SecItemUpdate(baseQuery() as CFDictionary,
                                   [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = baseQuery()
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "Faces admin sign-in"
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    @discardableResult
    static func delete() -> Bool {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

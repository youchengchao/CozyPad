import Capacitor
import Foundation

@objc(CozyPadSecureStorePlugin)
public final class CozyPadSecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CozyPadSecureStorePlugin"
    public let jsName = "CozyPadSecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private let keychain = KeychainStore()

    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        guard !isNativeOnlyKey(key) else { return call.reject("access denied") }
        do {
            call.resolve(["value": try keychain.string(for: "web-state:\(key)") as Any])
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        guard !isNativeOnlyKey(key) else { return call.reject("access denied") }
        guard let value = call.getString("value") else { return call.reject("value is required") }
        do {
            try keychain.set(value, for: "web-state:\(key)")
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else { return call.reject("key is required") }
        guard !isNativeOnlyKey(key) else { return call.reject("access denied") }
        do {
            try keychain.remove("web-state:\(key)")
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    private func isNativeOnlyKey(_ key: String) -> Bool {
        key == "known_hosts" || key.hasPrefix("password:") ||
            key.hasPrefix("private-key:") || key.hasPrefix("key-passphrase:")
    }
}

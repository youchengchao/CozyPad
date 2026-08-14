import Capacitor
import Foundation
import UIKit

@objc(CozyPadDownloadPlugin)
public final class CozyPadDownloadPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "CozyPadDownloadPlugin"
    public let jsName = "CozyPadDownload"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "saveFile", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?
    private var pendingURL: URL?
    private var pendingFileName: String?

    @objc func saveFile(_ call: CAPPluginCall) {
        guard pendingCall == nil else { return call.reject("another download is already open") }
        guard let fileName = call.getString("fileName"), isSafeFileName(fileName) else {
            return call.reject("Unsafe download filename")
        }
        guard let encoded = call.getString("dataBase64"),
              let data = Data(base64Encoded: encoded, options: .ignoreUnknownCharacters) else {
            return call.reject("Downloaded file data is invalid")
        }

        do {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("cozypad-download-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(fileName, isDirectory: false)
            try data.write(to: url, options: .atomic)

            let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
            picker.delegate = self
            pendingCall = call
            pendingURL = url
            pendingFileName = fileName
            DispatchQueue.main.async { [weak self] in
                guard let self, let viewController = self.bridge?.viewController else {
                    self?.finishWithError("Unable to present the iOS document picker")
                    return
                }
                viewController.present(picker, animated: true)
            }
        } catch {
            cleanup()
            call.reject("Unable to prepare the downloaded file", error.localizedDescription)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = pendingCall else { return }
        let fileName = pendingFileName ?? "download"
        cleanup()
        call.resolve(["fileName": fileName, "cancelled": false, "location": "Selected location"])
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let call = pendingCall else { return }
        let fileName = pendingFileName ?? "download"
        cleanup()
        call.resolve(["fileName": fileName, "cancelled": true])
    }

    private func finishWithError(_ message: String) {
        let call = pendingCall
        cleanup()
        call?.reject(message)
    }

    private func cleanup() {
        if let directory = pendingURL?.deletingLastPathComponent() {
            try? FileManager.default.removeItem(at: directory)
        }
        pendingCall = nil
        pendingURL = nil
        pendingFileName = nil
    }

    private func isSafeFileName(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed != "." && trimmed != ".." &&
            value == URL(fileURLWithPath: value).lastPathComponent &&
            !value.contains("/") && !value.contains("\\") && !value.contains("\0")
    }
}

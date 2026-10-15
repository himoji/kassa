// KassaLite's "Log Payment in Kassa" Shortcuts action (docs/KASSALITE.md, "Shortcut setup").
//
// Copied into the app target by plugins/with-log-payment-intent.js. It must live in the app target itself, not
// in a pod: Xcode extracts App Intents metadata from the app's own Swift module only. App Intents need no
// entitlement, so a free Personal Team build ships it.
//
// The action POSTs the purchase to `<server>/api/capture/shortcut` with the Shortcut's bearer token, as the
// hand-built automation does, and returns the reply's `nudge`. Server and token come from the Keychain item the
// JS side mirrors (src/lite/intent-config.ts): written through expo-secure-store, so its service carries the
// ":no-auth" suffix and its account is the key's UTF-8 bytes. That item is AfterFirstUnlockThisDeviceOnly, since a
// Transaction automation can run while the iPhone is still locked after an Apple Pay tap.

import AppIntents
import Foundation
import Security
import UserNotifications

private let configService = "kassalite.intent:no-auth"
private let configKey = "kassalite.intentConfig.v1"

private struct IntentConfig: Decodable {
  let serverUrl: String
  let token: String
}

private struct ShortcutReply: Decodable {
  let nudge: String
  let nudgeTitle: String?
  let nudgeBody: String?
}

enum LogPaymentError: Error, CustomLocalizedStringResourceConvertible {
  case notPaired
  case locked
  case refused
  case unreachable(String)
  case failed(Int)

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .notPaired:
      return "KassaLite is not paired on this iPhone. Open KassaLite and pair it with your Kassa server."
    case .locked:
      return "Unlock your iPhone once after a restart so Kassa can read its key."
    case .refused:
      return "Your Kassa server refused this iPhone's key. Open KassaLite, sign out and pair again."
    case let .unreachable(host):
      return "Cannot reach \(host). Check that your Kassa server (and its tunnel) is running."
    case let .failed(status):
      return "Your Kassa server answered with an error (\(status))."
    }
  }
}

struct LogPaymentIntent: AppIntent {
  static var title: LocalizedStringResource = "Log Payment in Kassa"
  static var description = IntentDescription(
    "Sends a purchase to your Kassa server and shows where your money went. Put it in a Wallet Transaction automation and pass Shortcut Input's Merchant, Amount and Card."
  )
  static var openAppWhenRun: Bool = false

  @Parameter(title: "Merchant")
  var merchant: String?

  @Parameter(title: "Amount", description: "As Wallet shows it, for example “€4.50”. Left empty, the action only tests the connection.")
  var amount: String?

  @Parameter(title: "Card")
  var card: String?

  @Parameter(title: "Street")
  var street: String?

  @Parameter(title: "City")
  var city: String?

  @Parameter(title: "Country")
  var country: String?

  @Parameter(title: "Show Notification", default: true)
  var showNotification: Bool

  static var parameterSummary: some ParameterSummary {
    Summary("Log \(\.$amount) at \(\.$merchant) in Kassa") {
      \.$card
      \.$street
      \.$city
      \.$country
      \.$showNotification
    }
  }

  func perform() async throws -> some IntentResult & ReturnsValue<String> {
    let config = try loadConfig()
    guard let url = URL(string: config.serverUrl + "/api/capture/shortcut"), url.scheme == "https" else {
      throw LogPaymentError.notPaired
    }

    // Empty amount: the server answers as a test run (status TEST) and records that the action reached it.
    var body: [String: String] = ["merchant": merchant ?? "", "amount": amount ?? ""]
    for (key, value) in [("card", card), ("street", street), ("city", city), ("country", country)] {
      if let value, !value.isEmpty { body[key] = value }
    }

    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)

    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await URLSession.shared.data(for: request)
    } catch {
      throw LogPaymentError.unreachable(url.host ?? config.serverUrl)
    }
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    if status == 401 { throw LogPaymentError.refused }
    guard (200..<300).contains(status), let reply = try? JSONDecoder().decode(ShortcutReply.self, from: data) else {
      throw LogPaymentError.failed(status)
    }

    if showNotification {
      await notify(title: reply.nudgeTitle ?? "Kassa", body: reply.nudgeBody ?? reply.nudge)
    }
    return .result(value: reply.nudge)
  }

  private func loadConfig() throws -> IntentConfig {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: configService,
      kSecAttrAccount as String: Data(configKey.utf8),
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecInteractionNotAllowed { throw LogPaymentError.locked }
    guard status == errSecSuccess, let data = item as? Data,
          let config = try? JSONDecoder().decode(IntentConfig.self, from: data),
          !config.token.isEmpty
    else { throw LogPaymentError.notPaired }
    return config
  }

  /// The nudge as a local notification (KassaLite already asks for notification permission); silent when denied.
  private func notify(title: String, body: String) async {
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.sound = .default
    try? await center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
  }
}

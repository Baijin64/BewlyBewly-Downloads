import AppKit
import Foundation

// Menu bar companion for the download helper.
//
//   BewlyTray --tray <data-directory>
//   BewlyTray --pick < request.json
//
// The tray never talks to the service directly: it reuses the same
// connection.json + Bearer RPC contract as the Windows tray, so the service needs
// no macOS-specific code path.

let DEFAULT_URL = "https://www.bilibili.com/?page=Downloads&downloadConnect=1"

func jsonReply(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: []),
          let text = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data(text.utf8))
}

struct Connection {
    let port: Int
    let token: String
}

final class Box<T> {
    var value: T?
}

final class Tray: NSObject, NSApplicationDelegate {
    private let dataDirectory: String
    private var statusItem: NSStatusItem?
    private var timer: Timer?
    private var failures = 0
    private var busy = false
    private var lastClipboard: Int = NSPasteboard.general.changeCount
    private var menu: NSMenu?

    private var stateLabel = NSMenuItem(title: "正在连接…", action: nil, keyEquivalent: "")
    private var startItem = NSMenuItem(title: "开始全部待下载", action: #selector(startAll), keyEquivalent: "")
    private var pauseItem = NSMenuItem(title: "暂停全部下载", action: #selector(pauseAll), keyEquivalent: "")
    private var cancelShutdownItem = NSMenuItem(title: "取消自动关机", action: #selector(cancelShutdown), keyEquivalent: "")

    init(dataDirectory: String) {
        self.dataDirectory = dataDirectory
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "arrow.down.circle", accessibilityDescription: "Bewly 下载助手")
            button.image?.isTemplate = true
        }
        let menu = NSMenu()
        stateLabel.isEnabled = false
        menu.addItem(stateLabel)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "打开下载器", action: #selector(openDownloads), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "下载设置", action: #selector(openSettings), keyEquivalent: ""))
        menu.addItem(.separator())
        startItem.target = self
        pauseItem.target = self
        cancelShutdownItem.target = self
        menu.addItem(startItem)
        menu.addItem(pauseItem)
        cancelShutdownItem.isHidden = true
        menu.addItem(cancelShutdownItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出助手", action: #selector(quit), keyEquivalent: ""))
        for entry in menu.items where entry.action != nil { entry.target = self }
        item.menu = menu
        statusItem = item
        self.menu = menu

        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer!, forMode: .common)
        tick()
    }

    private func connection() -> Connection? {
        let file = URL(fileURLWithPath: dataDirectory).appendingPathComponent("connection.json")
        guard let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = object["port"] as? Int, port > 0, port < 65536,
              let token = object["token"] as? String, !token.isEmpty else { return nil }
        return Connection(port: port, token: token)
    }

    private func rpc(_ body: [String: Any], timeout: TimeInterval = 5) -> [String: Any]? {
        guard let connection = connection(),
              let payload = try? JSONSerialization.data(withJSONObject: body),
              let url = URL(string: "http://127.0.0.1:\(connection.port)/rpc") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.httpBody = payload
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let semaphore = DispatchSemaphore(value: 0)
        let box = Box<[String: Any]>()
        let task = URLSession.shared.dataTask(with: request) { data, _, _ in
            if let data = data { box.value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] }
            semaphore.signal()
        }
        task.resume()
        _ = semaphore.wait(timeout: .now() + timeout + 1)
        return box.value
    }

    private func tick() {
        guard let reply = rpc(["method": "desktopState"]) else {
            failures += 1
            if failures >= 5 { NSApp.terminate(nil) }
            return
        }
        failures = 0
        guard let result = reply["result"] as? [String: Any] else { return }
        if (result["exiting"] as? Bool) == true { NSApp.terminate(nil); return }
        let pending = result["pending"] as? Int ?? 0
        let active = result["active"] as? Int ?? 0
        let mode = (result["mode"] as? String) == "manual" ? "常驻" : "按需"
        stateLabel.title = "\(mode) · 待下载 \(pending) · 下载中 \(active)"
        startItem.isEnabled = pending > 0 && !busy
        pauseItem.isEnabled = active > 0 && !busy
        let due = result["shutdownDue"] as? Double ?? 0
        cancelShutdownItem.isHidden = due <= 0
        if (result["listenClipboard"] as? Bool) == true { pollClipboard() }
    }

    private func pollClipboard() {
        let pasteboard = NSPasteboard.general
        guard pasteboard.changeCount != lastClipboard else { return }
        lastClipboard = pasteboard.changeCount
        guard let text = pasteboard.string(forType: .string), text.count < 500,
              let range = text.range(of: #"https?://(?:www\.|m\.)?(?:bilibili\.com/video/|b23\.tv/)[^\s]+"#, options: .regularExpression) else { return }
        let link = String(text[range])
        _ = rpc(["method": "clipboardVideo", "params": ["video": link]], timeout: 30)
    }

    @objc private func openDownloads() { openURL(DEFAULT_URL) }
    @objc private func openSettings() { openURL(DEFAULT_URL + "&downloadView=settings") }

    private func openURL(_ value: String) {
        guard let url = URL(string: value) else { return }
        NSWorkspace.shared.open(url)
    }

    private func action(_ name: String, all: String? = nil) {
        if busy { return }
        busy = true
        var params: [String: Any] = ["action": name]
        if let all = all { params["all"] = all }
        _ = rpc(["method": "desktopAction", "params": params])
        busy = false
        tick()
    }

    @objc private func startAll() { action("start", all: "pending") }
    @objc private func pauseAll() { action("pause", all: "active") }
    @objc private func cancelShutdown() { action("cancelShutdown") }

    @objc private func quit() {
        let alert = NSAlert()
        alert.messageText = "退出 Bewly 下载助手？"
        alert.informativeText = "退出后正在下载的任务会暂停，下次启动继续。"
        alert.addButton(withTitle: "退出")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { action("exit"); NSApp.terminate(nil) }
    }
}

func runPick() -> Never {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] ?? [:]
    let kind = request["kind"] as? String ?? "video"
    NSApp.setActivationPolicy(.accessory)
    NSApp.activate(ignoringOtherApps: true)
    let panel = NSOpenPanel()
    panel.canChooseFiles = kind != "directory"
    panel.canChooseDirectories = kind == "directory"
    panel.allowsMultipleSelection = false
    if let start = request["path"] as? String, !start.isEmpty { panel.directoryURL = URL(fileURLWithPath: start) }
    switch kind {
    case "audio": panel.allowedFileTypes = ["aac", "m4a", "m4s", "mp3", "flac", "mka", "eac3", "wav"]
    case "video": panel.allowedFileTypes = ["m4s", "mp4", "mkv", "mov"]
    case "cc": panel.allowedFileTypes = ["json"]
    case "srt": panel.allowedFileTypes = ["srt"]
    case "legacy": panel.allowedFileTypes = ["bilidownexport"]
    default: break
    }
    let response = panel.runModal()
    if response == .OK, let url = panel.url {
        jsonReply(["path": url.path, "cancelled": false])
    } else {
        jsonReply(["path": NSNull(), "cancelled": true])
    }
    exit(0)
}

let arguments = CommandLine.arguments
if arguments.contains("--pick") { runPick() }

let app = NSApplication.shared
var dataDirectory = NSHomeDirectory() + "/Library/Application Support/BewlyDownload"
if let index = arguments.firstIndex(of: "--tray"), index + 1 < arguments.count { dataDirectory = arguments[index + 1] }
let tray = Tray(dataDirectory: dataDirectory)
app.delegate = tray
app.run()

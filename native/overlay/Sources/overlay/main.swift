// deskpilot desktop overlay: a transparent, always-on-top, click-through window that shows the agents'
// avatars page served by the local control-panel server.
//
// Protocol: the first stdin line is JSON config {url, origin, x?, y?, width?, height?}. stdin closing
// (the parent exited) quits the overlay. Events go to stdout as JSON lines:
//   {"event":"ready"} · {"event":"open","runId":"…"} · {"event":"moved","x":…,"y":…}
//
// The window never becomes main and never activates the app, so the frontmost app stays frontmost
// (input.* tools depend on that). It becomes key only while the user types into an avatar's reply
// box ("focus" … "blur"; the core holds the desktop meanwhile so no agent types), then hands the
// keyboard back to the app that had it. Mouse events pass through except over avatar rectangles the
// page reports. Web data is kept in memory only (nothing written to ~/Library).
import AppKit
import WebKit

struct Config: Decodable {
    let url: String
    let origin: String
    let x: Double?
    let y: Double?
    let width: Double?
    let height: Double?
}

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

final class OverlayPanel: NSPanel {
    /** True only while the user types into a reply box. */
    var allowKey = false
    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { false }
}

final class OverlayWebView: WKWebView {
    // The window is never key, so accept the first click instead of swallowing it.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class Controller: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let panel: OverlayPanel
    let web: OverlayWebView
    let origin: String
    /// Hit areas in web-view coordinates (top-left origin, CSS px = points).
    var rects: [CGRect] = []
    var dragging = false
    /** App that had the keyboard before a reply box took it. */
    var previousApp: NSRunningApplication?

    init(config: Config) {
        origin = config.origin
        let width = config.width ?? 600
        let height = config.height ?? 320
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = config.x ?? (screen.maxX - width - 16)
        let y = config.y ?? (screen.minY + 16)
        panel = OverlayPanel(
            contentRect: NSRect(x: x, y: y, width: width, height: height),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .nonPersistent()
        web = OverlayWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: conf)
        super.init()

        conf.userContentController.add(self, name: "deskpilot")
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.underPageBackgroundColor = .clear
        web.autoresizingMask = [.width, .height]

        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.ignoresMouseEvents = true
        panel.contentView = web
        panel.orderFrontRegardless()

        if let url = URL(string: config.url) { web.load(URLRequest(url: url)) }

        // Click-through: only take the mouse while it is over an avatar (or mid-drag).
        Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.updateMouse() }
    }

    func updateMouse() {
        if dragging || panel.allowKey { panel.ignoresMouseEvents = false; return }
        let p = NSEvent.mouseLocation
        let f = panel.frame
        let local = CGPoint(x: p.x - f.minX, y: f.height - (p.y - f.minY))
        let over = rects.contains { $0.contains(local) }
        if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
    }

    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "rects":
            let list = body["rects"] as? [[Double]] ?? []
            rects = list.compactMap { $0.count == 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
        case "dragStart":
            dragging = true
        case "moveBy":
            let dx = body["dx"] as? Double ?? 0, dy = body["dy"] as? Double ?? 0
            var o = panel.frame.origin
            o.x += dx
            o.y -= dy // screen y grows upwards, page y downwards
            panel.setFrameOrigin(o)
        case "dragEnd":
            dragging = false
            emit(["event": "moved", "x": panel.frame.minX, "y": panel.frame.minY])
        case "focus":
            // The page asks right before showing a reply box (the core already holds the desktop).
            previousApp = NSWorkspace.shared.frontmostApplication
            panel.allowKey = true
            panel.ignoresMouseEvents = false
            panel.makeKey()
            panel.makeFirstResponder(web)
        case "blur":
            panel.allowKey = false
            panel.resignKey()
            if let app = previousApp, !app.isTerminated { app.activate() }
            previousApp = nil
        case "open":
            if let runId = body["runId"] as? String, runId.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil {
                emit(["event": "open", "runId": runId])
            }
        default:
            break
        }
    }

    // Only our own local page may load in this window.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = action.request.url?.absoluteString ?? ""
        decisionHandler(url.hasPrefix(origin + "/") || url == origin ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        emit(["event": "ready"])
    }
}

guard let line = readLine(), let data = line.data(using: .utf8), let config = try? JSONDecoder().decode(Config.self, from: data) else {
    FileHandle.standardError.write("overlay: expected a JSON config line on stdin\n".data(using: .utf8)!)
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, never steals focus
let controller = Controller(config: config)

// Quit when the parent closes our stdin.
Thread {
    while readLine() != nil {}
    DispatchQueue.main.async { NSApp.terminate(nil) }
}.start()

app.run()

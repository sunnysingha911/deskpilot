// axhelper: macOS desktop backend for ai-system.
//
// Usage:  echo '<json request>' | axhelper <command>
// Output: one JSON object on stdout: {"ok":true,...} or {"ok":false,"error":{"code","message"}}
//
// Commands: check, apps, tree, find, inspect, press, set-value, element-at, type, hotkey, click,
// pdf-text (text of a PDF via PDFKit; needs no permissions)
//
// Element addressing: a "path" is a dot-separated list of child indices from the application
// element ("" = the app itself, "1.0.3" = 2nd child → 1st child → 4th child). Alternatively a
// "selector" object {role, subrole, title, titleContains, identifier, description,
// descriptionContains, nth} matched breadth-first.

import AppKit
import ApplicationServices
import Foundation
import PDFKit

// MARK: - Output

struct Fail: Error {
    let code: String
    let message: String
}

func emit(_ obj: [String: Any]) {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]))
        ?? Data("{\"ok\":false,\"error\":{\"code\":\"encode\",\"message\":\"JSON encode failed\"}}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

// MARK: - Request helpers

typealias Req = [String: Any]

func readRequest() throws -> Req {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    if data.isEmpty || String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) == "" {
        return [:]
    }
    guard let obj = try? JSONSerialization.jsonObject(with: data), let dict = obj as? Req else {
        throw Fail(code: "bad_request", message: "stdin must be a JSON object")
    }
    return dict
}

func int(_ r: Req, _ k: String, _ def: Int) -> Int { (r[k] as? NSNumber)?.intValue ?? def }
func dbl(_ r: Req, _ k: String) throws -> Double {
    guard let n = r[k] as? NSNumber else { throw Fail(code: "bad_request", message: "missing number '\(k)'") }
    return n.doubleValue
}
func bool(_ r: Req, _ k: String, _ def: Bool) -> Bool { (r[k] as? NSNumber)?.boolValue ?? def }
func string(_ r: Req, _ k: String) throws -> String {
    guard let s = r[k] as? String else { throw Fail(code: "bad_request", message: "missing string '\(k)'") }
    return s
}

// MARK: - Trust

func requireTrust() throws {
    if !AXIsProcessTrusted() {
        throw Fail(
            code: "not_trusted",
            message: "Accessibility permission not granted to the parent app (e.g. your terminal). See docs/permissions.md.")
    }
}

// MARK: - Apps

func runningApps() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
}

func resolveApp(_ r: Req) throws -> NSRunningApplication {
    if let pid = r["app"] as? NSNumber {
        if let app = NSRunningApplication(processIdentifier: pid.int32Value) { return app }
        throw Fail(code: "app_not_running", message: "no process with pid \(pid)")
    }
    guard let name = r["app"] as? String, !name.isEmpty else {
        throw Fail(code: "bad_request", message: "missing 'app' (name, bundle id, pid, or \"frontmost\")")
    }
    if name.lowercased() == "frontmost" {
        if let app = NSWorkspace.shared.frontmostApplication { return app }
        throw Fail(code: "app_not_running", message: "no frontmost app")
    }
    let lower = name.lowercased()
    if let app = runningApps().first(where: {
        $0.localizedName?.lowercased() == lower || $0.bundleIdentifier?.lowercased() == lower
    }) {
        return app
    }
    throw Fail(code: "app_not_running", message: "app '\(name)' is not running")
}

func appElement(_ app: NSRunningApplication) -> AXUIElement {
    let el = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(el, 3.0)
    return el
}

func appInfo(_ app: NSRunningApplication) -> [String: Any] {
    [
        "name": app.localizedName ?? "",
        "bundleId": app.bundleIdentifier ?? "",
        "pid": Int(app.processIdentifier),
        "frontmost": app.isActive,
    ]
}

// MARK: - AX attribute access

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}



func actions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}

func isSettable(_ el: AXUIElement, _ name: String) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(el, name as CFString, &settable) == .success && settable.boolValue
}

/// Attributes fetched in one IPC round trip per element.
let batchAttrs: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXIdentifierAttribute,
    kAXPlaceholderValueAttribute, kAXValueAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
    kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
]

/// Fetch batchAttrs at once; missing attributes are omitted.
func fetch(_ el: AXUIElement) -> [String: CFTypeRef] {
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(el, batchAttrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
        let arr = values as? [AnyObject]
    else { return [:] }
    var out: [String: CFTypeRef] = [:]
    for (i, v) in arr.enumerated() where i < batchAttrs.count {
        if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { continue }
        if v is NSNull { continue }
        out[batchAttrs[i]] = v
    }
    return out
}

/// Custom actions arrive as "Name:Move next\nTarget:0x0\nSelector:(null)"; keep just the name.
func cleanAction(_ a: String) -> String {
    guard a.hasPrefix("Name:") else { return a }
    return String(a.dropFirst(5).split(separator: "\n", maxSplits: 1).first ?? "")
}

/// Toolbar-customization actions present on most toolbar items; noise for agents.
let noiseActions: Set<String> = ["Move previous", "Move next", "Remove from toolbar"]

func describe(_ el: AXUIElement, path: String, maxValueLen: Int, prefetched: [String: CFTypeRef]? = nil) -> [String: Any] {
    let a = prefetched ?? fetch(el)
    var n: [String: Any] = ["path": path]
    func s(_ k: String) -> String? { (a[k] as? String).flatMap { $0.isEmpty ? nil : $0 } }
    if let v = s(kAXRoleAttribute) { n["role"] = v }
    if let v = s(kAXSubroleAttribute) { n["subrole"] = v }
    if let v = s(kAXTitleAttribute) { n["title"] = v }
    if let v = s(kAXDescriptionAttribute) { n["description"] = v }
    if let v = s(kAXIdentifierAttribute) { n["identifier"] = v }
    if let v = s(kAXPlaceholderValueAttribute) { n["placeholder"] = v }
    if maxValueLen > 0, let v = a[kAXValueAttribute] {
        if let str = v as? String {
            n["value"] = str.count > maxValueLen ? String(str.prefix(maxValueLen)) + "…[\(str.count) chars]" : str
        } else if CFGetTypeID(v) == CFBooleanGetTypeID() {
            n["value"] = (v as! Bool)
        } else if let num = v as? NSNumber {
            n["value"] = num
        }
    }
    if let v = a[kAXEnabledAttribute] as? Bool, !v { n["enabled"] = false }
    if let v = a[kAXFocusedAttribute] as? Bool, v { n["focused"] = true }
    if let p = a[kAXPositionAttribute], let z = a[kAXSizeAttribute],
        CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(z) == AXValueGetTypeID()
    {
        var pt = CGPoint.zero
        var sz = CGSize.zero
        AXValueGetValue(p as! AXValue, .cgPoint, &pt)
        AXValueGetValue(z as! AXValue, .cgSize, &sz)
        n["frame"] = ["x": Int(pt.x.rounded()), "y": Int(pt.y.rounded()), "w": Int(sz.width.rounded()), "h": Int(sz.height.rounded())]
    }
    let acts = actions(el).map(cleanAction).filter { !$0.isEmpty && !noiseActions.contains($0) }
    if !acts.isEmpty { n["actions"] = acts }
    // Only value-bearing elements can be settable; skip the extra IPC for the rest.
    if a[kAXValueAttribute] != nil, isSettable(el, kAXValueAttribute) { n["valueSettable"] = true }
    return n
}

func roleOf(_ el: AXUIElement) -> String { (attr(el, kAXRoleAttribute) as? String) ?? "" }

// MARK: - Tree / find / resolve

func childPath(_ parent: String, _ i: Int) -> String { parent.isEmpty ? "\(i)" : "\(parent).\(i)" }

func elementAt(path: String, root: AXUIElement) throws -> AXUIElement {
    var el = root
    if path.isEmpty { return el }
    for part in path.split(separator: ".") {
        guard let i = Int(part) else { throw Fail(code: "bad_request", message: "invalid path '\(path)'") }
        let kids = children(el)
        guard i >= 0, i < kids.count else {
            throw Fail(code: "element_not_found", message: "path '\(path)' no longer exists (UI changed?). Re-dump the tree.")
        }
        el = kids[i]
    }
    return el
}

struct Budget {
    var nodes = 0
    let maxNodes: Int
    var truncated = false
}

func buildTree(_ el: AXUIElement, path: String, depth: Int, maxDepth: Int, includeMenuBar: Bool,
               maxValueLen: Int, budget: inout Budget) -> [String: Any] {
    budget.nodes += 1
    let fetched = fetch(el)
    var node = describe(el, path: path, maxValueLen: maxValueLen, prefetched: fetched)
    let kids = (fetched[kAXChildrenAttribute] as? [AXUIElement]) ?? []
    if kids.isEmpty { return node }
    let role = node["role"] as? String ?? ""
    if (role == "AXMenuBar" && !includeMenuBar) || depth >= maxDepth {
        node["childCount"] = kids.count
        return node
    }
    var out: [[String: Any]] = []
    for (i, k) in kids.enumerated() {
        if budget.nodes >= budget.maxNodes {
            budget.truncated = true
            node["childCount"] = kids.count
            break
        }
        out.append(buildTree(k, path: childPath(path, i), depth: depth + 1, maxDepth: maxDepth,
                             includeMenuBar: includeMenuBar, maxValueLen: maxValueLen, budget: &budget))
    }
    node["children"] = out
    return node
}

func matches(_ el: AXUIElement, _ sel: Req) -> Bool {
    func eq(_ key: String, _ attrName: String) -> Bool {
        guard let want = sel[key] as? String else { return true }
        return (attr(el, attrName) as? String) == want
    }
    func contains(_ key: String, _ attrName: String) -> Bool {
        guard let want = sel[key] as? String else { return true }
        return ((attr(el, attrName) as? String) ?? "").localizedCaseInsensitiveContains(want)
    }
    return eq("role", kAXRoleAttribute) && eq("subrole", kAXSubroleAttribute) && eq("title", kAXTitleAttribute)
        && eq("identifier", kAXIdentifierAttribute) && eq("description", kAXDescriptionAttribute)
        && contains("titleContains", kAXTitleAttribute) && contains("descriptionContains", kAXDescriptionAttribute)
}

/// Breadth-first search. Returns (element, path) pairs.
func find(root: AXUIElement, rootPath: String, sel: Req, limit: Int, includeMenuBar: Bool,
          maxDepth: Int = 30, maxVisited: Int = 20000) -> [(AXUIElement, String)] {
    var queue: [(AXUIElement, String, Int)] = [(root, rootPath, 0)]
    var head = 0
    var found: [(AXUIElement, String)] = []
    while head < queue.count, head < maxVisited {
        let (el, path, depth) = queue[head]
        head += 1
        if head > 1 || !rootPath.isEmpty, matches(el, sel) {
            found.append((el, path))
            if found.count >= limit { break }
        }
        if depth >= maxDepth { continue }
        if !includeMenuBar && roleOf(el) == "AXMenuBar" { continue }
        for (i, k) in children(el).enumerated() { queue.append((k, childPath(path, i), depth + 1)) }
    }
    return found
}

/// Resolve a target from {path} or {selector, under?} within an app.
func resolveTarget(_ r: Req, root: AXUIElement) throws -> (AXUIElement, String) {
    if let path = r["path"] as? String {
        return (try elementAt(path: path, root: root), path)
    }
    guard let sel = r["selector"] as? Req else {
        throw Fail(code: "bad_request", message: "need 'path' or 'selector'")
    }
    let under = (r["under"] as? String) ?? ""
    let nth = int(sel, "nth", 0)
    let menu = bool(r, "includeMenuBar", ((sel["role"] as? String) ?? "").hasPrefix("AXMenu"))
    let hits = find(root: try elementAt(path: under, root: root), rootPath: under, sel: sel, limit: nth + 1, includeMenuBar: menu)
    guard hits.count > nth else {
        throw Fail(code: "element_not_found", message: "no element matches selector \(sel)")
    }
    return hits[nth]
}

// MARK: - Keyboard / mouse (Quartz events)

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
    "p": 35, "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "enter": 76, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
    "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111, "home": 115,
    "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121, "left": 123, "right": 124,
    "down": 125, "up": 126,
]

let modifiers: [String: (CGKeyCode, CGEventFlags)] = [
    "cmd": (55, .maskCommand), "command": (55, .maskCommand),
    "shift": (56, .maskShift),
    "alt": (58, .maskAlternate), "option": (58, .maskAlternate), "opt": (58, .maskAlternate),
    "ctrl": (59, .maskControl), "control": (59, .maskControl),
    "fn": (63, .maskSecondaryFn),
]

func source() throws -> CGEventSource {
    guard let s = CGEventSource(stateID: .hidSystemState) else {
        throw Fail(code: "event_source", message: "cannot create CGEventSource")
    }
    return s
}

func pause(_ ms: Int) { if ms > 0 { usleep(useconds_t(ms * 1000)) } }

func postKey(_ src: CGEventSource, _ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
    let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
}

func typeText(_ text: String, delayMs: Int) throws {
    let src = try source()
    var chunk = ""
    func flush() {
        guard !chunk.isEmpty else { return }
        let utf16 = Array(chunk.utf16)
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
            e?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
            e?.post(tap: .cghidEventTap)
        }
        chunk = ""
        pause(delayMs)
    }
    for ch in text {
        if ch == "\n" || ch == "\r\n" || ch == "\t" {
            flush()
            let code: CGKeyCode = ch == "\t" ? 48 : 36
            postKey(src, code, down: true, flags: [])
            postKey(src, code, down: false, flags: [])
            pause(delayMs)
            continue
        }
        if chunk.utf16.count + String(ch).utf16.count > 16 { flush() }
        chunk.append(ch)
    }
    flush()
}

func hotkey(_ keys: [String]) throws {
    guard !keys.isEmpty else { throw Fail(code: "bad_request", message: "keys is empty") }
    let src = try source()
    var flags: CGEventFlags = []
    var mods: [CGKeyCode] = []
    var mainKeys: [CGKeyCode] = []
    for raw in keys {
        let k = raw.lowercased()
        if let (code, flag) = modifiers[k] {
            flags.insert(flag)
            mods.append(code)
        } else if let code = keyCodes[k] {
            mainKeys.append(code)
        } else {
            throw Fail(code: "bad_request", message: "unknown key '\(raw)'")
        }
    }
    var held: CGEventFlags = []
    for (i, code) in mods.enumerated() {
        held.insert(modifiers[keys.map { $0.lowercased() }.filter { modifiers[$0] != nil }[i]]!.1)
        postKey(src, code, down: true, flags: held)
    }
    for code in mainKeys {
        postKey(src, code, down: true, flags: flags)
        pause(10)
        postKey(src, code, down: false, flags: flags)
    }
    for code in mods.reversed() { postKey(src, code, down: false, flags: []) }
}

func click(x: Double, y: Double, button: String, count: Int) throws {
    let src = try source()
    let pt = CGPoint(x: x, y: y)
    let (downT, upT, btn): (CGEventType, CGEventType, CGMouseButton) =
        button == "right" ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
    CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: btn)?
        .post(tap: .cghidEventTap)
    pause(30)
    for n in 1...max(1, count) {
        for t in [downT, upT] {
            let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: pt, mouseButton: btn)
            e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
            e?.post(tap: .cghidEventTap)
        }
        pause(30)
    }
}

// MARK: - Commands

func run(_ cmd: String, _ r: Req) throws -> [String: Any] {
    let maxValueLen = int(r, "maxValueLength", 200)
    switch cmd {
    case "check":
        // prompt:true asks macOS to show its own "grant Accessibility" dialog (it changes nothing itself).
        if bool(r, "prompt", false) {
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            return ["trusted": AXIsProcessTrustedWithOptions([key: true] as CFDictionary)]
        }
        return ["trusted": AXIsProcessTrusted()]

    case "apps":
        return ["apps": runningApps().map(appInfo)]

    case "tree":
        try requireTrust()
        let app = try resolveApp(r)
        let root = appElement(app)
        let start = (r["path"] as? String) ?? ""
        var budget = Budget(maxNodes: int(r, "maxNodes", 1500))
        let tree = buildTree(try elementAt(path: start, root: root), path: start, depth: 0,
                             maxDepth: int(r, "maxDepth", 12), includeMenuBar: bool(r, "includeMenuBar", false),
                             maxValueLen: maxValueLen, budget: &budget)
        return ["app": appInfo(app), "tree": tree, "nodeCount": budget.nodes, "truncated": budget.truncated]

    case "find":
        try requireTrust()
        let app = try resolveApp(r)
        let root = appElement(app)
        guard let sel = r["selector"] as? Req else { throw Fail(code: "bad_request", message: "missing 'selector'") }
        let under = (r["under"] as? String) ?? ""
        let hits = find(root: try elementAt(path: under, root: root), rootPath: under, sel: sel,
                        limit: int(r, "limit", 20), includeMenuBar: bool(r, "includeMenuBar", false))
        return ["app": appInfo(app), "matches": hits.map { describe($0.0, path: $0.1, maxValueLen: maxValueLen) }]

    case "inspect":
        try requireTrust()
        let app = try resolveApp(r)
        let (el, path) = try resolveTarget(r, root: appElement(app))
        return ["app": appInfo(app), "element": describe(el, path: path, maxValueLen: maxValueLen)]

    case "press":
        try requireTrust()
        let app = try resolveApp(r)
        let (el, path) = try resolveTarget(r, root: appElement(app))
        let action = (r["action"] as? String) ?? (kAXPressAction as String)
        let err = AXUIElementPerformAction(el, action as CFString)
        guard err == .success else {
            throw Fail(code: "ax_error", message: "\(action) failed with AXError \(err.rawValue) on path \(path)")
        }
        return ["app": appInfo(app), "element": describe(el, path: path, maxValueLen: maxValueLen), "action": action]

    case "set-value":
        try requireTrust()
        let app = try resolveApp(r)
        let (el, path) = try resolveTarget(r, root: appElement(app))
        let value = try string(r, "value")
        if bool(r, "focus", true), isSettable(el, kAXFocusedAttribute) {
            AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        }
        guard isSettable(el, kAXValueAttribute) else {
            throw Fail(code: "not_settable", message: "AXValue is not settable on path \(path) (role \(roleOf(el)))")
        }
        let err = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFString)
        guard err == .success else {
            throw Fail(code: "ax_error", message: "set AXValue failed with AXError \(err.rawValue) on path \(path)")
        }
        let after = attr(el, kAXValueAttribute) as? String
        return ["app": appInfo(app), "element": describe(el, path: path, maxValueLen: maxValueLen),
                "verified": after == value]

    case "element-at":
        try requireTrust()
        let sys = AXUIElementCreateSystemWide()
        var hit: AXUIElement?
        let err = AXUIElementCopyElementAtPosition(sys, Float(try dbl(r, "x")), Float(try dbl(r, "y")), &hit)
        guard err == .success, let el = hit else { return ["element": NSNull()] }
        var pid: pid_t = 0
        AXUIElementGetPid(el, &pid)
        let app = NSRunningApplication(processIdentifier: pid)
        return ["app": app.map(appInfo) ?? NSNull(), "element": describe(el, path: "?", maxValueLen: maxValueLen)]

    case "type":
        try requireTrust()
        let text = try string(r, "text")
        try typeText(text, delayMs: int(r, "delayMs", 8))
        return ["typedChars": text.count]

    case "hotkey":
        try requireTrust()
        guard let keys = r["keys"] as? [String] else { throw Fail(code: "bad_request", message: "missing 'keys' array") }
        try hotkey(keys)
        return ["keys": keys]

    case "click":
        try requireTrust()
        let x = try dbl(r, "x"), y = try dbl(r, "y")
        let button = (r["button"] as? String) ?? "left"
        let count = int(r, "count", 1)
        try click(x: x, y: y, button: button, count: count)
        return ["x": x, "y": y, "button": button, "count": count]

    case "pdf-text":
        // Read-only: opens the file, never writes. Pages are 1-based; text is capped by maxChars.
        let path = try string(r, "path")
        guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else {
            throw Fail(code: "bad_pdf", message: "not a readable PDF")
        }
        if doc.isLocked { throw Fail(code: "pdf_locked", message: "the PDF is password-protected") }
        let maxChars = int(r, "maxChars", 200_000)
        var text = ""
        var pagesRead = 0
        for i in 0..<doc.pageCount {
            guard text.count < maxChars else { break }
            let pageText = doc.page(at: i)?.string ?? ""
            text += "--- page \(i + 1) ---\n" + pageText + "\n"
            pagesRead += 1
        }
        let truncated = text.count > maxChars || pagesRead < doc.pageCount
        if text.count > maxChars { text = String(text.prefix(maxChars)) }
        return ["pages": doc.pageCount, "pagesRead": pagesRead, "text": text, "truncated": truncated]

    default:
        throw Fail(code: "unknown_command", message: "unknown command '\(cmd)'")
    }
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    emit(["ok": false, "error": ["code": "usage", "message": "usage: echo '{json}' | axhelper <command>"]])
    exit(2)
}
do {
    var result = try run(args[1], try readRequest())
    result["ok"] = true
    emit(result)
} catch let f as Fail {
    emit(["ok": false, "error": ["code": f.code, "message": f.message]])
    exit(1)
} catch {
    emit(["ok": false, "error": ["code": "internal", "message": "\(error)"]])
    exit(1)
}

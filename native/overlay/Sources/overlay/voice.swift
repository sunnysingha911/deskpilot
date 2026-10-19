// Push-to-talk for A.R.S.E.N.A.L: a global hotkey (Carbon, no extra permission) and on-device speech
// recognition (Speech framework). Audio never leaves the Mac: if on-device recognition isn't available
// for the language, it refuses instead of falling back to Apple's servers. It listens only while the
// user holds the hotkey or the orb's mic button, and for at most MAX_LISTEN seconds.
import AVFoundation
import Carbon
import Speech

let MAX_LISTEN: TimeInterval = 30

// ── global hotkey ────────────────────────────────────────────────────────────

private var hotKeyRef: EventHotKeyRef?
private var hotKeyHandlerInstalled = false
private var hotKeyDown: (() -> Void)?
private var hotKeyUp: (() -> Void)?

/** "option+space" etc. → Carbon modifiers (space only, for now). */
func carbonModifiers(_ spec: String) -> UInt32? {
    var mods: UInt32 = 0
    let parts = spec.split(separator: "+").map(String.init)
    guard parts.last == "space" else { return nil }
    for p in parts.dropLast() {
        switch p {
        case "option": mods |= UInt32(optionKey)
        case "control": mods |= UInt32(controlKey)
        case "command": mods |= UInt32(cmdKey)
        case "shift": mods |= UInt32(shiftKey)
        default: return nil
        }
    }
    return mods == 0 ? nil : mods
}

/** Register (or replace) the push-to-talk hotkey; nil spec unregisters it. */
func setHotKey(_ spec: String?, down: @escaping () -> Void, up: @escaping () -> Void) -> Bool {
    if let ref = hotKeyRef {
        UnregisterEventHotKey(ref)
        hotKeyRef = nil
    }
    guard let spec, let mods = carbonModifiers(spec) else { return spec == nil }
    hotKeyDown = down
    hotKeyUp = up
    if !hotKeyHandlerInstalled {
        var types = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            let kind = GetEventKind(event)
            DispatchQueue.main.async { kind == UInt32(kEventHotKeyPressed) ? hotKeyDown?() : hotKeyUp?() }
            return noErr
        }, 2, &types, nil, nil)
        hotKeyHandlerInstalled = true
    }
    let id = EventHotKeyID(signature: OSType(0x6450_6C74), id: 1) // 'dPlt'
    return RegisterEventHotKey(UInt32(kVK_Space), mods, id, GetApplicationEventTarget(), 0, &hotKeyRef) == noErr
}

// ── on-device recognition ────────────────────────────────────────────────────

final class Listener {
    /** "" = the system language. */
    var locale = ""
    /** Events for the page (listening / partial / final / error) and the parent. */
    let onEvent: ([String: Any]) -> Void
    /** Still held? Checked after the permission prompts, which can take a while. */
    let stillWanted: () -> Bool

    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var session = 0
    private var capturing = false
    private var lastText = ""
    private var maxTimer: Timer?

    init(onEvent: @escaping ([String: Any]) -> Void, stillWanted: @escaping () -> Bool) {
        self.onEvent = onEvent
        self.stillWanted = stillWanted
    }

    var busy: Bool { capturing || task != nil }

    private func fail(_ message: String) {
        onEvent(["type": "error", "message": message])
    }

    /** Ask macOS for Speech Recognition and Microphone access (it prompts once), then listen. */
    func start() {
        guard !busy else { return }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    return self.fail("Speech Recognition is off for this app. Turn it on in System Settings → Privacy & Security → Speech Recognition (see docs/permissions.md).")
                }
                AVCaptureDevice.requestAccess(for: .audio) { ok in
                    DispatchQueue.main.async {
                        guard ok else {
                            return self.fail("Microphone access is off for this app. Turn it on in System Settings → Privacy & Security → Microphone (see docs/permissions.md).")
                        }
                        if self.stillWanted() { self.begin() } else { self.onEvent(["type": "idle"]) }
                    }
                }
            }
        }
    }

    private func begin() {
        guard !busy else { return }
        let rec = locale.isEmpty ? SFSpeechRecognizer() : SFSpeechRecognizer(locale: Locale(identifier: locale))
        let lang = locale.isEmpty ? Locale.current.identifier : locale
        guard let rec, rec.isAvailable else { return fail("Speech recognition isn't available for \(lang).") }
        guard rec.supportsOnDeviceRecognition else {
            return fail("On-device recognition isn't available for \(lang), and your voice is never sent to Apple's servers. Pick another language in A.R.S.E.N.A.L's settings.")
        }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.requiresOnDeviceRecognition = true
        req.shouldReportPartialResults = true
        req.addsPunctuation = true
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { return fail("No microphone found.") }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in req.append(buffer) }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            return fail("Couldn't start the microphone: \(error.localizedDescription)")
        }
        session += 1
        let mine = session
        request = req
        capturing = true
        lastText = ""
        onEvent(["type": "listening"])
        task = rec.recognitionTask(with: req) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.session == mine else { return }
                if let result {
                    self.lastText = result.bestTranscription.formattedString
                    if result.isFinal { return self.finish(mine) }
                    self.onEvent(["type": "partial", "text": self.lastText])
                } else if error != nil {
                    self.finish(mine) // e.g. nothing was said
                }
            }
        }
        maxTimer = Timer.scheduledTimer(withTimeInterval: MAX_LISTEN, repeats: false) { [weak self] _ in self?.stop() }
    }

    /** The user let go: stop capturing; the final transcript follows shortly. */
    func stop() {
        guard capturing else { return }
        capturing = false
        maxTimer?.invalidate()
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        let mine = session
        // If the recognizer never reports a final result, use what it had.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.finish(mine) }
    }

    /** Stop and drop whatever was heard. */
    func cancel() {
        let wasBusy = busy
        stop()
        task?.cancel()
        session += 1
        task = nil
        request = nil
        if wasBusy { onEvent(["type": "idle"]) }
    }

    private func finish(_ which: Int) {
        guard which == session, task != nil || capturing else { return }
        if capturing { stop() }
        session += 1
        task = nil
        request = nil
        onEvent(["type": "final", "text": lastText])
    }
}

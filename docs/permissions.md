# macOS permissions

This project never changes system or security settings itself. You grant each permission by hand.
Paths below are for macOS 26/27 (System Settings). Each permission is granted to the
**app that launches the process**, which is your terminal app (Terminal, iTerm2, Ghostty, VS Code,
…), not to `node`. If you switch terminals, grant again for the new one.

After granting any of these, **quit and relaunch the terminal app** (⌘Q). macOS caches the
decision per process.

---

## 1. Automation (Apple Events): needed now (Phase 0/1)
Lets the terminal send AppleScript commands to other apps (System Events, Notes, Finder, …).

- **How it's granted:** you don't add it manually the first time. The first time a script targets
  an app, macOS shows a dialog: *"Terminal wants access to control 'System Events'"*. Click **Allow**.
- **Where to review/change:** System Settings → **Privacy & Security** → **Automation** →
  expand your terminal app → toggle each target app (System Events, Notes, …).
- **If you clicked "Don't Allow" by mistake:** turn the toggle on at the path above. If the app isn't listed,
  run `tccutil reset AppleEvents` yourself (it resets *all* Automation decisions; you'll get the
  prompts again).
- **Check:**
  ```sh
  npm run frontmost      # → {"ok":true,"frontmostApp":"..."}
  osascript -e 'tell application "Notes" to get name of every folder'
  ```
  Error `-1743` ("Not authorized to send Apple events") means the permission is missing.

## 2. Accessibility: needed for Phase 1 (`ax.*`, keyboard, mouse)
Lets a process read other apps' UI trees (AXUIElement) and post synthetic keyboard/mouse events.

- **Easiest:** run `echo '{"prompt":true}' | native/axhelper/.build/release/axhelper check`.
  macOS shows its own dialog; click **Open System Settings**. Your terminal is already listed; turn it on.
- **Or open the pane directly:** `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"`
- **Manual path:** System Settings → **Privacy & Security** → scroll down past the Location
  Services / Contacts / Calendars list → **Accessibility**. (Don't use the top-level
  "Accessibility" sidebar item; that's VoiceOver, Zoom, etc., a different pane.)
- If your terminal isn't listed, click **+** (authenticate with Touch ID or your password) → choose your terminal app from
  /Applications (or /Applications/Utilities for Terminal) → make sure its toggle is **on**.
- Note: the Swift helper (`native/axhelper`) runs as a child of the terminal, so it inherits the
  terminal's grant. If you later run it from a different parent (e.g. a launchd agent), that
  parent needs the grant instead.
- **Check (after Phase 1 builds the helper):**
  ```sh
  npm run tool -- ui.check_access    # → "output": {"trusted": true}
  ```
  Without the grant, AX calls return `kAXErrorAPIDisabled` / `trusted:false`, and synthetic key
  events are silently dropped.

## 3. Screen Recording: later (only when `screenshot` gets wired to an agent)
Needed to capture window contents. Without it, screenshots show only the desktop wallpaper and
menu bar.

- **Path:** System Settings → **Privacy & Security** → **Screen & System Audio Recording**
  → under *Screen & System Audio Recording*, click **+** → add your terminal app → toggle **on**.
- macOS shows a periodic reminder that the app can record your screen. That's expected.
- **Check (Phase 1+):** `npm run screenshot` and open the PNG in `scratch/`. If it shows real windows, the permission is working.

## 4. Playwright browser: no OS permission needed
Playwright drives its own bundled Chromium, so no Automation or Accessibility grant is needed. The
first install downloads the browser to `~/Library/Caches/ms-playwright`. We'll ask before doing that.

---

### Revoking
Turn off the toggle under the same Privacy & Security pane, or click **–** to remove the app. Nothing in
this project depends on a permission staying on; tools will fail with a clear error instead.

// macOS checks privacy permissions (Microphone, Speech Recognition) against the "responsible" app: the
// one that started the process tree (Terminal, VS Code, …), using *its* Info.plist. Those apps don't
// declare speech recognition, so macOS would kill us on first use. So the helper re-launches itself as
// its own responsible process ("disclaimed"): macOS then reads our embedded Info.plist and asks the
// user about "overlay" itself. stdin/stdout/stderr are inherited, so the parent's pipes keep working.
import Darwin
import MachO

@_silgen_name("responsibility_spawnattrs_setdisclaim")
private func responsibility_spawnattrs_setdisclaim(_ attrs: UnsafeMutablePointer<posix_spawnattr_t?>, _ disclaim: Int32) -> Int32

private var disclaimedChild: pid_t = 0
private let DISCLAIM_ENV = "DESKPILOT_OVERLAY_DISCLAIMED"

/** In the original process: run a disclaimed copy of ourselves, wait for it and exit with its status. */
func relaunchDisclaimedIfNeeded() {
    if getenv(DISCLAIM_ENV) != nil { return }
    var pathBuf = [CChar](repeating: 0, count: Int(PATH_MAX))
    var size = UInt32(pathBuf.count)
    guard _NSGetExecutablePath(&pathBuf, &size) == 0 else { return }
    setenv(DISCLAIM_ENV, "1", 1)

    var attr: posix_spawnattr_t?
    posix_spawnattr_init(&attr)
    defer { posix_spawnattr_destroy(&attr) }
    guard responsibility_spawnattrs_setdisclaim(&attr, 1) == 0 else { return }

    let args = CommandLine.arguments.map { strdup($0) } + [nil]
    defer { args.forEach { free($0) } }
    var pid: pid_t = 0
    guard posix_spawn(&pid, pathBuf, nil, &attr, args, environ) == 0 else {
        unsetenv(DISCLAIM_ENV)
        return // run as we are (push-to-talk may then be refused by macOS)
    }
    disclaimedChild = pid
    // Pass a stop request on to the copy.
    for sig in [SIGTERM, SIGINT, SIGHUP] {
        signal(sig) { s in
            if disclaimedChild > 0 { kill(disclaimedChild, s) }
            _exit(0)
        }
    }
    var status: Int32 = 0
    while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
    exit((status & 0x7f) == 0 ? (status >> 8) & 0xff : 1)
}

"""The desktop backend for the current OS (macOS now; Windows and Linux later)."""

import sys

from deskpilot.platform.types import DesktopBackend

#: Platforms that have a desktop backend. Tools that need one declare these.
DESKTOP_PLATFORMS: tuple[str, ...] = ("darwin",)

_test_backend: DesktopBackend | None = None


def set_backend_for_tests(backend: DesktopBackend | None) -> None:
    """Tests only: route desktop calls to a fake backend (None restores the real one)."""
    global _test_backend
    _test_backend = backend


def desktop_backend() -> DesktopBackend | None:
    if _test_backend is not None:
        return _test_backend
    if sys.platform == "darwin":
        from deskpilot.platform.macos import MacosBackend

        return MacosBackend()
    return None


def require_backend() -> DesktopBackend:
    backend = desktop_backend()
    if backend is None:
        msg = f"no desktop backend for {sys.platform} yet"
        raise RuntimeError(msg)
    return backend

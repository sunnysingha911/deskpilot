"""Where keys live.

- Control plane signing key: a file readable only by the API user (in Docker: the API's data volume).
- Runner device key: the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
  via `keyring`; never a plain file. Tests use an in-memory store.
- Runner settings that aren't secret (CP URL, runner id, pinned CP key): data/runner/runner.json.
"""

import contextlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Protocol

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from deskpilot.runner import protocol as p

KEYRING_SERVICE = "deskpilot-runner"


def load_or_create_cp_key(path: Path) -> Ed25519PrivateKey:
    """The control plane's signing key (created on first use, 0600)."""
    if path.exists():
        return p.load_private(path.read_text().strip())
    path.parent.mkdir(parents=True, exist_ok=True)
    key = p.new_key()
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(p.private_b64(key))
    return key


def key_id(key: Ed25519PrivateKey) -> str:
    return p.fingerprint(p.public_b64(key)).replace("-", "")[:8].lower()


class SecretStore(Protocol):
    def get(self, name: str) -> str | None: ...
    def set(self, name: str, value: str) -> None: ...
    def delete(self, name: str) -> None: ...


class KeyringStore:
    """The OS keychain."""

    def get(self, name: str) -> str | None:
        import keyring

        return keyring.get_password(KEYRING_SERVICE, name)

    def set(self, name: str, value: str) -> None:
        import keyring

        keyring.set_password(KEYRING_SERVICE, name, value)

    def delete(self, name: str) -> None:
        import keyring
        from keyring.errors import PasswordDeleteError

        with contextlib.suppress(PasswordDeleteError):
            keyring.delete_password(KEYRING_SERVICE, name)


class MemoryStore:
    """For tests."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def get(self, name: str) -> str | None:
        return self.values.get(name)

    def set(self, name: str, value: str) -> None:
        self.values[name] = value

    def delete(self, name: str) -> None:
        self.values.pop(name, None)


@dataclass
class RunnerConfig:
    """Not secret: where the control plane is, who we are, and the CP key we pinned at pairing."""

    cp_url: str
    runner_id: str
    cp_pub: str
    cp_key_id: str
    label: str

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), indent=2) + "\n")

    @classmethod
    def load(cls, path: Path) -> RunnerConfig | None:
        if not path.exists():
            return None
        return cls(**json.loads(path.read_text()))


def device_key_name(runner_id: str) -> str:
    return f"device-key:{runner_id}"

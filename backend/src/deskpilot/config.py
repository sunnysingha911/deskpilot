"""Settings from the environment (and a .env file), validated once at startup.

Secrets (database password, provider API keys) come only from the environment; never from code or
committed files.
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/src/deskpilot/config.py → repo root
REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DESKPILOT_", env_file=(REPO_ROOT / ".env", ".env"), extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    #: Full URL (postgresql+asyncpg://user:pass@host:5432/db). If unset, built from the parts below, which
    #: match compose.yaml: the same DESKPILOT_DB_PASSWORD drives both.
    database_url: SecretStr | None = None
    db_password: SecretStr | None = None
    db_host: str = "127.0.0.1"
    db_port: int = 5432
    db_name: str = "deskpilot"
    db_user: str = "deskpilot"
    #: The API binds here. In Docker it listens on 0.0.0.0 inside the container, published on 127.0.0.1 only.
    host: str = "127.0.0.1"
    port: int = Field(default=8800, ge=1, le=65535)
    #: Local data (uploads, models, audio) on the host; the database lives in Postgres.
    data_dir: Path = REPO_ROOT / "data"
    #: Ollama on the host (from Docker: http://host.docker.internal:11434).
    ollama_url: str = "http://127.0.0.1:11434"
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    #: The web app's access token. Set in .env (DESKPILOT_UI_TOKEN) so the container and `deskpilot open` on the
    #: host agree; if unset, a random one is made per launch and printed.
    ui_token: SecretStr | None = None
    #: "runner": machine tools run on a paired desktop runner (Docker). "local": in this process (native dev, tests).
    tool_mode: Literal["runner", "local"] = "runner"
    #: Agent definitions (agents/*.json) and the built web app.
    agents_dir: Path = REPO_ROOT / "agents"
    ui_dist: Path = REPO_ROOT / "ui" / "dist"
    #: The port the browser uses, if it differs from the one we listen on (Docker port mapping).
    public_port: int | None = None
    #: Attached files (copies; never the user's originals). Default: <data_dir>/uploads.
    uploads_dir: Path | None = None
    #: Where provider keys entered in the web app are stored (write-only; read back only as "set / not set").
    #: Natively the repo's .env; in Docker a file in the API's data volume.
    secrets_file: Path = REPO_ROOT / ".env"

    @property
    def cp_key_path(self) -> Path:
        """The control plane's signing key (runners pin its public half at pairing)."""
        return self.data_dir / "keys" / "cp_signing.key"

    @property
    def runner_dir(self) -> Path:
        """On a runner's computer: its config, local policy and audit log."""
        return self.data_dir / "runner"

    @property
    def dsn(self) -> str:
        """The database URL (contains the password: never log it)."""
        if self.database_url:
            return self.database_url.get_secret_value()
        if not self.db_password:
            msg = "set DESKPILOT_DB_PASSWORD (or DESKPILOT_DATABASE_URL) in .env; see .env.example"
            raise RuntimeError(msg)
        pw = self.db_password.get_secret_value()
        return f"postgresql+asyncpg://{self.db_user}:{pw}@{self.db_host}:{self.db_port}/{self.db_name}"


def load_env_file(path: Path | None = None) -> None:
    """Put KEY=VALUE lines from the .env file into os.environ (provider keys for CLI runs). Existing
    environment variables win; values are never printed."""
    import os

    path = path or get_settings().secrets_file
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


@lru_cache
def get_settings() -> Settings:
    return Settings()

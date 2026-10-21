"""Files the user attaches to a task.

Each task gets its own folder, <uploads>/<set_id>/, holding copies of the files (never the user's
originals). Names are reduced to a safe basename so nothing can point outside the folder. Agents read
them through file.read (tools/file.py).
"""

import re
import shutil
import unicodedata
import uuid
from collections.abc import AsyncIterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Literal

from deskpilot.config import get_settings

MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_FILES = 10
SET_ID_RE = re.compile(r"^att-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$")

MIME = {
    ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
    ".json": "application/json", ".xml": "application/xml", ".yaml": "application/yaml", ".yml": "application/yaml",
    ".html": "text/html", ".htm": "text/html", ".log": "text/plain", ".pdf": "application/pdf", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic",
    ".svg": "image/svg+xml", ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".rtf": "application/rtf", ".odt": "application/vnd.oasis.opendocument.text", ".zip": "application/zip",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime",
}  # fmt: skip


class AttachmentError(Exception):
    def __init__(self, code: Literal["bad_set", "too_large", "too_many", "not_found", "empty"], message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Attachment:
    name: str
    size: int
    mime: str
    #: Absolute path of the copy in the upload folder.
    path: Path


@dataclass(frozen=True)
class AttachmentSet:
    id: str
    dir: Path
    files: list[Attachment]


def uploads_dir() -> Path:
    s = get_settings()
    return s.uploads_dir or s.data_dir / "uploads"


def mime_for(name: str) -> str:
    return MIME.get(Path(name).suffix.lower(), "application/octet-stream")


def safe_file_name(name: str) -> str:
    """A file name that is safe to create inside the upload folder: a plain basename, no path tricks."""
    n = PurePosixPath(name.replace("\\", "/")).name
    n = unicodedata.normalize("NFC", n)
    n = re.sub(r'[\x00-\x1f\x7f<>:"|?*/]', "_", n)
    n = re.sub(r"\s+", " ", n).strip().lstrip(".")
    if len(n) > 120:
        ext = Path(n).suffix[:16]
        n = n[: 120 - len(ext)] + ext
    return n or "file"


def new_set_id() -> str:
    return f"att-{datetime.now(UTC):%Y-%m-%d}-{uuid.uuid4().hex[:8]}"


def _set_dir(set_id: str) -> Path:
    if not SET_ID_RE.match(set_id):
        raise AttachmentError("bad_set", "invalid attachment set id")
    return uploads_dir() / set_id


def create_set() -> str:
    set_id = new_set_id()
    _set_dir(set_id).mkdir(parents=True)
    return set_id


def set_exists(set_id: str) -> bool:
    return bool(SET_ID_RE.match(set_id)) and _set_dir(set_id).is_dir()


def list_set(set_id: str) -> AttachmentSet:
    directory = _set_dir(set_id)
    if not directory.is_dir():
        raise AttachmentError("bad_set", "no such attachment set")
    files = [
        Attachment(p.name, p.stat().st_size, mime_for(p.name), p)
        for p in sorted(directory.iterdir(), key=lambda p: p.name)
        if not p.name.startswith(".") and p.is_file()
    ]
    return AttachmentSet(set_id, directory, files)


def _unique_name(directory: Path, name: str) -> str:
    """ "report.pdf" → "report (2).pdf" if that name is taken."""
    if not (directory / name).exists():
        return name
    stem, ext = Path(name).stem, Path(name).suffix
    i = 2
    while (directory / f"{stem} ({i}){ext}").exists():
        i += 1
    return f"{stem} ({i}){ext}"


def _check_room(s: AttachmentSet) -> None:
    if len(s.files) >= MAX_FILES:
        raise AttachmentError("too_many", f"at most {MAX_FILES} files per task")


def _too_large() -> AttachmentError:
    return AttachmentError("too_large", f"files can be at most {MAX_FILE_BYTES // 1024 // 1024} MB")


async def add_stream(set_id: str, name: str, body: AsyncIterable[bytes]) -> Attachment:
    """Store an uploaded stream (stops reading past the size limit)."""
    s = list_set(set_id)
    _check_room(s)
    final = _unique_name(s.dir, safe_file_name(name))
    part = s.dir / f".{uuid.uuid4().hex}.part"
    size = 0
    try:
        with part.open("xb") as f:
            async for chunk in body:
                size += len(chunk)
                if size > MAX_FILE_BYTES:
                    raise _too_large()
                f.write(chunk)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    if size == 0:
        part.unlink(missing_ok=True)
        raise AttachmentError("empty", "the file is empty")
    part.rename(s.dir / final)
    return Attachment(final, size, mime_for(final), s.dir / final)


def add_from_path(set_id: str, src: Path) -> Attachment:
    """Copy a local file in (CLI --file). The original is only read."""
    s = list_set(set_id)
    _check_room(s)
    if not src.is_file():
        raise AttachmentError("not_found", f"{src} is not a file")
    size = src.stat().st_size
    if size > MAX_FILE_BYTES:
        raise _too_large()
    final = _unique_name(s.dir, safe_file_name(src.name))
    shutil.copyfile(src, s.dir / final)
    return Attachment(final, size, mime_for(final), s.dir / final)


def get_attachment(set_id: str, name: str) -> Attachment:
    """One attached file by its stored name (exact match only)."""
    f = next((x for x in list_set(set_id).files if x.name == name), None)
    if f is None:
        raise AttachmentError("not_found", f"no attached file named '{name}'")
    return f


def remove_attachment(set_id: str, name: str) -> None:
    get_attachment(set_id, name).path.unlink()


def format_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"

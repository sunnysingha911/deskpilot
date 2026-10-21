"""The API's front door.

This server can make agents act on the computer, so:
- requests must target 127.0.0.1/localhost on our port (blocks DNS rebinding),
- cross-origin requests are refused,
- every /api call needs the access token (header, or ?t= for SSE),
- every response carries a strict Content-Security-Policy and related headers.
Runner endpoints authenticate themselves (pairing code / signed handshake) and the health check is public.
"""

import json
import secrets
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any
from urllib.parse import parse_qs

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

SECURITY_HEADERS = {
    "content-security-policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
}

#: Paths that don't take the UI token (they have their own authentication, or reveal nothing).
PUBLIC_PATHS = ("/api/v1/health", "/api/v1/runners/pair", "/api/v1/runners/ws")


class Security:
    def __init__(self, app: ASGIApp, token: str, public_port: int | None = None) -> None:
        self.app = app
        self.token = token.encode()
        self.public_port = public_port

    def _ports(self, scope: Scope) -> set[int]:
        server = scope.get("server")
        ports: set[int] = {int(server[1])} if server else set()
        if self.public_port:
            ports.add(self.public_port)
        return ports

    def _allowed_hosts(self, scope: Scope) -> set[str]:
        return {f"{h}:{p}" for p in self._ports(scope) for h in ("127.0.0.1", "localhost")}

    def _allowed_origins(self, scope: Scope) -> set[str]:
        return {f"http://{h}" for h in self._allowed_hosts(scope)}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        path: str = scope.get("path", "")

        async def deny(status: int, message: str) -> None:
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 4003, "reason": message})
                return
            body = json.dumps({"error": message}).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": status,
                    "headers": [
                        (b"content-type", b"application/json; charset=utf-8"),
                        *((k.encode(), v.encode()) for k, v in SECURITY_HEADERS.items()),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})

        # Only requests addressed to us on loopback (defeats DNS-rebinding attacks).
        if headers.get("host", "") not in self._allowed_hosts(scope):
            await deny(421, "bad host")
            return
        origin = headers.get("origin")
        if origin and origin not in self._allowed_origins(scope):
            await deny(403, "cross-origin request refused")
            return
        if path.startswith("/api/") and path not in PUBLIC_PATHS:
            given = headers.get("x-deskpilot-token") or (parse_qs(scope.get("query_string", b"").decode()).get("t") or [""])[0]
            if not secrets.compare_digest(given.encode(), self.token):
                await deny(401, "missing or wrong token")
                return

        async def with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                existing = {k.decode().lower() for k, _ in message.get("headers", [])}
                message["headers"] = [
                    *message.get("headers", []),
                    *((k.encode(), v.encode()) for k, v in SECURITY_HEADERS.items() if k not in existing),
                ]
            await send(message)

        await self.app(scope, receive, with_headers)

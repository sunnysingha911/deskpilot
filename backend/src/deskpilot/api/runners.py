"""Runner endpoints: pairing (HTTP) and the runner connection (WebSocket). See runner-protocol.md."""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, WebSocket
from pydantic import BaseModel, Field, StringConstraints

from deskpilot.runner import pairing
from deskpilot.runner import protocol as p
from deskpilot.runner.hub import RunnerHub

router = APIRouter(prefix="/api/v1/runners", tags=["runners"])

Short = Annotated[str, StringConstraints(min_length=1, max_length=128)]


class PairIn(BaseModel):
    code: Annotated[str, StringConstraints(min_length=4, max_length=16)]
    device_pub: Annotated[str, StringConstraints(min_length=40, max_length=64)]
    label: Short
    os: Short
    version: Short
    tools: list[Short] = Field(max_length=200)


class PairOut(BaseModel):
    runner_id: str
    status: str
    cp_pub: str
    cp_key_id: str
    cp_fingerprint: str
    runner_fingerprint: str


def _hub(request: Request | WebSocket) -> RunnerHub:
    hub: RunnerHub = request.app.state.hub
    return hub


@router.post("/pair")
async def pair(body: PairIn, request: Request) -> PairOut:
    """Use a one-time code (created by the user) to register this computer; it stays pending until approved."""
    hub = _hub(request)
    try:
        runner = await pairing.pair(pairing.PairRequest(**body.model_dump()))
    except pairing.PairingError as err:
        raise HTTPException(err.status, str(err)) from err
    cp_pub = p.public_b64(hub.cp_key)
    return PairOut(
        runner_id=runner.id,
        status=runner.status,
        cp_pub=cp_pub,
        cp_key_id=hub.cp_key_id,
        cp_fingerprint=p.fingerprint(cp_pub),
        runner_fingerprint=runner.fingerprint,
    )


@router.websocket("/ws")
async def runner_socket(ws: WebSocket) -> None:
    await _hub(ws).serve(ws)

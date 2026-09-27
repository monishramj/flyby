"""Onboard reflex process: /ws/reflex frames → fly eye → looming readout → command.

README Steps 6.1 and 6.4. The eye loads and warms up once at startup; each
episode resets it to that warmed state.
"""

from runtime import set_threads
from reflex.config import BENCH_FRAMES_DIR, CLOSED_LOOP_PATH, CPU_THREADS, PORT, REFLEX_DEVICE

set_threads(CPU_THREADS)

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import json
import logging
from pathlib import Path
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import numpy as np

from reflex.controller import Controller, load_theta
from reflex.frames import Frame, FrameError, Mode, decode_frame
from reflex.hexeye import load_layout
from reflex.looming import Readout, load_weights

BENCH_MODES = (Mode.BENCH_RECORD, Mode.BENCH_CLOSED)
_LAYOUT = load_layout()
COL_X, COL_Y = np.asarray(_LAYOUT["col_x"]), np.asarray(_LAYOUT["col_y"])
READOUT_WEIGHTS = load_weights()
THETA, THETA_CALIBRATED = load_theta()
log = logging.getLogger("reflex")

# One eye per process; its network state belongs to one episode at a time.
EYE_LOCK = asyncio.Lock()
_eye_owner: list = [None]


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.eye, app.state.eye_error = None, None
    try:
        from reflex.hexeye import FlyEye
        eye = await asyncio.to_thread(FlyEye, REFLEX_DEVICE)
        await asyncio.to_thread(eye.reset)  # one gray warm-up; episodes reuse it
        app.state.eye = eye
    except Exception as exc:  # optional fly extra or weights may be absent
        app.state.eye_error = f"{type(exc).__name__}: {exc}"
        log.error("Fly eye not loaded: %s", app.state.eye_error)
    yield


app = FastAPI(title="FlyBy reflex", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    eye = getattr(app.state, "eye", None)
    return {
        "service": "reflex", "status": "ready" if eye else "no_model", "model_ready": eye is not None,
        "theta": THETA, "theta_calibrated": THETA_CALIBRATED, "readout": "learned" if READOUT_WEIGHTS else "default", "error": getattr(app.state, "eye_error", None),
    }


class ProtocolError(ValueError):
    pass


@dataclass
class Episode:
    episode: int
    bracketed: bool
    readout: Readout
    controller: Controller
    params: dict = field(default_factory=dict)
    mode: Mode | None = None
    reflex_on: bool | None = None
    last_k: int | None = None
    ks: list[int] = field(default_factory=list)
    frames: list[np.ndarray] = field(default_factory=list)


class Session:
    """Per-connection state. At most one episode is active at a time."""

    def __init__(self, frames_dir: Path, closed_loop_path: Path, eye=None, theta: float = THETA):
        self.frames_dir = frames_dir
        self.closed_loop_path = closed_loop_path
        self.eye = eye
        self.theta = theta
        self.current: Episode | None = None

    def _new_episode(self, episode: int, bracketed: bool, params: dict | None = None) -> Episode:
        return Episode(episode, bracketed, Readout(COL_X, COL_Y, weights=READOUT_WEIGHTS), Controller(self.theta), params or {})

    async def on_frame(self, frame: Frame) -> dict:
        ep = self._validate(frame)
        if frame.mode == Mode.BENCH_RECORD:
            ep.ks.append(frame.k)
            ep.frames.append(frame.pixels.copy())
            return {"k": frame.k, "cmd": "none", "speed": None, "yaw_rate": None, "S": None, "dLR": None}
        if self.eye is None:
            raise ProtocolError("fly model not loaded; see /health")
        async with EYE_LOCK:
            if _eye_owner[0] is not ep:
                await asyncio.to_thread(self.eye.reset)
                _eye_owner[0] = ep
            drive, _ = await asyncio.to_thread(self.eye.step, frame.pixels)
        S, dLR = ep.readout.update(drive)
        command = ep.controller.step(frame.k, S, dLR, frame.reflex_on, frame.goal_bearing, frame.goal_dist)
        return {"k": frame.k, **command, "S": S, "dLR": dLR}

    def _validate(self, frame: Frame) -> Episode:
        ep = self.current
        if frame.mode in BENCH_MODES:
            if ep is None or not ep.bracketed or ep.episode != frame.episode:
                raise ProtocolError(f"bench frame for episode {frame.episode} outside episode.begin/end")
        elif ep is None or ep.episode != frame.episode:
            if ep is not None and ep.bracketed:
                raise ProtocolError(f"episode {ep.episode} is still open")
            ep = self.current = self._new_episode(frame.episode, bracketed=False)
        if ep.mode is None:
            ep.mode, ep.reflex_on = frame.mode, frame.reflex_on
        elif (frame.mode, frame.reflex_on) != (ep.mode, ep.reflex_on):
            raise ProtocolError("mode and reflex_on cannot change within an episode")
        if ep.last_k is not None and frame.k <= ep.last_k:
            raise ProtocolError(f"k must increase: got {frame.k} after {ep.last_k}")
        ep.last_k = frame.k
        return ep

    def on_text(self, msg: dict) -> dict:
        kind, episode = msg.get("type"), msg.get("episode")
        if kind not in ("episode.begin", "episode.end"):
            raise ProtocolError(f"unknown message type {kind!r}")
        if isinstance(episode, bool) or not isinstance(episode, int) or not 0 <= episode < 2**32:
            raise ProtocolError("episode must be a u32 integer")
        if kind == "episode.begin":
            params = msg.get("params", {})
            if not isinstance(params, dict):
                raise ProtocolError("params must be an object")
            if self.current is not None and self.current.bracketed:
                raise ProtocolError(f"episode {self.current.episode} is still open")
            self.current = self._new_episode(episode, bracketed=True, params=params)
        else:
            ep = self.current
            if ep is None or not ep.bracketed or ep.episode != episode:
                raise ProtocolError(f"episode.end for episode {episode} that is not open")
            result = msg.get("result", {})
            if not isinstance(result, dict):
                raise ProtocolError("result must be an object")
            self.current = None
            self._finish(ep, result)
        return {"ack": kind, "episode": episode}

    def _finish(self, ep: Episode, result: dict) -> None:
        if ep.mode == Mode.BENCH_RECORD:
            self.frames_dir.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(
                self.frames_dir / f"{ep.episode}.npz",
                frames=np.stack(ep.frames),
                k=np.asarray(ep.ks, dtype=np.uint32),
                reflex_on=np.bool_(ep.reflex_on),
                params=json.dumps(ep.params),
                result=json.dumps(result),
            )
        elif ep.mode == Mode.BENCH_CLOSED:
            self.closed_loop_path.parent.mkdir(parents=True, exist_ok=True)
            line = {"episode": ep.episode, "reflex_on": ep.reflex_on, "theta": self.theta,
                    "params": ep.params, "result": result}
            with self.closed_loop_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(line) + "\n")
        elif ep.mode is None:
            raise ProtocolError(f"episode {ep.episode} ended without frames")


@app.websocket("/ws/reflex")
async def ws_reflex(websocket: WebSocket) -> None:
    await websocket.accept()
    session = Session(BENCH_FRAMES_DIR, CLOSED_LOOP_PATH, getattr(websocket.app.state, "eye", None))
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                return
            t0 = time.perf_counter()
            try:
                if message.get("bytes") is not None:
                    reply = await session.on_frame(decode_frame(message["bytes"]))
                    reply["ms"] = (time.perf_counter() - t0) * 1000
                else:
                    try:
                        msg = json.loads(message.get("text") or "")
                    except json.JSONDecodeError as exc:
                        raise ProtocolError(f"invalid JSON: {exc.msg}") from None
                    if not isinstance(msg, dict):
                        raise ProtocolError("message must be a JSON object")
                    reply = session.on_text(msg)
            except (FrameError, ProtocolError) as exc:
                reply = {"error": str(exc)}
            await websocket.send_json(reply)
    except WebSocketDisconnect:
        return


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port)

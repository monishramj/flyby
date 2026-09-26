"""The live server: one mission, many viewers, no decisions on the network path."""
import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from server.config import settings
from server.grok.ask import ask
from server.mission.loop import MissionRun
from server.protocol import command_adapter, event
from server.store.writer import Writer

log = logging.getLogger("flyby")


class Mission:
    """Holds the single live run so a reset can swap it without dropping viewers."""

    def __init__(self, cfg=settings):
        self.cfg = cfg
        self.writer = Writer(cfg)
        self.runtime = None
        self.run: MissionRun | None = None
        self.viewers: set[WebSocket] = set()
        self.outbox: asyncio.Queue = asyncio.Queue()

    def load_runtime(self):
        if self.cfg.LIVE_POLICY == "rule":
            log.warning("Laya is loaded for logging only; README GATE T0.2 set the live policy to the rule.")
        try:
            from server.triage.laya_runtime import load
            self.runtime = load(self.cfg)
            log.info("Laya ready on %s", self.runtime.device)
        except Exception as exc:  # A missing model must not stop the mission.
            log.warning("Laya unavailable (%s); decisions use the rule fallback.", exc)

    def build(self, seed=None):
        self.run = MissionRun(self.cfg.DEMO_SEED if seed is None else seed, self.cfg,
                              runtime=self.runtime, writer=self.writer)
        self.run.subscribe(self.outbox.put_nowait)
        return self.run

    async def reset(self, seed=None):
        if self.run is not None:
            await self.run.stop()
        while not self.outbox.empty():
            self.outbox.get_nowait()
        run = self.build(seed)
        await self.broadcast(event("mission.snapshot", run.snapshot()))

    async def broadcast(self, message):
        for viewer in list(self.viewers):
            try:
                await viewer.send_json(message)
            except Exception:
                self.viewers.discard(viewer)

    async def pump(self):
        """Fan mission events out to viewers, and tick mission.state at WS_HZ."""
        interval = 1 / self.cfg.WS_HZ
        while True:
            try:
                message = await asyncio.wait_for(self.outbox.get(), timeout=interval)
                await self.broadcast(message)
            except TimeoutError:
                if self.run is not None:
                    await self.broadcast(event("mission.state", self.run.mission_state()))

    async def handle(self, raw):
        command = command_adapter.validate_python(raw)
        kind, payload = command.type, command.payload
        if self.run is None:
            return
        if kind == "mission.control":
            if payload.cmd == "start":
                await self.run.start()
            elif payload.cmd == "pause":
                self.run.pause()
            else:
                await self.reset(payload.seed)
        elif kind == "lead.approve":
            self.run.approve(payload.lead_id)
        elif kind == "lead.override":
            self.run.override(payload.lead_id, payload.action)
        elif kind == "inspect.result":
            self.run.inspect_result(payload.lead_id, payload.found, payload.collided)


@asynccontextmanager
async def lifespan(app: FastAPI):
    mission = app.state.mission = Mission(settings)
    await mission.writer.start()
    await asyncio.to_thread(mission.load_runtime)
    mission.build()
    pump = asyncio.create_task(mission.pump())
    try:
        yield
    finally:
        pump.cancel()
        with suppress(asyncio.CancelledError):
            await pump
        if mission.run is not None:
            await mission.run.stop()
        with suppress(Exception):
            await mission.writer.stop()


app = FastAPI(title="FlyBy Triage", lifespan=lifespan)


@app.websocket("/ws/mission")
async def mission_socket(socket: WebSocket):
    mission: Mission = socket.app.state.mission
    await socket.accept()
    mission.viewers.add(socket)
    try:
        if mission.run is not None:
            await socket.send_json(event("mission.snapshot", mission.run.snapshot()))
        while True:
            try:
                await mission.handle(await socket.receive_json())
            except (ValidationError, ValueError) as exc:
                await socket.send_json(event("error", {"message": f"Command rejected: {type(exc).__name__}"}))
    except WebSocketDisconnect:
        pass
    finally:
        mission.viewers.discard(socket)


class Question(BaseModel):
    question: str = Field(min_length=1, max_length=settings.ASK_MAX_QUESTION_CHARS)


@app.post("/api/ask")
async def ask_ground_control(body: Question):
    mission: Mission = app.state.mission
    if mission.run is None:
        raise HTTPException(503, "No mission is running.")
    return await ask(mission.run, body.question, cfg=mission.cfg)


@app.get("/api/truth")
async def truth():
    """Ground truth for the 3D view's debug toggle; the websocket snapshot stays truth-free."""
    mission: Mission = app.state.mission
    if mission.run is None:
        raise HTTPException(503, "No mission is running.")
    scene = mission.run.scenario.snapshot(include_truth=True)
    return {"run_id": mission.run.run_id, "subjects": scene["subjects"], "decoys": scene["decoys"]}


@app.get("/api/results/{name}")
async def results(name: str):
    path = (settings.RESULTS_DIR / name).resolve()
    if path.parent != settings.RESULTS_DIR.resolve() or not path.is_file():
        raise HTTPException(404, "No such results file.")
    return FileResponse(path)


@app.get("/api/health")
async def health():
    mission: Mission = app.state.mission
    return {"ok": True, "policy": mission.cfg.LIVE_POLICY, "parse_mode": mission.cfg.PARSE_MODE,
            "laya": mission.runtime is not None, "atlas": mission.writer.available,
            "run_id": None if mission.run is None else mission.run.run_id}


# Serving the built UI keeps a demo to one process; `npm run dev` still works via its proxy.
if settings.WEB_DIST.is_dir():
    app.mount("/", StaticFiles(directory=settings.WEB_DIST, html=True), name="web")

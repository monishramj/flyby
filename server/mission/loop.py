"""The mission lifecycle from README §1. Live and batch runs share this object."""
import asyncio
from copy import deepcopy
from datetime import UTC, datetime
from time import perf_counter
from uuid import uuid4

import numpy as np

from server.config import settings
from server.grok import briefs
from server.grok.parse import parse_intel
from server.incident.store import IncidentStore
from server.mission import intel_script
from server.mission.clock import SimClock
from server.mission.noise import Noise
from server.mission.scenario import generate
from server.mission.sweep import Sweep
from server.mission.truth import optimal_action
from server.triage.decide import Decider
from server.triage.fallback import ACTIONS, rule
from server.triage.state import build_state

TERMINAL = frozenset({"dispatched", "ignored", "resolved_empty"})
PENDING = frozenset({"awaiting_approval", "awaiting_human"})
HEARTBEAT_S = 1.0


class MissionRun:
    def __init__(self, seed, cfg=settings, *, policy=None, parse_mode=None, sim_human=False,
                 fast=False, runtime=None, writer=None, grok_client=None, run_id=None):
        self.seed, self.cfg = seed, cfg
        self.policy = policy or cfg.LIVE_POLICY
        self.parse_mode = parse_mode or cfg.PARSE_MODE
        self.sim_human, self.fast = sim_human, fast
        self.writer, self.grok_client = writer, grok_client
        self.run_id = run_id or f"{datetime.now(UTC):%Y%m%dT%H%M%S}-{seed}-{uuid4().hex[:6]}"
        self.scenario = generate(seed, cfg)
        self.sweep = Sweep(cfg)
        self.noise = Noise(self.scenario, np.random.default_rng(seed + 1))
        self.intel = intel_script.generate(self.scenario, np.random.default_rng(seed + 2))
        self.human_rng = np.random.default_rng(seed + 3)
        self.clock = SimClock(fast=fast, scale=cfg.LIVE_TIME_SCALE)
        self.incident = IncidentStore(self.run_id, self.scenario.gazetteer, cfg)
        self.incident.on_update(self.on_incident_update)
        self.decider = Decider(runtime, cfg)
        self.leads: dict[str, dict] = {}
        self.intel_log: dict[str, dict] = {}
        self.redecision_count = 0
        self._subscribers = []
        self._tasks: set[asyncio.Task] = set()
        self._coverage_mark = -1.0
        self._started = self._stopped = self._finished = False
        self._task = None

    # ---- events -------------------------------------------------------------

    def subscribe(self, callback):
        self._subscribers.append(callback)
        return lambda: self._subscribers.remove(callback)

    def _emit(self, kind, payload):
        for callback in list(self._subscribers):
            callback({"type": kind, "payload": payload})

    def _spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    # ---- public views -------------------------------------------------------

    def mission_state(self, *, cells=None):
        t = self.clock.now
        covered = self.sweep.covered_count(t)
        include = self._coverage_mark != covered if cells is None else cells
        state = {"t": round(t, 3), "drone": self.sweep.position_at(t),
                 "coverage_pct": round(self.sweep.coverage_pct(t), 2),
                 "running": self._started and not self.clock.paused and not self._finished,
                 "finished": self._finished}
        if include:
            self._coverage_mark = covered
            state["coverage_cells"] = self.sweep.coverage(t)["coverage_cells"]
        return state

    def public_lead(self, lead):
        return {key: deepcopy(value) for key, value in lead.items() if key not in ("truth", "human_token")}

    def snapshot(self):
        return {
            "run_id": self.run_id, "seed": self.seed,
            "scene": self.scenario.snapshot(include_truth=False),
            "leads": [self.public_lead(lead) for lead in self.leads.values()],
            "intel": [deepcopy(row) for row in self.intel_log.values()],
            "incident": self.incident.public(),
            "state": self.mission_state(cells=True),
            "config": {"DEMO_SEED": self.cfg.DEMO_SEED, "COVERAGE_CELL_M": self.cfg.COVERAGE_CELL_M,
                       "LIVE_POLICY": self.policy, "PARSE_MODE": self.parse_mode,
                       "TAU_ROUTE": self.cfg.TAU_ROUTE, "MAX_PASSES": self.cfg.MAX_PASSES,
                       "LIVE_TIME_SCALE": self.cfg.LIVE_TIME_SCALE, "SWEEP_DURATION_S": self.sweep.duration},
            "services": {"policy": self.policy, "parse_mode": self.parse_mode,
                         "persistence": "atlas" if self.writer and self.writer.available else "local"},
        }

    # ---- persistence --------------------------------------------------------

    def _persist_lead(self, lead):
        if self.writer is None:
            return
        document = {key: value for key, value in deepcopy(lead).items() if key != "human_token"}
        self.writer.put("leads", {"run_id": self.run_id, **document})

    def _persist_incident(self, picture):
        if self.writer is not None:
            self.writer.put("incidents", picture)

    # ---- run control --------------------------------------------------------

    async def start(self):
        if self._started:
            self.clock.resume()
            return
        self._started = True
        if self.writer is not None:
            self.writer.put("runs", {"run_id": self.run_id, "seed": self.seed,
                                     "kind": "batch" if self.fast else "live", "policy": self.policy,
                                     "parse_mode": self.parse_mode, "sim_human": self.sim_human,
                                     "config": self.cfg.public_dict(),
                                     "started_at": datetime.now(UTC).isoformat()})
        for capture in self.sweep.captures():
            self.clock.call_at(capture["t"], lambda capture=capture: self._on_capture(capture))
        for message in self.intel:
            self.clock.call_at(message["t"], lambda message=message: self._on_intel(message))
        if not self.fast:
            self.clock.call_at(HEARTBEAT_S, self._heartbeat)
        self._emit("mission.snapshot", self.snapshot())
        if self.fast:
            await self._run()
        else:
            self._task = asyncio.create_task(self._run())

    def pause(self):
        self.clock.pause()

    async def _run(self):
        try:
            await self.clock.run()
            while self._tasks:
                await asyncio.gather(*list(self._tasks), return_exceptions=True)
        finally:
            self._finished = True
            self._emit("mission.state", self.mission_state(cells=True))

    def _heartbeat(self):
        """A live clock stays alive while a lead still waits on a human click."""
        if self._stopped:
            return
        waiting = self._tasks or self.clock.now < self.sweep.duration or \
            any(lead["status"] not in TERMINAL for lead in self.leads.values())
        if waiting:
            self.clock.call_at(self.clock.now + HEARTBEAT_S, self._heartbeat)

    async def stop(self):
        self._stopped = True
        self.clock.pause()
        for task in list(self._tasks):
            task.cancel()
        if self._task is not None:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)
        self.decider.close()

    # ---- captures and decisions --------------------------------------------

    def _on_capture(self, capture):
        leads = self.noise.detect(capture)
        if self.fast:
            return self._decide_batch(leads)
        for lead in leads:
            self._register(lead)
            self._spawn(self._decide(lead))

    async def _decide_batch(self, leads):
        for lead in leads:
            self._register(lead)
            await self._decide(lead)

    def _register(self, lead):
        lead.setdefault("status", "captured")
        lead.setdefault("history", [])
        lead.setdefault("status_history", [])
        lead["human_token"] = lead.get("human_token", 0)
        self.leads[lead["lead_id"]] = lead
        lead["status_history"].append({"status": "captured", "t": round(self.clock.now, 3)})
        self._emit("lead.new", self.public_lead(lead))
        self._persist_lead(lead)

    def _build_state(self, lead):
        open_leads = sum(item["status"] not in TERMINAL for item in self.leads.values())
        mission = {"coverage_pct": round(self.sweep.coverage_pct(self.clock.now)), "open_leads": open_leads}
        return build_state(lead, self.incident.snapshot(), mission, leads=self.leads, cfg=self.cfg)

    async def _decide(self, lead, *, base=None):
        state = self._build_state(lead)
        base = lead["t_capture"] if base is None else base
        decision = await self.decider.decide(state, policy=self.policy)
        payload = decision.model_dump()
        t = base + decision.latency_ms / 1000 if self.fast else self.clock.now
        lead["state"] = state
        lead["decision"] = payload
        lead["baseline_rule"] = rule(state, self.cfg)["action"]
        lead["history"].append({**payload, "t": round(t, 3)})
        self._route(lead, payload, t)

    def _route(self, lead, decision, t):
        """The one place a decision becomes a status, for first and repeat decisions."""
        action = decision["action"]
        if decision["routed_to_human"]:
            status = "awaiting_human"
        elif action == "ignore":
            status = "ignored"
        elif action == "reimage_zoom":
            status = "reimaging" if lead["pass"] < self.cfg.MAX_PASSES else "awaiting_human"
        else:
            status = "awaiting_approval"
        self._set_status(lead, status, t=t, emit="lead.decided")
        if status == "reimaging":
            self.clock.call_at(t + self.cfg.T_REIMAGE_S, lambda: self._on_reimage(lead["lead_id"]))

    def _set_status(self, lead, status, *, t=None, emit="lead.status"):
        t = self.clock.now if t is None else t
        lead["status"] = status
        lead["human_token"] += 1
        lead["status_history"].append({"status": status, "t": round(t, 3)})
        payload = {"lead_id": lead["lead_id"], "status": status, "lead": self.public_lead(lead)}
        if emit == "lead.decided":
            payload["decision"] = lead["decision"]
        self._emit(emit, payload)
        self._persist_lead(lead)
        if self.sim_human and status in PENDING:
            delay = self.cfg.SIM_HUMAN_APPROVE_S if status == "awaiting_approval" else self.cfg.SIM_HUMAN_ROUTED_S
            token = lead["human_token"]
            self.clock.call_at(t + delay, lambda: self._on_sim_human(lead["lead_id"], token))

    def _on_reimage(self, lead_id):
        lead = self.leads[lead_id]
        if lead["status"] != "reimaging":
            return None
        zoomed = self.noise.recapture(lead)
        zoomed["t_capture"] = round(self.clock.now, 3)
        lead.update({key: zoomed[key] for key in ("pass", "t_capture", "detector_conf", "box_px")})
        self._emit("lead.new", self.public_lead(lead))
        if self.fast:
            return self._decide(lead)
        self._spawn(self._decide(lead))
        return None

    # ---- human decisions ----------------------------------------------------

    def approve(self, lead_id):
        lead = self.leads.get(lead_id)
        if lead is None or lead["status"] not in PENDING:
            return False
        return self._apply_human(lead, lead["decision"]["action"], kind="approve")

    def override(self, lead_id, action):
        lead = self.leads.get(lead_id)
        if lead is None or lead["status"] not in PENDING or action not in ACTIONS:
            return False
        return self._apply_human(lead, action, kind="override")

    def _apply_human(self, lead, action, *, kind):
        lead["human"] = {"kind": kind, "action": action, "t": round(self.clock.now, 3)}
        lead["final_action"] = action
        if action == "dispatch_ground_team":
            self._set_status(lead, "dispatched")
            self._spawn(self._dispatch(lead))
        elif action == "close_in_inspect":
            self._set_status(lead, "inspecting")
            self._emit("inspect.request", {"lead_id": lead["lead_id"]})
            self.clock.call_at(self.clock.now + self.cfg.T_INSPECT_S,
                               lambda: self._resolve_inspection(lead["lead_id"], None))
        elif action == "reimage_zoom" and lead["pass"] < self.cfg.MAX_PASSES:
            self._set_status(lead, "reimaging")
            self.clock.call_at(self.clock.now + self.cfg.T_REIMAGE_S, lambda: self._on_reimage(lead["lead_id"]))
        else:
            self._set_status(lead, "ignored")
        return True

    def _on_sim_human(self, lead_id, token):
        lead = self.leads.get(lead_id)
        if lead is None or lead["human_token"] != token or lead["status"] not in PENDING:
            return
        best = optimal_action(lead, self.cfg)
        if self.human_rng.random() < self.cfg.SIM_HUMAN_ACC:
            action = best
        else:
            others = [item for item in ACTIONS if item != best]
            action = str(self.human_rng.choice(others))
        self._apply_human(lead, action, kind="sim_human")

    async def _dispatch(self, lead):
        picture = self.incident.snapshot()
        if not self.fast and (self.parse_mode == "grok" or self.grok_client is not None):
            brief = await briefs.create_brief(lead, picture, gazetteer=self.scenario.gazetteer,
                                              t=round(self.clock.now, 3), cfg=self.cfg, client=self.grok_client)
        else:
            brief = briefs.template_brief(lead, picture, gazetteer=self.scenario.gazetteer,
                                          t=round(self.clock.now, 3))
        lead["dispatch"] = brief
        self._persist_lead(lead)
        self._emit("dispatch.created", {"lead_id": lead["lead_id"], "brief": brief,
                                        "pin": {"x": lead["x"], "y": lead["y"]}})

    def inspect_result(self, lead_id, found, collided=False):
        """Optional external hook; only a live run accepts an outside answer."""
        if self.fast:
            return False
        return self._resolve_inspection(lead_id, {"found": bool(found), "collided": bool(collided)}) is not False

    def _resolve_inspection(self, lead_id, external):
        lead = self.leads.get(lead_id)
        if lead is None or lead["status"] != "inspecting":
            return False
        found = lead["truth"]["is_person"] if external is None else external["found"]
        lead["inspection"] = {"found": found, "source": "external" if external else "truth",
                              "collided": bool(external and external["collided"]),
                              "t": round(self.clock.now, 3)}
        lead["inspection_found"] = found
        if not found:
            self._set_status(lead, "resolved_empty")
            return True
        decision = {**lead["decision"], "action": "dispatch_ground_team",
                    "probs": {key: float(key == "dispatch_ground_team") for key in ACTIONS},
                    "source": "inspection", "routed_to_human": False, "used_fallback": False}
        lead["decision"] = decision
        lead["history"].append({**decision, "t": round(self.clock.now, 3)})
        self._set_status(lead, "awaiting_approval", emit="lead.decided")
        return True

    # ---- intel and re-decision ---------------------------------------------

    def _on_intel(self, message):
        row = {"intel_id": message["intel_id"], "t": round(message["t"], 3), "raw": message["raw"]}
        self.intel_log[message["intel_id"]] = row
        self._emit("intel.new", deepcopy(row))
        if self.parse_mode == "grok":
            self._spawn(self._grok_intel(message))
            return None
        return self._apply_intel(message, message["oracle_parse"], ok=True, latency_ms=0.0)

    async def _grok_intel(self, message):
        started = perf_counter()
        try:
            parse = await parse_intel(message["raw"], self.scenario.gazetteer,
                                      cfg=self.cfg, client=self.grok_client)
        except Exception:
            latency = (perf_counter() - started) * 1000
            row = self.intel_log[message["intel_id"]]
            row.update(ok=False, latency_ms=round(latency, 1))
            self._emit("intel.parsed", {"intel_id": message["intel_id"], "ok": False, "parse": None})
            self._log_intel(message, None, latency, ok=False)
            return
        await self._apply_intel(message, parse.model_dump(mode="json"), ok=True,
                                latency_ms=(perf_counter() - started) * 1000)

    def _log_intel(self, message, parse, latency_ms, *, ok):
        if self.writer is None:
            return
        self.writer.put("intel", {"run_id": self.run_id, "intel_id": message["intel_id"],
                                  "t": round(message["t"], 3), "raw": message["raw"],
                                  "oracle_parse": message.get("oracle_parse"),
                                  "grok_parse": parse if self.parse_mode == "grok" else None,
                                  "latency_ms": round(latency_ms, 1), "ok": ok})

    async def _apply_intel(self, message, parse, *, ok, latency_ms):
        row = self.intel_log[message["intel_id"]]
        row.update(parse=deepcopy(parse), ok=ok, latency_ms=round(latency_ms, 1))
        self._emit("intel.parsed", {"intel_id": message["intel_id"], "parse": deepcopy(parse), "ok": ok})
        self._log_intel(message, parse, latency_ms, ok=ok)
        await self.incident.apply(parse, message["intel_id"], round(message["t"], 3))

    async def on_incident_update(self, picture):
        """T2.3: a pending lead whose built state changed is decided again."""
        self._emit("incident.update", self.incident.public())
        self._persist_incident(picture)
        for lead in list(self.leads.values()):
            if lead["status"] not in PENDING:
                continue
            state = self._build_state(lead)
            if state == lead.get("state"):
                continue
            self.redecision_count += 1
            await self._decide(lead, base=self.clock.now)


async def run_fast(seed, cfg=settings, **kwargs):
    run = MissionRun(seed, cfg, fast=True, **{"sim_human": True, **kwargs})
    try:
        await run.start()
    finally:
        await run.stop()
    return run

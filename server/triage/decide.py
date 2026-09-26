"""FIFO inference. Queue wait never spends a lead's inference timeout."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from time import perf_counter
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from server.config import settings
from server.triage.fallback import ACTIONS, Action, rule
from server.triage.laya_runtime import QUESTIONS, normalize


class Decision(BaseModel):
    action: Action
    probs: dict[Action, float]
    urgency: float | None = Field(default=None, ge=0, le=3)
    p_person: float | None = Field(default=None, ge=0, le=1)
    latency_ms: float = Field(ge=0)
    used_fallback: bool = False
    routed_to_human: bool = False
    source: Literal["laya", "rule"]
    version: int = 1

    @model_validator(mode="after")
    def valid_probs(self):
        if set(self.probs) != set(ACTIONS) or any(not 0 <= p <= 1 for p in self.probs.values()) or abs(sum(self.probs.values()) - 1) > 1e-3:
            raise ValueError("Expected a probability distribution over all four actions")
        return self


class Decider:
    def __init__(self, runtime=None, cfg=settings):
        self.runtime, self.cfg = runtime, cfg
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="laya")

    async def decide(self, state, *, policy="laya"):
        if policy not in ("laya", "rule"):
            raise ValueError("Unknown decision policy")
        start = perf_counter()
        fallback = False
        result = None
        if policy == "laya":
            loop = asyncio.get_running_loop()
            started = loop.create_future()

            def mark_started(value):
                if not started.done():
                    started.set_result(value)

            def infer():
                worker_start = perf_counter()
                loop.call_soon_threadsafe(mark_started, worker_start)
                if self.runtime is None:
                    raise RuntimeError("Laya unavailable")
                return self.runtime.system_one(state, QUESTIONS)

            future = loop.run_in_executor(self.pool, infer)
            # A timed-out torch call cannot be killed; the single worker stays occupied
            # until it returns, and the next lead's timeout starts after that return.
            future.add_done_callback(lambda done: None if done.cancelled() else done.exception())
            start = await asyncio.shield(started)
            try:
                remaining = max(0, self.cfg.LAYA_TIMEOUT_MS / 1000 - (perf_counter() - start))
                result = await asyncio.wait_for(asyncio.shield(future), timeout=remaining)
                result = normalize(result, result.get("latency_ms", (perf_counter() - start) * 1000))
            except (Exception, asyncio.TimeoutError):
                fallback = True
        elapsed = (perf_counter() - start) * 1000
        if result is not None and not fallback:
            answers = result["answers"]
            values = {"action": answers["action"]["choice"], "probs": answers["action"]["probabilities"],
                      "urgency": answers["urgency"]["score"], "p_person": answers["is_person"]["noul"]}
            source, elapsed = "laya", result["latency_ms"]
        else:
            values, source = rule(state, self.cfg), "rule"
        passes = state["lead"].get("passes", 1)
        routed = fallback or max(values["probs"].values()) < self.cfg.TAU_ROUTE or passes > self.cfg.MAX_PASSES or (passes == self.cfg.MAX_PASSES and values["action"] == "reimage_zoom")
        return Decision(**values, latency_ms=elapsed, used_fallback=fallback, routed_to_human=routed, source=source)

    def close(self):
        self.pool.shutdown(wait=True, cancel_futures=True)


_default = Decider()


async def decide(state, *, policy="laya"):
    return await _default.decide(state, policy=policy)

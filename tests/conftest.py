from server.config import Settings
from server.triage.fallback import ACTIONS


class FakeRuntime:
    """Stands in for Laya: deterministic answers derived from the state itself."""

    def __init__(self, *, action=None, confident=True, latency_ms=12.0, fail=False, delay=0.0):
        self.action, self.confident, self.latency_ms = action, confident, latency_ms
        self.fail, self.delay = fail, delay
        self.calls = []
        self.device = "fake"

    def system_one(self, state, questions=None):
        import time
        self.calls.append(state)
        if self.delay:
            time.sleep(self.delay)
        if self.fail:
            raise RuntimeError("fake runtime failure")
        lead = state["lead"]
        action = self.action or _expected(lead)
        top = 0.94 if self.confident else 0.34
        rest = (1 - top) / 3
        probs = {key: (top if key == action else rest) for key in ACTIONS}
        urgency = 3.0 if state["context"].get("sector_priority") == "critical" else 1.0
        return {"answers": {"action": {"choice": action, "probabilities": probs},
                            "urgency": {"score": urgency},
                            "is_person": {"noul": min(1.0, lead.get("detector_conf", 0.5) + .05)}},
                "latency_ms": self.latency_ms}


def _expected(lead):
    confidence, box = lead.get("detector_conf", 0), lead.get("box_px", 0)
    if lead.get("near_structure") and confidence < .75:
        return "close_in_inspect"
    if confidence < .45:
        return "ignore"
    if box < 20 or confidence < .6:
        return "reimage_zoom"
    return "dispatch_ground_team"


def fast_settings(**overrides):
    """Hermetic by default: no credentials, so no test can reach xAI or Atlas by accident."""
    return Settings(**{"LAYA_TIMEOUT_MS": 5_000, "PARSE_MODE": "oracle", "XAI_API_KEY": "",
                       "XAI_MODEL": "", "MONGODB_URI": "", **overrides})

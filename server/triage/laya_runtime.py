"""Local-only official Laya adapter. Acquisition belongs to tools.setup_laya."""
from math import isfinite
from time import perf_counter

from server.config import settings
from server.triage.fallback import ACTIONS


QUESTIONS = {
    "action": {
        "type": "choice",
        "instructions": "What should incident command do with this drone lead?",
        "criteria": {
            "dispatch_ground_team": "highly confident it is a person; send a crew",
            "reimage_zoom": "unsure, or the image is tiny; take a closer picture",
            "close_in_inspect": "unsure and next to a building or under a roof",
            "ignore": "not confident it is a person; ignore",
        },
    },
    "urgency": {"type": "score", "instructions": "How urgent is this lead?", "criteria": ["low", "moderate", "high", "critical"]},
    "is_person": {"type": "noul", "instructions": "Is this a real person?"},
}


def render(state):
    """Laya reads text, not JSON thresholds: say what the state means in plain words."""
    lead, context = state["lead"], state.get("context", {})
    words = {"high": "highly confident", "medium": "unsure", "low": "not confident"}[lead["detector_band"]]
    parts = [f"The detector is {words} ({round(lead['detector_conf'] * 100)}%) this is a person.",
             "It is next to a building or under a roof." if lead.get("near_structure") else "It is out in the open.",
             {"small": "The image is tiny.", "medium": "The image is clear.", "large": "The image is large and clear."}[lead["size_band"]]]
    if lead.get("passes", 1) > 1:
        parts.append("This is a zoomed second look.")
    if "sector_priority" in context:
        parts.append(f"The sector is {context['sector_priority']} priority.")
    if context.get("hazards_nearby"):
        parts.append("Nearby hazards: " + ", ".join(h.replace("_", " ") for h in context["hazards_nearby"]) + ".")
    if context.get("near_last_known_point"):
        parts.append("It is near the last known point of a missing person.")
    if context.get("reported_subjects_in_sector"):
        parts.append(f"{context['reported_subjects_in_sector']} people were reported in this sector.")
    return " ".join(parts)


def normalize(result, latency_ms):
    answers = result["answers"]
    if set(answers) != set(QUESTIONS):
        raise ValueError("Laya returned unexpected answer keys")
    probs = answers["action"]["probabilities"]
    if set(probs) != set(ACTIONS) or any(not isfinite(value) or not 0 <= value <= 1 for value in probs.values()):
        raise ValueError("Laya returned invalid action probabilities")
    total = sum(probs.values())
    if abs(total - 1) > 1e-3:
        raise ValueError("Laya action probabilities do not sum to one")
    answers["action"]["probabilities"] = {key: probs[key] / total for key in ACTIONS}
    if answers["action"]["choice"] not in ACTIONS:
        raise ValueError("Laya returned an unknown action")
    for value, maximum in ((answers["urgency"]["score"], 3), (answers["is_person"]["noul"], 1)):
        if not isfinite(value) or not 0 <= value <= maximum:
            raise ValueError("Laya returned an invalid typed answer")
    return {"answers": answers, "latency_ms": latency_ms}


class LayaRuntime:
    def __init__(self, agent):
        self.agent = agent
        self.device = str(agent.device)

    def system_one(self, state, questions=QUESTIONS):
        start = perf_counter()
        result = self.agent.system_one(render(state) if isinstance(state, dict) else state, questions)
        return normalize(result, (perf_counter() - start) * 1000)


def load(cfg=settings):
    directory = cfg.LAYA_MODEL_DIR.resolve()
    required = ("model.safetensors", "rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer.json")
    missing = [name for name in required if not (directory / name).is_file()]
    if missing:
        raise FileNotFoundError("Laya model is not installed. Run `uv run python -m tools.setup_laya`. Missing: " + ", ".join(missing))
    from laya import Agent
    agent = Agent(str(directory), device=cfg.LAYA_DEVICE, compile=False)
    if cfg.LAYA_SCORER:
        import torch
        # Only the scorer is fine-tuned on simulated search leads; the encoder and head are stock Laya.
        agent.model.scorer.load_state_dict(torch.load(cfg.LAYA_SCORER, map_location="cpu")["scorer"])
    return LayaRuntime(agent)

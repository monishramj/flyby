"""Local-only official Laya adapter. Acquisition belongs to tools.setup_laya."""
from math import isfinite
from copy import deepcopy
from time import perf_counter

from server.config import settings
from server.triage.fallback import ACTIONS


QUESTIONS = {
    "action": {
        "type": "choice",
        "instructions": "What should incident command do with this drone lead?",
        "criteria": {
            "dispatch_ground_team": "likely a real person who is clearly visible and reachable; send a crew",
            "reimage_zoom": "possibly a person but the image is small or partly hidden; take another zoomed pass",
            "close_in_inspect": "possibly a person inside or under a structure the overhead camera cannot see into",
            "ignore": "likely debris, an animal, a warm spot, or a false alarm",
        },
    },
    "urgency": {"type": "score", "instructions": "How urgent is this lead?", "criteria": ["low", "moderate", "high", "critical"]},
    "is_person": {"type": "noul", "instructions": "Is this lead a real person?"},
}


def questions_for_variant(index=0):
    questions = deepcopy(QUESTIONS)
    variants = (
        None,
        ("high detector confidence and a clear, adequately sized person detection; dispatch a rescue crew",
         "medium detector confidence, a small image, or partial visibility without a nearby structure; zoom and reimage",
         "medium detector confidence and near_structure is true: a possible person obscured by a structure; inspect closely",
         "low detector confidence indicates debris, an animal, or a false alarm; ignore"),
        ("detector_band is high: strong evidence of a visible person; send a ground team",
         "detector_band is medium and near_structure is false: uncertain or small person image; take a zoom pass",
         "detector_band is medium and near_structure is true: possible person under cover; close inspection",
         "detector_band is low: weak evidence and likely a false positive; ignore the detection"),
        ("high confidence or a clear second-pass image means rescue personnel should be dispatched",
         "uncertain first-pass detection with a small box and no structure needs another zoom image",
         "uncertain detection near a structure may hide a survivor and requires a close inspection",
         "weak low-confidence detection is probably an inanimate object or other false alarm"),
    )
    if not 0 <= index < len(variants):
        raise ValueError("Criteria variant must be 0–3")
    if variants[index] is not None:
        questions["action"]["criteria"] = dict(zip(ACTIONS, variants[index]))
    return questions


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
        result = self.agent.system_one(state, questions)
        return normalize(result, (perf_counter() - start) * 1000)


def load(cfg=settings):
    directory = cfg.LAYA_MODEL_DIR.resolve()
    required = ("model.safetensors", "rl_agent_config.json", "encoder/config.json", "tokenizer/tokenizer.json")
    missing = [name for name in required if not (directory / name).is_file()]
    if missing:
        raise FileNotFoundError("Laya model is not installed. Run `uv run python -m tools.setup_laya`. Missing: " + ", ".join(missing))
    from laya import Agent
    return LayaRuntime(Agent(str(directory), device=cfg.LAYA_DEVICE, compile=False))

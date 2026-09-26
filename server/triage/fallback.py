"""The declared deterministic baseline; it does not estimate person probability."""
from typing import Literal

from server.config import settings

Action = Literal["dispatch_ground_team", "reimage_zoom", "close_in_inspect", "ignore"]
ACTIONS = ("dispatch_ground_team", "reimage_zoom", "close_in_inspect", "ignore")


def rule(state, cfg=settings):
    lead = state["lead"]
    confidence = lead["detector_conf"]
    if confidence >= cfg.DETECTOR_HIGH:
        action = "dispatch_ground_team"
    elif confidence >= cfg.DETECTOR_LOW:
        action = "close_in_inspect" if lead.get("near_structure", False) else "reimage_zoom"
    else:
        action = "ignore"
    return {"action": action, "probs": {key: float(key == action) for key in ACTIONS}, "urgency": None, "p_person": None}

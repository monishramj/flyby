"""Evaluation-only optimal actions from README §4.4."""
from server.config import Settings, settings


def optimal_action(lead: dict, cfg: Settings = settings) -> str:
    truth = lead["truth"]
    if not truth["is_person"]:
        return "ignore"
    if truth.get("visibility") == "under_structure":
        return "close_in_inspect"
    if lead["pass"] == 1 and (truth.get("visibility") == "partial" or lead["box_px"] < cfg.SMALL_BOX_PX):
        return "reimage_zoom"
    return "dispatch_ground_team"

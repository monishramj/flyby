"""Build the public, ordered model state without exposing simulated truth."""
from math import hypot

from server.config import settings


def build_state(lead, picture, mission=None, *, leads=(), cfg=settings):
    mission = mission or {}
    public = {}
    conf = lead.get("detector_conf")
    if conf is not None:
        public["detector_conf"] = conf
        public["detector_band"] = "low" if conf < cfg.DETECTOR_LOW else "medium" if conf < cfg.DETECTOR_HIGH else "high"
    box = lead.get("box_px")
    if box is not None:
        public["box_px"] = box
        public["size_band"] = "small" if box < cfg.SMALL_BOX_PX else "medium" if box < cfg.LARGE_BOX_PX else "large"
    for key in ("altitude_m", "sector", "near_structure"):
        if lead.get(key) is not None:
            public[key] = lead[key]
    public["passes"] = lead.get("pass", lead.get("passes", 1))
    sector = lead.get("sector")
    context = {}
    point = picture.get("last_known_point")
    if point and all(key in lead and key in point for key in ("x", "y")):
        distance = hypot(lead["x"] - point["x"], lead["y"] - point["y"])
        context["dist_to_last_known_point_m"] = round(distance, 3)
        context["near_last_known_point"] = distance < cfg.NEAR_LKP_M
    priority = picture.get("sector_priority", {}).get(sector)
    if priority is not None:
        context["sector_priority"] = priority
    if "hazards" in picture and "x" in lead and "y" in lead:
        context["hazards_nearby"] = sorted({
            hazard["type"] for hazard in picture["hazards"]
            if hypot(lead["x"] - hazard["x"], lead["y"] - hazard["y"]) <= cfg.HAZARD_RADIUS_M
        })
    count = picture.get("reported_subjects", {}).get(sector)
    if count is not None:
        context["reported_subjects_in_sector"] = count
    values = list(leads.values()) if isinstance(leads, dict) else list(leads)
    context["confirmed_subjects_in_sector"] = sum(
        item.get("sector") == sector and item.get("status") == "dispatched" for item in values
    )
    mission_state = {key: mission[key] for key in ("coverage_pct", "open_leads") if mission.get(key) is not None}
    return {"lead": public, "context": context, "mission": mission_state}

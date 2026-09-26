"""Pure §4.6 merge. Grok proposes reports; only this code changes the picture."""
from copy import deepcopy

from server.config import Settings, settings
from server.mission.scenario import sector_of

URGENCY = ("low", "moderate", "high", "critical")


def empty(run_id: str) -> dict:
    return {"run_id": run_id, "reports": [], "sector_priority": {}, "reported_subjects": {},
            "hazards": [], "last_known_point": None}


def _sector_center(sector: str, cfg: Settings) -> tuple[float, float]:
    index = int(sector[1:]) - 1
    size = cfg.AREA_M / cfg.SECTOR_GRID
    return (index % cfg.SECTOR_GRID + 0.5) * size, (index // cfg.SECTOR_GRID + 0.5) * size


def _locate(report: dict, gazetteer: dict, cfg: Settings) -> tuple[str | None, float | None, float | None]:
    """A report is placed by its landmark when it has one, otherwise by sector center."""
    landmark = report.get("landmark")
    if landmark and landmark in gazetteer:
        point = gazetteer[landmark]
        return sector_of(point["x"], point["y"], cfg), float(point["x"]), float(point["y"])
    sector = report.get("sector")
    if sector:
        x, y = _sector_center(sector, cfg)
        return sector, x, y
    return None, None, None


def _matches(report: dict, retraction: dict) -> bool:
    for key in ("landmark", "sector"):
        if retraction.get(key) and report.get(key) == retraction[key]:
            return True
    return retraction["sector_of"] is not None and report["sector_of"] == retraction["sector_of"]


def _recompute(picture: dict, cfg: Settings) -> None:
    live = [report for report in picture["reports"] if not report["is_retraction"] and not report["retracted"]]
    picture["sector_priority"] = {}
    picture["reported_subjects"] = {}
    for report in live:
        sector = report["sector_of"]
        if sector is None:
            continue
        current = picture["sector_priority"].get(sector)
        if current is None or URGENCY.index(report["urgency"]) > URGENCY.index(current):
            picture["sector_priority"][sector] = report["urgency"]
        count = report.get("subject_count")
        if count is not None:
            picture["reported_subjects"][sector] = max(picture["reported_subjects"].get(sector, 0), count)
    hazards, seen = [], set()
    for report in live:
        if report["x"] is None:
            continue
        for hazard in report["hazards"]:
            key = (hazard, report["x"], report["y"])
            if key not in seen:
                seen.add(key)
                hazards.append({"type": hazard, "x": report["x"], "y": report["y"]})
    picture["hazards"] = hazards
    located = [report for report in live if report["x"] is not None]
    firsthand = [report for report in located if report["source"] == "firsthand"]
    named = [report for report in located if report.get("landmark")]
    chosen = max(firsthand or named, key=lambda report: report["t"], default=None)
    picture["last_known_point"] = None if chosen is None else {
        "landmark": chosen.get("landmark"), "x": chosen["x"], "y": chosen["y"], "t": chosen["t"]}


def apply(picture: dict, parse, intel_id: str, t: float, gazetteer: dict, cfg: Settings = settings) -> dict:
    """Return a new picture with this parse merged in; the input is left untouched."""
    result = deepcopy(picture)
    reports = parse if isinstance(parse, dict) else parse.model_dump(mode="json")
    for index, report in enumerate(reports.get("reports", [])):
        sector, x, y = _locate(report, gazetteer, cfg)
        entry = {**report, "report_id": f"{intel_id}-{index}", "intel_id": intel_id, "t": t,
                 "sector_of": sector, "x": x, "y": y, "retracted": False,
                 "is_retraction": bool(report.get("is_retraction")), "hazards": list(report.get("hazards", []))}
        entry.setdefault("source", "unverified")
        if entry["is_retraction"]:
            target = max((item for item in result["reports"]
                          if not item["is_retraction"] and not item["retracted"] and _matches(item, entry)),
                         key=lambda item: item["t"], default=None)
            if target is not None:
                target["retracted"] = True
                entry["retracts"] = target["report_id"]
        result["reports"].append(entry)
    _recompute(result, cfg)
    return result

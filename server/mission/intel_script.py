"""Synthetic radio reports paired with schema-valid oracle interpretations."""
from copy import deepcopy
import json
from math import hypot

import numpy as np

from server.config import ROOT
from server.incident.schemas import IntelParse
from server.mission.scenario import Scenario
from server.mission.sweep import Sweep


def generate(scenario: Scenario, rng: np.random.Generator) -> list[dict]:
    cfg = scenario.cfg
    templates = json.loads((ROOT / "data/intel_templates.json").read_text())
    normal = [t for t in templates if t.get("reports") and not t["reports"][0]["is_retraction"]]
    retraction = next(t for t in templates if t.get("reports") and t["reports"][0]["is_retraction"])
    vague = next(t for t in templates if t.get("unparseable"))
    count = int(rng.integers(cfg.INTEL_COUNT[0], cfg.INTEL_COUNT[1] + 1))
    if count < 2 or count > len(templates):
        raise ValueError("Intel count must accommodate retraction/vague templates and available messages")
    selected = [normal[int(i)] for i in rng.permutation(len(normal))[:count - 2]]
    selected.insert(len(selected) // 2, vague)
    selected.append(retraction)
    times = sorted(float(t) for t in rng.uniform(0, Sweep(cfg).duration, count))
    messages, earlier_locations = [], []
    for i, (template, t) in enumerate(zip(selected, times)):
        targeting = bool(scenario.subjects and rng.random() < cfg.RHO)
        if targeting:
            subject = scenario.subjects[int(rng.integers(len(scenario.subjects)))]
            sector = scenario.sector_of(subject["x"], subject["y"])
            landmark = min((key for key, p in scenario.gazetteer.items() if p["sector"] == sector),
                           key=lambda key: hypot(scenario.gazetteer[key]["x"] - subject["x"], scenario.gazetteer[key]["y"] - subject["y"]))
        else:
            landmark = str(rng.choice(list(scenario.gazetteer)))
            sector = scenario.gazetteer[landmark]["sector"]
        if template is retraction and earlier_locations:
            landmark, sector = earlier_locations[-1]
        values = {"landmark": landmark, "landmark_name": scenario.gazetteer[landmark]["name"], "sector": sector}
        reports = deepcopy(template.get("reports", []))
        for report in reports:
            for key in ("sector", "landmark"):
                if key in report:
                    report[key] = report[key].format(**values)
        parsed = IntelParse(reports=reports, unparseable=template.get("unparseable", False))
        messages.append({"intel_id": f"I{i + 1}", "t": t, "raw": template["raw"].format(**values),
                         "oracle_parse": parsed.model_dump(mode="json", exclude_none=True)})
        if reports and template is not retraction:
            earlier_locations.append((landmark, sector))
    return messages

"""Declared synthetic detector noise; no claims of measured detector quality."""
from copy import deepcopy

import numpy as np

from server.config import Settings
from server.mission.scenario import Scenario
from server.mission.sweep import contains


class Noise:
    def __init__(self, scenario: Scenario, rng: np.random.Generator, cfg: Settings | None = None):
        self.scenario, self.rng, self.cfg = scenario, rng, cfg or scenario.cfg
        self._seen: set[tuple[str, int]] = set()

    def detect(self, capture: dict) -> list[dict]:
        leads = []
        for obj in self.scenario.subjects + self.scenario.decoys:
            if (obj["id"], 1) in self._seen or not contains(capture, obj):
                continue
            is_person = "visibility" in obj
            category = obj["visibility"] if is_person else obj["type"]
            probability, mean = self.cfg.NOISE[category]
            if self.rng.random() >= probability:
                continue
            self._seen.add((obj["id"], 1))
            truth = {"is_person": is_person, "kind": "subject" if is_person else "decoy",
                     "type": "subject" if is_person else obj["type"]}
            if is_person:
                truth["visibility"] = obj["visibility"]
            leads.append({"lead_id": f"L-{obj['id']}", "object_id": obj["id"], "t_capture": capture["t"],
                          "x": obj["x"], "y": obj["y"], "sector": self.scenario.sector_of(obj["x"], obj["y"]),
                          "pass": 1, "detector_conf": float(np.clip(self.rng.normal(mean, self.cfg.CONF_STD), 0, 1)),
                          "box_px": self.cfg.OBJECT_SIZE_M[truth["type"]] / capture["footprint_m"] * self.cfg.IMAGE_WIDTH_PX,
                          "altitude_m": self.cfg.ALT_M, "near_structure": self.scenario.near_structure(obj["x"], obj["y"]),
                          "nearest_landmark": self.scenario.nearest_landmark(obj["x"], obj["y"]), "truth": truth})
        return leads

    def recapture(self, lead: dict) -> dict:
        if lead["pass"] >= self.cfg.MAX_PASSES:
            raise ValueError("Lead has already used its zoom pass")
        result = deepcopy(lead)
        result["pass"] += 1
        result["box_px"] *= self.cfg.REIMAGE_BOX_MULT
        kind = "subject" if lead["truth"]["is_person"] else "decoy"
        result["detector_conf"] = float(np.clip(lead["detector_conf"] + self.cfg.REIMAGE_CONF_SHIFT[kind], 0, 1))
        return result

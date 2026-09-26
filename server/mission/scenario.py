"""Seeded flood scene. Object labels stay internal to simulation/evaluation."""
from copy import deepcopy
from dataclasses import dataclass
import json
from math import hypot

import numpy as np

from server.config import ROOT, Settings


def sector_of(x: float, y: float, cfg: Settings) -> str:
    if not 0 <= x <= cfg.AREA_M or not 0 <= y <= cfg.AREA_M:
        raise ValueError("Position is outside the mission area")
    size = cfg.AREA_M / cfg.SECTOR_GRID
    col, row = min(int(x / size), cfg.SECTOR_GRID - 1), min(int(y / size), cfg.SECTOR_GRID - 1)
    return f"S{row * cfg.SECTOR_GRID + col + 1}"


@dataclass
class Scenario:
    seed: int
    cfg: Settings
    gazetteer: dict
    houses: list[dict]
    water: list[dict]
    trees: list[dict]
    subjects: list[dict]
    decoys: list[dict]

    def sector_of(self, x: float, y: float) -> str:
        return sector_of(x, y, self.cfg)

    def nearest_landmark(self, x: float, y: float) -> str:
        return min(self.gazetteer, key=lambda key: hypot(self.gazetteer[key]["x"] - x, self.gazetteer[key]["y"] - y))

    def near_structure(self, x: float, y: float) -> bool:
        return any(hypot(max(abs(x - h["x"]) - h["width"] / 2, 0), max(abs(y - h["y"]) - h["height"] / 2, 0)) <= self.cfg.STRUCTURE_NEAR_M for h in self.houses)

    def snapshot(self, *, include_truth: bool = True) -> dict:
        scene = {"seed": self.seed, "area_m": self.cfg.AREA_M, "sector_grid": self.cfg.SECTOR_GRID,
                 "gazetteer": self.gazetteer, "houses": self.houses, "water": self.water, "trees": self.trees}
        if include_truth:
            scene.update(subjects=self.subjects, decoys=self.decoys)
        return deepcopy(scene)


def generate(seed: int, cfg: Settings) -> Scenario:
    rng = np.random.default_rng(seed)
    gazetteer = json.loads((ROOT / "data/gazetteer.json").read_text())
    houses = [{"id": key, "x": p["x"], "y": p["y"], "width": cfg.HOUSE_SIZE_M[0],
               "height": cfg.HOUSE_SIZE_M[1], "kind": "house"} for key, p in gazetteer.items()]
    houses[1].update(kind="carport", width=cfg.CARPORT_SIZE_M[0], height=cfg.CARPORT_SIZE_M[1])
    # Scene geometry is expressed relative to the configured area.
    water = [{"x": cfg.AREA_M * .72, "y": 0, "width": cfg.AREA_M * .12, "height": cfg.AREA_M}]
    trees = [{"x": p["x"] - cfg.HOUSE_SIZE_M[0], "y": p["y"], "radius": cfg.TREE_RADIUS_M}
             for p in gazetteer.values()]
    n_subjects = int(rng.integers(cfg.N_SUBJECTS[0], cfg.N_SUBJECTS[1] + 1))
    n_decoys = int(rng.integers(cfg.N_DECOYS[0], cfg.N_DECOYS[1] + 1))
    visibilities = ["visible", "partial", "under_structure"]
    visibility = (visibilities + rng.choice(visibilities, max(0, n_subjects - len(visibilities))).tolist())[:n_subjects]
    rng.shuffle(visibility)
    subjects = []
    for i, kind in enumerate(visibility):
        x, y = rng.uniform(cfg.SCENE_MARGIN_M, cfg.AREA_M - cfg.SCENE_MARGIN_M, 2)
        if kind == "under_structure":
            house = houses[int(rng.integers(len(houses)))]
            x, y = house["x"], house["y"]
        subjects.append({"id": f"P{i + 1}", "x": float(x), "y": float(y), "visibility": kind})
    decoy_types = [name for name in cfg.OBJECT_SIZE_M if name != "subject"]
    decoys = []
    for i in range(n_decoys):
        x, y = rng.uniform(cfg.SCENE_MARGIN_M, cfg.AREA_M - cfg.SCENE_MARGIN_M, 2)
        decoys.append({"id": f"D{i + 1}", "x": float(x), "y": float(y), "type": str(rng.choice(decoy_types))})
    return Scenario(seed, cfg, gazetteer, houses, water, trees, subjects, decoys)

"""Square camera footprints along a lawnmower sweep."""
from copy import deepcopy
from math import ceil, radians, tan

import numpy as np

from server.config import Settings


class Sweep:
    def __init__(self, cfg: Settings):
        self.cfg = cfg
        self.footprint_m = 2 * cfg.ALT_M * tan(radians(cfg.FOV_DEG / 2))
        n_lanes = ceil(cfg.AREA_M / cfg.LANE_SPACING_M)
        margin = (cfg.AREA_M - (n_lanes - 1) * cfg.LANE_SPACING_M) / 2
        points = []
        for lane in range(n_lanes):
            x = margin + lane * cfg.LANE_SPACING_M
            ends = (margin, cfg.AREA_M - margin) if lane % 2 == 0 else (cfg.AREA_M - margin, margin)
            points.extend([(x, ends[0]), (x, ends[1])])
        self.path = [{"x": x, "y": y} for x, y in points]
        self._points = np.array(points, dtype=float)
        self._times = np.r_[0., np.cumsum(np.linalg.norm(np.diff(self._points, axis=0), axis=1) / cfg.SWEEP_SPEED_MPS)]
        self.duration = float(self._times[-1])
        self._captures = []
        for lane in range(n_lanes):
            start, end = self._points[2 * lane:2 * lane + 2]
            length = float(np.linalg.norm(end - start))
            distances = np.arange(0, length + cfg.CAPTURE_SPACING_M / 2, cfg.CAPTURE_SPACING_M)
            for distance in distances:
                if distance > length:
                    continue
                pos = start + (end - start) * distance / length
                self._captures.append({"id": f"C{len(self._captures) + 1}",
                                       "t": float(self._times[2 * lane] + distance / cfg.SWEEP_SPEED_MPS),
                                       "x": float(pos[0]), "y": float(pos[1]), "footprint_m": self.footprint_m})
        centers = np.arange(cfg.COVERAGE_CELL_M / 2, cfg.AREA_M, cfg.COVERAGE_CELL_M)
        x, y = np.meshgrid(centers, centers)
        self._cells = np.column_stack((x.ravel(), y.ravel()))
        self._covered_at = np.full(len(self._cells), np.inf)
        for capture in self._captures:
            inside = np.max(np.abs(self._cells - [capture["x"], capture["y"]]), axis=1) <= self.footprint_m / 2
            self._covered_at[inside] = np.minimum(self._covered_at[inside], capture["t"])

    def position_at(self, t: float) -> dict:
        return {"x": float(np.interp(t, self._times, self._points[:, 0])),
                "y": float(np.interp(t, self._times, self._points[:, 1]))}

    def captures(self) -> list[dict]:
        return deepcopy(self._captures)

    def covered_count(self, t: float) -> int:
        return int((self._covered_at <= t).sum())

    def coverage_pct(self, t: float) -> float:
        return self.covered_count(t) / len(self._cells) * 100

    def coverage(self, t: float) -> dict:
        mask = self._covered_at <= t
        return {"coverage_pct": float(mask.mean() * 100),
                "coverage_cells": [{"x": float(x), "y": float(y)} for x, y in self._cells[mask]]}


def contains(capture: dict, obj: dict) -> bool:
    return max(abs(capture["x"] - obj["x"]), abs(capture["y"] - obj["y"])) <= capture["footprint_m"] / 2

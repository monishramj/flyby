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
        # The plan as a GCS would upload it (MAVLink MISSION_ITEM_INT, simplified): camera trigger, then waypoints.
        self.mission = [{"seq": 1, "command": "DO_SET_CAM_TRIGG_DIST", "param1": cfg.CAPTURE_SPACING_M}] + [
            {"seq": i + 2, "command": "NAV_WAYPOINT", "x": x, "y": y, "alt": cfg.ALT_M} for i, (x, y) in enumerate(points)]
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

    def current_seq(self, t: float) -> int:
        """MISSION_CURRENT: the waypoint the drone is flying toward at sweep time t."""
        return min(int(np.searchsorted(self._times, t, side="right")), len(self._times) - 1) + 2

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


class Drone:
    """The one drone: flies the sweep, and breaks off for a visit (zoom or close-in inspect) when asked.

    A visit pauses the sweep, so every later capture happens `offset` seconds later than planned.
    """

    def __init__(self, sweep: Sweep, cfg: Settings):
        self.sweep, self.cfg = sweep, cfg
        self.offset = 0.0     # seconds the sweep has been paused by finished visits
        self.visit = None     # {kind, lead_id, legs: [(t, x, y)], done_t, resume_t, left_at}

    def position(self, t: float) -> dict:
        if self.visit and t < self.visit["resume_t"]:
            times, xs, ys = zip(*self.visit["legs"])
            return {"x": float(np.interp(t, times, xs)), "y": float(np.interp(t, times, ys))}
        return self.sweep.position_at(self.sweep_time(t))

    def sweep_time(self, t: float) -> float:
        """How far along the planned sweep the drone is; frozen while it is away on a visit."""
        return self.visit["left_at"] if self.visit and t < self.visit["resume_t"] else t - self.offset

    def plan_visit(self, t: float, lead: dict, kind: str) -> dict:
        start = self.position(t)
        leg = float(np.hypot(lead["x"] - start["x"], lead["y"] - start["y"])) / self.cfg.TRANSIT_SPEED_MPS
        hover = self.cfg.ZOOM_HOVER_S if kind == "reimage" else self.cfg.INSPECT_HOVER_S
        arrive, done = t + leg, t + leg + hover
        self.visit = {"kind": kind, "lead_id": lead["lead_id"], "left_at": self.sweep_time(t),
                      "legs": [(t, start["x"], start["y"]), (arrive, lead["x"], lead["y"]),
                               (done, lead["x"], lead["y"]), (done + leg, start["x"], start["y"])],
                      "arrive_t": arrive, "done_t": done, "resume_t": done + leg, "started_t": t}
        return self.visit

    def finish_visit(self) -> None:
        self.offset += self.visit["resume_t"] - self.visit["started_t"]
        self.visit = None

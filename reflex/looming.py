"""Looming score S and left/right imbalance dLR from T4/T5 motion drive.

Replaces the README §4.8 half-field readout (see docs/fly-connectome/STATUS.md).
An engineered layer on top of real flyvis T4/T5 output, modelled on the fly's
LPLC2 looming neurons; flyvis itself has no LPLC2 cells.

Hexagonal set of overlapping units. Each unit has four branches (left, right,
up, down of its own centre); a branch is excited by outward and inhibited by
inward motion on its side (radial motion opponency). Two pathways:
  2d:    all four branches must fire (geometric mean) — compact objects.
  horiz: left and right branches must fire — objects taller than the view.
Default rule: each of the 2d/horiz pathways is scaled by its largest response on
obstacle-free clips; S is the larger one; dLR is left units minus right units of
that pathway (> 0: more looming on the left).
Fitted rule (when bench/readout_weights.json exists, from tools/fit_readout.py),
two pathways that either can trigger a brake, like the giant fiber pooling
different looming inputs:
  cone:  outward − inward motion per column, relative to the image centre (the
         direction of travel), weighted by a Gaussian of radius CONE sigma. Edges
         that will hit the drone sit near the centre; things passing by do not.
  units: Σ w·log1p(feature/scale) + b over the EMA'd 7 units × 3 pathways.
S = max(cone / θ_cone, 1 + units − θ_units), so S > 1 means "brake". dLR comes
from the pathway that is higher: left side minus right side (> 0: turn right).
"""

import json
from pathlib import Path

import numpy as np

from reflex.config import (
    EMA_ALPHA, LPLC2_NORM_2D, LPLC2_NORM_HORIZ, LPLC2_RINGS, LPLC2_SPACING, READOUT_WEIGHTS_PATH,
)

DIRECTIONS = ("left", "right", "up", "down")  # row order of the drive array
OPPOSITE = (1, 0, 3, 2)


def unit_centers(rings: int = LPLC2_RINGS, spacing: float = LPLC2_SPACING) -> np.ndarray:
    return np.array([(spacing * (i + j / 2), spacing * j * np.sqrt(3) / 2)
                     for i in range(-rings, rings + 1) for j in range(-rings, rings + 1) if abs(i + j) <= rings])


class LoomingUnits:
    def __init__(self, col_x: np.ndarray, col_y: np.ndarray, rings: int = LPLC2_RINGS, spacing: float = LPLC2_SPACING):
        self.centers = unit_centers(rings, spacing)
        # weights[b]: (units, columns) averaging over the columns in branch b of each unit
        self.weights = np.zeros((4, len(self.centers), len(col_x)))
        for u, (cx, cy) in enumerate(self.centers):
            dx, dy = col_x - cx, col_y - cy
            r, ang = np.hypot(dx, dy), np.degrees(np.arctan2(dy, dx))
            inside = (r <= spacing) & (r > 1e-6)
            masks = (inside & (np.abs(ang) > 135), inside & (np.abs(ang) <= 45),
                     inside & (ang > 45) & (ang <= 135), inside & (ang < -45) & (ang >= -135))
            for b, m in enumerate(masks):
                self.weights[b, u, m] = 1.0 / m.sum()
        self.side = -np.sign(np.round(self.centers[:, 0], 9))  # +1 left of centre, −1 right, 0 middle

    def pathways(self, drive: np.ndarray) -> np.ndarray:
        """drive: (4, columns) rectified T4+T5 by preferred direction.
        Returns (3, units): 2d (all four branches), horiz (left+right), vert (up+down)."""
        g = np.maximum(np.einsum("buc,bc->bu", self.weights, drive)
                       - np.einsum("buc,bc->bu", self.weights, drive[list(OPPOSITE)]), 0)
        horiz, vert = np.sqrt(g[0] * g[1]), np.sqrt(g[2] * g[3])
        return np.stack([np.sqrt(horiz * vert), horiz, vert])

    def responses(self, drive: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        p = self.pathways(drive)
        return p[0], p[1]


def load_weights(path: Path = READOUT_WEIGHTS_PATH) -> dict | None:
    return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None


class Cone:
    """Radial (outward − inward) motion per column about the image centre, Gaussian-weighted."""

    def __init__(self, col_x: np.ndarray, col_y: np.ndarray, sigma: float):
        x, y = np.asarray(col_x), np.asarray(col_y)
        self.cols = np.arange(len(x))
        self.out_h, self.in_h = np.where(x > 0, 1, 0), np.where(x > 0, 0, 1)
        self.out_v, self.in_v = np.where(y > 0, 2, 3), np.where(y > 0, 3, 2)
        self.wh = np.abs(x) / np.maximum(np.abs(x) + np.abs(y), 1e-9)
        self.kernel = np.exp(-(x**2 + y**2) / (2 * sigma**2))
        self.side = -np.sign(x)  # +1 left half, −1 right half

    def radial(self, drive: np.ndarray) -> np.ndarray:
        c = self.cols
        qh = drive[self.out_h, c] - drive[self.in_h, c]
        qv = drive[self.out_v, c] - drive[self.in_v, c]
        return self.wh * qh + (1 - self.wh) * qv

    def score(self, drive: np.ndarray) -> tuple[float, float]:
        kq = self.kernel * self.radial(drive)
        return float(kq.sum()), float(kq @ self.side)


class Readout:
    def __init__(self, col_x: np.ndarray, col_y: np.ndarray, alpha: float = EMA_ALPHA, weights: dict | None = None):
        self.units = LoomingUnits(np.asarray(col_x), np.asarray(col_y))
        self.alpha = alpha
        self.weights = weights
        if weights is not None:
            n = len(self.units.centers)
            u = weights["units"]
            self._w = np.asarray(u["w"]).reshape(3, n)
            self._scale = np.asarray(u["scale"]).reshape(3, n)
            self._b, self._theta_u = float(u["b"]), float(u["theta"])
            self.cone = Cone(col_x, col_y, float(weights["cone"]["sigma"]))
            self._theta_c = float(weights["cone"]["theta"])
        self.reset()

    def reset(self) -> None:
        self._ema = np.zeros(4)  # S_2d, S_horiz, dLR_2d, dLR_horiz
        self._feat = np.zeros((3, len(self.units.centers)))
        self._cone = np.zeros(2)  # cone score, cone left−right
        self.S, self.dLR, self.pathway = 0.0, 0.0, "2d"

    def update(self, drive: np.ndarray) -> tuple[float, float]:
        if self.weights is not None:
            a = self.alpha
            self._feat = a * self.units.pathways(drive) + (1 - a) * self._feat
            self._cone = a * np.array(self.cone.score(drive)) + (1 - a) * self._cone
            contrib = self._w * np.log1p(self._feat / self._scale)
            s_units = 1.0 + float(contrib.sum() + self._b) - self._theta_u
            s_cone = self._cone[0] / self._theta_c
            if s_cone >= s_units:
                self.S, self.dLR, self.pathway = s_cone, self._cone[1] / self._theta_c, "cone"
            else:
                self.S, self.dLR, self.pathway = s_units, float(contrib.sum(0) @ self.units.side), "units"
            return float(self.S), float(self.dLR)
        r2d, rh = self.units.responses(drive)
        raw = np.array([r2d.sum(), rh.sum(), r2d @ self.units.side, rh @ self.units.side])
        self._ema = self.alpha * raw + (1 - self.alpha) * self._ema
        s2d, sh = self._ema[0] / LPLC2_NORM_2D, self._ema[1] / LPLC2_NORM_HORIZ
        if s2d >= sh:
            self.S, self.dLR, self.pathway = s2d, self._ema[2] / LPLC2_NORM_2D, "2d"
        else:
            self.S, self.dLR, self.pathway = sh, self._ema[3] / LPLC2_NORM_HORIZ, "horiz"
        return float(self.S), float(self.dLR)

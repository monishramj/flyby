"""Brake/swerve rules (README §4.8). Time is counted in frames (k), not wall clock."""

import json
from pathlib import Path

from reflex.config import BRAKE_LATCH_S, DT_S, THETA_UNCALIBRATED, THRESHOLDS_PATH


def load_theta(path: Path = THRESHOLDS_PATH) -> tuple[float, bool]:
    """(theta, calibrated). Falls back to the hand-set value until Step 8.2 writes the file."""
    if path.is_file():
        return float(json.loads(path.read_text(encoding="utf-8"))["theta"]), True
    return THETA_UNCALIBRATED, False


class Controller:
    def __init__(self, theta: float, latch_s: float = BRAKE_LATCH_S):
        self.theta = theta
        self.latch_frames = round(latch_s / DT_S)
        self.brake_until_k: int | None = None

    def step(self, k: int, S: float, dLR: float, reflex_on: bool) -> str:
        if not reflex_on:
            return "none"
        if S > self.theta:
            self.brake_until_k = k + self.latch_frames
        if self.brake_until_k is None or k >= self.brake_until_k:
            return "none"
        if abs(dLR) > 0.5 * self.theta:
            # dLR > 0: more looming on the left, so move right.
            return "brake_swerve_right" if dLR > 0 else "brake_swerve_left"
        return "brake"

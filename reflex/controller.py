"""Fly-inspired flight control. Time is counted in frames (k), not wall clock.

cruise:  fly at NAV_CRUISE_MPS, steering toward the goal (yaw ∝ sin(bearing), like
         the fly's heading-vs-goal steering neurons).
brake:   S > θ latches a stop for BRAKE_LATCH_S (re-latched while S stays high).
saccade: then a SACCADE_DEG yaw turn away from the looming side (dLR at brake
         onset), or toward the goal side when the side is unclear.
         Looming is ignored during the turn and for SACCADE_SUPPRESS_S after it,
         as flies suppress vision during saccades. Then cruise again.
arrived: within GOAL_RADIUS_M of the goal.
The first HOVER_S of an episode ignores looming: the scene's onset after the
gray warm-up is not approach (the scene hovers during this time).
These rules are an engineered control layer, not simulated fly neurons.
reflex_on=0 cruises toward the goal with no brake or saccade.
"""

import json
import math
from pathlib import Path

from reflex.config import (
    BRAKE_LATCH_S, DT_S, GOAL_RADIUS_M, GOAL_TURN_DPS, HOVER_S, NAV_CRUISE_MPS, SACCADE_DEG,
    SACCADE_RATE_DPS, SACCADE_SUPPRESS_S, THETA_UNCALIBRATED, THRESHOLDS_PATH,
)


def load_theta(path: Path = THRESHOLDS_PATH) -> tuple[float, bool]:
    """(theta, calibrated). Falls back to the hand-set value until Step 8.2 writes the file."""
    if path.is_file():
        return float(json.loads(path.read_text(encoding="utf-8"))["theta"]), True
    return THETA_UNCALIBRATED, False


class Controller:
    def __init__(self, theta: float, latch_s: float = BRAKE_LATCH_S):
        self.theta = theta
        self.latch_frames = round(latch_s / DT_S)
        self.saccade_frames = round(SACCADE_DEG / SACCADE_RATE_DPS / DT_S)
        self.suppress_frames = round(SACCADE_SUPPRESS_S / DT_S)
        self.state = "cruise"
        self.until_k = 0
        self.suppress_until_k = round(HOVER_S / DT_S)
        self.turn = 0.0  # +1 right, −1 left

    def _cmd(self, cmd: str, speed: float, yaw_dps: float) -> dict:
        return {"cmd": cmd, "speed": speed, "yaw_rate": yaw_dps}

    def step(self, k: int, S: float, dLR: float, reflex_on: bool,
             goal_bearing: float = 0.0, goal_dist: float = math.nan) -> dict:
        """yaw_rate in degrees/s, + = turn right. speed in m/s (target; the vehicle decelerates at A_BRAKE)."""
        if goal_dist < GOAL_RADIUS_M:
            self.state = "arrived"
            return self._cmd("arrived", 0.0, 0.0)
        cruise = self._cmd("none", NAV_CRUISE_MPS, GOAL_TURN_DPS * math.sin(goal_bearing))
        if not reflex_on:
            return cruise
        if self.state == "brake":
            if S > self.theta:
                self.until_k = k + self.latch_frames
            if k < self.until_k:
                return self._cmd("brake", 0.0, 0.0)
            self.state, self.until_k = "saccade", k + self.saccade_frames
        if self.state == "saccade":
            if k < self.until_k:
                side = "right" if self.turn > 0 else "left"
                return self._cmd(f"saccade_{side}", 0.0, self.turn * SACCADE_RATE_DPS)
            self.state, self.suppress_until_k = "cruise", k + self.suppress_frames
        if k >= self.suppress_until_k and S > self.theta:
            self.state, self.until_k = "brake", k + self.latch_frames
            if abs(dLR) > 0.5 * self.theta:
                self.turn = 1.0 if dLR > 0 else -1.0  # dLR > 0: looming on the left, turn right
            else:
                self.turn = 1.0 if goal_bearing >= 0 else -1.0
            return self._cmd("brake", 0.0, 0.0)
        return cruise

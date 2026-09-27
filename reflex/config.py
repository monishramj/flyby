"""Reflex constants. Unmeasured model parameters must remain unset."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = 8001
CPU_THREADS = 4
REFLEX_DEVICE = "cpu"  # Only CPU timings are measured so far.
FRAME_HZ = 50
DT_S = 1 / FRAME_HZ
FRAME_R = 96  # Step 0.4: accepted by BoxEye; resized internally to 391x391.
FRAME_R_TARGET = 96
SUBTYPE_DIR = {
    "T4a": "left", "T4b": "right", "T4c": "up", "T4d": "down",
    "T5a": "left", "T5b": "right", "T5c": "up", "T5d": "down",
}  # Measured with camera-space drifting gratings; see saved smoke report.
DRONE_RADIUS_M = 0.25
INSPECT_SPEED_MPS = (1.0, 3.0)
INSPECT_SPEED_PLANNED_MPS = 1.5  # needs 1.5/4 + 0.04 = 0.415 s warning; 3 m/s needs 0.79 s
A_BRAKE_MPS2 = 4.0
# Fly-inspired navigation (reflex/controller.py): cruise → brake → saccade → cruise.
NAV_CRUISE_MPS = INSPECT_SPEED_PLANNED_MPS
SACCADE_DEG = 90.0          # yaw turn after a brake, away from the looming side
SACCADE_RATE_DPS = 180.0    # a drone cannot match a fly's ~1000°/s saccades
SACCADE_SUPPRESS_S = 0.3    # looming ignored this long after a saccade (rotation flow)
GOAL_TURN_DPS = 60.0        # goal steering: yaw rate = GOAL_TURN_DPS · sin(goal bearing)
GOAL_RADIUS_M = 0.5         # arrived when closer than this
HOVER_S = 1.0               # each flight starts hovering; looming ignored meanwhile (scene onset)
BRAKE_LATCH_S = 0.5
EMA_ALPHA = 0.3
WARMUP_S = 2.0  # Measured: 0.5s leaves 0.241 drift; 2s leaves <0.00026 (CPU).
REST_WINDOW_S = 0.2
VIZ_HZ = 10
THRESHOLDS_PATH = ROOT / "bench" / "thresholds.json"
BENCH_FRAMES_DIR = ROOT / "bench" / "frames"
CLOSED_LOOP_PATH = ROOT / "bench" / "closed_loop.jsonl"
LAYOUT_PATH = ROOT / "data" / "flyvis_layout.json"
THETA: float | None = None  # No calibrated brake threshold yet.
# LPLC2-style looming units (reflex/looming.py): 7 units, one hex ring.
LPLC2_RINGS = 1
LPLC2_SPACING = 0.55  # unit spacing and radius, in col_x/col_y units
# Largest pathway response on obstacle-free 1.5 m/s corridor clips (90° FOV),
# results/readout_comparison_fov90_v1.5.json. Scales both pathways to one S.
LPLC2_NORM_2D = 0.0475
LPLC2_NORM_HORIZ = 0.1596
# Hand-set, NOT calibrated: 20% above the scaled obstacle-free maximum (1.0).
# Step 8.2 replaces it via THRESHOLDS_PATH.
THETA_UNCALIBRATED = 1.2
EXPECTED_NODES = 45_669
EXPECTED_TYPES = 65
EXPECTED_COLUMNS = 721
FRAME_HEADER_BYTES = 20  # README §4.7's 12 bytes + goal bearing and distance (f32 each)
VIZ_HEADER_BYTES = 16
FLYVIS_MODEL = "flow/0000/000"
FLYVIS_ROOT = ROOT / "data" / "checkpoints" / "flyvis"
FLYVIS_EXTENT = 15
FLYVIS_KERNEL_SIZE = 13
SMOKE_DIRECTIONS = ("left", "right", "up", "down")
SMOKE_GRATING_PERIOD_PX = 24
SMOKE_GRATING_SPEED_PX_S = 24
SMOKE_STIMULUS_S = 1.0
SMOKE_GRAY_S = 5.0
SMOKE_SPOT_S = 0.2
SMOKE_SPOT_CENTER = (0.55, 0.55)
SMOKE_SPOT_RADIUS = 0.15
SMOKE_DIRECTION_MARGIN = 0.02
SMOKE_GRAY_TOLERANCE = 0.01

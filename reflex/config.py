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
A_BRAKE_MPS2 = 4.0
SWERVE_MPS = 1.0
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
# Hand-set, NOT calibrated: just above the max S (0.177) seen on non-looming test
# stimuli (onsets, translation, contraction). Step 8.2 replaces it via THRESHOLDS_PATH.
THETA_UNCALIBRATED = 0.2
EXPECTED_NODES = 45_669
EXPECTED_TYPES = 65
EXPECTED_COLUMNS = 721
FRAME_HEADER_BYTES = 12
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

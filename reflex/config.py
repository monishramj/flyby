"""Reflex constants. Unmeasured model parameters must remain unset."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = 8001
CPU_THREADS = 4
FRAME_HZ = 50
DT_S = 1 / FRAME_HZ
FRAME_R: int | None = None  # Step 0.4 measures accepted input dimensions.
FRAME_R_TARGET = 96
SUBTYPE_DIR: dict[str, str] = {}  # Step 0.4 measures camera-image directions.
DRONE_RADIUS_M = 0.25
INSPECT_SPEED_MPS = (1.0, 3.0)
A_BRAKE_MPS2 = 4.0
SWERVE_MPS = 1.0
BRAKE_LATCH_S = 0.5
EMA_ALPHA = 0.3
WARMUP_S = 0.5
REST_WINDOW_S = 0.2
VIZ_HZ = 10
THRESHOLDS_PATH = ROOT / "bench" / "thresholds.json"
LAYOUT_PATH = ROOT / "data" / "flyvis_layout.json"
THETA: float | None = None  # No calibrated brake threshold yet.
EXPECTED_NODES = 45_669
EXPECTED_TYPES = 65
EXPECTED_COLUMNS = 721
FRAME_HEADER_BYTES = 12
VIZ_HEADER_BYTES = 16

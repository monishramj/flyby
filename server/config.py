"""Ground-station constants from README section 3; no clients on import."""

from pathlib import Path
from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[1]
PORT = 8000
CPU_THREADS = 4
AREA_M = 300
SECTOR_GRID = 3
ALT_M = 40
FOV_DEG = 60
LANE_SPACING_M = 40
CAPTURE_SPACING_M = 40
SWEEP_SPEED_MPS = 8
LIVE_TIME_SCALE = 4.0
N_SUBJECTS = (5, 8)
N_DECOYS = (10, 15)
SMALL_BOX_PX = 20
OBJECT_SIZE_M = {"subject": 1.7, "person_shaped_junk": 1.5, "animal": 0.8, "warm_spot": 1.0, "debris": 2.0}
NOISE = {
    "visible": (0.90, 0.75), "partial": (0.60, 0.55),
    "under_structure": (0.30, 0.40), "person_shaped_junk": (0.50, 0.45),
    "animal": (0.40, 0.45), "warm_spot": (0.30, 0.45), "debris": (0.15, 0.45),
}
CONFIDENCE_STD = 0.15
T_REIMAGE_S = 60
REIMAGE_BOX_MULT = 3.0
REIMAGE_CONF_SHIFT = {"subject": 0.20, "decoy": -0.10}
T_INSPECT_S = 90
TAU_ROUTE = 0.60
LAYA_TIMEOUT_MS = 500  # Replace after Monish measures local latency.
RHO = 0.9
INTEL_COUNT = (12, 15)
GROK_PARSE_TIMEOUT_S = 10
GROK_BRIEF_TIMEOUT_S = 8
GROK_ASK_TIMEOUT_S = 20
ASK_MAX_TOOL_ROUNDS = 4
SIM_HUMAN_ROUTED_S = 20
SIM_HUMAN_APPROVE_S = 5
HANDOFF_S = 60
REVIEW_S = (120, 10)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")
    XAI_API_KEY: SecretStr = SecretStr("")
    XAI_MODEL: str = ""
    MONGODB_URI: SecretStr = SecretStr("")


settings = Settings()

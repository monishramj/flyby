"""Simulation assumptions and operating constants. Secrets never enter run logs."""
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    AREA_M: int = 300
    SECTOR_GRID: int = 3
    ALT_M: float = 40
    FOV_DEG: float = 60
    LANE_SPACING_M: float = 40
    CAPTURE_SPACING_M: float = 40
    SWEEP_SPEED_MPS: float = 8
    LIVE_TIME_SCALE: float = 4.0
    N_SUBJECTS: tuple[int, int] = (5, 8)
    N_DECOYS: tuple[int, int] = (10, 15)
    OBJECT_SIZE_M: dict[str, float] = {"subject": 1.7, "person_shaped_junk": 1.5, "animal": 0.8, "warm_spot": 1.0, "debris": 2.0}
    NOISE: dict[str, tuple[float, float]] = {"visible": (0.90, 0.75), "partial": (0.60, 0.55), "under_structure": (0.30, 0.40), "person_shaped_junk": (0.50, 0.45), "animal": (0.40, 0.45), "warm_spot": (0.30, 0.45), "debris": (0.15, 0.45)}
    CONF_STD: float = 0.15
    IMAGE_WIDTH_PX: int = 640
    COVERAGE_CELL_M: float = 5
    STRUCTURE_NEAR_M: float = 10
    HOUSE_SIZE_M: tuple[float, float] = (18, 14)
    CARPORT_SIZE_M: tuple[float, float] = (24, 18)
    TREE_RADIUS_M: float = 4
    SCENE_MARGIN_M: float = 5
    SMALL_BOX_PX: float = 20
    LARGE_BOX_PX: float = 60
    DETECTOR_LOW: float = 0.45
    DETECTOR_HIGH: float = 0.75
    NEAR_LKP_M: float = 100
    HAZARD_RADIUS_M: float = 50
    ORDER_HAZARD_M: float = 150    # hazards this close can still shape a crew's approach
    ORDER_LANDMARK_M: float = 80   # landmarks named in a crew order
    MAX_PASSES: int = 2
    REIMAGE_BOX_MULT: float = 3.0
    REIMAGE_CONF_SHIFT: dict[str, float] = {"subject": 0.20, "decoy": -0.10}
    TRANSIT_SPEED_MPS: float = 12   # the drone cruises to a lead faster than it surveys
    ZOOM_HOVER_S: float = 10        # hover for the zoomed second photo
    INSPECT_HOVER_S: float = 80     # descend and look under cover; 20 s wall at x4 fits a ~10 s fly-reflex debris flight
    TAU_ROUTE: float = 0.50
    TAU_CLOSE: float = 0.60  # Laya must be this sure to auto-close; at 0.50 it closed 9 of 87 held-out people, at 0.60 one
    # Measured share of flags that were real people, by camera band and cover (docs/GATES.md, 1,191 states).
    # Calibrated by construction, so it ranks the queue; Laya's own P(person) is less reliable.
    PERSON_CHANCE: dict[str, float] = {"low/open": 0.13, "low/structure": 0.61, "medium/open": 0.47,
                                       "medium/structure": 0.76, "high/open": 0.96, "high/structure": 0.97}
    # Three times the p95 measured inside a mission by tools/laya_check.py (494 ms on CPU).
    LAYA_TIMEOUT_MS: float = 1500
    RHO: float = 0.9
    INTEL_COUNT: tuple[int, int] = (12, 15)
    GROK_PARSE_TIMEOUT_S: float = 10
    GROK_ORDER_TIMEOUT_S: float = 20  # measured 6–11 s; off the critical path, Approve never waits
    GROK_ASK_TIMEOUT_S: float = 20
    ASK_MAX_TOOL_ROUNDS: int = 4
    SIM_HUMAN_ROUTED_S: float = 20
    SIM_HUMAN_APPROVE_S: float = 5
    HANDOFF_S: float = 60
    SIM_HUMAN_ACC: float = 0.9
    WS_HZ: float = 10
    MONGO_TIMEOUT_MS: int = 1000
    MONGO_RETRY_S: float = 5
    ASK_MAX_LEADS: int = 100
    ASK_MAX_QUESTION_CHARS: int = 2000
    GROK_PROMPT_VERSION: str = "triage-v1"
    XAI_API_KEY: str = ""
    XAI_MODEL: str = ""
    MONGODB_URI: str = ""
    MONGODB_DATABASE: str = "flyby_triage"
    LAYA_MODEL_DIR: Path = ROOT / "models/laya"
    LAYA_MODEL_ID: str = "convaiinnovations/laya"
    LAYA_REVISION: str = "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851"
    LAYA_DEVICE: str = "cpu"
    LAYA_SCORER: str = ""  # path to a scorer from tools/laya_finetune.py; empty = stock Laya (fine-tuning did not help, docs/GATES.md)
    # GATE T0.2: Laya scored 0.25 on the twenty hand cases across all four criteria
    # rewordings, so the live policy is the rule. See docs/GATES.md.
    LIVE_POLICY: Literal["laya", "rule"] = "laya"
    PARSE_MODE: Literal["oracle", "grok"] = "grok"
    # T7: tools/demo_check.py --find-seed showed seed 7 routes leads to a human,
    # re-ranks the queue at t+99 s, and reaches three dispatches.
    DEMO_SEED: int = 7
    LOG_DIR: Path = ROOT / "logs"
    RESULTS_DIR: Path = ROOT / "results"
    WEB_DIST: Path = ROOT / "web/dist"

    def public_dict(self) -> dict:
        return self.model_dump(mode="json", exclude={"XAI_API_KEY", "MONGODB_URI"})


settings = Settings()

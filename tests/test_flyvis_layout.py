"""Check exported browser contract independently of model-loading dependencies."""

import json
from pathlib import Path
import numpy as np
from reflex import config as cfg


def test_exported_layout_is_complete_and_preserves_coordinates():
    layout = json.loads(cfg.LAYOUT_PATH.read_text())
    n = cfg.EXPECTED_NODES
    for key in ("node_type", "u", "v", "node_col"):
        assert len(layout[key]) == n
    assert len(layout["types"]) == cfg.EXPECTED_TYPES
    for key in ("col_u", "col_v", "col_x", "col_y"):
        assert len(layout[key]) == cfg.EXPECTED_COLUMNS
    columns = np.array(layout["node_col"])
    assert columns.min() == 0 and columns.max() == cfg.EXPECTED_COLUMNS - 1
    np.testing.assert_array_equal(np.array(layout["col_u"])[columns], layout["u"])
    np.testing.assert_array_equal(np.array(layout["col_v"])[columns], layout["v"])
    for key in ("col_x", "col_y"):
        assert np.isfinite(layout[key]).all()
        assert np.max(np.abs(layout[key])) <= 1
    for edge in layout["type_edges"]:
        assert edge["src"] in layout["types"] and edge["dst"] in layout["types"]
        assert edge["sign"] in (-1, 1)
        assert np.isfinite(edge["weight"]) and edge["weight"] > 0


def test_measured_config_matches_passing_report_and_layout():
    report = json.loads((cfg.ROOT / "docs/fly-connectome/measurements/cpu-smoke.json").read_text())
    layout = json.loads(cfg.LAYOUT_PATH.read_text())
    assert report["passed"] and report["orientation"]["passed"]
    assert report["frame_r"] == cfg.FRAME_R
    assert report["warmup_s"] == cfg.WARMUP_S
    assert report["subtype_dir"] == cfg.SUBTYPE_DIR == layout["subtype_dir"]
    assert report["gray_after_5s_max_deviation"] < cfg.SMOKE_GRAY_TOLERANCE
    assert layout["S_theta"] is None  # This is not a calibrated avoidance threshold.

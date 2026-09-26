import numpy as np
import pytest

from reflex import config as cfg
from reflex.hexeye import REGIONS, RegionIndex, load_layout

LAYOUT = load_layout()
HAS_WEIGHTS = (cfg.FLYVIS_ROOT / "results" / cfg.FLYVIS_MODEL / "_meta.yaml").is_file()


def test_regions_use_image_position_and_one_node_per_column():
    readout = RegionIndex(LAYOUT, cfg.SUBTYPE_DIR)
    col_x, col_y = np.array(LAYOUT["col_x"]), np.array(LAYOUT["col_y"])
    assert (col_x[readout.region_cols["L"]] < 0).all() and (col_x[readout.region_cols["R"]] > 0).all()
    assert (col_y[readout.region_cols["U"]] > 0).all() and (col_y[readout.region_cols["D"]] < 0).all()
    assert readout.index.shape == (4, 2, cfg.EXPECTED_COLUMNS)  # direction, T4/T5, column
    assert len(np.unique(readout.index)) == 8 * cfg.EXPECTED_COLUMNS


def test_energies_rectify_and_average_named_subtypes_over_region_columns():
    readout = RegionIndex(LAYOUT, cfg.SUBTYPE_DIR)
    types, node_type = LAYOUT["types"], np.array(LAYOUT["node_type"])
    node_col, col_x = np.array(LAYOUT["node_col"]), np.array(LAYOUT["col_x"])
    activity = np.full(cfg.EXPECTED_NODES, -5.0)  # negative values must rectify to zero
    left_cols = col_x < 0
    for name in ("T4a", "T5a"):  # measured: prefer leftward image motion
        nodes = np.flatnonzero(node_type == types.index(name))
        activity[nodes[left_cols[node_col[nodes]]]] = 1.5
    e = readout.energies(activity)
    assert e["L"] == {"out": 3.0, "in": 0.0}
    assert e["R"] == {"out": 0.0, "in": 0.0}
    assert set(e) == set(REGIONS)


def test_readout_rejects_incomplete_direction_map():
    partial = {k: v for k, v in cfg.SUBTYPE_DIR.items() if v != "down"}
    with pytest.raises(ValueError, match="left/right/up/down"):
        RegionIndex(LAYOUT, partial)


# ---- synthetic stimuli at FRAME_R, x right / y up, row 0 = top -------------

def grid():
    x = np.linspace(-1, 1, cfg.FRAME_R)
    return np.meshgrid(x, -x)


def disc(radius, center=(0.0, 0.0)):
    x, y = grid()
    img = np.full((cfg.FRAME_R, cfg.FRAME_R), 128, np.uint8)
    img[(x - center[0]) ** 2 + (y - center[1]) ** 2 <= radius**2] = 0
    return img


def texture(shift_px):
    rng = np.random.default_rng(0)
    base = rng.integers(0, 2, (cfg.FRAME_R // 4, cfg.FRAME_R * 2 // 4)).repeat(4, 0).repeat(4, 1) * 255
    return np.roll(base, shift_px, axis=1)[:, : cfg.FRAME_R].astype(np.uint8)


def run(eye, frames):
    eye.reset()
    rows = [eye.step(f)[0] for f in frames]
    return {r: {s: float(np.mean([row[r][s] for row in rows])) for s in ("out", "in")} for r in REGIONS}


N = round(1.0 / cfg.DT_S)
EXPANDING = [disc(0.1 + 0.8 * k / N) for k in range(N)]
CONTRACTING = EXPANDING[::-1]
RIGHTWARD = [texture(k) for k in range(N)]  # 1 px/frame = 50 px/s to the right


@pytest.fixture(scope="module")
def pretrained_eye():
    if not HAS_WEIGHTS:
        pytest.skip("pretrained flow/0000/000 not prepared (python -m tools.prepare_flyvis)")
    from reflex.hexeye import FlyEye
    return FlyEye("cpu")


@pytest.mark.slow
def test_untrained_network_plumbing_only():
    """Checks shapes, node order and persistent state; says nothing about model behavior."""
    flyvis = pytest.importorskip("flyvis")
    from reflex.hexeye import FlyEye

    eye = FlyEye("cpu", network=flyvis.Network())
    rest = eye.reset()
    assert rest.shape == (cfg.EXPECTED_NODES,) and np.isfinite(rest).all()
    energies, activity = eye.step(disc(0.3))
    assert activity.shape == rest.shape and set(energies) == set(REGIONS)
    np.testing.assert_array_equal(eye.deviation(), activity - rest)
    state_before = eye.state
    eye.step(disc(0.35))
    assert eye.state is not state_before and eye.last_ms > 0


@pytest.mark.slow
def test_expanding_disc_is_outward_in_all_regions(pretrained_eye):
    e = run(pretrained_eye, EXPANDING)
    assert all(e[r]["out"] > e[r]["in"] for r in REGIONS), e


@pytest.mark.slow
def test_contracting_disc_is_inward_in_all_regions(pretrained_eye):
    e = run(pretrained_eye, CONTRACTING)
    assert all(e[r]["in"] > e[r]["out"] for r in REGIONS), e


@pytest.mark.slow
def test_rightward_texture_drives_right_outward_and_left_inward(pretrained_eye):
    e = run(pretrained_eye, RIGHTWARD)
    assert e["R"]["out"] > e["R"]["in"] and e["L"]["in"] > e["L"]["out"], e


@pytest.mark.slow
def test_five_seconds_of_gray_stays_finite_near_rest(pretrained_eye):
    pretrained_eye.reset()
    gray = np.full((cfg.FRAME_R, cfg.FRAME_R), 128, np.uint8)
    for _ in range(round(5.0 / cfg.DT_S)):
        pretrained_eye.step(gray)
    assert np.abs(pretrained_eye.deviation()).max() < cfg.SMOKE_GRAY_TOLERANCE


@pytest.mark.slow
def test_cached_reset_matches_a_fresh_warm_up(pretrained_eye):
    import time
    frames = EXPANDING[:20]
    pretrained_eye.reset()
    cached = [pretrained_eye.step(f)[1] for f in frames]
    start = time.perf_counter()
    pretrained_eye.reset()
    assert time.perf_counter() - start < 0.01
    again = [pretrained_eye.step(f)[1] for f in frames]
    pretrained_eye._warm = None  # force a full gray warm-up
    pretrained_eye.reset()
    fresh = [pretrained_eye.step(f)[1] for f in frames]
    np.testing.assert_array_equal(np.stack(cached), np.stack(fresh))
    np.testing.assert_array_equal(np.stack(again), np.stack(fresh))

import json

import numpy as np
import pytest

from reflex import config as cfg
from reflex.controller import Controller, load_theta
from reflex.hexeye import load_layout
from reflex.looming import DIRECTIONS, Readout

THETA = cfg.THETA_UNCALIBRATED
LAYOUT = load_layout()
COL_X, COL_Y = np.array(LAYOUT["col_x"]), np.array(LAYOUT["col_y"])


def radial_drive(cx=0.0, cy=0.0, radius=0.5, gain=0.2, vertical=True):
    """Synthetic T4/T5 drive: outward motion from (cx, cy) within radius."""
    drive = np.zeros((4, len(COL_X)))
    dx, dy = COL_X - cx, COL_Y - cy
    near = np.hypot(dx, dy) <= radius
    horiz = np.abs(dx) >= np.abs(dy) if vertical else np.ones_like(near)
    for name, mask in (("left", dx < 0), ("right", dx > 0)):
        drive[DIRECTIONS.index(name)] = gain * (near & horiz & mask)
    if vertical:
        for name, mask in (("up", dy > 0), ("down", dy < 0)):
            drive[DIRECTIONS.index(name)] = gain * (near & ~horiz & mask)
    return drive


def settle(drive, n=20):
    ro = Readout(COL_X, COL_Y)
    for _ in range(n):
        S, dLR = ro.update(drive)
    return ro, S, dLR


def test_no_motion_gives_zero():
    _, S, dLR = settle(np.zeros((4, len(COL_X))))
    assert S == 0 and dLR == 0


def test_uniform_translation_is_rejected_by_both_pathways():
    drive = np.zeros((4, len(COL_X)))
    drive[DIRECTIONS.index("right")] = 1.0
    _, S, _ = settle(drive)
    assert S == 0


def test_compact_expansion_drives_the_2d_pathway_and_brakes():
    ro, S, dLR = settle(radial_drive())
    assert ro.pathway == "2d" and S > THETA
    assert Controller(THETA).step(0, S, dLR, True) == "brake"


def test_tall_bar_expansion_drives_the_horizontal_pathway():
    ro, S, _ = settle(radial_drive(vertical=False, radius=0.6))
    assert ro.pathway == "horiz" and S > THETA


def test_left_expansion_swerves_right_and_right_expansion_swerves_left():
    for cx, expected in ((-0.55, "brake_swerve_right"), (0.55, "brake_swerve_left")):
        ro, S, dLR = settle(radial_drive(cx=cx))
        assert S > THETA and np.sign(dLR) == -np.sign(cx)
        assert Controller(THETA).step(0, S, dLR, True) == expected


def test_brake_latch_holds_for_brake_latch_s():
    ctl = Controller(THETA)
    latch = round(cfg.BRAKE_LATCH_S / cfg.DT_S)
    assert ctl.step(100, THETA + 0.01, 0.0, True) == "brake"
    held = [ctl.step(100 + i, 0.0, 0.0, True) for i in range(1, latch + 2)]
    assert held[: latch - 1] == ["brake"] * (latch - 1)
    assert held[latch - 1:] == ["none", "none"]  # released at exactly BRAKE_LATCH_S


def test_reflex_off_never_brakes():
    ctl = Controller(THETA)
    assert all(ctl.step(k, 10.0, 10.0, reflex_on=False) == "none" for k in range(50))


def test_theta_comes_from_thresholds_file_when_present(tmp_path):
    assert load_theta(tmp_path / "missing.json") == (cfg.THETA_UNCALIBRATED, False)
    path = tmp_path / "thresholds.json"
    path.write_text(json.dumps({"theta": 0.123}))
    assert load_theta(path) == (0.123, True)


def approach(cx=0.0, d0=3.0, v=3.0, r0=0.1):
    """Black disc of fixed physical size approaching at v; image radius ∝ 1/distance."""
    x = np.linspace(-1, 1, cfg.FRAME_R)
    x, y = np.meshgrid(x, -x)
    frames, k = [], 0
    while (r := r0 * d0 / (d0 - v * k * cfg.DT_S)) < 1.0:  # stop once it spans the frame
        img = np.full((cfg.FRAME_R, cfg.FRAME_R), 128, np.uint8)
        img[(x - cx) ** 2 + y**2 <= r**2] = 0
        frames.append(img)
        k += 1
    return frames


@pytest.mark.slow
def test_brake_fires_before_expanding_disc_fills_frame():
    if not (cfg.FLYVIS_ROOT / "results" / cfg.FLYVIS_MODEL / "_meta.yaml").is_file():
        pytest.skip("pretrained weights not prepared")
    from reflex.hexeye import FlyEye

    eye, ro, ctl = FlyEye("cpu"), Readout(COL_X, COL_Y), Controller(cfg.THETA_UNCALIBRATED)
    eye.reset()
    frames = approach()
    cmds = [ctl.step(k, *ro.update(eye.step(f)[0]), True) for k, f in enumerate(frames)]
    assert "brake" in cmds, "no brake before the disc filled the frame"

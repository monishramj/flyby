import json

import numpy as np
import pytest

from reflex import config as cfg
from reflex.controller import Controller, load_theta
from reflex.looming import Readout

THETA = 0.2


def energies(L=0.0, R=0.0, U=0.0, D=0.0):
    return {r: {"out": max(q, 0.0), "in": max(-q, 0.0)} for r, q in zip("LRUD", (L, R, U, D))}


def test_readout_is_ema_of_summed_q_and_left_minus_right():
    ro = Readout(alpha=0.5)
    assert ro.update(energies(L=1.0, R=0.2, U=-0.4)) == pytest.approx((0.4, 0.4))
    assert ro.update(energies()) == pytest.approx((0.2, 0.2))


def test_left_dominant_expansion_swerves_right():
    ro, ctl = Readout(), Controller(THETA)
    for k in range(10):
        S, dLR = ro.update(energies(L=0.4, R=0.05, U=0.05, D=0.05))
        cmd = ctl.step(k, S, dLR, reflex_on=True)
    assert dLR > 0.5 * THETA and cmd == "brake_swerve_right"
    ro, ctl = Readout(), Controller(THETA)
    for k in range(10):
        S, dLR = ro.update(energies(R=0.4, L=0.05, U=0.05, D=0.05))
        cmd = ctl.step(k, S, dLR, reflex_on=True)
    assert cmd == "brake_swerve_left"


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

    eye, ro, ctl = FlyEye("cpu"), Readout(), Controller(cfg.THETA_UNCALIBRATED)
    eye.reset()
    frames = approach()
    cmds = [ctl.step(k, *ro.update(eye.step(f)[0]), True) for k, f in enumerate(frames)]
    assert "brake" in cmds, "no brake before the disc filled the frame"

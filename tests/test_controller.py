import json
import math

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
    assert Controller(THETA).step(HOVER, S, dLR, True)["cmd"] == "brake"


def test_tall_bar_expansion_drives_the_horizontal_pathway():
    ro, S, _ = settle(radial_drive(vertical=False, radius=0.6))
    assert ro.pathway == "horiz" and S > THETA


def test_left_expansion_gives_positive_dLR_and_right_negative():
    for cx in (-0.55, 0.55):
        _, S, dLR = settle(radial_drive(cx=cx))
        assert S > THETA and np.sign(dLR) == -np.sign(cx)


LATCH = round(cfg.BRAKE_LATCH_S / cfg.DT_S)
SACCADE = round(cfg.SACCADE_DEG / cfg.SACCADE_RATE_DPS / cfg.DT_S)
SUPPRESS = round(cfg.SACCADE_SUPPRESS_S / cfg.DT_S)


HOVER = round(cfg.HOVER_S / cfg.DT_S)


def run_ctl(ctl, S_of_k, dLR=0.0, n=100, bearing=0.0):
    """Steps after the hover window; S_of_k and the returned list are indexed from its end."""
    return [ctl.step(HOVER + k, S_of_k(k), dLR, True, bearing) for k in range(n)]


def test_looming_is_ignored_while_hovering():
    ctl = Controller(THETA)
    assert all(ctl.step(k, THETA + 1, THETA, True)["cmd"] == "none" for k in range(HOVER))
    assert ctl.step(HOVER, THETA + 1, THETA, True)["cmd"] == "brake"


def test_cruise_steers_toward_the_goal():
    c = Controller(THETA).step(0, 0.0, 0.0, True, goal_bearing=math.pi / 2, goal_dist=5.0)
    assert c == {"cmd": "none", "speed": cfg.NAV_CRUISE_MPS, "yaw_rate": pytest.approx(cfg.GOAL_TURN_DPS)}
    assert Controller(THETA).step(0, 0.0, 0.0, True, goal_bearing=-0.3)["yaw_rate"] < 0


def test_brake_latches_then_saccades_away_from_left_looming_then_cruises():
    out = run_ctl(Controller(THETA), lambda k: THETA + 1 if k == 10 else 0.0, dLR=THETA)
    cmds = [o["cmd"] for o in out]
    assert cmds[:10] == ["none"] * 10
    assert cmds[10:10 + LATCH] == ["brake"] * LATCH
    assert all(o["speed"] == 0 for o in out[10:10 + LATCH + SACCADE])
    turn = out[10 + LATCH:10 + LATCH + SACCADE]
    assert [o["cmd"] for o in turn] == ["saccade_right"] * SACCADE
    assert sum(o["yaw_rate"] for o in turn) * cfg.DT_S == pytest.approx(cfg.SACCADE_DEG)
    assert cmds[10 + LATCH + SACCADE] == "none"


def test_saccade_turns_toward_goal_side_when_looming_is_centred():
    out = run_ctl(Controller(THETA), lambda k: THETA + 1 if k == 0 else 0.0, dLR=0.0, bearing=-0.1)
    assert out[LATCH]["cmd"] == "saccade_left"


def test_brake_relatches_while_looming_stays_high():
    out = run_ctl(Controller(THETA), lambda k: THETA + 1 if k < 40 else 0.0)
    assert all(o["cmd"] == "brake" for o in out[: 39 + LATCH])
    assert out[39 + LATCH]["cmd"].startswith("saccade")


def test_looming_is_suppressed_during_and_just_after_the_saccade():
    end = LATCH + SACCADE
    out = run_ctl(Controller(THETA), lambda k: THETA + 1 if k == 0 or k > LATCH else 0.0)
    assert all(o["cmd"].startswith("saccade") for o in out[LATCH:end])
    assert all(o["cmd"] == "none" for o in out[end:end + SUPPRESS])
    assert out[end + SUPPRESS]["cmd"] == "brake"


def test_arrival_stops_the_drone():
    assert Controller(THETA).step(0, 99.0, 0.0, True, 0.0, goal_dist=0.1) == {"cmd": "arrived", "speed": 0.0, "yaw_rate": 0.0}


def test_reflex_off_never_brakes_or_saccades():
    ctl = Controller(THETA)
    assert all(ctl.step(k, 10.0, 10.0, False)["cmd"] == "none" for k in range(100))


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
    cmds = [ctl.step(HOVER + k, *ro.update(eye.step(f)[0]), True)["cmd"] for k, f in enumerate(frames)]
    assert "brake" in cmds, "no brake before the disc filled the frame"


def fitted(theta_units=1.0, theta_cone=1.0, sigma=0.1):
    n = len(Readout(COL_X, COL_Y).units.centers)
    w = np.zeros((3, n)); w[1] = 1.0  # horizontal pathway only
    return {"units": {"w": w.ravel().tolist(), "scale": [1.0] * (3 * n), "b": 0.0, "theta": theta_units},
            "cone": {"sigma": sigma, "theta": theta_cone}}


def test_fitted_readout_is_quiet_without_motion_and_ignores_translation():
    ro = Readout(COL_X, COL_Y, weights=fitted())
    S, _ = ro.update(np.zeros((4, len(COL_X))))
    assert S == 0.0  # 1 + 0 − θ_units(1) and cone 0
    drive = np.zeros((4, len(COL_X))); drive[DIRECTIONS.index("right")] = 1.0
    for _ in range(20):
        S, _ = ro.update(drive)
    assert S < 1.0


def test_centred_expansion_fires_the_cone_and_off_centre_left_expansion_turns_right():
    ro = Readout(COL_X, COL_Y, weights=fitted(theta_cone=0.05))
    for _ in range(20):
        S, dLR = ro.update(radial_drive(radius=0.3))
    assert ro.pathway == "cone" and S > 1.0
    ro = Readout(COL_X, COL_Y, weights=fitted(theta_units=0.05, theta_cone=1e9))
    for _ in range(20):
        S, dLR = ro.update(radial_drive(cx=-0.55, vertical=False, radius=0.5))
    assert ro.pathway == "units" and S > 1.0 and dLR > 0


COMMIT = round(cfg.COMMIT_S / cfg.DT_S)


def test_after_a_saccade_the_new_heading_is_held_before_goal_steering():
    out = run_ctl(Controller(THETA), lambda k: THETA + 1 if k == 0 else 0.0, dLR=THETA, n=200, bearing=-0.1)
    end = LATCH + SACCADE
    assert all(o["yaw_rate"] == 0.0 and o["speed"] == cfg.NAV_CRUISE_MPS for o in out[end:end + COMMIT])
    assert out[end + COMMIT]["yaw_rate"] < 0  # goal steering resumes toward the goal (left)


def test_a_brake_soon_after_a_saccade_turns_the_same_way_again():
    end = LATCH + SACCADE
    again = end + SUPPRESS + 5
    ctl = Controller(THETA)
    out = run_ctl(ctl, lambda k: THETA + 1 if k in (0, again) else 0.0, dLR=THETA, n=again + LATCH + 3)
    assert out[LATCH]["cmd"] == "saccade_right"
    # the second brake sees looming on the right (dLR < 0) but keeps turning right
    ctl2 = Controller(THETA)
    outs = [ctl2.step(HOVER + k, THETA + 1 if k in (0, again) else 0.0, THETA if k == 0 else -THETA, True) for k in range(again + LATCH + 3)]
    assert outs[again + LATCH]["cmd"] == "saccade_right"


def test_a_brake_with_the_goal_behind_turns_toward_the_goal_not_around():
    end = LATCH + SACCADE
    again = end + SUPPRESS + 5
    ctl = Controller(THETA)
    # first brake: looming on the left -> turn right; second brake soon after, goal now far to the left
    outs = [ctl.step(HOVER + k, THETA + 1 if k in (0, again) else 0.0, THETA if k == 0 else 0.0, True,
                     goal_bearing=0.0 if k < again else -2.5) for k in range(again + LATCH + 3)]
    assert outs[LATCH]["cmd"] == "saccade_right"
    assert outs[again + LATCH]["cmd"] == "saccade_left"


def test_looming_is_ignored_while_the_controller_itself_turns():
    ctl = Controller(THETA)
    # goal 45 degrees right: goal steering turns at ~42 deg/s, above YAW_BLIND_DPS
    assert ctl.step(HOVER, THETA + 1, 0.0, True, goal_bearing=0.8)["cmd"] == "none"
    ctl2 = Controller(THETA)
    assert ctl2.step(HOVER, THETA + 1, 0.0, True, goal_bearing=0.05)["cmd"] == "brake"  # nearly straight

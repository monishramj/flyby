"""Plot S traces from recorded carport flights (run after tools.calibrate_reflex).

Colliding flights are aligned to contact; safe flights to when the drone passes
under the carport's front edge (z = 0.3 m). Output: results/reflex_calibration.png
"""

import glob
import json

import matplotlib
import numpy as np

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

from reflex import config as cfg  # noqa: E402
from reflex.hexeye import FlyEye, load_layout  # noqa: E402
from reflex.looming import Readout  # noqa: E402
from tools.calibrate_reflex import replay  # noqa: E402

CRUISE_START_S = cfg.HOVER_S + cfg.NAV_CRUISE_MPS / 2.0  # scene accelerates at 2 m/s²


def z_at(k, start_z):
    t = k * cfg.DT_S
    accel = cfg.NAV_CRUISE_MPS / (CRUISE_START_S - cfg.HOVER_S)
    if t <= cfg.HOVER_S:
        return start_z
    if t <= CRUISE_START_S:
        return start_z - 0.5 * accel * (t - cfg.HOVER_S) ** 2
    return start_z - 0.5 * cfg.NAV_CRUISE_MPS * (CRUISE_START_S - cfg.HOVER_S) - cfg.NAV_CRUISE_MPS * (t - CRUISE_START_S)


def main():
    layout = load_layout()
    eye, ro = FlyEye("cpu"), Readout(np.array(layout["col_x"]), np.array(layout["col_y"]))
    theta = json.loads((cfg.ROOT / "results" / "reflex_calibration.json").read_text())["theta"]
    fig, axes = plt.subplots(5, 1, figsize=(10, 12), sharex=False)
    names = ["post", "beam", "debris", "clear", "near_post"]
    for path in sorted(glob.glob(str(cfg.BENCH_FRAMES_DIR / "*.npz")))[::2]:
        with np.load(path) as d:
            p, r, frames = json.loads(str(d["params"])), json.loads(str(d["result"])), d["frames"]
        ro.reset()
        S, _ = replay(eye, ro, frames)
        paths = []
        ax = axes[names.index(p["scenario"])]
        k = np.arange(len(S))
        if r["collided"]:
            t = (k - r["contact_k"]) * cfg.DT_S
            ax.set_xlabel("seconds relative to contact")
        else:
            z = np.array([z_at(i, p["startZ"]) for i in k])
            t = (k - np.argmax(z < 0.3)) * cfg.DT_S
            ax.set_xlabel("seconds relative to passing under the front edge")
        ax.plot(t, S, lw=1, color="C3" if r["collided"] else "C0")
        ax.set_title(p["scenario"], loc="left", fontsize=9)
        ax.axhline(theta, ls="--", color="orange")
    plt.tight_layout()
    out = cfg.ROOT / "results" / "reflex_calibration.png"
    plt.savefig(out, dpi=65)
    print(out)


if __name__ == "__main__":
    main()

"""Calibrate the brake threshold θ from recorded carport flights (README Step 8.2).

1. Record: web/bench.html?mode=record&n=12 with the reflex server running.
2. Run:    uv run --extra fly python -m tools.calibrate_reflex [--write]

Each bench/frames/<episode>.npz holds one scripted straight flight (hover, then
cruise) with collision truth. Every frame is replayed through the pretrained eye and
the live readout. θ is the smallest value keeping the false-brake rate on
non-colliding flights at or below TARGET_FALSE_BRAKE; results are calibration-set
performance, not held-out. --write saves bench/thresholds.json for the server.
"""

import argparse
from datetime import date
import glob
import json

import numpy as np

from reflex import config as cfg
from reflex.hexeye import FlyEye, load_layout
from reflex.looming import Readout

TARGET_FALSE_BRAKE = 0.05


def replay(eye, readout, frames):
    eye.reset()
    readout.reset()
    S, dLR = [], []
    for f in frames:
        s, d = readout.update(eye.step(f)[0])
        S.append(s)
        dLR.append(d)
    return np.array(S), np.array(dLR)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="write bench/thresholds.json")
    args = parser.parse_args()
    files = sorted(glob.glob(str(cfg.BENCH_FRAMES_DIR / "*.npz")))
    if not files:
        raise SystemExit("No recorded flights in bench/frames; run web/bench.html?mode=record first")
    layout = load_layout()
    eye, readout = FlyEye("cpu"), Readout(np.array(layout["col_x"]), np.array(layout["col_y"]))
    hover = round(cfg.HOVER_S / cfg.DT_S)
    need = cfg.NAV_CRUISE_MPS / cfg.A_BRAKE_MPS2 + 0.04
    episodes = []
    for path in files:
        with np.load(path) as d:
            params, result, frames = json.loads(str(d["params"])), json.loads(str(d["result"])), d["frames"]
        S, dLR = replay(eye, readout, frames)
        episodes.append({"file": path, "scenario": params["scenario"], "seed": params["seed"], "startX": params["startX"],
                         "collided": result["collided"], "contact_k": result["contact_k"], "S": S, "dLR": dLR})
        print(f"replayed {params['scenario']} seed {params['seed']}: {len(frames)} frames, S max {S[hover:].max():.2f}", flush=True)

    safe = [e for e in episodes if not e["collided"]]
    hits = [e for e in episodes if e["collided"]]
    peaks = np.sort([e["S"][hover:].max() for e in safe])
    allowed = int(np.floor(TARGET_FALSE_BRAKE * len(peaks)))
    theta = float(peaks[len(peaks) - 1 - allowed]) * 1.001 if len(peaks) else cfg.THETA_UNCALIBRATED
    false_brakes = int(sum(p > theta for p in peaks))

    rows = []
    for e in hits:
        above = np.flatnonzero(e["S"][hover:] > theta) + hover
        first = int(above[0]) if len(above) else None
        warn = None if first is None else (e["contact_k"] - first) * cfg.DT_S
        side = None
        if first is not None and abs(e["dLR"][first]) > 0.5 * theta:
            side = "right" if e["dLR"][first] > 0 else "left"
        rows.append({"scenario": e["scenario"], "seed": e["seed"], "startX": e["startX"], "first_brake_k": first,
                     "contact_k": e["contact_k"], "warning_s": warn, "meets_need": warn is not None and warn >= need,
                     "turn_away_side": side})
    warnings = [r["warning_s"] for r in rows if r["warning_s"] is not None]
    by_scenario = {}
    for sc in sorted({r["scenario"] for r in rows}):
        rs = [r for r in rows if r["scenario"] == sc]
        ws = [r["warning_s"] for r in rs if r["warning_s"] is not None]
        by_scenario[sc] = {"n": len(rs), "detected": len(ws), "meets_need": sum(r["meets_need"] for r in rs),
                           "warning_mean_s": float(np.mean(ws)) if ws else None,
                           "warning_p5_s": float(np.percentile(ws, 5)) if ws else None}
    report = {
        "date": str(date.today()), "theta": theta, "target_false_brake": TARGET_FALSE_BRAKE,
        "n_safe": len(safe), "false_brakes": false_brakes,
        "false_brake_rate": false_brakes / len(safe) if safe else None,
        "n_colliding": len(hits), "detected": len(warnings),
        "required_warning_s": need, "meets_need": sum(r["meets_need"] for r in rows),
        "warning_mean_s": float(np.mean(warnings)) if warnings else None,
        "warning_p5_s": float(np.percentile(warnings, 5)) if warnings else None,
        "by_scenario": by_scenario, "safe_peaks": peaks.tolist(), "colliding": rows,
        "note": "Calibration-set performance on recorded straight flights; not held-out.",
    }
    out = cfg.ROOT / "results" / "reflex_calibration.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k not in ("safe_peaks", "colliding")}, indent=2))
    if args.write:
        cfg.THRESHOLDS_PATH.parent.mkdir(parents=True, exist_ok=True)
        cfg.THRESHOLDS_PATH.write_text(json.dumps({
            "theta": theta, "false_brake_rate": report["false_brake_rate"], "n_safe": len(safe),
            "n_colliding": len(hits), "detected": len(warnings), "date": report["date"],
            "source": "tools/calibrate_reflex.py on bench/frames (calibration set)",
        }, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {cfg.THRESHOLDS_PATH}")


if __name__ == "__main__":
    main()

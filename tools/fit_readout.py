"""Fit the looming readout on recorded carport flights (engineered layer; reflex/looming.py).

Two pathways, either of which can trigger a brake:
  cone:  Gaussian-weighted radial motion about the image centre (sigma fixed by --sigma);
  units: logistic weights over the EMA'd 7 LPLC2-style units × 3 pathways (21 inputs),
         trained on "contact within DANGER seconds" versus safe flight.
Each pathway's threshold is the --quantile of its peak score over TRAIN non-colliding
flights, so false brakes on train stay near 1 − quantile per pathway.
Scoring uses the runtime reflex.looming.Readout frame by frame, so reported numbers are
exactly what the server does. TEST flights (different seeds) are held out.

Run: uv run python -m tools.fit_readout <train_drive_dir> <test_drive_dir> [--write]
Drive dirs come from tools.record_drive. --write saves bench/readout_weights.json and
bench/thresholds.json (θ = 1 on the combined scale).
"""

import argparse
from datetime import date
import glob
import json
import os

import numpy as np

from reflex import config as cfg
from reflex.hexeye import load_layout
from reflex.looming import Cone, LoomingUnits, Readout

DANGER = (0.2, 1.2)      # seconds before contact labelled "brake now"
FAR_S = 2.0              # colliding-flight frames earlier than this before contact are safe
L2 = 1e-2


def ema(x, a=cfg.EMA_ALPHA):
    out, acc = np.empty_like(x), np.zeros(x.shape[1:])
    for i in range(len(x)):
        acc = a * x[i] + (1 - a) * acc
        out[i] = acc
    return out


def load(dirpath):
    eps = []
    for path in sorted(glob.glob(os.path.join(dirpath, "*.npz"))):
        with np.load(path) as d:
            eps.append({"params": json.loads(str(d["params"])), "result": json.loads(str(d["result"])),
                        "drive": d["drive"]})
    return eps


def labelled(eps, hover, key="feats"):
    X, y = [], []
    for e in eps:
        f, r = e[key], e["result"]
        k = np.arange(len(f))
        if r["collided"]:
            before = (r["contact_k"] - k) * cfg.DT_S
            pos = (before >= DANGER[0]) & (before <= DANGER[1])
            neg = (before > FAR_S) & (k >= hover)
        else:
            pos, neg = np.zeros(len(f), bool), k >= hover
        X += [f[pos], f[neg]]
        y += [np.ones(pos.sum()), np.zeros(neg.sum())]
    return np.concatenate(X), np.concatenate(y)


def fit_logistic(X, y, l2=L2, iters=50):
    """Class-balanced L2 logistic regression by Newton's method."""
    Xb = np.hstack([X, np.ones((len(X), 1))])
    sw = np.where(y == 1, 0.5 / y.mean(), 0.5 / (1 - y.mean()))
    w = np.zeros(Xb.shape[1])
    reg = l2 * np.eye(Xb.shape[1]); reg[-1, -1] = 0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-Xb @ w))
        grad = Xb.T @ (sw * (p - y)) / len(y) + reg @ w
        H = (Xb * (sw * p * (1 - p))[:, None]).T @ Xb / len(y) + reg
        step = np.linalg.solve(H, grad)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return w[:-1], w[-1]


def evaluate(eps, weights, col_x, col_y, hover):
    """Replays each flight through the runtime Readout; brake = S > 1 after the hover."""
    need = cfg.NAV_CRUISE_MPS / cfg.A_BRAKE_MPS2 + 0.04
    safe, hits = [], []
    for e in eps:
        ro = Readout(col_x, col_y, weights=weights)
        S = np.array([ro.update(dr)[0] for dr in e["drive"]])
        above = np.flatnonzero(S[hover:] > 1.0) + hover
        if not e["result"]["collided"]:
            safe.append(len(above) > 0)
            continue
        first = int(above[0]) if len(above) else None
        hits.append((e["params"]["scenario"], None if first is None else (e["result"]["contact_k"] - first) * cfg.DT_S))
    by = {}
    for sc in sorted({s for s, _ in hits}):
        ws = [w for s, w in hits if s == sc]
        det = [w for w in ws if w is not None]
        by[sc] = {"n": len(ws), "detected": len(det), "in_time": sum(w >= need for w in det),
                  "warning_median_s": float(np.median(det)) if det else None}
    return {"false_brakes": int(sum(safe)), "n_safe": len(safe), "n_colliding": len(hits),
            "detected": sum(w is not None for _, w in hits),
            "in_time": sum(w is not None and w >= need for _, w in hits),
            "required_warning_s": need, "by_scenario": by}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("train")
    parser.add_argument("test")
    parser.add_argument("--sigma", type=float, default=0.1)
    parser.add_argument("--quantile", type=float, default=0.975)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    layout = load_layout()
    col_x, col_y = np.array(layout["col_x"]), np.array(layout["col_y"])
    units, cone = LoomingUnits(col_x, col_y), Cone(col_x, col_y, args.sigma)
    hover = round(cfg.HOVER_S / cfg.DT_S)
    train, test = load(args.train), load(args.test)
    for e in train:
        e["feats"] = ema(np.stack([units.pathways(dr).reshape(-1) for dr in e["drive"]]))
        e["cone"] = ema(np.array([cone.score(dr)[0] for dr in e["drive"]]))

    X, y = labelled(train, hover)
    scale = np.maximum(np.percentile(X[y == 0], 95, axis=0), 1e-9)
    w, b = fit_logistic(np.log1p(X / scale), y)
    safe = [e for e in train if not e["result"]["collided"]]
    unit_peaks = [(np.log1p(e["feats"][hover:] / scale) @ w + b).max() for e in safe]
    cone_peaks = [e["cone"][hover:].max() for e in safe]
    weights = {
        "date": str(date.today()),
        "features": "EMA of 7 units x [2d, horiz, vert] (LoomingUnits.pathways) + Gaussian cone",
        "units": {"w": w.tolist(), "scale": scale.tolist(), "b": float(b),
                  "theta": float(np.quantile(unit_peaks, args.quantile) + 1e-3)},
        "cone": {"sigma": args.sigma, "theta": float(np.quantile(cone_peaks, args.quantile) * 1.001)},
        "quantile": args.quantile, "train_flights": len(train), "test_flights": len(test),
    }
    report = {**weights, "train": evaluate(train, weights, col_x, col_y, hover),
              "test": evaluate(test, weights, col_x, col_y, hover)}
    out = cfg.ROOT / "results" / "readout_fit.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    for split in ("train", "test"):
        r = report[split]
        per = "  ".join(f"{sc} {v['detected']}/{v['n']} (in time {v['in_time']})" for sc, v in r["by_scenario"].items())
        print(f"{split:5s} false brakes {r['false_brakes']}/{r['n_safe']}  caught {r['detected']}/{r['n_colliding']}, "
              f"in time {r['in_time']}  | {per}")
    print(f"θ_units {weights['units']['theta']:.3f}  θ_cone {weights['cone']['theta']:.3f}  (sigma {args.sigma})")
    if args.write:
        (cfg.ROOT / "bench").mkdir(exist_ok=True)
        cfg.READOUT_WEIGHTS_PATH.write_text(json.dumps(weights, indent=2) + "\n", encoding="utf-8")
        cfg.THRESHOLDS_PATH.write_text(json.dumps({
            "theta": 1.0, "readout": "cone + units (bench/readout_weights.json)",
            "train": report["train"], "test": report["test"], "date": weights["date"],
            "source": "tools/fit_readout.py",
        }, indent=2) + "\n", encoding="utf-8")
        print("wrote bench/readout_weights.json and bench/thresholds.json")


if __name__ == "__main__":
    main()

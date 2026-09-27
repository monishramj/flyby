"""Fit the looming readout weights on recorded carport flights (engineered layer).

Features per frame: the 7 LPLC2-style units × 3 pathways (2d, horiz, vert), each
smoothed with the readout EMA — 21 inputs, like the giant fiber weighting its
looming inputs. A logistic model separates "contact within DANGER window" from
safe flight; θ keeps false brakes on TRAIN non-colliding flights ≤ 5%.
Everything is then evaluated on held-out TEST flights (different seeds).

Run: uv run python -m tools.fit_readout <train_drive_dir> <test_drive_dir> [--write]
Drive dirs come from tools.record_drive. --write saves bench/readout_weights.json
and bench/thresholds.json for the server.
"""

import argparse
from datetime import date
import glob
import json
import os

import numpy as np

from reflex import config as cfg
from reflex.hexeye import load_layout
from reflex.looming import LoomingUnits

DANGER = (0.2, 1.2)      # seconds before contact labelled "brake now"
FAR_S = 2.0              # colliding-flight frames earlier than this before contact are safe
TARGET_FALSE_BRAKE = 0.05
L2 = 1e-2
PATHWAYS = ("2d", "horiz", "vert")


def ema(x, a=cfg.EMA_ALPHA):
    out, acc = np.empty_like(x), np.zeros(x.shape[1:])
    for i in range(len(x)):
        acc = a * x[i] + (1 - a) * acc
        out[i] = acc
    return out


def load(dirpath, units):
    eps = []
    for path in sorted(glob.glob(os.path.join(dirpath, "*.npz"))):
        with np.load(path) as d:
            p, r, drive = json.loads(str(d["params"])), json.loads(str(d["result"])), d["drive"]
        feats = ema(np.stack([units.pathways(dr).reshape(-1) for dr in drive]))  # (T, 3*units)
        eps.append({"params": p, "result": r, "feats": feats})
    return eps


def labelled(eps, hover):
    X, y = [], []
    for e in eps:
        f, r = e["feats"], e["result"]
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


def evaluate(eps, score_fn, theta, hover):
    need = cfg.NAV_CRUISE_MPS / cfg.A_BRAKE_MPS2 + 0.04
    safe, hits = [], []
    for e in eps:
        s = score_fn(e["feats"])
        above = np.flatnonzero(s[hover:] > theta) + hover
        if not e["result"]["collided"]:
            safe.append(len(above) > 0)
        else:
            first = int(above[0]) if len(above) else None
            warn = None if first is None else (e["result"]["contact_k"] - first) * cfg.DT_S
            hits.append((e["params"]["scenario"], warn))
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


def pick_theta(eps, score_fn, hover):
    peaks = np.sort([score_fn(e["feats"])[hover:].max() for e in eps if not e["result"]["collided"]])
    allowed = int(np.floor(TARGET_FALSE_BRAKE * len(peaks)))
    top = peaks[len(peaks) - 1 - allowed]
    return float(top + 1e-3 * max(1.0, abs(top)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("train")
    parser.add_argument("test")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    layout = load_layout()
    units = LoomingUnits(np.array(layout["col_x"]), np.array(layout["col_y"]))
    hover = round(cfg.HOVER_S / cfg.DT_S)
    train, test = load(args.train, units), load(args.test, units)
    n_units = len(units.centers)

    # Feature scaling: log1p of each feature relative to its 95th percentile on train safe frames.
    X, y = labelled(train, hover)
    scale = np.maximum(np.percentile(X[y == 0], 95, axis=0), 1e-9)
    transform = lambda f: np.log1p(f / scale)
    w, b = fit_logistic(transform(X), y)
    learned = lambda f: transform(f) @ w + b

    # Baselines: the current 2-pathway rule, and the same with the vertical pathway added.
    safe_feats = np.concatenate([e["feats"][hover:] for e in train if not e["result"]["collided"]])
    per_path = safe_feats.reshape(len(safe_feats), 3, n_units).sum(2).max(0)
    def rule(f, paths):
        s = f.reshape(len(f), 3, n_units).sum(2) / per_path
        return s[:, paths].max(1)
    candidates = {"current 2 pathways (sum, max)": lambda f: rule(f, [0, 1]),
                  "3 pathways (sum, max)": lambda f: rule(f, [0, 1, 2]),
                  "learned weights (21 inputs)": learned}
    report = {"date": str(date.today()), "danger_window_s": DANGER, "train_flights": len(train),
              "test_flights": len(test), "results": {}}
    for name, fn in candidates.items():
        theta = pick_theta(train, fn, hover)
        report["results"][name] = {"theta": theta, "train": evaluate(train, fn, theta, hover),
                                   "test": evaluate(test, fn, theta, hover)}
    W = w.reshape(3, n_units)
    report["weights"] = {p: W[i].round(3).tolist() for i, p in enumerate(PATHWAYS)}
    report["unit_centers"] = units.centers.round(3).tolist()
    out = cfg.ROOT / "results" / "readout_fit.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    for name, res in report["results"].items():
        for split in ("train", "test"):
            r = res[split]
            per = "  ".join(f"{sc} {v['detected']}/{v['n']} (in time {v['in_time']})" for sc, v in r["by_scenario"].items())
            print(f"{name:32s} {split:5s} θ={res['theta']:7.3f}  false brakes {r['false_brakes']}/{r['n_safe']}  "
                  f"caught {r['detected']}/{r['n_colliding']}, in time {r['in_time']}  | {per}")
    print("weights (rows 2d/horiz/vert, units in hex order):")
    for p, row in report["weights"].items():
        print(f"  {p:5s} {row}")

    if args.write:
        best = report["results"]["learned weights (21 inputs)"]
        cfg.ROOT.joinpath("bench").mkdir(exist_ok=True)
        (cfg.ROOT / "bench" / "readout_weights.json").write_text(json.dumps({
            "features": "EMA of 7 units x [2d, horiz, vert] (reflex.looming.LoomingUnits.pathways)",
            "scale": scale.tolist(), "w": w.tolist(), "b": float(b), "date": report["date"],
        }, indent=2) + "\n", encoding="utf-8")
        cfg.THRESHOLDS_PATH.write_text(json.dumps({
            "theta": best["theta"], "readout": "learned", "train": best["train"], "test": best["test"],
            "date": report["date"], "source": "tools/fit_readout.py",
        }, indent=2) + "\n", encoding="utf-8")
        print("wrote bench/readout_weights.json and bench/thresholds.json")


if __name__ == "__main__":
    main()

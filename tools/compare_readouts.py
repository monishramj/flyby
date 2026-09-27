"""Compare the §4.8 half-field readout with LPLC2-style patch readouts on real flyvis output.

Run: uv run --extra fly python -m tools.compare_readouts [--fov 90]
The model runs once per clip; readouts are evaluated offline on the saved T4/T5
drive (rectified deviation from rest, per direction and column).

θ for each readout is set to 1.2 × its max S on the non-colliding clips, scored from
each clip's `hold` frame (after the gray→scene onset settles).
These clips are the calibration set: results are not held-out performance.
"""

import argparse
import json

import numpy as np

from reflex import config as cfg
from reflex.hexeye import FlyEye, load_layout
from tools.looming_stimuli import SPEED_MPS, standard_clips

DIRS = ("left", "right", "up", "down")
OPP = {"left": "right", "right": "left", "up": "down", "down": "up"}


def ema(x, a=cfg.EMA_ALPHA):
    y, out = 0.0, []
    for v in x:
        y = a * v + (1 - a) * y
        out.append(y)
    return np.array(out)


def halves(drive, col_x, col_y):
    """README §4.8 regions (with rest subtraction): q = out − in per half-field."""
    d = {name: drive[:, i] for i, name in enumerate(DIRS)}
    regions = {"L": (col_x < 0, "left"), "R": (col_x > 0, "right"), "U": (col_y > 0, "up"), "D": (col_y < 0, "down")}
    q = {r: d[o][:, m].mean(1) - d[OPP[o]][:, m].mean(1) for r, (m, o) in regions.items()}
    return q["L"] + q["R"] + q["U"] + q["D"], q["L"] - q["R"]


def hex_centers(rings, spacing):
    pts = []
    for i in range(-rings, rings + 1):
        for j in range(-rings, rings + 1):
            if abs(i + j) <= rings:
                pts.append((spacing * (i + j / 2), spacing * j * np.sqrt(3) / 2))
    return np.array(pts)


class Patches:
    """LPLC2-like units: 4 dendritic branches, each excited by outward and inhibited by
    inward motion on its own side of the unit's centre; a unit fires only when all four
    branches do (geometric mean). S pools all units; dLR = left units − right units."""

    def __init__(self, col_x, col_y, rings, spacing, radius_scale=1.0, mode="2d"):
        self.mode = mode
        self.centers = hex_centers(rings, spacing)
        self.units = []
        for cx, cy in self.centers:
            dx, dy = col_x - cx, col_y - cy
            r = np.hypot(dx, dy)
            inside = (r <= spacing * radius_scale) & (r > 1e-6)
            ang = np.degrees(np.arctan2(dy, dx))
            branch = {
                "right": inside & (np.abs(ang) <= 45),
                "up": inside & (ang > 45) & (ang <= 135),
                "left": inside & (np.abs(ang) > 135),
                "down": inside & (ang < -45) & (ang >= -135),
            }
            self.units.append({b: np.flatnonzero(m) for b, m in branch.items()})
        self.side = np.sign(-self.centers[:, 0])  # +1 left units, −1 right units, 0 centre column

    def responses(self, drive):
        idx = {name: i for i, name in enumerate(DIRS)}
        out = np.zeros((drive.shape[0], len(self.units)))
        for u, branches in enumerate(self.units):
            if any(len(c) == 0 for c in branches.values()):
                continue
            g = {b: np.maximum(drive[:, idx[b], c].mean(1) - drive[:, idx[OPP[b]], c].mean(1), 0) for b, c in branches.items()}
            horiz = np.sqrt(g["left"] * g["right"])
            vert = np.sqrt(g["up"] * g["down"])
            out[:, u] = {"2d": np.sqrt(horiz * vert), "either": np.maximum(horiz, vert), "horiz": horiz}[self.mode]
        return out

    def __call__(self, drive, col_x, col_y):
        r = self.responses(drive)
        return r.sum(1), (r * self.side).sum(1)


def combo(a, b, clips, drives, col_x, col_y):
    """Two pathways (2D looming units, horizontal-expansion units); either can brake.
    Each S is scaled by its own max on the non-colliding clips, then the larger one is used."""
    sa = [tuple(map(ema, a(d, col_x, col_y))) for d in drives]
    sb = [tuple(map(ema, b(d, col_x, col_y))) for d in drives]
    safe = [i for i, c in enumerate(clips) if not c.collides]
    na = max(sa[i][0][clips[i].hold:].max() for i in safe)
    nb = max(sb[i][0][clips[i].hold:].max() for i in safe)
    out = []
    for (Sa, Da), (Sb, Db) in zip(sa, sb):
        pick_a = Sa / na >= Sb / nb
        out.append((np.maximum(Sa / na, Sb / nb), np.where(pick_a, Da / na, Db / nb)))
    return out


def record(eye, clips):
    runs = []
    for clip in clips:
        eye.reset()
        drive = []
        for f in clip.frames:
            _, activity = eye.step(f)
            drive.append(np.maximum((activity - eye.rest)[eye.readout.index], 0).sum(1))
        runs.append(np.array(drive))
        print(f"recorded {clip.name} ({len(clip.frames)} frames)", flush=True)
    return runs


def evaluate(name, fn, clips, drives, col_x, col_y, speed):
    series = [tuple(map(ema, fn(d, col_x, col_y))) for d in drives] if callable(fn) else fn
    safe = [s for c, s in zip(clips, series) if not c.collides]
    theta = 1.2 * max(S[c.hold:].max() for c, (S, _) in zip([c for c in clips if not c.collides], safe))
    need = speed / cfg.A_BRAKE_MPS2 + 0.04
    rows = []
    for c, (S, dLR) in zip(clips, series):
        onset = c.hold
        cross = np.flatnonzero(S[onset:] > theta) + onset
        first = int(cross[0]) if len(cross) else None
        row = {"clip": c.name, "collides": c.collides, "S_max": float(S.max()),
               "onset_S_max": float(S[:onset].max()), "first_brake_k": first}
        if c.collides:
            row["warning_s"] = None if first is None else (c.contact_k - first) * cfg.DT_S
            row["meets_target"] = row["warning_s"] is not None and row["warning_s"] >= need
            if first is not None:
                row["dLR_at_brake"] = float(dLR[first])
                row["swerve"] = ("right" if dLR[first] > 0 else "left") if abs(dLR[first]) > 0.5 * theta else "none"
        else:
            row["false_brake"] = first is not None and first >= onset
        rows.append(row)
    return {"readout": name, "theta": float(theta), "required_warning_s": need, "clips": rows,
            "series": {c.name: [np.round(S, 5).tolist(), np.round(dLR, 5).tolist()] for c, (S, dLR) in zip(clips, series)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fov", type=float, default=90.0)
    parser.add_argument("--speed", type=float, default=SPEED_MPS)
    args = parser.parse_args()
    layout = load_layout()
    col_x, col_y = np.array(layout["col_x"]), np.array(layout["col_y"])
    clips = [c for c in standard_clips(args.fov, args.speed) if c.name.split()[0] not in ("disc", "texture")] \
        if args.speed != SPEED_MPS else standard_clips(args.fov)
    drives = record(FlyEye("cpu"), clips)
    readouts = {"halves (§4.8)": halves}
    for rings, spacing in ((1, 0.55), (2, 0.4)):
        n = 3 * rings * (rings + 1) + 1
        for mode in ("2d", "horiz"):
            readouts[f"{n} units {mode}"] = Patches(col_x, col_y, rings, spacing, 1.0, mode)
        readouts[f"{n} units 2d OR horiz"] = combo(Patches(col_x, col_y, rings, spacing, 1.0, "2d"),
                                                  Patches(col_x, col_y, rings, spacing, 1.0, "horiz"), clips, drives, col_x, col_y)
    report = {"fov_deg": args.fov, "speed_mps": args.speed,
              "results": [evaluate(n, f, clips, drives, col_x, col_y, args.speed) for n, f in readouts.items()]}
    path = cfg.ROOT / "results" / f"readout_comparison_fov{args.fov:.0f}_v{args.speed:g}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    names = [c.name for c in clips]
    print(f"{'readout':18s} {'θ':>7s} | " + " | ".join(f"{n[:14]:>14s}" for n in names))
    for res in report["results"]:
        cells = []
        for r in res["clips"]:
            if r["collides"]:
                w = "miss" if r["warning_s"] is None else f"{r['warning_s']:.2f}s"
                sw = {"right": "R", "left": "L", "none": "-"}.get(r.get("swerve"), "")
                cells.append(f"{w}{'*' if r.get('meets_target') else ' '}{sw:>2s}")
            else:
                cells.append("FALSE BRAKE" if r["false_brake"] else "ok")
        print(f"{res['readout']:18s} {res['theta']:7.4f} | " + " | ".join(f"{c:>14s}" for c in cells))
    print("warning = seconds before contact; * meets", f"{report['results'][0]['required_warning_s']:.2f}s; L/R = swerve direction")

if __name__ == "__main__":
    main()

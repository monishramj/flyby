"""Compare the §4.8 readout on raw vs rest-subtracted T4/T5 activity (pretrained, CPU)."""

import json

import numpy as np

from reflex import config as cfg
from reflex.hexeye import REGIONS, FlyEye


def disc(radius):
    x = np.linspace(-1, 1, cfg.FRAME_R)
    x, y = np.meshgrid(x, -x)
    img = np.full((cfg.FRAME_R, cfg.FRAME_R), 128, np.uint8)
    img[x**2 + y**2 <= radius**2] = 0
    return img


def texture(shift_px):
    rng = np.random.default_rng(0)
    base = rng.integers(0, 2, (cfg.FRAME_R // 4, cfg.FRAME_R // 2)).repeat(4, 0).repeat(4, 1) * 255
    return np.roll(base, shift_px, axis=1)[:, : cfg.FRAME_R].astype(np.uint8)


def main():
    n = round(1.0 / cfg.DT_S)
    stimuli = {
        "expanding_disc": [disc(0.1 + 0.8 * k / n) for k in range(n)],
        "contracting_disc": [disc(0.9 - 0.8 * k / n) for k in range(n)],
        "static_disc": [disc(0.5)] * n,
        "rightward_texture_50px_s": [texture(k) for k in range(n)],
    }
    eye = FlyEye("cpu")
    rest = eye.reset()
    q = lambda e: {r: e[r]["out"] - e[r]["in"] for r in REGIONS}
    report = {"note": "q = out - in, mean over 1 s of stimulus, black disc on gray, FRAME_R px",
              "gray_rest_raw": q(eye.readout.energies(rest)), "stimuli": {}}
    for name, frames in stimuli.items():
        eye.reset()
        raw, dev = [], []
        for frame in frames:
            _, activity = eye.step(frame)
            raw.append(q(eye.readout.energies(activity)))
            dev.append(q(eye.readout.energies(activity - eye.rest)))
        mean = lambda rows: {r: float(np.mean([row[r] for row in rows])) for r in REGIONS}
        report["stimuli"][name] = {"raw": mean(raw), "minus_rest": mean(dev)}
    path = cfg.ROOT / "results" / "readout_baseline.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

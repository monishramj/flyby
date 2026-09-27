"""Reproduce the gray settling diagnostic that selected WARMUP_S=2.0."""

import json
import numpy as np

from reflex import config as cfg
from tools.flyvis_smoke import ReferenceEye


def main():
    eye = ReferenceEye("cpu", cfg.FRAME_R_TARGET)
    gray = np.full((eye.frame_r, eye.frame_r), 0.5, np.float32)
    activity = np.stack([eye.step(gray)[0] for _ in range(round(10 / cfg.DT_S))])
    types = eye.network.connectome.nodes.type[:].astype(str)
    report = {}
    for warmup in (0.5, 1.0, 2.0, 3.0, 5.0):
        end = round(warmup / cfg.DT_S)
        rest = activity[end - round(cfg.REST_WINDOW_S / cfg.DT_S):end].mean(axis=0)
        deviation = np.abs(activity[end + round(cfg.SMOKE_GRAY_S / cfg.DT_S) - 1] - rest)
        index = int(deviation.argmax())
        report[str(warmup)] = {
            "max_deviation_after_5s": float(deviation.max()),
            "mean": float(deviation.mean()), "worst_type": str(types[index]),
        }
    path = cfg.ROOT / "results" / "gray_settling.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()

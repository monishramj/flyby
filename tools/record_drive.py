"""Replay recorded flights (bench/frames-style .npz) through the pretrained eye and save
the per-frame T4/T5 drive, so readouts can be fitted offline without re-running the model.

Run: uv run --extra fly python -m tools.record_drive <frames_dir> <drive_dir>
"""

import glob
import os
import sys

import numpy as np

from reflex.hexeye import FlyEye


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    eye = FlyEye("cpu")
    for path in sorted(glob.glob(os.path.join(src, "*.npz"))):
        target = os.path.join(out, os.path.basename(path))
        if os.path.exists(target):
            continue
        with np.load(path) as d:
            params, result, frames = str(d["params"]), str(d["result"]), d["frames"]
        eye.reset()
        drive = np.stack([eye.step(f)[0] for f in frames]).astype(np.float32)
        np.savez(target, drive=drive, params=params, result=result)
    print(f"drive saved to {out}")


if __name__ == "__main__":
    main()

"""Record a short flyvis deviation sample for the 3D connectome dev page (web/connectome.html).

Runs the pretrained eye (reflex.hexeye.FlyEye) on CPU on a synthetic head-on approaching
disc (tools.looming_stimuli.disc_clip) and keeps every node's deviation from rest at
VIZ_HZ, the rate of the planned live viz stream. This is a RECORDING of real model output
on a synthetic stimulus, not the live stream (Step 7.1).

    python -m tools.record_connectome_sample

Writes web/public/recordings/connectome_disc.json (metadata) and .f16 (float16 LE,
frames x 45,669 nodes, our node order = data/flyvis_layout.json).
"""

import os

# CPU only (GPU benchmarking is a separate task). "-1", not "": Windows drops empty env vars.
os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

import json  # noqa: E402
import time  # noqa: E402
from datetime import datetime, timezone  # noqa: E402

import numpy as np  # noqa: E402

from reflex import config as cfg  # noqa: E402
from reflex.hexeye import FlyEye  # noqa: E402
from tools.looming_stimuli import SPEED_MPS, disc_clip  # noqa: E402

OUT = cfg.ROOT / "web" / "public" / "recordings"
D0_M = 6.0            # disc starts 6 m away, 0.1 m radius at the start (image units)
R0 = 0.1
KEEP_HOLD_S = 0.5     # keep the last 0.5 s of the still hold before the approach
STRIDE = round(cfg.FRAME_HZ / cfg.VIZ_HZ)


def main() -> None:
    clip = disc_clip(d0=D0_M, r0=R0, name="disc head-on")
    eye = FlyEye(device="cpu")
    eye.reset()
    start = clip.hold - round(KEEP_HOLD_S * cfg.FRAME_HZ)
    frames, radius, t_s = [], [], []
    ms = []
    for k, img in enumerate(clip.frames):
        eye.step(img)
        ms.append(eye.last_ms)
        if k >= start and (k - start) % STRIDE == 0:
            frames.append(eye.deviation().astype(np.float16))
            dark = img < 64
            radius.append(round(float(np.sqrt(dark.sum() / np.pi) / (cfg.FRAME_R / 2)), 4))
            t_s.append(round((k - clip.hold) * cfg.DT_S, 3))
    data = np.stack(frames)
    if not np.isfinite(data).all():
        raise ValueError("non-finite deviation after float16 conversion")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "connectome_disc.f16").write_bytes(data.astype("<f2").tobytes())
    meta = {
        "kind": "recording",
        "note": "Recorded pretrained flyvis output on a synthetic stimulus; not the live stream.",
        "model": cfg.FLYVIS_MODEL,
        "checkpoint_sha256": eye.checkpoint_sha256,
        "device": "cpu",
        "stimulus": (f"black disc approaching head-on at {SPEED_MPS} m/s from {D0_M} m "
                     f"(radius {R0} of the half-frame at the start), after a still hold; "
                     "tools.looming_stimuli.disc_clip"),
        "value": "activity - rest (deviation), our node order (data/flyvis_layout.json)",
        "dtype": "float16 little-endian, frames x nodes",
        "hz": cfg.VIZ_HZ,
        "frames": int(data.shape[0]),
        "nodes": int(data.shape[1]),
        "t_s": t_s,  # seconds relative to the approach start (negative = still hold)
        "disc_radius": radius,  # dark-disc radius as a fraction of the half-frame
        "contact_t_s": round(D0_M / SPEED_MPS, 3),
        "step_ms_p50": round(float(np.percentile(ms[5:], 50)), 2),
        "recorded_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (OUT / "connectome_disc.json").write_text(json.dumps(meta, indent=1) + "\n")
    print(f"{data.shape[0]} frames x {data.shape[1]} nodes at {cfg.VIZ_HZ} Hz, "
          f"|dev| max {float(np.abs(data).max()):.3f}, {data.nbytes / 1e6:.2f} MB")


if __name__ == "__main__":
    t0 = time.perf_counter()
    main()
    print(f"done in {time.perf_counter() - t0:.1f} s")

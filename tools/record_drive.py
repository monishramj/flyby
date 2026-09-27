"""Replay recorded flights (bench/frames-style .npz) through the pretrained eye and save
the per-frame T4/T5 drive, so readouts can be fitted offline without re-running the model.

Flights are replayed in batches (many flights step together), which is what makes a
GPU fast. Each flight starts from the same warmed-up state as FlyEye.reset(), and the
drive matches FlyEye.step(): relu(activity − rest) summed over T4 and T5 per direction.

Run: uv run --extra fly python -m tools.record_drive <frames_dir> <drive_dir> [--device cuda --batch 64]
"""

import argparse
import glob
import os
import time

import numpy as np

from reflex import config as cfg
from reflex.hexeye import FlyEye


def warm_state(eye: FlyEye, n: int):
    """Batch-n state after WARMUP_S of gray: per sample identical to FlyEye.reset()."""
    torch, net = eye.torch, eye.network
    gray = torch.full((n, 1, cfg.FRAME_R, cfg.FRAME_R), 0.5, device=eye.device)
    state = None
    with torch.inference_mode():
        for _ in range(round(cfg.WARMUP_S / cfg.DT_S)):
            net.stimulus.zero(n, 1)
            net.stimulus.add_input(eye.box_eye(gray))
            state = net(net.stimulus(), dt=cfg.DT_S, state=state, as_states=True)[-1]
    return state


def replay(eye: FlyEye, flights: list[np.ndarray], batch: int) -> list[np.ndarray]:
    torch, net = eye.torch, eye.network
    eye.reset()  # sets eye.rest
    warm: dict = {}
    idx = torch.as_tensor(eye.readout.index, device=eye.device)
    rest = torch.as_tensor(eye.rest, device=eye.device, dtype=torch.float32)[idx]
    order = sorted(range(len(flights)), key=lambda i: len(flights[i]))
    out: list[np.ndarray | None] = [None] * len(flights)
    for start in range(0, len(order), batch):
        group = order[start:start + batch]
        B, T = len(group), max(len(flights[i]) for i in group)
        if B not in warm:
            warm[B] = warm_state(eye, B)
        state = warm[B]
        drive = np.zeros((B, T, 4, idx.shape[-1]), np.float32)
        with torch.inference_mode():
            for t in range(T):
                frames = np.stack([flights[i][min(t, len(flights[i]) - 1)] for i in group]).astype(np.float32) / 255.0
                x = torch.as_tensor(frames, device=eye.device)[:, None]  # (B, 1 frame, H, W)
                net.stimulus.zero(B, 1)
                net.stimulus.add_input(eye.box_eye(x))
                state = net(net.stimulus(), dt=cfg.DT_S, state=state, as_states=True)[-1]
                act = state.nodes.activity  # (B, nodes)
                drive[:, t] = torch.relu(act[:, idx] - rest).sum(2).cpu().numpy()
        for j, i in enumerate(group):
            out[i] = drive[j, :len(flights[i])]
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src")
    parser.add_argument("out")
    parser.add_argument("--device", default="cpu", choices=("cpu", "cuda"))
    parser.add_argument("--batch", type=int, default=1)
    args = parser.parse_args()
    os.makedirs(args.out, exist_ok=True)
    todo = [p for p in sorted(glob.glob(os.path.join(args.src, "*.npz")))
            if not os.path.exists(os.path.join(args.out, os.path.basename(p)))]
    if not todo:
        print("nothing to do")
        return
    eye = FlyEye(args.device)
    started = time.perf_counter()
    for chunk in range(0, len(todo), args.batch * 4):
        paths = todo[chunk:chunk + args.batch * 4]
        meta, flights = [], []
        for path in paths:
            with np.load(path) as d:
                meta.append((str(d["params"]), str(d["result"])))
                flights.append(d["frames"])
        for path, (params, result), drive in zip(paths, meta, replay(eye, flights, args.batch)):
            np.savez(os.path.join(args.out, os.path.basename(path)), drive=drive, params=params, result=result)
        print(f"{chunk + len(paths)}/{len(todo)} flights, {time.perf_counter() - started:.0f} s", flush=True)
    print(f"drive saved to {args.out}")


if __name__ == "__main__":
    main()

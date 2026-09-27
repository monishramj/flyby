"""Measure the pretrained fly eye; export the layout without inferred directions.

Run setup once: uv run --extra fly python -m tools.prepare_flyvis
Then: uv run --extra fly python -m tools.flyvis_smoke --device cpu
All image coordinates are x-right/y-up. No weights are downloaded here.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import time

from reflex import config as cfg
from reflex.threads import set_threads


def configure_environment():
    set_threads(cfg.CPU_THREADS)
    os.environ["FLYVIS_ROOT_DIR"] = str(cfg.FLYVIS_ROOT)
    os.environ.setdefault("MPLCONFIGDIR", str(cfg.ROOT / ".cache" / "matplotlib"))
    os.environ.setdefault("NUMBA_CACHE_DIR", str(cfg.ROOT / ".cache" / "numba"))


def camera_grid(size):
    import numpy as np
    x = np.linspace(-1, 1, size, dtype=np.float32)
    return np.meshgrid(x, -x)


def grating_frame(direction, k, size):
    import numpy as np
    x, y = camera_grid(size)
    axis = {"left": -x, "right": x, "up": y, "down": -y}[direction]
    # phase = position - speed*time: peaks move along the named image direction.
    distance = axis * (size - 1) / 2 - cfg.SMOKE_GRATING_SPEED_PX_S * k * cfg.DT_S
    return (0.5 + 0.5 * np.sin(2 * np.pi * distance / cfg.SMOKE_GRATING_PERIOD_PX)).astype(np.float32)


class ReferenceEye:
    """Unoptimized public forward path, preserving full state between frames."""

    def __init__(self, device, frame_r):
        configure_environment()
        import flyvis
        import torch
        from flyvis.datasets.rendering import BoxEye
        from reflex.compat import datamate_windows_writer

        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable in this PyTorch installation")
        self.torch = torch
        self.device = torch.device(device)
        # flyvis constructs indices and temporary tensors on its global default device.
        flyvis.device = self.device
        torch.set_default_device(self.device)
        torch.set_num_threads(cfg.CPU_THREADS)
        checkpoint_dir = cfg.FLYVIS_ROOT / "results" / cfg.FLYVIS_MODEL
        if not (checkpoint_dir / "_meta.yaml").is_file():
            raise FileNotFoundError("Run python -m tools.prepare_flyvis first")
        with datamate_windows_writer() as patched:
            self.windows_cache_workaround = patched
            self.view = flyvis.NetworkView(cfg.FLYVIS_MODEL)
            checkpoint = self.view.get_checkpoint()
            if checkpoint is None or not Path(checkpoint).is_file():
                raise FileNotFoundError("A real pretrained checkpoint is required")
            self.checkpoint_sha256 = hashlib.sha256(Path(checkpoint).read_bytes()).hexdigest()
            self.network = self.view.init_network().eval().requires_grad_(False)
        self.eye = BoxEye(extent=cfg.FLYVIS_EXTENT, kernel_size=cfg.FLYVIS_KERNEL_SIZE)
        self.frame_r = frame_r
        self.state = None
        self.rest = None
        self.version = flyvis.__version__

    def sync(self):
        if self.device.type == "cuda":
            self.torch.cuda.synchronize(self.device)

    def step(self, frame):
        import numpy as np
        if frame.shape != (self.frame_r, self.frame_r):
            raise ValueError("Frame shape does not match selected square camera size")
        with self.torch.inference_mode():
            self.sync()
            start = time.perf_counter()
            value = self.torch.as_tensor(frame, dtype=self.torch.float32, device=self.device)[None, None]
            receptors = self.eye(value)
            self.network.stimulus.zero(1, 1)
            self.network.stimulus.add_input(receptors)
            self.sync()
            prepared = time.perf_counter()
            self.state = self.network(
                self.network.stimulus(), dt=cfg.DT_S, state=self.state, as_states=True
            )[-1]
            self.sync()
            inferred = time.perf_counter()
            activity = self.state.nodes.activity[0].detach().cpu().numpy().copy()
            self.sync()
            finished = time.perf_counter()
        if not np.isfinite(activity).all():
            raise ValueError("Non-finite neural activity")
        timing = {
            "preprocess_ms": (prepared - start) * 1000,
            "inference_ms": (inferred - prepared) * 1000,
            "output_ms": (finished - inferred) * 1000,
            "total_ms": (finished - start) * 1000,
        }
        return activity, timing

    def reset(self):
        import numpy as np
        self.state = None
        gray = np.full((self.frame_r, self.frame_r), 0.5, np.float32)
        values = [self.step(gray)[0] for _ in range(round(cfg.WARMUP_S / cfg.DT_S))]
        self.rest = np.mean(values[-round(cfg.REST_WINDOW_S / cfg.DT_S):], axis=0)
        return self.rest


def export_layout(eye):
    import numpy as np
    from flyvis.utils.hex_utils import get_hex_coords

    net = eye.network
    connectome = net.connectome
    types = connectome.unique_cell_types[:].astype(str).tolist()
    node_names = connectome.nodes.type[:].astype(str)
    ids = {name: i for i, name in enumerate(types)}
    node_type = np.array([ids[name] for name in node_names], dtype=int)
    node_u, node_v = connectome.nodes.u[:], connectome.nodes.v[:]
    col_u, col_v = get_hex_coords(cfg.FLYVIS_EXTENT)
    lookup = {(int(u), int(v)): i for i, (u, v) in enumerate(zip(col_u, col_v))}
    node_col = np.array([lookup[(int(u), int(v))] for u, v in zip(node_u, node_v)])
    # Confirm sampler order and stimulus receptor order agree with native node order.
    for indices in net.stimulus.input_index:
        np.testing.assert_array_equal(node_u[indices], col_u)
        np.testing.assert_array_equal(node_v[indices], col_v)
    centers = eye.eye.receptor_centers.detach().cpu().numpy()
    minimum = eye.eye.min_frame_size.detach().cpu().numpy()
    h, w = minimum if (minimum > eye.frame_r).any() else (eye.frame_r, eye.frame_r)
    col_x = centers[:, 1] / (int(w) // 2)
    col_y = -centers[:, 0] / (int(h) // 2)

    # Learned effective synaptic weights, grouped by source/destination/sign.
    with eye.torch.inference_mode():
        weights = net._param_api().edges.weight.detach().cpu().numpy()
    src = node_type[connectome.edges.source_index[:]]
    dst = node_type[connectome.edges.target_index[:]]
    signs = np.sign(weights).astype(int)
    groups = (src * len(types) + dst) * 3 + signs + 1
    sums = np.bincount(groups, weights=np.abs(weights), minlength=len(types) ** 2 * 3)
    edges = []
    for group in np.flatnonzero(sums):
        pair, sign_id = divmod(int(group), 3)
        source, target = divmod(pair, len(types))
        edges.append({"src": types[source], "dst": types[target], "weight": float(sums[group]), "sign": sign_id - 1})

    if (net.n_nodes, len(types), len(col_u)) != (cfg.EXPECTED_NODES, cfg.EXPECTED_TYPES, cfg.EXPECTED_COLUMNS):
        raise ValueError("Model dimensions differ from the agreed layout contract")
    return {
        "types": types, "node_type": node_type.tolist(), "u": node_u.tolist(),
        "v": node_v.tolist(), "node_col": node_col.tolist(),
        "col_u": col_u.tolist(), "col_v": col_v.tolist(),
        "col_x": col_x.tolist(), "col_y": col_y.tolist(),
        "receptor_types": [f"R{i}" for i in range(1, 9)],
        "t4t5_types": [f"T{layer}{subtype}" for layer in (4, 5) for subtype in "abcd"],
        "subtype_dir": {}, "type_edges": edges, "S_theta": None,
    }


def summarize_timing(timings):
    import numpy as np
    return {key: {"p50": float(np.percentile([row[key] for row in timings], 50)),
                  "p95": float(np.percentile([row[key] for row in timings], 95))}
            for key in timings[0]}


def run_smoke(device="cpu", frame_r=cfg.FRAME_R_TARGET):
    import numpy as np
    started = time.perf_counter()
    eye = ReferenceEye(device, frame_r)
    layout = export_layout(eye)
    node_type = np.array(layout["node_type"])
    types = layout["types"]
    indices = {name: np.flatnonzero(node_type == types.index(name)) for name in layout["t4t5_types"]}
    responses = {name: {} for name in indices}
    timings = []
    for direction in cfg.SMOKE_DIRECTIONS:
        eye.reset()
        samples = []
        for k in range(round(cfg.SMOKE_STIMULUS_S / cfg.DT_S)):
            activity, timing = eye.step(grating_frame(direction, k, frame_r))
            samples.append({name: float(np.maximum(activity[index], 0).mean()) for name, index in indices.items()})
            timings.append(timing)
        for name in indices:
            responses[name][direction] = float(np.mean([sample[name] for sample in samples]))
        print(f"Measured {direction} drifting grating", flush=True)

    margins = {}
    for name, table in responses.items():
        ranked = sorted(table, key=table.get, reverse=True)
        margin = (table[ranked[0]] - table[ranked[1]]) / max(abs(table[ranked[0]]), 1e-12)
        margins[name] = margin
        if margin >= cfg.SMOKE_DIRECTION_MARGIN:
            layout["subtype_dir"][name] = ranked[0]

    # Independent orientation check: model photoreceptor responses to a spot.
    x, y = camera_grid(frame_r)
    cx, cy = cfg.SMOKE_SPOT_CENTER
    spot = np.full((frame_r, frame_r), 0.5, np.float32)
    spot[(x - cx) ** 2 + (y - cy) ** 2 <= cfg.SMOKE_SPOT_RADIUS ** 2] = 1.0
    rest = eye.reset()
    for _ in range(round(cfg.SMOKE_SPOT_S / cfg.DT_S)):
        activity, _ = eye.step(spot)
    receptor_indices = [np.flatnonzero(node_type == types.index(f"R{i}")) for i in range(1, 7)]
    response = np.mean([(activity - rest)[index] for index in receptor_indices], axis=0)
    peak = np.argsort(response)[-10:]
    col_x, col_y = np.array(layout["col_x"]), np.array(layout["col_y"])
    orientation_ok = bool((response[peak] > 0).all() and (col_x[peak] > 0).all() and (col_y[peak] > 0).all())

    # Check residual settling relative to the configured warm-up/rest window.
    rest = eye.reset()
    gray = np.full((frame_r, frame_r), 0.5, np.float32)
    for _ in range(round(cfg.SMOKE_GRAY_S / cfg.DT_S)):
        activity, _ = eye.step(gray)
    gray_deviation = float(np.max(np.abs(activity - rest)))
    directions_ok = len(layout["subtype_dir"]) == 8 and all(
        {layout["subtype_dir"].get(f"T{layer}{subtype}") for subtype in "abcd"} == set(cfg.SMOKE_DIRECTIONS)
        for layer in (4, 5)
    )
    passed = orientation_ok and directions_ok and gray_deviation < cfg.SMOKE_GRAY_TOLERANCE
    report = {
        "schema_version": 1, "passed": passed, "model": cfg.FLYVIS_MODEL,
        "checkpoint_sha256": eye.checkpoint_sha256, "flyvis_version": eye.version,
        "torch_version": eye.torch.__version__, "python": platform.python_version(),
        "platform": platform.platform(), "cpu": platform.processor(), "device": str(eye.device),
        "threads": cfg.CPU_THREADS, "windows_cache_workaround": eye.windows_cache_workaround,
        "frame_r": frame_r, "internal_sampler_size": eye.eye.min_frame_size.tolist(),
        "dt_s": cfg.DT_S, "warmup_s": cfg.WARMUP_S, "rest_window_s": cfg.REST_WINDOW_S,
        "n_nodes": eye.network.n_nodes, "n_edges": eye.network.n_edges,
        "n_types": len(types), "n_columns": len(layout["col_x"]),
        "grating": {"period_px": cfg.SMOKE_GRATING_PERIOD_PX, "speed_px_s": cfg.SMOKE_GRATING_SPEED_PX_S, "duration_s": cfg.SMOKE_STIMULUS_S},
        "responses_mean_rectified": responses, "direction_margin": margins,
        "direction_margin_min": cfg.SMOKE_DIRECTION_MARGIN, "subtype_dir": layout["subtype_dir"],
        "directions_passed": directions_ok,
        "orientation": {"passed": orientation_ok, "peak_columns": peak.tolist(), "peak_x": col_x[peak].tolist(), "peak_y": col_y[peak].tolist()},
        "gray_after_5s_max_deviation": gray_deviation,
        "timing": summarize_timing(timings), "timing_frames": len(timings),
        "timing_note": "Public forward API; CPU output copy included; warm-up/reset/loading excluded; browser/transport not included.",
        "elapsed_s": time.perf_counter() - started,
    }
    return layout, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--frame-r", type=int, default=cfg.FRAME_R_TARGET)
    parser.add_argument("--report", type=Path, default=cfg.ROOT / "results" / "flyvis_smoke.json")
    args = parser.parse_args()
    configure_environment()
    layout, report = run_smoke(args.device, args.frame_r)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("passed", "subtype_dir", "orientation", "gray_after_5s_max_deviation", "timing")}, indent=2))
    if not report["passed"]:
        raise SystemExit("Smoke checks failed; report saved, layout NOT exported")
    cfg.LAYOUT_PATH.write_text(json.dumps(layout, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Exported {cfg.LAYOUT_PATH}")


if __name__ == "__main__":
    main()

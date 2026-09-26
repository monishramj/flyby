"""Fly eye: pretrained flyvis stepped one camera frame at a time (README Step 6.3).

Mirrors the path verified in tools/flyvis_smoke.py: BoxEye sampling, persistent
network state, dt = DT_S, gray warm-up and a rest vector from the last
REST_WINDOW_S. step() returns the T4/T5 motion drive per column: relu(activity −
rest) summed over T4 and T5 for each preferred direction (raw rectified activity
has a resting out-in offset; see measurements/readout-baseline.json). The looming
readout is in reflex/looming.py. `energies()` keeps the §4.8 half-field view for tests.
"""

import hashlib
import json
import os
from pathlib import Path
import time

import numpy as np

from reflex import config as cfg

# flyvis reads this once at import; set it before anything imports flyvis.
os.environ.setdefault("FLYVIS_ROOT_DIR", str(cfg.FLYVIS_ROOT))

REGIONS = ("L", "R", "U", "D")
OUTWARD = {"L": "left", "R": "right", "U": "up", "D": "down"}
INWARD = {"L": "right", "R": "left", "U": "down", "D": "up"}


class RegionIndex:
    """Index tables for the §4.8 regional T4/T5 energies, built from the layout."""

    def __init__(self, layout: dict, subtype_dir: dict[str, str]):
        node_type = np.asarray(layout["node_type"])
        node_col = np.asarray(layout["node_col"])
        col_x, col_y = np.asarray(layout["col_x"]), np.asarray(layout["col_y"])
        n_cols = len(col_x)
        self.region_cols = {
            "L": np.flatnonzero(col_x < 0), "R": np.flatnonzero(col_x > 0),
            "U": np.flatnonzero(col_y > 0), "D": np.flatnonzero(col_y < 0),
        }
        by_dir: dict[str, list[np.ndarray]] = {}
        for name, direction in subtype_dir.items():
            nodes = np.flatnonzero(node_type == layout["types"].index(name))
            if len(nodes) != n_cols or set(node_col[nodes]) != set(range(n_cols)):
                raise ValueError(f"{name} does not have exactly one node per column")
            by_col = np.empty(n_cols, dtype=np.int64)
            by_col[node_col[nodes]] = nodes
            by_dir.setdefault(direction, []).append(by_col)
        if set(by_dir) != set(OUTWARD.values()):
            raise ValueError(f"subtype_dir must cover left/right/up/down, got {sorted(by_dir)}")
        # (direction, subtype, column) -> node index
        self.directions = tuple(OUTWARD.values())
        self.index = np.stack([np.stack(by_dir[d]) for d in self.directions])

    def drive(self, deviation: np.ndarray) -> np.ndarray:
        """(4 directions left/right/up/down, columns): relu(T4) + relu(T5) of deviation from rest."""
        return np.maximum(deviation[self.index], 0).sum(axis=1)

    def energies(self, activity: np.ndarray) -> dict[str, dict[str, float]]:
        """Per region: column mean of relu(T4) + relu(T5) preferring out/in; pass activity - rest."""
        per_col = self.drive(activity)
        result = {}
        for region in REGIONS:
            mean = per_col[:, self.region_cols[region]].mean(axis=1)
            result[region] = {
                "out": float(mean[self.directions.index(OUTWARD[region])]),
                "in": float(mean[self.directions.index(INWARD[region])]),
            }
        return result


def load_layout(path: Path = cfg.LAYOUT_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class FlyEye:
    """Pass `network` only to exercise plumbing with an untrained flyvis.Network."""

    def __init__(self, device: str = "cpu", layout: dict | None = None, network=None):
        import flyvis
        import torch
        from flyvis.datasets.rendering import BoxEye

        from reflex.compat import datamate_windows_writer

        self.torch = torch
        self.device = torch.device(device)
        flyvis.device = self.device
        torch.set_default_device(self.device)
        torch.set_num_threads(cfg.CPU_THREADS)
        self.checkpoint_sha256 = None
        if network is None:
            if not (cfg.FLYVIS_ROOT / "results" / cfg.FLYVIS_MODEL / "_meta.yaml").is_file():
                raise FileNotFoundError("Run python -m tools.prepare_flyvis first")
            with datamate_windows_writer():
                view = flyvis.NetworkView(cfg.FLYVIS_MODEL, root_dir=cfg.FLYVIS_ROOT / "results")
                checkpoint = view.get_checkpoint()
                if checkpoint is None or not Path(checkpoint).is_file():
                    raise FileNotFoundError("A real pretrained checkpoint is required")
                self.checkpoint_sha256 = hashlib.sha256(Path(checkpoint).read_bytes()).hexdigest()
                network = view.init_network()
        self.network = network.to(self.device).eval().requires_grad_(False)
        self.box_eye = BoxEye(extent=cfg.FLYVIS_EXTENT, kernel_size=cfg.FLYVIS_KERNEL_SIZE)

        layout = layout or load_layout()
        types = np.asarray(layout["types"])
        native = self.network.connectome.nodes.type[:].astype(str)
        if not np.array_equal(native, types[np.asarray(layout["node_type"])]):
            raise ValueError("Network node order differs from data/flyvis_layout.json")
        self.readout = RegionIndex(layout, cfg.SUBTYPE_DIR)
        self.state = None
        self.rest: np.ndarray | None = None
        self.activity: np.ndarray | None = None
        self.last_ms = 0.0
        self._warm = None

    def _step(self, image: np.ndarray) -> np.ndarray:
        torch = self.torch
        with torch.inference_mode():
            value = torch.as_tensor(image, dtype=torch.float32, device=self.device)[None, None]
            self.network.stimulus.zero(1, 1)
            self.network.stimulus.add_input(self.box_eye(value))
            self.state = self.network(self.network.stimulus(), dt=cfg.DT_S, state=self.state, as_states=True)[-1]
            activity = self.state.nodes.activity[0].cpu().numpy().copy()
        if not np.isfinite(activity).all():
            raise ValueError("Non-finite neural activity")
        self.activity = activity
        return activity

    def reset(self) -> np.ndarray:
        """New network state, WARMUP_S of gray; rest = mean over the last REST_WINDOW_S.

        The warm-up is deterministic, so it runs once and later resets reuse its end
        state. Safe because flyvis builds a new state each step and never mutates one.
        """
        if self._warm is None:
            self.state = None
            gray = np.full((cfg.FRAME_R, cfg.FRAME_R), 0.5, np.float32)
            steps = [self._step(gray) for _ in range(round(cfg.WARMUP_S / cfg.DT_S))]
            rest = np.mean(steps[-round(cfg.REST_WINDOW_S / cfg.DT_S):], axis=0)
            self._warm = (self.state, rest, self.activity)
        self.state, self.rest, self.activity = self._warm
        return self.rest

    def step(self, frame: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """frame: (FRAME_R, FRAME_R) uint8, row 0 = image top. Returns (drive, activity)."""
        if self.rest is None:
            raise RuntimeError("Call reset() before step()")
        if frame.shape != (cfg.FRAME_R, cfg.FRAME_R):
            raise ValueError(f"frame must be {cfg.FRAME_R}x{cfg.FRAME_R}")
        start = time.perf_counter()
        if self.device.type == "cuda":
            self.torch.cuda.synchronize(self.device)
        activity = self._step(np.asarray(frame, dtype=np.float32) / 255.0)
        drive = self.readout.drive(activity - self.rest)
        self.last_ms = (time.perf_counter() - start) * 1000
        return drive, activity

    def deviation(self) -> np.ndarray:
        return self.activity - self.rest

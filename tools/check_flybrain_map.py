"""Check fly-brain's flyvis node order against ours and measure how many map pairs resolve.

fly-brain's vision/flyvis.bin stores per-node tid (u8, index into vision/flyvis.json 'types'),
u (i16) and v (i16) at its start. vision/flyvis_map.json 'eyes'.<L|R>.'pairs' are
[neuron_index, flyvis_node_index] in that node order. Our node order is data/flyvis_layout.json
(types[node_type], u, v). Nodes are matched by (type name, u, v), never by index.

    python -m tools.check_flybrain_map          # recompute; fail if it differs from the saved map
    python -m tools.check_flybrain_map --write  # (re)write data/flybrain_node_map.json
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

from reflex import config as cfg

FLYBRAIN_REPO = "https://github.com/Lulzx/fly-brain"
FLYBRAIN_COMMIT = "08cf8666bd3cb405c803f95821ebe06d22b3e5ab"
ASSETS = cfg.ROOT / "web" / "public" / "fly-brain"
MAP_PATH = cfg.ROOT / "data" / "flybrain_node_map.json"
MIN_COVERAGE = 0.95
USED_EYE = "L"  # README Step 7.4: the left-eye pairs


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def flybrain_nodes(assets: Path = ASSETS) -> tuple[list[str], np.ndarray, np.ndarray]:
    meta = json.loads((assets / "vision" / "flyvis.json").read_text())
    n = meta["N"]
    raw = (assets / "vision" / "flyvis.bin").read_bytes()
    tid = np.frombuffer(raw, np.uint8, n, 0)
    u = np.frombuffer(raw, np.int16, n, n)
    v = np.frombuffer(raw, np.int16, n, n * 3)
    if tid.max() >= len(meta["types"]):
        raise ValueError("flyvis.bin type id outside flyvis.json types")
    return [meta["types"][t] for t in tid], u.astype(int), v.astype(int)


def build(assets: Path = ASSETS, layout_path: Path = cfg.LAYOUT_PATH) -> dict:
    layout = json.loads(layout_path.read_text())
    ours = list(zip(np.asarray(layout["types"])[layout["node_type"]].tolist(), layout["u"], layout["v"]))
    index = {key: i for i, key in enumerate(ours)}
    if len(index) != len(ours):
        raise ValueError("(type, u, v) is not unique in our layout")
    ftypes, fu, fv = flybrain_nodes(assets)
    theirs = list(zip(ftypes, fu.tolist(), fv.tolist()))
    remap = np.array([index.get(key, -1) for key in theirs])
    identical = len(theirs) == len(ours) and bool(np.array_equal(remap, np.arange(len(ours))))

    fmap = json.loads((assets / "vision" / "flyvis_map.json").read_text())
    node_col = np.asarray(layout["node_col"])
    eyes = {}
    for eye, entry in fmap["eyes"].items():
        pairs = np.asarray(entry["pairs"], dtype=np.int64).reshape(-1, 2)
        in_range = (pairs[:, 1] >= 0) & (pairs[:, 1] < len(remap))
        target = np.full(len(pairs), -1)
        target[in_range] = remap[pairs[in_range, 1]]
        ok = target >= 0
        eyes[eye] = {
            "pairs": int(len(pairs)),
            "resolved": int(ok.sum()),
            "coverage": round(float(ok.mean()), 6),
            "distinct_neurons": int(len(np.unique(pairs[:, 0]))),
            "distinct_nodes": int(len(np.unique(target[ok]))),
            "distinct_columns": int(len(np.unique(node_col[target[ok]]))),
        }
    return {
        "source": {
            "repo": FLYBRAIN_REPO,
            "commit": FLYBRAIN_COMMIT,
            "sha256": {
                name: sha256(assets / name)
                for name in ("vision/flyvis.bin", "vision/flyvis.json", "vision/flyvis_map.json")
            },
            "layout_sha256": sha256(layout_path),
        },
        "match_key": "(type name, u, v)",
        "flybrain_nodes": len(theirs),
        "our_nodes": len(ours),
        "matched_nodes": int((remap >= 0).sum()),
        "node_order": "identical" if identical else "remapped",
        # fly-brain node index -> our node index (-1 = no match); null when the orders are identical.
        "flybrain_to_ours": None if identical else remap.tolist(),
        "used_eye": USED_EYE,
        "eyes": eyes,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write", action="store_true", help=f"write {MAP_PATH.relative_to(cfg.ROOT)}")
    args = parser.parse_args()
    result = build()
    used = result["eyes"][USED_EYE]
    print(f"node order: {result['node_order']} "
          f"({result['matched_nodes']}/{result['flybrain_nodes']} fly-brain nodes matched)")
    for eye, e in result["eyes"].items():
        print(f"eye {eye}: {e['resolved']}/{e['pairs']} pairs resolve ({100 * e['coverage']:.3f}%), "
              f"{e['distinct_neurons']} neurons, {e['distinct_nodes']} nodes, {e['distinct_columns']}/721 columns")
    if args.write:
        MAP_PATH.write_text(json.dumps(result, indent=1) + "\n")
        print(f"wrote {MAP_PATH.relative_to(cfg.ROOT)}")
    elif not MAP_PATH.is_file() or json.loads(MAP_PATH.read_text()) != result:
        print(f"{MAP_PATH.relative_to(cfg.ROOT)} is missing or stale; rerun with --write")
        return 1
    if used["coverage"] <= MIN_COVERAGE:
        print(f"FAIL: {USED_EYE}-eye coverage {used['coverage']:.4f} <= {MIN_COVERAGE}")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())

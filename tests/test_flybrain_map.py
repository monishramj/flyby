"""Step 7.4: fly-brain's flyvis node order and map pairs resolve against our layout."""

import hashlib
import json
import re

from reflex import config as cfg
from tools import check_flybrain_map as fbm


def test_saved_map_is_current_and_covers_more_than_95_percent():
    result = fbm.build()
    assert json.loads(fbm.MAP_PATH.read_text()) == result, "rerun python -m tools.check_flybrain_map --write"
    assert result["our_nodes"] == cfg.EXPECTED_NODES
    assert result["matched_nodes"] == result["flybrain_nodes"] == cfg.EXPECTED_NODES
    used = result["eyes"][fbm.USED_EYE]
    assert used["pairs"] == 30_946
    assert used["resolved"] / used["pairs"] > fbm.MIN_COVERAGE
    # The browser uses the map's node indices directly; that is only valid for identical order.
    assert result["node_order"] == "identical" and result["flybrain_to_ours"] is None


def test_vendored_loader_hashes_and_attribution_match_the_assets():
    loader = (cfg.ROOT / "web/vendor/fly-brain/data.js").read_text()
    for name, v, size in re.findall(r"'([\w.]+)': \{ v: '([0-9a-f]{16})', size: (\d+) \}", loader):
        data = (fbm.ASSETS / name).read_bytes()
        assert hashlib.sha256(data).hexdigest()[:16] == v and len(data) == int(size), name
    attribution = (cfg.ROOT / "web/vendor/fly-brain/ATTRIBUTION.md").read_text()
    assert fbm.FLYBRAIN_COMMIT in attribution
    assert (cfg.ROOT / "web/vendor/fly-brain/LICENSE").read_text().startswith("MIT License")

"""The browser renders only server fields, so the wire contract is pinned here.

Every key asserted below is read by web/src/*.ts. If the server stops sending one,
a panel silently renders "—" instead of failing, so these checks stand in for the UI.
"""
import json

import pytest
from fastapi.testclient import TestClient

from batch import run_eval
from conftest import FakeRuntime, fast_settings
from server import app as app_module

SNAPSHOT_KEYS = {"run_id", "seed", "scene", "leads", "intel", "incident", "state", "config", "services"}
SCENE_KEYS = {"area_m", "sector_grid", "gazetteer", "houses", "water", "trees"}
STATE_KEYS = {"t", "drone", "coverage_pct", "coverage_cells", "running", "finished"}
CONFIG_KEYS = {"DEMO_SEED", "COVERAGE_CELL_M", "LIVE_POLICY", "PARSE_MODE"}
LEAD_KEYS = {"lead_id", "x", "y", "sector", "pass", "detector_conf", "box_px", "nearest_landmark",
             "status", "history", "t_capture"}
DECISION_KEYS = {"action", "probs", "urgency", "p_person", "latency_ms", "used_fallback",
                 "routed_to_human", "source", "version"}
PICTURE_KEYS = {"sector_priority", "reported_subjects", "hazards", "last_known_point"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    cfg = fast_settings(LOG_DIR=tmp_path, RESULTS_DIR=tmp_path, MONGODB_URI="", DEMO_SEED=0,
                        LIVE_TIME_SCALE=2_000, WS_HZ=50)
    monkeypatch.setattr(app_module, "settings", cfg)
    monkeypatch.setattr(app_module.Mission, "load_runtime",
                        lambda self: setattr(self, "runtime", FakeRuntime()))
    with TestClient(app_module.app) as client:
        client.app.state.mission.cfg = cfg
        yield client


def test_the_snapshot_carries_every_field_the_browser_renders(client):
    with client.websocket_connect("/ws/mission") as socket:
        payload = socket.receive_json()["payload"]
        assert SNAPSHOT_KEYS <= set(payload)
        assert SCENE_KEYS <= set(payload["scene"])
        assert STATE_KEYS <= set(payload["state"])
        assert CONFIG_KEYS <= set(payload["config"])
        assert PICTURE_KEYS <= set(payload["incident"])
        assert "persistence" in payload["services"]
        landmark = next(iter(payload["scene"]["gazetteer"].values()))
        assert {"x", "y", "sector"} <= set(landmark), "the map labels landmarks by position and sector"
        house = payload["scene"]["houses"][0]
        assert {"x", "y", "width", "height", "kind"} <= set(house)


def test_lead_and_intel_events_carry_every_card_field(client):
    with client.websocket_connect("/ws/mission") as socket:
        socket.receive_json()
        socket.send_json({"type": "mission.control", "payload": {"cmd": "start"}})
        decided = parsed = dispatch = None
        for _ in range(600):
            message = socket.receive_json()
            if message["type"] == "lead.decided" and decided is None:
                decided = message["payload"]
            if message["type"] == "intel.parsed" and parsed is None:
                parsed = message["payload"]
            if message["type"] == "lead.status" and message["payload"]["status"] == "awaiting_approval":
                socket.send_json({"type": "lead.approve", "payload": {"lead_id": message["payload"]["lead_id"]}})
            if message["type"] == "dispatch.created":
                dispatch = message["payload"]
            if decided and parsed and dispatch:
                break
        assert decided and parsed, "the queue and feed need these events"
        assert LEAD_KEYS <= set(decided["lead"])
        assert DECISION_KEYS <= set(decided["decision"])
        assert set(decided["decision"]["probs"]) == {"dispatch_ground_team", "reimage_zoom",
                                                    "close_in_inspect", "ignore"}
        assert {"intel_id", "parse", "ok"} <= set(parsed)
        if parsed["parse"]:
            assert "reports" in parsed["parse"] and "unparseable" in parsed["parse"]
        if dispatch:
            assert {"lead_id", "brief", "pin"} <= set(dispatch)
            assert {"lead_id", "coordinates", "sector", "nearest_landmark", "p_person", "urgency",
                    "time", "text", "source", "digits_stripped"} <= set(dispatch["brief"])
            assert {"headline", "what_drone_saw", "access_notes", "confidence_statement"} == set(dispatch["brief"]["text"])


async def test_the_results_file_matches_what_the_results_tab_reads(tmp_path, monkeypatch):
    import server.triage.laya_runtime as runtime_module
    monkeypatch.setattr(runtime_module, "load", lambda cfg=None: FakeRuntime())
    cfg = fast_settings(RESULTS_DIR=tmp_path)
    await run_eval.evaluate([4], ["laya", "rule"], cfg)
    summary = json.loads((tmp_path / "summary.json").read_text())
    assert {"seeds", "generated_at", "assumptions", "arms", "comparison"} <= set(summary)
    for arm in summary["arms"].values():
        assert {"time_to_dispatch_s", "under_structure_time_to_dispatch_s", "subjects",
                "action_accuracy", "dispatch", "routing_rate", "fallback_rate", "redecisions",
                "latency_ms", "calibration"} <= set(arm)
        assert {"n", "median", "iqr"} <= set(arm["time_to_dispatch_s"])
        assert {"placed", "dispatched"} <= set(arm["subjects"])
        assert {"laya_p_person", "detector_conf", "reliability"} <= set(arm["calibration"])
        assert {"bin", "n", "confidence", "accuracy"} == set(arm["calibration"]["reliability"][0])
    for row in summary["comparison"]:
        assert {"arm", "review_s", "flyby_median_s", "manual_median_s", "speedup"} <= set(row)


def test_the_built_ui_is_served_from_the_same_origin(client):
    """One process serves the UI, so the demo never needs a second port."""
    from server.config import settings
    if not settings.WEB_DIST.is_dir():
        pytest.skip("web/dist is absent; run npm run build")
    page = client.get("/")
    assert page.status_code == 200 and "FlyBy" in page.text

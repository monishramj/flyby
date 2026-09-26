import json

import pytest
from fastapi.testclient import TestClient

from conftest import FakeRuntime, fast_settings
from server import app as app_module
from server.triage.laya_runtime import LayaRuntime


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A live server with Laya faked and Atlas absent, as in the offline demo."""
    cfg = fast_settings(LOG_DIR=tmp_path, RESULTS_DIR=tmp_path, MONGODB_URI="", DEMO_SEED=0,
                        LIVE_TIME_SCALE=2_000, WS_HZ=50)
    monkeypatch.setattr(app_module, "settings", cfg)
    monkeypatch.setattr(app_module.Mission, "load_runtime",
                        lambda self: setattr(self, "runtime", FakeRuntime()))
    with TestClient(app_module.app) as client:
        client.app.state.mission.cfg = cfg
        yield client


def drain(socket, wanted, *, limit=4_000):
    """Collect messages until every wanted type has been seen."""
    seen, missing = [], set(wanted)
    for _ in range(limit):
        message = socket.receive_json()
        seen.append(message)
        missing.discard(message["type"])
        if not missing:
            return seen
    raise AssertionError(f"never received {missing}")


def test_websocket_streams_a_snapshot_then_a_live_mission(client):
    with client.websocket_connect("/ws/mission") as socket:
        snapshot = socket.receive_json()
        assert snapshot["type"] == "mission.snapshot"
        payload = snapshot["payload"]
        assert payload["seed"] == 0 and payload["leads"] == [] and payload["state"]["running"] is False
        assert "subjects" not in payload["scene"], "simulation truth never reaches the browser"
        assert 0 < len(payload["state"]["coverage_cells"]) < 200, "only the first footprint is covered at t=0"
        socket.send_json({"type": "mission.control", "payload": {"cmd": "start"}})
        events = drain(socket, {"mission.state", "lead.new", "lead.decided", "intel.new", "incident.update"})
        state = [message["payload"] for message in events if message["type"] == "mission.state"][-1]
        assert state["t"] > 0 and state["coverage_pct"] > 0
        lead = next(message["payload"] for message in events if message["type"] == "lead.decided")
        assert "truth" not in lead["lead"] and lead["decision"]["source"] in {"laya", "rule"}
        assert json.dumps(events)


def test_approve_dispatches_with_a_brief_and_a_pin(client):
    with client.websocket_connect("/ws/mission") as socket:
        socket.receive_json()
        socket.send_json({"type": "mission.control", "payload": {"cmd": "start"}})
        pending = None
        for _ in range(4_000):
            message = socket.receive_json()
            if message["type"] in {"lead.decided", "lead.status"} and message["payload"]["status"] == "awaiting_approval":
                pending = message["payload"]["lead_id"]
                break
        assert pending, "a lead must reach approval"
        socket.send_json({"type": "mission.control", "payload": {"cmd": "pause"}})
        socket.send_json({"type": "lead.approve", "payload": {"lead_id": pending}})
        dispatch = next(message for message in drain(socket, {"dispatch.created"}) if message["type"] == "dispatch.created")
        assert dispatch["payload"]["lead_id"] == pending
        brief = dispatch["payload"]["brief"]
        assert brief["lead_id"] == pending and brief["coordinates"] == dispatch["payload"]["pin"]
        assert brief["nearest_landmark"] and brief["text"]["headline"]


def test_a_rejected_command_returns_an_error_and_keeps_the_socket_open(client):
    with client.websocket_connect("/ws/mission") as socket:
        socket.receive_json()
        socket.send_json({"type": "lead.override", "payload": {"lead_id": "L-1", "action": "delete_everything"}})
        assert socket.receive_json()["type"] == "error"
        socket.send_json({"type": "mission.control", "payload": {"cmd": "pause"}})
        assert socket.receive_json()["type"] == "mission.state"


def test_reset_with_a_new_seed_replaces_the_mission(client):
    with client.websocket_connect("/ws/mission") as socket:
        assert socket.receive_json()["payload"]["seed"] == 0
        socket.send_json({"type": "mission.control", "payload": {"cmd": "reset", "seed": 11}})
        snapshot = next(message for message in drain(socket, {"mission.snapshot"}) if message["type"] == "mission.snapshot")
        assert snapshot["payload"]["seed"] == 11 and snapshot["payload"]["leads"] == []


def test_results_endpoint_serves_only_files_inside_results(client, tmp_path):
    (tmp_path / "summary.json").write_text('{"ok": true}')
    assert client.get("/api/results/summary.json").json() == {"ok": True}
    assert client.get("/api/results/missing.json").status_code == 404
    assert client.get("/api/results/..%2F.env").status_code in {404, 400}


def test_health_reports_degraded_services(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True and body["atlas"] is False and body["run_id"]


def test_ask_reports_offline_without_credentials(client):
    body = client.post("/api/ask", json={"question": "What is unresolved in S3?"}).json()
    assert "offline" in body["answer"].lower() or "unavailable" in body["answer"].lower()
    assert body["tool_calls"] == []
    assert client.post("/api/ask", json={"question": ""}).status_code == 422


def test_the_runtime_adapter_is_the_only_laya_entry_point():
    assert hasattr(LayaRuntime, "system_one")


def test_a_mission_runs_offline_with_grok_and_atlas_unreachable(tmp_path, monkeypatch):
    """T7 offline demo: no credentials, no Atlas, and nothing may stall or crash."""
    cfg = fast_settings(LOG_DIR=tmp_path, RESULTS_DIR=tmp_path, MONGODB_URI="", XAI_API_KEY="",
                        XAI_MODEL="", PARSE_MODE="grok", DEMO_SEED=7, LIVE_TIME_SCALE=2_000, WS_HZ=50)
    monkeypatch.setattr(app_module, "settings", cfg)
    monkeypatch.setattr(app_module.Mission, "load_runtime",
                        lambda self: setattr(self, "runtime", FakeRuntime()))
    with TestClient(app_module.app) as client:
        client.app.state.mission.cfg = cfg
        with client.websocket_connect("/ws/mission") as socket:
            socket.receive_json()
            socket.send_json({"type": "mission.control", "payload": {"cmd": "start"}})
            decided, failed_parse, brief = [], None, None
            for _ in range(2_000):
                message = socket.receive_json()
                if message["type"] == "lead.decided":
                    decided.append(message["payload"])
                if message["type"] == "intel.parsed" and message["payload"]["ok"] is False:
                    failed_parse = message["payload"]
                if message["type"] in {"lead.status", "lead.decided"}:
                    status, lead_id = message["payload"]["status"], message["payload"]["lead_id"]
                    if status == "awaiting_approval":
                        socket.send_json({"type": "lead.approve", "payload": {"lead_id": lead_id}})
                    elif status == "awaiting_human":
                        socket.send_json({"type": "lead.override",
                                          "payload": {"lead_id": lead_id, "action": "dispatch_ground_team"}})
                if message["type"] == "dispatch.created":
                    brief = message["payload"]["brief"]
                if decided and failed_parse and brief:
                    break
        assert decided, "decisions keep flowing with the network down"
        assert failed_parse and failed_parse["parse"] is None, "the feed reports an unavailable parse"
        assert brief and brief["source"] == "template", "briefs fall back to templates"
        answer = client.post("/api/ask", json={"question": "Status?"}).json()
        assert "offline" in answer["answer"].lower() or "unavailable" in answer["answer"].lower()
    spooled = (tmp_path / "leads.jsonl")
    assert spooled.is_file() and spooled.read_text().strip(), "writes land in the local JSONL spool"

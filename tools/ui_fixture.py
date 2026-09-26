"""Record a real websocket session so web/test can replay it without a server.

  uv run python -m tools.ui_fixture
"""
import json

from fastapi.testclient import TestClient

from server import app as app_module
from server.config import ROOT, settings

OUTPUT = ROOT / "web/test/fixture.json"
LIMIT = 1_200


def record():
    cfg = settings.model_copy(update={"XAI_API_KEY": "", "XAI_MODEL": "", "MONGODB_URI": "",
                                      "PARSE_MODE": "oracle", "LIVE_TIME_SCALE": 2_000, "WS_HZ": 50})
    app_module.settings = cfg
    events = []
    with TestClient(app_module.app) as client:
        client.app.state.mission.cfg = cfg
        with client.websocket_connect("/ws/mission") as socket:
            events.append(socket.receive_json())
            socket.send_json({"type": "mission.control", "payload": {"cmd": "start"}})
            approved = set()
            for _ in range(LIMIT):
                message = socket.receive_json()
                if message["type"] == "mission.state":
                    # The browser merges state updates, so only the snapshot needs the cell list.
                    message["payload"].pop("coverage_cells", None)
                events.append(message)
                if message["type"] in {"lead.status", "lead.decided"}:
                    status, lead_id = message["payload"]["status"], message["payload"]["lead_id"]
                    if lead_id not in approved and status in {"awaiting_approval", "awaiting_human"}:
                        approved.add(lead_id)
                        socket.send_json({"type": "lead.approve", "payload": {"lead_id": lead_id}}
                                         if status == "awaiting_approval" else
                                         {"type": "lead.override",
                                          "payload": {"lead_id": lead_id, "action": "dispatch_ground_team"}})
                kinds = {event["type"] for event in events}
                if {"lead.decided", "intel.parsed", "incident.update", "dispatch.created"} <= kinds and len(events) > 120:
                    break
    ask = {"answer": "Lead L-P1 in S3 is awaiting approval; L-D2 was ignored.",
           "tool_calls": [{"id": "c1", "name": "list_leads", "arguments": {"sector": "S3"},
                           "result": [{"lead_id": "L-P1", "sector": "S3", "status": "awaiting_approval"}]}]}
    return {"events": events, "ask": ask}


def main():
    payload = record()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, indent=1) + "\n")
    kinds = sorted({event["type"] for event in payload["events"]})
    print(f"{len(payload['events'])} events -> {OUTPUT}")
    print("types: " + ", ".join(kinds))


if __name__ == "__main__":
    main()

"""Grok never decides: it proposes schema-checked reports and writes number-free text."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from conftest import FakeRuntime, fast_settings
from server.grok import briefs
from server.grok.ask import ask
from server.grok.client import GrokUnavailable
from server.grok.parse import parse_intel
from server.grok.tools import mission_tools
from server.incident.schemas import BriefText, IntelParse
from server.mission.loop import MissionRun


class FakeChat:
    def __init__(self, client, schema_result=None, script=()):
        self.client, self.schema_result, self.script = client, schema_result, list(script)
        self.history = []

    async def parse(self, schema):
        await asyncio.sleep(self.client.delay)
        if self.client.error:
            raise self.client.error
        return SimpleNamespace(), self.schema_result

    async def sample(self):
        await asyncio.sleep(self.client.delay)
        if self.client.error:
            raise self.client.error
        return self.script.pop(0) if self.script else SimpleNamespace(tool_calls=[], content="No tool data.")

    def append(self, message):
        self.history.append(message)


class FakeClient:
    """Stands in for xai_sdk.AsyncClient without importing its transport."""

    def __init__(self, *, result=None, script=(), delay=0.0, error=None):
        self.result, self.script, self.delay, self.error = result, script, delay, error
        self.chats = []
        self.chat = SimpleNamespace(create=self._create)

    def _create(self, **kwargs):
        chat = FakeChat(self, self.result, self.script)
        self.chats.append((kwargs, chat))
        return chat


def call(name, arguments, call_id="c1"):
    return SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))


GAZETTEER = {"elm_school": {"name": "Elm School", "x": 45, "y": 55, "sector": "S1"}}


async def test_parse_intel_returns_the_schema_instance_and_sends_the_gazetteer():
    parsed = IntelParse(reports=[{"landmark": "elm_school", "urgency": "high", "source": "firsthand"}])
    client = FakeClient(result=parsed)
    result = await parse_intel("two people at elm school", GAZETTEER, cfg=fast_settings(), client=client)
    assert result is parsed
    prompt = client.chats[0][0]["messages"][0]
    assert "elm_school" in str(prompt), "the allowed landmarks are named in the prompt"


async def test_a_parse_timeout_leaves_the_picture_unchanged_and_reports_failure():
    cfg = fast_settings(PARSE_MODE="grok", GROK_PARSE_TIMEOUT_S=0.01)
    run = MissionRun(3, cfg, policy="rule", parse_mode="grok", grok_client=FakeClient(delay=0.5))
    events = []
    run.subscribe(events.append)
    message = run.intel[0]
    run._on_intel(message)
    await asyncio.gather(*list(run._tasks))
    parsed = [event for event in events if event["type"] == "intel.parsed"]
    assert parsed and parsed[0]["payload"]["ok"] is False
    assert run.incident.snapshot()["reports"] == []
    assert not [event for event in events if event["type"] == "incident.update"]
    assert run.intel_log[message["intel_id"]]["ok"] is False
    await run.stop()


async def test_a_successful_parse_updates_the_picture_and_triggers_redecision():
    cfg = fast_settings(PARSE_MODE="grok")
    parsed = IntelParse(reports=[{"landmark": "elm_school", "urgency": "critical",
                                  "source": "secondhand", "subject_count": 2}])
    run = MissionRun(3, cfg, policy="laya", parse_mode="grok", runtime=FakeRuntime(),
                     grok_client=FakeClient(result=parsed))
    lead = {"lead_id": "L-A", "t_capture": 1.0, "x": 45.0, "y": 55.0, "sector": "S1", "pass": 1,
            "detector_conf": .8, "box_px": 40.0, "altitude_m": 40, "near_structure": False,
            "nearest_landmark": "elm_school", "truth": {"is_person": True, "visibility": "visible"}}
    run._register(lead)
    await run._decide(lead)
    assert lead["status"] == "awaiting_approval"
    run._on_intel(run.intel[0])
    await asyncio.gather(*list(run._tasks))
    assert run.incident.snapshot()["sector_priority"] == {"S1": "critical"}
    assert len(lead["history"]) == 2, "new intel re-decides the pending lead"
    assert run.redecision_count == 1
    await run.stop()


async def test_a_lead_decided_while_a_parse_is_pending_uses_the_earlier_snapshot():
    cfg = fast_settings(PARSE_MODE="grok")
    parsed = IntelParse(reports=[{"landmark": "elm_school", "urgency": "critical", "source": "secondhand"}])
    run = MissionRun(3, cfg, policy="laya", parse_mode="grok", runtime=FakeRuntime(),
                     grok_client=FakeClient(result=parsed, delay=0.05))
    run._on_intel(run.intel[0])
    lead = {"lead_id": "L-A", "t_capture": 1.0, "x": 45.0, "y": 55.0, "sector": "S1", "pass": 1,
            "detector_conf": .8, "box_px": 40.0, "altitude_m": 40, "near_structure": False,
            "truth": {"is_person": True, "visibility": "visible"}}
    run._register(lead)
    await run._decide(lead)
    assert lead["state"]["context"].get("sector_priority") is None, "the decision used the picture it could read"
    await asyncio.gather(*list(run._tasks))
    assert run.incident.snapshot()["sector_priority"] == {"S1": "critical"}
    assert len(lead["history"]) == 2, "the pending lead is re-decided once the parse lands"
    await run.stop()


def dispatch_lead():
    return {"lead_id": "L-A", "x": 45.25, "y": 55.5, "sector": "S1", "pass": 1, "t_capture": 12.0,
            "nearest_landmark": "elm_school", "near_structure": True,
            "state": {"lead": {"size_band": "medium", "detector_band": "high"}},
            "decision": {"action": "dispatch_ground_team", "urgency": 2, "p_person": 0.81}}


async def test_brief_numbers_come_only_from_code_and_digits_are_stripped():
    text = BriefText(headline="Crew to grid 45 now", what_drone_saw="1 person seen",
                     access_notes="Approach from the south", confidence_statement="Detection only")
    brief = await briefs.create_brief(dispatch_lead(), {"hazards": [{"type": "fire", "x": 1, "y": 2}]},
                                     gazetteer=GAZETTEER, t=30.0, cfg=fast_settings(),
                                     client=FakeClient(result=text))
    assert brief["source"] == "grok" and brief["digits_stripped"] is True
    assert not any(character.isdigit() for value in brief["text"].values() for character in value)
    assert brief["text"]["headline"] == "Crew to grid now"
    assert brief["coordinates"] == {"x": 45.25, "y": 55.5} and brief["p_person"] == 0.81
    assert brief["nearest_landmark"] == "elm_school" and brief["time"] == 30.0


async def test_a_brief_timeout_falls_back_to_the_template():
    cfg = fast_settings(GROK_BRIEF_TIMEOUT_S=0.01)
    brief = await briefs.create_brief(dispatch_lead(), {"hazards": []}, gazetteer=GAZETTEER, t=1.0,
                                      cfg=cfg, client=FakeClient(delay=0.5))
    template = briefs.template_brief(dispatch_lead(), {"hazards": []}, gazetteer=GAZETTEER, t=1.0)
    assert brief["source"] == "template" and brief["text"] == template["text"]
    assert brief["p_person"] == 0.81, "code still supplies the numbers"


async def mission_for_ask(**kwargs):
    run = MissionRun(3, fast_settings(), policy="laya", runtime=FakeRuntime(), **kwargs)
    lead = {"lead_id": "L-A", "t_capture": 1.0, "x": 45.0, "y": 55.0, "sector": "S1", "pass": 1,
            "detector_conf": .8, "box_px": 40.0, "altitude_m": 40, "near_structure": False,
            "nearest_landmark": "elm_school", "truth": {"is_person": True, "visibility": "visible"}}
    run._register(lead)
    await run._decide(lead)
    return run


async def test_ask_records_a_tool_trace_and_leaves_the_mission_unchanged():
    run = await mission_for_ask()
    before = json.dumps(run.snapshot(), sort_keys=True, default=str)
    script = [SimpleNamespace(tool_calls=[call("list_leads", {"sector": "S1"}), call("get_mission_status", {}, "c2")],
                              content=None),
              SimpleNamespace(tool_calls=[], content="Lead L-A is awaiting approval in S1.")]
    result = await ask(run, "What is pending in S1?", cfg=fast_settings(), client=FakeClient(script=script))
    assert result["answer"] == "Lead L-A is awaiting approval in S1."
    assert [entry["name"] for entry in result["tool_calls"]] == ["list_leads", "get_mission_status"]
    assert result["tool_calls"][0]["result"][0]["lead_id"] == "L-A"
    assert json.dumps(run.snapshot(), sort_keys=True, default=str) == before, "tools are read-only"
    await run.stop()


async def test_ask_stops_at_the_round_cap():
    run = await mission_for_ask()
    cfg = fast_settings(ASK_MAX_TOOL_ROUNDS=2)
    looping = [SimpleNamespace(tool_calls=[call("get_mission_status", {})], content=None) for _ in range(6)]
    result = await ask(run, "Loop forever", cfg=cfg, client=FakeClient(script=looping))
    assert "round limit" in result["answer"]
    assert len(result["tool_calls"]) == cfg.ASK_MAX_TOOL_ROUNDS
    await run.stop()


async def test_ask_reports_unavailable_tools_and_offline_grok():
    run = await mission_for_ask()
    _, implementations = mission_tools(run)
    assert (await implementations["get_decision_stats"]())["unavailable"] is True
    result = await ask(run, "Status?", cfg=fast_settings(), client=FakeClient(error=RuntimeError("no network")))
    assert "offline" in result["answer"].lower() or "unavailable" in result["answer"].lower()
    with pytest.raises(ValueError):
        await ask(run, "   ", cfg=fast_settings())
    await run.stop()


async def test_ask_logs_every_exchange_to_qa():
    documents = []
    writer = SimpleNamespace(put=lambda collection, document: documents.append((collection, document)),
                             available=False, decision_stats=None)
    run = await mission_for_ask(writer=writer)
    script = [SimpleNamespace(tool_calls=[], content="Nothing is unresolved.")]
    await ask(run, "Anything unresolved?", cfg=fast_settings(), client=FakeClient(script=script))
    qa = [document for collection, document in documents if collection == "qa"]
    assert len(qa) == 1 and qa[0]["question"] == "Anything unresolved?"
    assert qa[0]["answer"] == "Nothing is unresolved." and qa[0]["latency_ms"] >= 0
    await run.stop()


async def test_an_unknown_tool_is_refused_without_raising():
    run = await mission_for_ask()
    script = [SimpleNamespace(tool_calls=[call("delete_mission", {})], content=None),
              SimpleNamespace(tool_calls=[], content="I cannot do that.")]
    result = await ask(run, "Delete the mission", cfg=fast_settings(), client=FakeClient(script=script))
    assert result["tool_calls"][0]["result"] == {"error": "Invalid read-only tool or arguments"}
    assert result["answer"] == "I cannot do that."
    await run.stop()


async def test_grok_unavailable_without_credentials():
    with pytest.raises(GrokUnavailable):
        await parse_intel("anything", GAZETTEER, cfg=fast_settings(XAI_API_KEY="", XAI_MODEL=""))

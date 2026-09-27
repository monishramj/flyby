"""External flight results must not confuse an incomplete visit with an empty one."""
import pytest

from conftest import FakeRuntime, fast_settings
from server.app import Mission
from server.mission.loop import MissionRun
from server.protocol import command_adapter


@pytest.fixture
async def inspection():
    run = MissionRun(3, fast_settings(), policy="laya", runtime=FakeRuntime(action="close_in_inspect"))
    lead = {"lead_id": "L-A", "t_capture": 1.0, "x": 45., "y": 55., "sector": "S1", "pass": 1,
            "detector_conf": .6, "box_px": 40., "altitude_m": 40, "near_structure": True,
            "truth": {"is_person": True, "visibility": "under_structure"}}
    run._register(lead)
    await run._decide(lead)
    assert run.approve("L-A")
    yield run, lead
    await run.stop()


@pytest.mark.parametrize("found,collided", [(False, False), (False, True), (True, False), (None, False)])
async def test_incomplete_external_visit_needs_human_even_when_found_is_false(inspection, found, collided):
    run, lead = inspection
    mission = Mission(fast_settings())
    mission.run = run
    await mission.handle({"type": "inspect.result", "payload": {
        "lead_id": "L-A", "reached": False, "found": found, "collided": collided}})
    assert lead["status"] == "awaiting_human"
    assert lead["inspection_found"] is None
    assert lead["inspection"]["collided"] is collided
    assert lead["decision"]["routed_to_human"] is True
    assert run._resolve_inspection("L-A", None) is False


@pytest.mark.parametrize("found,expected", [(None, "awaiting_approval"), (True, "awaiting_approval"), (False, "resolved_empty")])
async def test_reached_result_uses_explicit_found_or_simulation_truth(inspection, found, expected):
    run, lead = inspection
    assert run.inspect_result("L-A", found, reached=True)
    assert lead["status"] == expected
    assert lead["inspection"]["source"] == "external"
    assert run.inspect_result("L-A", not found, reached=True) is False


async def test_earlier_timer_does_not_resolve_a_retry(inspection):
    run, lead = inspection
    old_token = lead["human_token"]
    assert run.inspect_result("L-A", None, reached=False)
    assert run.approve("L-A")
    assert run._resolve_inspection("L-A", None, token=old_token) is False
    assert lead["status"] == "inspecting"


async def test_timer_still_resolves_an_unflown_visit(inspection):
    run, lead = inspection
    assert run._resolve_inspection("L-A", None, token=lead["human_token"])
    assert lead["status"] == "awaiting_approval"
    assert lead["inspection"]["source"] == "truth"


def test_legacy_result_defaults_to_reached_and_accepts_unknown_person():
    result = command_adapter.validate_python({"type": "inspect.result", "payload": {
        "lead_id": "L-A", "found": False, "collided": False}})
    assert result.payload.reached is True and result.payload.found is False
    result = command_adapter.validate_python({"type": "inspect.result", "payload": {
        "lead_id": "L-A", "reached": False, "collided": False}})
    assert result.payload.found is None


@pytest.mark.parametrize("reached", [True, False, None])
async def test_collision_always_needs_human_including_legacy_client(inspection, reached):
    run, lead = inspection
    mission = Mission(fast_settings())
    mission.run = run
    payload = {"lead_id": "L-A", "found": True, "collided": True}
    if reached is not None:
        payload["reached"] = reached
    await mission.handle({"type": "inspect.result", "payload": payload})
    assert lead["status"] == "awaiting_human"
    assert lead["inspection_found"] is None
    assert lead["inspection"]["collided"] is True


async def test_request_draws_truth_and_caps_the_flight_under_the_hover(inspection):
    run, lead = inspection
    seen = []
    run.subscribe(seen.append)
    await run.clock.advance_to(run.drone.visit["arrive_t"])
    request = next(m["payload"] for m in seen if m["type"] == "inspect.request")
    assert request == {"lead_id": "L-A", "person": True,
                       "maxWallS": run.cfg.INSPECT_HOVER_S / run.cfg.LIVE_TIME_SCALE - 2}
    assert lead["status"] == "inspecting"  # the truth fallback waits for the full hover


async def test_new_intel_does_not_redecide_an_inspection_confirmed_person(inspection):
    run, lead = inspection
    assert run.inspect_result("L-A", True, reached=True)
    assert lead["status"] == "awaiting_approval" and lead["decision"]["source"] == "inspection"
    lead["state"] = None  # any state change would normally trigger a re-decision
    await run.on_incident_update(run.incident.public())
    assert lead["decision"]["source"] == "inspection"
    assert lead["decision"]["action"] == "dispatch_ground_team"

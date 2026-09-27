import asyncio
import json
import time

import pytest

from conftest import FakeRuntime, fast_settings
from server.incident.schemas import IntelParse
from server.mission.loop import PENDING, TERMINAL, MissionRun
from server.mission.truth import optimal_action
from server.store.writer import Writer

DECIDED = {"ignored", "auto_closed", "reimaging", "awaiting_approval", "awaiting_human"}
HUMAN = {"dispatched", "inspecting", "reimaging", "ignored"}
VALID = {
    "captured": DECIDED,
    "awaiting_approval": DECIDED | HUMAN,
    "awaiting_human": DECIDED | HUMAN,
    "auto_closed": DECIDED | HUMAN,
    "reimaging": DECIDED,
    "inspecting": {"awaiting_approval", "resolved_empty"},
    "dispatched": set(), "ignored": set(), "resolved_empty": set(),
}


async def run_fast(seed=3, **kwargs):
    cfg = kwargs.pop("cfg", fast_settings())
    run = MissionRun(seed, cfg, fast=True, runtime=kwargs.pop("runtime", FakeRuntime()), **kwargs)
    events = []
    run.subscribe(events.append)
    try:
        await run.start()
    finally:
        await run.stop()
    return run, events


async def test_fast_run_processes_every_capture_with_valid_transitions():
    run, events = await run_fast(policy="laya", sim_human=True)
    assert run.leads and run._finished
    for lead in run.leads.values():
        assert lead["status"] in TERMINAL or lead["status"] in PENDING
        assert lead["history"], "every lead reaches a decision"
        names = [entry["status"] for entry in lead["status_history"]]
        assert names[0] == "captured"
        for before, after in zip(names, names[1:]):
            assert after in VALID[before], f"{lead['lead_id']}: {before} -> {after}"
    assert {event["type"] for event in events} >= {
        "mission.snapshot", "lead.new", "lead.decided", "lead.status", "intel.new", "intel.parsed", "incident.update"}
    assert json.dumps(events)


async def test_event_order_is_deterministic_for_a_seed():
    def trace(events):
        return [(event["type"], event["payload"].get("lead_id") or event["payload"].get("intel_id")) for event in events]

    first, second = await run_fast(policy="laya", sim_human=True), await run_fast(policy="laya", sim_human=True)
    assert trace(first[1]) == trace(second[1])


async def test_reimage_produces_a_pass_two_lead_and_pass_two_reimage_routes_to_a_human():
    cfg = fast_settings()
    run = MissionRun(3, cfg, fast=True, policy="laya", runtime=FakeRuntime(action="reimage_zoom"))
    try:
        await run.start()
    finally:
        await run.stop()
    reimaged = [lead for lead in run.leads.values() if lead["pass"] == cfg.MAX_PASSES]
    assert reimaged, "a reimage_zoom decision must produce a second pass"
    for lead in reimaged:
        assert lead["history"][-1]["routed_to_human"] is True
        assert lead["status"] == "awaiting_human"
        assert [entry["status"] for entry in lead["status_history"]].count("reimaging") == 1


def hidden_lead(lead_id, *, is_person):
    return {"lead_id": lead_id, "t_capture": 1.0, "x": 45.0, "y": 55.0, "sector": "S1", "pass": 1,
            "detector_conf": .6, "box_px": 40.0, "altitude_m": 40, "near_structure": True,
            "nearest_landmark": "elm_school",
            "truth": {"is_person": is_person, "kind": "subject" if is_person else "decoy",
                      "type": "subject" if is_person else "debris",
                      **({"visibility": "under_structure"} if is_person else {})}}


async def test_inspection_resolves_from_truth_after_the_timer():
    cfg = fast_settings()
    run = MissionRun(3, cfg, fast=True, policy="laya", runtime=FakeRuntime(action="close_in_inspect"))
    found, empty = hidden_lead("L-person", is_person=True), hidden_lead("L-junk", is_person=False)
    for lead in (found, empty):
        run._register(lead)
        await run._decide(lead)
        assert lead["status"] == "awaiting_approval"
        assert run.approve(lead["lead_id"]) is True
        assert lead["status"] == "inspecting"
    await run.clock.advance_to(run.clock.now + 600)  # the drone flies to each lead in turn and looks
    assert found["decision"]["action"] == "dispatch_ground_team"
    assert found["decision"]["probs"]["dispatch_ground_team"] == 1
    assert found["status"] == "awaiting_approval"
    assert run.approve("L-person") is True and found["status"] == "dispatched"
    assert empty["status"] == "resolved_empty"
    await run.stop()


async def test_low_confidence_routes_and_a_human_override_sets_the_final_action():
    run = MissionRun(3, fast_settings(), fast=True, policy="laya", runtime=FakeRuntime(confident=False))
    await run.start()
    try:
        assert all(lead["history"][0]["routed_to_human"] for lead in run.leads.values())
        lead_id = next(key for key, lead in run.leads.items() if run.leads[key]["status"] == "awaiting_human")
        assert run.override(lead_id, "ignore") is True
        assert run.leads[lead_id]["final_action"] == "ignore"
        assert run.leads[lead_id]["status"] == "ignored"
        assert run.override(lead_id, "dispatch_ground_team") is False, "a settled lead rejects further input"
        assert run.approve("L-missing") is False
    finally:
        await run.stop()


async def test_simulated_human_accuracy_and_approval_of_dispatches():
    run, _ = await run_fast(seed=7, policy="laya", sim_human=True)
    humans = [lead for lead in run.leads.values() if lead.get("human")]
    assert humans
    agreed = sum(lead["human"]["action"] == optimal_action(lead, run.cfg) for lead in humans)
    assert agreed / len(humans) >= .6
    dispatched = [lead for lead in run.leads.values() if lead["status"] == "dispatched"]
    assert dispatched and all(lead["dispatch"]["text"] for lead in dispatched)


async def test_intel_raises_a_sector_priority_and_redecides_only_pending_leads_there():
    cfg = fast_settings()
    run = MissionRun(3, cfg, fast=True, policy="laya", runtime=FakeRuntime())
    lead = {"lead_id": "L-A", "object_id": "P1", "t_capture": 1.0, "x": 45.0, "y": 55.0, "sector": "S1",
            "pass": 1, "detector_conf": .8, "box_px": 40.0, "altitude_m": 40, "near_structure": False,
            "nearest_landmark": "elm_school", "truth": {"is_person": True, "kind": "subject", "type": "subject", "visibility": "visible"}}
    other = {**lead, "lead_id": "L-B", "x": 255.0, "y": 55.0, "sector": "S3", "nearest_landmark": "river_bridge"}
    settled = {**lead, "lead_id": "L-C", "x": 250.0, "y": 250.0, "sector": "S9", "nearest_landmark": "maple_tower"}
    for item in (lead, other, settled):
        run._register(item)
        await run._decide(item)
    run._set_status(settled, "dispatched")
    before = {key: len(value["history"]) for key, value in run.leads.items()}
    # A secondhand, sector-only report changes S1's priority without moving the last-known point.
    await run.incident.apply(IntelParse(reports=[{"sector": "S1", "urgency": "critical", "source": "secondhand", "subject_count": 2}]), "I1", 20.0)
    after = {key: len(value["history"]) for key, value in run.leads.items()}
    assert after["L-A"] == before["L-A"] + 1, "the pending lead in S1 is decided again"
    assert after["L-B"] == before["L-B"], "a lead in another sector is untouched"
    assert after["L-C"] == before["L-C"], "a dispatched lead is never re-decided"
    assert run.leads["L-A"]["history"][-1]["urgency"] == 3.0
    assert run.redecision_count == 1
    await run.stop()


async def test_an_identical_picture_change_does_not_redecide():
    run = MissionRun(3, fast_settings(), fast=True, policy="laya", runtime=FakeRuntime())
    lead = {"lead_id": "L-A", "t_capture": 1.0, "x": 45.0, "y": 55.0, "sector": "S1", "pass": 1,
            "detector_conf": .8, "box_px": 40.0, "altitude_m": 40, "near_structure": False,
            "truth": {"is_person": True, "visibility": "visible"}}
    run._register(lead)
    await run._decide(lead)
    await run.incident.apply(IntelParse(reports=[], unparseable=True), "I1", 5.0)
    assert len(run.leads["L-A"]["history"]) == 1
    await run.stop()


async def test_a_writer_whose_io_takes_a_second_does_not_slow_decisions(tmp_path):
    """README §1 rule 2: put() queues, so persistence never enters the decision path."""
    cfg = fast_settings(LOG_DIR=tmp_path, MONGODB_URI="")
    writer = Writer(cfg)
    seen = []

    async def slow_write(collection, documents):
        seen.append((collection, documents))
        await asyncio.sleep(1)

    writer._write = slow_write
    await writer.start()
    run = MissionRun(3, cfg, fast=True, policy="laya", runtime=FakeRuntime(), writer=writer, sim_human=True)
    started = time.perf_counter()
    await run.start()
    elapsed = time.perf_counter() - started
    await run.stop()
    latencies = [entry["latency_ms"] for lead in run.leads.values() for entry in lead["history"]]
    assert latencies and max(latencies) < 1_000
    assert elapsed < 5, "the mission must not wait for queued writes"
    assert writer.queue.qsize() > 0, "writes are still draining behind the mission"
    writer._write = lambda collection, documents: asyncio.sleep(0)
    await writer.stop()
    assert {collection for collection, _ in seen} >= {"runs"}


async def test_external_inspect_result_wins_in_a_live_run():
    run = MissionRun(3, fast_settings(), policy="laya", runtime=FakeRuntime(action="close_in_inspect"))
    lead = {"lead_id": "L-A", "t_capture": 1.0, "x": 45.0, "y": 55.0, "sector": "S1", "pass": 1,
            "detector_conf": .6, "box_px": 40.0, "altitude_m": 40, "near_structure": True,
            "truth": {"is_person": True, "visibility": "under_structure"}}
    run._register(lead)
    await run._decide(lead)
    assert run.approve("L-A") is True
    assert lead["status"] == "inspecting"
    assert run.inspect_result("L-A", found=False) is True
    assert lead["status"] == "resolved_empty" and lead["inspection"]["source"] == "external"
    assert run.inspect_result("L-A", found=True) is False
    await run.stop()


@pytest.mark.parametrize("policy", ["rule", "laya"])
async def test_both_policies_complete_a_run(policy):
    run, _ = await run_fast(seed=11, policy=policy, sim_human=True)
    assert all(lead["history"][0]["source"] == ("rule" if policy == "rule" else "laya") for lead in run.leads.values())
    assert all(lead["baseline_rule"] for lead in run.leads.values())


def open_lead(lead_id, conf):
    return {"lead_id": lead_id, "t_capture": 1.0, "x": 150.0, "y": 150.0, "sector": "S5", "pass": 1,
            "detector_conf": conf, "box_px": 40.0, "altitude_m": 40, "near_structure": False,
            "nearest_landmark": "elm_school", "truth": {"is_person": False, "kind": "decoy", "type": "debris"}}


async def test_ignore_only_auto_closes_a_low_band_and_stays_reopenable():
    run = MissionRun(3, fast_settings(), fast=True, policy="laya", runtime=FakeRuntime(action="ignore"))
    low, medium = open_lead("L-low", .2), open_lead("L-medium", .6)
    for lead in (low, medium):
        run._register(lead)
        await run._decide(lead)
    assert low["status"] == "auto_closed", "a low-band ignore is closed but kept reviewable"
    assert medium["status"] == "awaiting_human", "an ignore on a non-low band needs a human"
    assert run.override("L-low", "dispatch_ground_team") is True and low["status"] == "dispatched"
    await run.stop()


async def test_new_intel_re_decides_an_auto_closed_lead():
    run = MissionRun(3, fast_settings(), fast=True, policy="laya", runtime=FakeRuntime(action="ignore"))
    lead = open_lead("L-low", .2)
    run._register(lead)
    await run._decide(lead)
    assert lead["status"] == "auto_closed"
    run.leads = {"L-low": lead}
    await run.incident.apply(IntelParse.model_validate({"reports": [{"sector": "S5", "urgency": "critical",
                             "subject_count": 2, "source": "firsthand"}]}), "I1", 5.0)
    assert len(lead["history"]) == 2, "the changed context triggers a second decision"
    await run.stop()


async def test_only_a_confident_ignore_in_the_open_may_auto_close():
    """No one gets lost: cover or doubt sends a would-be ignore to a human instead."""
    cases = [("L-open-sure", False, True, "auto_closed"),       # low score, in the open, Laya 0.94 sure
             ("L-roof-sure", True, True, "awaiting_human"),     # 61% of low-score leads by a building are people
             ("L-open-unsure", False, False, "awaiting_human")]  # Laya under TAU_CLOSE
    for lead_id, structure, confident, expected in cases:
        run = MissionRun(3, fast_settings(), fast=True, policy="laya",
                         runtime=FakeRuntime(action="ignore", confident=confident))
        lead = {**open_lead(lead_id, .2), "near_structure": structure}
        run._register(lead)
        await run._decide(lead)
        assert lead["status"] == expected, lead_id
        assert lead["person_chance"] == (0.61 if structure else 0.13)
        await run.stop()


async def test_the_rule_obeys_the_same_close_gate():
    run = MissionRun(3, fast_settings(), fast=True, policy="rule", runtime=FakeRuntime())
    lead = {**open_lead("L-roof", .2), "near_structure": True}
    run._register(lead)
    await run._decide(lead)
    assert lead["decision"]["action"] == "ignore" and lead["status"] == "awaiting_human"
    await run.stop()


async def test_the_drone_reroutes_to_reimage_and_the_sweep_resumes_later():
    cfg = fast_settings()
    run = MissionRun(3, cfg, fast=True, policy="laya", runtime=FakeRuntime(action="reimage_zoom"))
    await run.start()
    try:
        planned = {capture["id"]: capture["t"] for capture in run.sweep.captures()}
        late = [cid for cid, t in run.capture_times.items() if t > planned[cid] + 1e-6]
        assert late, "visits pushed later captures back"
        assert max(run.capture_times.values()) > max(planned.values())
        assert all(lead["pass"] == 2 for lead in run.leads.values() if lead["history"] and len(lead["history"]) > 1
                   and lead["history"][0]["action"] == "reimage_zoom")
        assert run.drone.visit is None and not run._visits and run._search_done()
        detours = run.mission_state()["detours"]
        assert detours and all(d["status"] == "done" for d in detours), "every reimage shows up as a flown GUIDED waypoint"
        assert [d["n"] for d in detours] == list(range(1, len(detours) + 1))
        assert all(3 <= d["before_seq"] <= len(run.sweep.mission) for d in detours)
    finally:
        await run.stop()


async def test_visits_go_to_the_likeliest_person_first():
    cfg = fast_settings()
    run = MissionRun(3, cfg, fast=True, policy="laya", runtime=FakeRuntime(action="reimage_zoom"))
    far, near = open_lead("L-maybe", .5), {**open_lead("L-likely", .7), "x": 250.0}
    for lead in (far, near):
        run._register(lead)
    far["person_chance"], near["person_chance"] = .13, .96
    run.drone.plan_visit(0, far, "reimage")  # the drone is busy, so both requests queue
    run._request_visit(far, "reimage")
    run._request_visit(near, "reimage")
    run.drone.finish_visit()
    run._start_visit(run.clock.now)
    assert run.drone.visit["lead_id"] == "L-likely"
    await run.stop()

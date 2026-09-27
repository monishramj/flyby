import asyncio
from copy import deepcopy
import json

import numpy as np
import pytest
from pydantic import ValidationError

from server.config import Settings
from server.incident.schemas import IntelParse, Report
from server.mission.clock import SimClock
from server.mission.intel_script import generate as generate_intel
from server.mission.noise import Noise
from server.mission.scenario import generate, sector_of
from server.mission.sweep import Sweep, contains
from server.mission.truth import optimal_action


def test_scenario_and_sweep():
    cfg = Settings()
    a, b = generate(17, cfg), generate(17, cfg)
    assert a.snapshot() == b.snapshot()
    assert cfg.N_SUBJECTS[0] <= len(a.subjects) <= cfg.N_SUBJECTS[1]
    assert cfg.N_DECOYS[0] <= len(a.decoys) <= cfg.N_DECOYS[1]
    assert set(p["visibility"] for p in a.subjects) == {"visible", "partial", "under_structure"}
    assert all(0 <= p["x"] <= cfg.AREA_M and 0 <= p["y"] <= cfg.AREA_M for p in a.subjects + a.decoys + a.houses + a.trees)
    assert any(h["kind"] == "carport" for h in a.houses)
    assert {p["sector"] for p in a.gazetteer.values()} == {f"S{i}" for i in range(1, 10)}
    assert [sector_of(x, y, cfg) for x, y in [(0, 0), (150, 0), (299, 0), (0, 150), (300, 300)]] == ["S1", "S2", "S3", "S4", "S9"]
    json.dumps(a.snapshot())
    assert "subjects" not in a.snapshot(include_truth=False)
    snapshot = a.snapshot()
    snapshot["subjects"].clear()
    assert a.subjects
    sweep = Sweep(cfg)
    assert sweep.footprint_m == pytest.approx(46.188, abs=.001)
    assert 60 <= len(sweep.captures()) <= 70
    assert 300 <= sweep.duration <= 360
    assert sweep.coverage(sweep.duration)["coverage_pct"] >= 99
    assert sweep.coverage(-1)["coverage_pct"] == 0
    assert sweep.position_at(0) == {"x": 10., "y": 10.}
    assert sweep.position_at(5) == {"x": 10., "y": 50.}
    assert sweep.position_at(sweep.duration + 1) == sweep.path[-1]
    assert all(any(contains(c, obj) for c in sweep.captures()) for obj in a.subjects + a.decoys)


def test_detector_rates_deduplication_and_reimage():
    cfg = Settings()
    scenario = generate(5, cfg)
    capture = {"id": "C1", "t": 0., "x": 50., "y": 50., "footprint_m": Sweep(cfg).footprint_m}
    for category, (probability, _) in cfg.NOISE.items():
        subject = category in {"visible", "partial", "under_structure"}
        obj = {"id": "object", "x": 50., "y": 50., "visibility" if subject else "type": category}
        scenario.subjects, scenario.decoys = ([obj], []) if subject else ([], [obj])
        rng = np.random.default_rng(400)
        detected = sum(bool(Noise(scenario, rng).detect(capture)) for _ in range(2000))
        assert abs(detected / 2000 - probability) <= .03
    scenario = generate(8, cfg)
    noise = Noise(scenario, np.random.default_rng(12))
    leads = [lead for cap in Sweep(cfg).captures() for lead in noise.detect(cap)]
    assert leads
    assert len({lead["object_id"] for lead in leads}) == len(leads)
    original = deepcopy(leads[0])
    zoomed = noise.recapture(original)
    assert original == leads[0]
    assert zoomed["pass"] == 2 and zoomed["lead_id"] == original["lead_id"]
    assert zoomed["box_px"] == original["box_px"] * cfg.REIMAGE_BOX_MULT
    assert zoomed["t_capture"] == original["t_capture"], "the loop stamps the real arrival time"
    with pytest.raises(ValueError):
        noise.recapture(zoomed)


def test_every_truth_cell_and_schema_bounds():
    for person, visibility, size, first, second in [
        (False, None, 30, "ignore", "ignore"),
        (True, "under_structure", 30, "close_in_inspect", "close_in_inspect"),
        (True, "partial", 30, "reimage_zoom", "dispatch_ground_team"),
        (True, "visible", 19, "reimage_zoom", "dispatch_ground_team"),
        (True, "visible", 20, "dispatch_ground_team", "dispatch_ground_team"),
    ]:
        lead = {"truth": {"is_person": person, "visibility": visibility}, "box_px": size, "pass": 1}
        assert optimal_action(lead) == first
        lead["pass"] = 2
        assert optimal_action(lead) == second
    with pytest.raises(ValidationError):
        Report(sector="S1", subject_count=21, urgency="high", source="firsthand")
    with pytest.raises(ValidationError):
        Report(landmark="fictional", urgency="high", source="firsthand")


def test_intel_deterministic_and_valid():
    cfg = Settings()
    scene = generate(20, cfg)
    messages = generate_intel(scene, np.random.default_rng(9))
    assert messages == generate_intel(scene, np.random.default_rng(9))
    assert cfg.INTEL_COUNT[0] <= len(messages) <= cfg.INTEL_COUNT[1]
    assert [m["t"] for m in messages] == sorted(m["t"] for m in messages)
    parsed = [IntelParse.model_validate(m["oracle_parse"]) for m in messages]
    assert any(p.unparseable for p in parsed)
    assert sum(r.is_retraction for p in parsed for r in p.reports) == 1
    assert all(0 <= m["t"] <= Sweep(cfg).duration for m in messages)
    json.dumps(messages)


async def test_clock_order_awaitables_and_new_events():
    clock = SimClock(fast=True)
    events = []

    async def first():
        await asyncio.sleep(0)
        events.append((clock.now, "first"))
        clock.call_at(2, lambda: events.append((clock.now, "new")))

    clock.call_at(1, first)
    clock.call_at(1, lambda: events.append((clock.now, "tie")))
    clock.call_at(3, lambda: events.append((clock.now, "last")))
    await clock.run()
    assert events == [(1, "first"), (1, "tie"), (2, "new"), (3, "last")]
    assert clock.now == 3 and not clock.pending
    with pytest.raises(ValueError):
        await clock.advance_to(2)


async def test_live_clock_pause():
    clock = SimClock(scale=10)
    clock.resume()
    await asyncio.sleep(.01)
    clock.pause()
    frozen = clock.now
    await asyncio.sleep(.01)
    assert frozen > 0 and clock.now == frozen


def test_a_visit_takes_the_drone_off_the_sweep_and_pauses_it():
    from server.mission.sweep import Drone
    cfg = Settings()
    sweep = Sweep(cfg)
    drone = Drone(sweep, cfg)
    home = drone.position(20)
    visit = drone.plan_visit(20, {"lead_id": "L-1", "x": home["x"] + 60, "y": home["y"]}, "reimage")
    leg = 60 / cfg.TRANSIT_SPEED_MPS
    assert visit["arrive_t"] == 20 + leg and visit["done_t"] == 20 + leg + cfg.ZOOM_HOVER_S
    halfway = drone.position(20 + leg / 2)
    assert abs(halfway["x"] - (home["x"] + 30)) < 1e-6, "flying out to the lead"
    assert drone.sweep_time(20 + leg) == 20, "the sweep is frozen while away"
    drone.finish_visit()
    assert drone.offset == 2 * leg + cfg.ZOOM_HOVER_S
    assert drone.position(20 + drone.offset) == home, "it resumes exactly where it left"


def test_the_mission_lists_numbered_waypoints_and_holds_the_current_one_while_guided():
    from server.mission.sweep import Drone
    cfg = Settings()
    sweep = Sweep(cfg)
    assert [item["command"] for item in sweep.mission[:2]] == ["DO_SET_CAM_TRIGG_DIST", "NAV_WAYPOINT"]
    assert len(sweep.mission) == 1 + len(sweep.path) and [i["seq"] for i in sweep.mission] == list(range(1, len(sweep.mission) + 1))
    assert sweep.current_seq(0) == 3, "starts at the first waypoint, flying to the second"
    assert sweep.current_seq(sweep.duration + 99) == len(sweep.mission)
    drone = Drone(sweep, cfg)
    t = sweep.duration / 3
    before = sweep.current_seq(drone.sweep_time(t))
    drone.plan_visit(t, {"lead_id": "L-1", "x": 150, "y": 150}, "inspect")
    assert sweep.current_seq(drone.sweep_time(t + 30)) == before, "GUIDED leaves the mission's current item alone"
    target = sweep.mission[before - 1]
    assert (target["x"], target["y"]) == (sweep.path[before - 2]["x"], sweep.path[before - 2]["y"])

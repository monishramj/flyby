import json

import pytest

from batch import metrics, run_eval
from conftest import FakeRuntime, fast_settings


def test_ece_on_a_toy_input():
    # Perfectly calibrated: half the 0.0 cases and half the 1.0 cases land in their own bins.
    assert metrics.ece([0.0, 0.0, 1.0, 1.0], [0, 0, 1, 1]) == pytest.approx(0.0)
    # Fully overconfident: predicts 1.0 for everything while nothing is true.
    assert metrics.ece([1.0, 1.0], [0, 0]) == pytest.approx(1.0)
    # Two equal bins, each off by 0.5, weighted by their share.
    assert metrics.ece([0.05, 0.95], [1, 0]) == pytest.approx(0.5 * 0.95 + 0.5 * 0.95, abs=1e-9)
    rows = metrics.reliability([0.05, 0.95], [1, 0])
    assert [row["n"] for row in rows] == [1, 0, 0, 0, 0, 0, 0, 0, 0, 1]
    assert rows[0]["accuracy"] == 1.0 and rows[-1]["accuracy"] == 0.0
    assert metrics.reliability([], [])[0]["n"] == 0


async def test_a_one_seed_evaluation_produces_every_reported_metric(tmp_path):
    cfg = fast_settings(RESULTS_DIR=tmp_path)
    summary = await run_eval.evaluate([4], ["rule"], cfg)
    arm = summary["arms"]["rule"]
    assert arm["runs"] == 1 and arm["leads"] > 0
    assert arm["subjects"]["placed"] >= cfg.N_SUBJECTS[0]
    for key in ("time_to_dispatch_s", "under_structure_time_to_dispatch_s", "subjects",
                "action_accuracy", "dispatch", "routing_rate", "fallback_rate", "redecisions",
                "latency_ms", "calibration"):
        assert key in arm
    load = arm["human_load"]
    assert load["needed_judgment"] + load["one_click"] + load["no_human"] == load["flags"] == arm["leads"]
    assert summary["assumptions"]["detector_noise"]["visible"] == {"p_detect": .9, "mu_conf": .75}
    flow = arm["flag_flow"]
    assert sum(sum(row.values()) for row in flow["routes"].values()) == arm["leads"]
    assert "comparison" not in summary, "Results measure the system itself, not a simulated reviewer"
    assert (tmp_path / "raw.parquet").is_file() and (tmp_path / "subjects.parquet").is_file()
    assert json.loads((tmp_path / "summary.json").read_text())["seeds"] == [4]


async def test_a_laya_arm_records_calibration_against_detector_confidence(tmp_path):
    cfg = fast_settings(RESULTS_DIR=tmp_path)
    summary = await run_eval.evaluate([4], ["laya"], cfg)
    calibration = summary["arms"]["laya"]["calibration"]
    assert calibration["laya_p_person"]["n"] > 0
    assert calibration["laya_p_person"]["ece"] is not None
    assert calibration["detector_conf"]["n"] == calibration["laya_p_person"]["n"]
    assert sum(row["n"] for row in calibration["reliability"]) == calibration["laya_p_person"]["n"]


async def test_dispatch_times_are_measured_from_the_subjects_zero_point(monkeypatch, tmp_path):
    cfg = fast_settings(RESULTS_DIR=tmp_path)
    summary = await run_eval.evaluate([4], ["rule"], cfg)
    dispatch = summary["arms"]["rule"]["time_to_dispatch_s"]
    if dispatch["n"]:
        assert dispatch["median"] >= cfg.HANDOFF_S, "every dispatch carries the handoff cost"
        assert all(value > 0 for value in dispatch["values"])


@pytest.fixture(autouse=True)
def laya_is_not_loaded(monkeypatch):
    """The batch tests must never touch the real 800 MB checkpoint."""
    import server.triage.laya_runtime as runtime_module
    monkeypatch.setattr(runtime_module, "load", lambda cfg=None: FakeRuntime())


def test_human_load_counts_each_flag_once_and_names_people_nobody_saw():
    from batch.metrics import human_load
    row = lambda *names, person=False, status="ignored": {
        "status_history": [{"status": n} for n in names], "is_person": person, "status": status}
    load = human_load([row("captured", "awaiting_human", "awaiting_approval", "dispatched", status="dispatched"),
                       row("captured", "awaiting_approval", "dispatched", status="dispatched"),
                       row("captured", "auto_closed", person=True, status="auto_closed"),
                       row("captured", "reimaging", "auto_closed", status="auto_closed")])
    assert load == {"flags": 4, "needed_judgment": 1, "one_click": 1, "no_human": 2, "people_closed_without_human": 1}


def test_flag_flow_and_the_confidence_curve_on_hand_made_flags():
    from batch.metrics import confidence_curve, flag_flow
    def lead(object_id, names, *, person, action, top, right, source="laya"):
        rest = (1 - top) / 3
        probs = {name: (top if name == action else rest) for name in ("dispatch_ground_team", "reimage_zoom", "close_in_inspect", "ignore")}
        return {"seed": 0, "object_id": object_id, "is_person": person, "status": names[-1],
                "status_history": [{"status": n, "t": i} for i, n in enumerate(names)],
                "history": [{"action": action, "probs": probs, "source": source}], "decision_optimal": [right]}
    leads = [lead("a", ["captured", "awaiting_approval", "dispatched"], person=True, action="dispatch_ground_team", top=.9, right="dispatch_ground_team"),
             lead("b", ["captured", "auto_closed"], person=True, action="ignore", top=.7, right="dispatch_ground_team"),
             lead("c", ["captured", "awaiting_human", "ignored"], person=False, action="ignore", top=.4, right="ignore"),
             lead("d", ["captured", "awaiting_human", "dispatched"], person=False, action="dispatch_ground_team", top=.3, right="ignore", source="rule")]
    flow = flag_flow(leads, [{"seed": 0, "object_id": "a"}, {"seed": 0, "object_id": "b"}, {"seed": 0, "object_id": "z"}])
    assert flow["routes"]["one_click"]["person_reached"] == 1
    assert flow["routes"]["no_human"]["person_missed"] == 1
    assert flow["routes"]["needed_judgment"] == {"person_reached": 0, "person_missed": 0, "empty_dispatch": 1, "cleared": 1}
    assert flow["people_never_flagged"] == 1
    curve = confidence_curve(leads, fast_settings())
    assert curve["n"] == 3, "only Laya's own calls are scored"
    at = {point["bar"]: point for point in curve["points"]}
    assert at[0.25] == {"bar": 0.25, "cleared_share": 1.0, "accuracy": round(2 / 3, 3)}
    assert at[0.5] == {"bar": 0.5, "cleared_share": round(2 / 3, 3), "accuracy": 0.5}
    assert at[0.95]["cleared_share"] == 0 and at[0.95]["accuracy"] is None
    assert curve["confusion"]["ignore"]["dispatch_ground_team"] == 1

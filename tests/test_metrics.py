import json

import pytest

from batch import metrics, run_eval
from conftest import FakeRuntime, fast_settings


def test_reviewer_baseline_matches_a_hand_computed_three_capture_queue():
    # Captures at t = 0, 5, 10 with 120 s per image: the queue, not the flight, sets the pace.
    # f_0 = 0 + 120; f_1 = max(5, 120) + 120 = 240; f_2 = max(10, 240) + 120 = 360.
    assert metrics.reviewer_finish_times([0, 5, 10], 120) == [120, 240, 360]
    cfg = fast_settings()
    subjects = [{"visibility": "visible", "capture_index": 0},
                {"visibility": "partial", "capture_index": 2},
                {"visibility": "under_structure", "capture_index": 1}]
    lag = [finish - t + cfg.HANDOFF_S for finish, t in zip([120, 240, 360], [0, 5, 10])]
    assert lag == [180, 295, 410]
    assert metrics.manual_times(subjects, lag) == [180, 410], "hidden subjects are excluded"
    # At 10 s per image the reviewer keeps up, so only the handoff remains.
    assert metrics.reviewer_finish_times([0, 5, 10], 10) == [10, 20, 30]


def test_the_real_sweep_baseline_grows_with_review_time():
    cfg = fast_settings()
    lags = metrics.capture_lag(cfg)
    assert set(lags) == {"120", "10"}
    assert len(lags["120"]) == len(lags["10"])
    assert lags["120"][0] == 120 + cfg.HANDOFF_S
    assert lags["120"][-1] > lags["10"][-1], "a slower reviewer accumulates a longer backlog"
    assert all(later >= earlier for earlier, later in zip(lags["120"], lags["120"][1:]))


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
    assert summary["assumptions"]["review_s"] == list(cfg.REVIEW_S)
    assert summary["assumptions"]["human_detection_probability"] == 1.0
    assert summary["assumptions"]["detector_noise"]["visible"] == {"p_detect": .9, "mu_conf": .75}
    assert [row["review_s"] for row in summary["comparison"]] == [120, 10]
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

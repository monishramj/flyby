"""T6.1 metrics.

Results JSON schema written by batch/run_eval.py (results/summary.json):

{
  "seeds": [int],                      seeds evaluated in both arms
  "generated_at": iso8601,
  "assumptions": {                     declared, not measured (README T1.2, T6.1)
      "detector_noise": {truth: {p_detect, mu_conf}}, "conf_std": float,
      "sim_human_acc": float, "human_detection_probability": 1.0,
      "handoff_s": float, "intel": "oracle", "review_s": [int],
      "policy_gate": str},
  "baseline": {                        manual overhead review, seed-independent
      "review_s": {"120": {...}, "10": {...}}},
  "arms": {policy: {
      "leads": int, "runs": int,
      "time_to_dispatch_s": {"n", "median", "iqr", "p25", "p75", "values"},
      "under_structure_time_to_dispatch_s": {...},
      "subjects": {"placed", "visible_partial", "dispatched", "found_share"},
      "action_accuracy": {"decision", "final"},
      "human_load": {"flags", "needed_judgment", "one_click", "no_human", "people_closed_without_human"},
      "dispatch": {"precision", "recall"},
      "routing_rate": float, "fallback_rate": float, "redecisions": int,
      "latency_ms": {"p50", "p95"},
      "calibration": {"laya_p_person": {"ece", "n"}, "detector_conf": {"ece", "n"},
                      "reliability": [{"bin", "n", "confidence", "accuracy"}]}}},
  "comparison": [{"arm", "review_s", "flyby_median_s", "manual_median_s", "speedup"}]
}

All times are seconds measured from a subject's zero point t0: the time of the
first capture whose footprint contained it.
"""
from datetime import UTC, datetime

import numpy as np

from server.config import settings
from server.mission.sweep import Sweep

BINS = 10


def ece(probabilities, labels, bins: int = BINS) -> float:
    """Expected calibration error: Σ_b (n_b/N)·|acc_b − conf_b|."""
    probabilities, labels = np.asarray(probabilities, float), np.asarray(labels, float)
    if not probabilities.size:
        return float("nan")
    index = _bin_index(probabilities, bins)
    total = 0.0
    for bin_index in range(bins):
        mask = index == bin_index
        if mask.any():
            total += mask.mean() * abs(labels[mask].mean() - probabilities[mask].mean())
    return float(total)


def reliability(probabilities, labels, bins: int = BINS) -> list[dict]:
    probabilities, labels = np.asarray(probabilities, float), np.asarray(labels, float)
    edges = np.linspace(0, 1, bins + 1)
    index = _bin_index(probabilities, bins) if probabilities.size else np.array([], int)
    rows = []
    for bin_index in range(bins):
        mask = index == bin_index if index.size else np.array([], bool)
        rows.append({"bin": f"{edges[bin_index]:.1f}-{edges[bin_index + 1]:.1f}",
                     "n": int(mask.sum()),
                     "confidence": float(probabilities[mask].mean()) if mask.any() else None,
                     "accuracy": float(labels[mask].mean()) if mask.any() else None})
    return rows


def _bin_index(probabilities, bins):
    return np.clip(np.digitize(probabilities, np.linspace(0, 1, bins + 1)[1:-1], right=False), 0, bins - 1)


def reviewer_finish_times(capture_times, review_s: float) -> list[float]:
    """f_i = max(t_i, f_{i−1}) + REVIEW_S: a reviewer who cannot skip an image."""
    finish, previous = [], 0.0
    for t in capture_times:
        previous = max(t, previous) + review_s
        finish.append(previous)
    return finish


def capture_lag(cfg=settings, review_seconds=None) -> dict:
    """Per capture index, how long after t0 a manual reviewer reaches that image.

    Seed-independent, because the sweep and its capture times are fixed by config.
    """
    times = [capture["t"] for capture in Sweep(cfg).captures()]
    lags = {}
    for review_s in review_seconds or cfg.REVIEW_S:
        finish = reviewer_finish_times(times, review_s)
        lags[str(review_s)] = [finish[index] - times[index] + cfg.HANDOFF_S for index in range(len(times))]
    return lags


def manual_times(subjects, lags) -> list[float]:
    """T_human per subject: the reviewer spots it with P=1 at its first containing capture."""
    return [lags[row["capture_index"]] for row in subjects
            if row["visibility"] in ("visible", "partial") and row["capture_index"] is not None]


def manual_baseline(subjects, cfg=settings) -> dict:
    lags = capture_lag(cfg)
    return {review_s: {"review_s": int(review_s), "captures": len(lag),
                       **_spread(manual_times(subjects, lag))}
            for review_s, lag in lags.items()}


def _spread(values) -> dict:
    values = sorted(float(value) for value in values)
    if not values:
        return {"n": 0, "median": None, "iqr": None, "p25": None, "p75": None, "values": []}
    p25, p50, p75 = (float(np.percentile(values, q)) for q in (25, 50, 75))
    return {"n": len(values), "median": p50, "iqr": p75 - p25, "p25": p25, "p75": p75, "values": values}


def _status_time(lead, status):
    for entry in reversed(lead.get("status_history", [])):
        if entry["status"] == status:
            return entry["t"]
    return None


def human_load(leads: list[dict]) -> dict:
    """Sub-problem 2 directly: of every flag, how many reached a human, and how."""
    seen = [{entry["status"] for entry in lead.get("status_history", [])} for lead in leads]
    judgment = [lead for lead, names in zip(leads, seen) if "awaiting_human" in names]
    one_click = [lead for lead, names in zip(leads, seen) if "awaiting_approval" in names and "awaiting_human" not in names]
    untouched = [lead for lead, names in zip(leads, seen) if not names & {"awaiting_human", "awaiting_approval"}]
    return {"flags": len(leads), "needed_judgment": len(judgment), "one_click": len(one_click),
            "no_human": len(untouched),
            # the price of not looking: real people that no human ever saw
            "people_closed_without_human": sum(bool(lead["is_person"]) and lead["status"] in ("auto_closed", "ignored")
                                               for lead in untouched)}


def arm_metrics(leads: list[dict], subjects: list[dict], runs: int, cfg=settings) -> dict:
    """leads: one row per lead across seeds. subjects: every placed subject with its t0."""
    zero = {(row["seed"], row["object_id"]): row for row in subjects}
    primary, hidden = [], []
    dispatched_objects = set()
    for lead in leads:
        if _status_time(lead, "dispatched") is None:
            continue
        dispatched_objects.add((lead["seed"], lead["object_id"]))
        subject = zero.get((lead["seed"], lead["object_id"]))
        if subject is None or subject["t0"] is None:
            continue
        elapsed = _status_time(lead, "dispatched") - subject["t0"] + cfg.HANDOFF_S
        (hidden if subject["visibility"] == "under_structure" else primary).append(elapsed)

    overhead = [row for row in subjects if row["visibility"] in ("visible", "partial")]
    found = sum((row["seed"], row["object_id"]) in dispatched_objects for row in subjects)
    decisions = [lead["history"][0] for lead in leads if lead.get("history")]
    laya = [(lead, lead["history"][0]) for lead in leads
            if lead.get("history") and lead["history"][0].get("p_person") is not None
            and not lead["history"][0]["used_fallback"]]
    probabilities = [decision["p_person"] for _, decision in laya]
    detector = [lead["detector_conf"] for lead, _ in laya]
    labels = [bool(lead["is_person"]) for lead, _ in laya]
    latencies = [decision["latency_ms"] for decision in decisions] or [0.0]
    dispatched = [lead for lead in leads if _status_time(lead, "dispatched") is not None]
    true_dispatches = [lead for lead in dispatched if lead["is_person"]]
    return {
        "leads": len(leads), "runs": runs,
        "time_to_dispatch_s": _spread(primary),
        "under_structure_time_to_dispatch_s": _spread(hidden),
        "subjects": {"placed": len(subjects), "visible_partial": len(overhead), "dispatched": found,
                     "found_share": round(found / len(subjects), 3) if subjects else None},
        "action_accuracy": {
            "decision": _share([lead["history"][0]["action"] == lead["optimal_action"] for lead in leads if lead.get("history")]),
            "final": _share([(lead.get("final_action") or lead["history"][0]["action"]) == lead["optimal_action"] for lead in leads if lead.get("history")]),
        },
        "dispatch": {"precision": _share([lead["is_person"] for lead in dispatched]),
                     "recall": round(len(true_dispatches) / len(subjects), 3) if subjects else None},
        "human_load": human_load(leads),
        "routing_rate": _share([decision["routed_to_human"] for decision in decisions]),
        "fallback_rate": _share([decision["used_fallback"] for decision in decisions]),
        "redecisions": sum(max(0, len(lead.get("history", [])) - 1) for lead in leads),
        "latency_ms": {"p50": round(float(np.percentile(latencies, 50)), 1),
                       "p95": round(float(np.percentile(latencies, 95)), 1)},
        "calibration": {
            "laya_p_person": {"ece": round(ece(probabilities, labels), 4) if probabilities else None, "n": len(probabilities)},
            "detector_conf": {"ece": round(ece(detector, labels), 4) if detector else None, "n": len(detector)},
            "reliability": reliability(probabilities, labels),
        },
    }


def _share(values) -> float | None:
    values = list(values)
    return round(float(np.mean(values)), 3) if values else None


def summarize(arms: dict, subjects_by_arm: dict, seeds: list[int], cfg=settings, policy_gate: str = "") -> dict:
    """arms: policy -> {"leads": [...], "runs": int}; subjects_by_arm: policy -> subject rows."""
    baseline = manual_baseline(next(iter(subjects_by_arm.values())), cfg)
    summary = {
        "seeds": list(seeds),
        "generated_at": datetime.now(UTC).isoformat(),
        "assumptions": {
            "detector_noise": {key: {"p_detect": value[0], "mu_conf": value[1]} for key, value in cfg.NOISE.items()},
            "conf_std": cfg.CONF_STD,
            "sim_human_acc": cfg.SIM_HUMAN_ACC,
            "human_detection_probability": 1.0,
            "handoff_s": cfg.HANDOFF_S,
            "intel": "oracle",
            "review_s": list(cfg.REVIEW_S),
            "note": "Detector rates and human behaviour are declared simulation assumptions, "
                    "not measured detector or operator performance.",
            "policy_gate": policy_gate,
        },
        "baseline": {"review_s": baseline},
        "arms": {policy: arm_metrics(data["leads"], subjects_by_arm[policy], data["runs"], cfg)
                 for policy, data in arms.items()},
    }
    comparison = []
    for policy, metrics in summary["arms"].items():
        flyby = metrics["time_to_dispatch_s"]["median"]
        for review_s, row in manual_baseline(subjects_by_arm[policy], cfg).items():
            comparison.append({"arm": policy, "review_s": int(review_s),
                               "flyby_median_s": flyby, "manual_median_s": row["median"],
                               "flyby_n": metrics["time_to_dispatch_s"]["n"], "manual_n": row["n"],
                               "speedup": round(row["median"] / flyby, 2) if flyby and row["median"] else None})
    summary["comparison"] = comparison
    return summary

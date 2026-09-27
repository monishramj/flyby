"""T6.1 metrics.

Results JSON schema written by batch/run_eval.py (results/summary.json):

{
  "seeds": [int],                      seeds evaluated in both arms
  "generated_at": iso8601,
  "assumptions": {                     declared, not measured (README T1.2, T6.1)
      "detector_noise": {truth: {p_detect, mu_conf}}, "conf_std": float,
      "sim_human_acc": float, "handoff_s": float, "intel": "oracle",
      "policy_gate": str},
  "arms": {policy: {
      "leads": int, "runs": int,
      "time_to_dispatch_s": {"n", "median", "iqr", "p25", "p75", "values"},
      "under_structure_time_to_dispatch_s": {...},
      "subjects": {"placed", "visible_partial", "dispatched", "found_share"},
      "action_accuracy": {"decision", "final"},
      "human_load": {"flags", "needed_judgment", "one_click", "no_human", "people_closed_without_human"},
      "flag_flow": {"routes": {no_human|one_click|needed_judgment: {person_reached, person_missed,
                    empty_dispatch, cleared}}, "people_placed", "people_never_flagged"},
      "confidence": {"n", "tau_route", "accuracy", "points": [{"bar", "cleared_share", "accuracy"}],
                     "confusion": {chosen: {right: count}}},   Laya's first call per flag
      "dispatch": {"precision", "recall"},
      "routing_rate": float, "fallback_rate": float, "redecisions": int,
      "latency_ms": {"p50", "p95"},
      "calibration": {"laya_p_person": {"ece", "n"}, "detector_conf": {"ece", "n"},
                      "reliability": [{"bin", "n", "confidence", "accuracy"}]}}}
}

All times are seconds measured from a subject's zero point t0: the time of the
first capture whose footprint contained it.
"""
from datetime import UTC, datetime

import numpy as np

from server.config import settings
from server.triage.fallback import ACTIONS

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


def _handled_by(lead):
    """Who a flag needed: a judgment call, a one-click approval, or no human at all."""
    names = {entry["status"] for entry in lead.get("status_history", [])}
    return "needed_judgment" if "awaiting_human" in names else "one_click" if "awaiting_approval" in names else "no_human"


def human_load(leads: list[dict]) -> dict:
    """Sub-problem 2 directly: of every flag, how many reached a human, and how."""
    routes = [_handled_by(lead) for lead in leads]
    return {"flags": len(leads), **{name: routes.count(name) for name in ("needed_judgment", "one_click", "no_human")},
            # the price of not looking: real people that no human ever saw
            "people_closed_without_human": sum(bool(lead["is_person"]) and lead["status"] in ("auto_closed", "ignored")
                                               for lead, route in zip(leads, routes) if route == "no_human")}


OUTCOMES = ("person_reached", "person_missed", "empty_dispatch", "cleared")


def flag_flow(leads: list[dict], subjects: list[dict]) -> dict:
    """Where every flag went: who handled it, then whether a real person reached a crew."""
    routes = {name: dict.fromkeys(OUTCOMES, 0) for name in ("no_human", "one_click", "needed_judgment")}
    for lead in leads:
        dispatched = _status_time(lead, "dispatched") is not None
        outcome = ("person_reached" if dispatched else "person_missed") if lead["is_person"] else \
            ("empty_dispatch" if dispatched else "cleared")
        routes[_handled_by(lead)][outcome] += 1
    flagged = {(lead["seed"], lead["object_id"]) for lead in leads}
    return {"routes": routes, "people_placed": len(subjects),
            # the camera never flagged them, so no triage could have helped
            "people_never_flagged": sum((row["seed"], row["object_id"]) not in flagged for row in subjects)}


def _first_optimal(lead):
    """The right action for Laya's first call, judged at that call's own pass."""
    return (lead.get("decision_optimal") or [lead["optimal_action"]])[0]


def confidence_curve(leads: list[dict], cfg=settings) -> dict:
    """Laya's first call on each flag: at each confidence bar, how many calls clear it and how often those are right."""
    calls = [(max(lead["history"][0]["probs"].values()), lead["history"][0]["action"], _first_optimal(lead))
             for lead in leads if lead.get("history") and lead["history"][0].get("source") == "laya"]
    points = []
    for bar in np.round(np.arange(0.25, 0.951, 0.05), 2):
        cleared = [chosen == right for top, chosen, right in calls if top >= bar]
        points.append({"bar": float(bar), "cleared_share": round(len(cleared) / len(calls), 3) if calls else None,
                       "accuracy": _share(cleared)})
    confusion = {chosen: {right: sum(c == chosen and r == right for _, c, r in calls) for right in ACTIONS} for chosen in ACTIONS}
    return {"n": len(calls), "tau_route": cfg.TAU_ROUTE, "points": points,
            "accuracy": _share([chosen == right for _, chosen, right in calls]), "confusion": confusion}


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
            "decision": _share([lead["history"][0]["action"] == _first_optimal(lead) for lead in leads if lead.get("history")]),
            "final": _share([(lead.get("final_action") or lead["history"][0]["action"]) == lead["optimal_action"] for lead in leads if lead.get("history")]),
        },
        "dispatch": {"precision": _share([lead["is_person"] for lead in dispatched]),
                     "recall": round(len(true_dispatches) / len(subjects), 3) if subjects else None},
        "human_load": human_load(leads),
        "flag_flow": flag_flow(leads, subjects),
        "confidence": confidence_curve(leads, cfg),
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
    summary = {
        "seeds": list(seeds),
        "generated_at": datetime.now(UTC).isoformat(),
        "assumptions": {
            "detector_noise": {key: {"p_detect": value[0], "mu_conf": value[1]} for key, value in cfg.NOISE.items()},
            "conf_std": cfg.CONF_STD,
            "sim_human_acc": cfg.SIM_HUMAN_ACC,
            "handoff_s": cfg.HANDOFF_S,
            "intel": "oracle",
            "note": "Detector rates and human behaviour are declared simulation assumptions, "
                    "not measured detector or operator performance.",
            "policy_gate": policy_gate,
        },
        "arms": {policy: arm_metrics(data["leads"], subjects_by_arm[policy], data["runs"], cfg)
                 for policy, data in arms.items()},
    }
    return summary

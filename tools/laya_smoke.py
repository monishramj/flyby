"""T0.2: twenty declared hand cases, criteria gate, then fifty warm calls."""
import argparse
import json
import math

import numpy as np

from server.config import settings
from server.triage.laya_runtime import load, questions_for_variant


def hand_cases():
    # Labels live outside model state. Cases describe the simulation's four outcomes.
    rows = [
        ("visible-clear", "dispatch_ground_team", .94, 40, False, 1),
        ("visible-large", "dispatch_ground_team", .89, 70, False, 1),
        ("visible-medium", "dispatch_ground_team", .81, 28, False, 1),
        ("partial-after-zoom", "dispatch_ground_team", .87, 75, False, 2),
        ("small-after-zoom", "dispatch_ground_team", .91, 36, False, 2),
        ("partial-small", "reimage_zoom", .62, 16, False, 1),
        ("small-box", "reimage_zoom", .68, 11, False, 1),
        ("partial-uncertain", "reimage_zoom", .51, 18, False, 1),
        ("small-medium-confidence", "reimage_zoom", .56, 9, False, 1),
        ("partial-medium-box", "reimage_zoom", .70, 24, False, 1),
        ("under-carport", "close_in_inspect", .61, 25, True, 1),
        ("under-roof", "close_in_inspect", .52, 30, True, 1),
        ("under-structure-large", "close_in_inspect", .68, 65, True, 1),
        ("under-structure-after-zoom", "close_in_inspect", .64, 72, True, 2),
        ("under-structure-uncertain", "close_in_inspect", .47, 22, True, 1),
        ("debris-low", "ignore", .13, 32, False, 1),
        ("animal-low", "ignore", .22, 11, False, 1),
        ("warm-spot-low", "ignore", .31, 14, False, 1),
        ("junk-low", "ignore", .38, 20, False, 1),
        ("decoy-after-zoom", "ignore", .18, 60, True, 2),
    ]
    cases = []
    for name, action, confidence, box, structure, passes in rows:
        state = {
            "lead": {"detector_conf": confidence, "detector_band": "high" if confidence >= settings.DETECTOR_HIGH else "medium" if confidence >= settings.DETECTOR_LOW else "low",
                     "box_px": box, "size_band": "small" if box < settings.SMALL_BOX_PX else "medium" if box < settings.LARGE_BOX_PX else "large",
                     "altitude_m": settings.ALT_M, "sector": "S3", "near_structure": structure, "passes": passes},
            "context": {"sector_priority": "moderate", "hazards_nearby": [], "reported_subjects_in_sector": 1, "confirmed_subjects_in_sector": 0},
            "mission": {"coverage_pct": 42, "open_leads": 5},
        }
        cases.append({"name": name, "expected": action, "state": state})
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cpu", "mps"), default=settings.LAYA_DEVICE)
    args = parser.parse_args()
    runtime = load(settings.model_copy(update={"LAYA_DEVICE": args.device}))
    cases, attempts = hand_cases(), []
    selected = 0
    for variant in range(4):
        questions = questions_for_variant(variant)
        answers = []
        for case in cases:
            result = runtime.system_one(case["state"], questions)
            actual = result["answers"]["action"]["choice"]
            answers.append({**case, **result, "correct": actual == case["expected"]})
            print(json.dumps({"variant": variant, "case": case["name"], "expected": case["expected"], **result}), flush=True)
        accuracy = sum(item["correct"] for item in answers) / len(answers)
        attempts.append({"variant": variant, "accuracy": accuracy, "cases": answers})
        if accuracy >= .5:
            selected = variant
            break
    else:
        selected = max(attempts, key=lambda item: item["accuracy"])["variant"]
    questions = questions_for_variant(selected)
    runtime.system_one(cases[0]["state"], questions)
    latencies = [runtime.system_one(cases[index % len(cases)]["state"], questions)["latency_ms"] for index in range(50)]
    p50, p95 = (float(value) for value in np.percentile(latencies, [50, 95]))
    accuracy = attempts[selected]["accuracy"]
    report = {"device": runtime.device, "runtime": "laya==0.3.20", "revision": settings.LAYA_REVISION,
              "p50_ms": p50, "p95_ms": p95, "recommended_timeout_ms": math.ceil(3 * p95),
              "accuracy": accuracy, "selected_variant": selected, "gate_passed": accuracy >= .5,
              "warm_calls": len(latencies), "latencies_ms": latencies, "attempts": attempts}
    settings.RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output = settings.RESULTS_DIR / f"laya_smoke_{runtime.device}.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key not in ("attempts", "latencies_ms")}, indent=2))
    print(f"Report: {output}")


if __name__ == "__main__":
    main()

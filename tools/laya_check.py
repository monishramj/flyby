"""T2.4: action accuracy, P(person) calibration, and the routing threshold sweep.

Prints tables only. Defaults in server/config.py are never changed from here.
"""
import argparse
import asyncio
import json

import numpy as np

from batch.metrics import ece, reliability
from server.config import settings
from server.mission.loop import MissionRun
from server.mission.truth import optimal_action

SEEDS = range(100, 105)


async def collect(seeds, cfg, runtime):
    rows = []
    for seed in seeds:
        run = MissionRun(seed, cfg, policy="laya", parse_mode="oracle", sim_human=True,
                         fast=True, runtime=runtime)
        try:
            await run.start()
        finally:
            await run.stop()
        for lead in run.leads.values():
            first = lead["history"][0]
            rows.append({"seed": seed, "lead_id": lead["lead_id"], "pass": lead["pass"],
                         "optimal": optimal_action(lead, cfg), "laya": first["action"],
                         "rule": lead["baseline_rule"], "is_person": bool(lead["truth"]["is_person"]),
                         "detector_conf": lead["detector_conf"], "p_person": first["p_person"],
                         "max_prob": max(first["probs"].values()), "latency_ms": first["latency_ms"],
                         "used_fallback": first["used_fallback"], "source": first["source"]})
        print(f"  seed {seed}: {len(run.leads)} leads", flush=True)
    return rows


def table(title, rows):
    print(f"\n{title}")
    if not rows:
        print("  (no rows)")
        return
    columns = list(rows[0])
    widths = [max(len(column), *(len(f"{row[column]}") for row in rows)) for column in columns]
    print("  " + "  ".join(column.ljust(width) for column, width in zip(columns, widths)))
    for row in rows:
        print("  " + "  ".join(f"{row[column]}".ljust(width) for column, width in zip(columns, widths)))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cpu", "mps"), default=settings.LAYA_DEVICE)
    parser.add_argument("--seeds", type=int, nargs="*", default=list(SEEDS))
    parser.add_argument("--out", default="laya_check.json")
    args = parser.parse_args()
    cfg = settings.model_copy(update={"LAYA_DEVICE": args.device, "PARSE_MODE": "oracle"})
    from server.triage.laya_runtime import load
    runtime = load(cfg)
    print(f"Laya on {runtime.device}; seeds {args.seeds}", flush=True)
    rows = asyncio.run(collect(args.seeds, cfg, runtime))
    laya_rows = [row for row in rows if not row["used_fallback"]]

    accuracy = [{"policy": policy,
                 "leads": len(rows),
                 "action_accuracy": round(np.mean([row[policy] == row["optimal"] for row in rows]), 3)}
                for policy in ("laya", "rule")]
    table("Action accuracy against README §4.4 truth", accuracy)

    labels = [row["is_person"] for row in laya_rows]
    laya_probabilities = [row["p_person"] for row in laya_rows]
    detector = [row["detector_conf"] for row in laya_rows]
    calibration = [
        {"signal": "laya_p_person", "n": len(laya_rows), "ece": round(ece(laya_probabilities, labels), 4),
         "mean": round(float(np.mean(laya_probabilities)), 3) if laya_rows else None},
        {"signal": "detector_conf", "n": len(laya_rows), "ece": round(ece(detector, labels), 4),
         "mean": round(float(np.mean(detector)), 3) if laya_rows else None},
    ]
    table("Calibration of P(person), 10 equal bins", calibration)
    table("Laya reliability diagram", reliability(laya_probabilities, labels))

    latencies = [row["latency_ms"] for row in laya_rows]
    table("Laya latency", [{"p50_ms": round(float(np.percentile(latencies, 50)), 1),
                            "p95_ms": round(float(np.percentile(latencies, 95)), 1),
                            "fallbacks": sum(row["used_fallback"] for row in rows)}] if latencies else [])

    sweep = []
    for tau in np.round(np.arange(.3, .81, .05), 2):
        auto = [row for row in rows if row["max_prob"] >= tau and not row["used_fallback"]
                and not (row["pass"] >= cfg.MAX_PASSES and row["laya"] == "reimage_zoom")]
        sweep.append({"tau_route": tau, "auto_share": round(len(auto) / len(rows), 3) if rows else 0,
                      "routed_share": round(1 - len(auto) / len(rows), 3) if rows else 1,
                      "auto_accuracy": round(np.mean([row["laya"] == row["optimal"] for row in auto]), 3) if auto else None})
    table("Auto-handled accuracy vs routing rate", sweep)

    qualifying = [row for row in sweep if row["auto_accuracy"] is not None and row["auto_accuracy"] >= .9]
    if qualifying:
        print(f"\nHUMAN: lowest TAU_ROUTE with auto accuracy >= 0.90 is {min(row['tau_route'] for row in qualifying)}")
    else:
        closest = min(sweep, key=lambda row: abs(row["routed_share"] - .3))
        print(f"\nHUMAN: no threshold reaches 0.90 auto accuracy; nearest 30% routing is "
              f"TAU_ROUTE={closest['tau_route']} (routed {closest['routed_share']})")
    better = calibration[0]["ece"] < calibration[1]["ece"]
    print(f"HUMAN: Laya P(person) is {'better' if better else 'worse'} calibrated than detector confidence "
          f"(ECE {calibration[0]['ece']} vs {calibration[1]['ece']}). Phrase the pitch accordingly.")

    settings.RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    output = settings.RESULTS_DIR / args.out
    output.write_text(json.dumps({"device": runtime.device, "seeds": args.seeds, "accuracy": accuracy,
                                  "calibration": calibration, "sweep": sweep,
                                  "reliability": reliability(laya_probabilities, labels),
                                  "leads": rows}, indent=2, default=float) + "\n")
    print(f"Report: {output}")


if __name__ == "__main__":
    main()

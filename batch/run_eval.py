"""T6.1: seeds 0-19 in fast mode, two policy arms, oracle intel, simulated human."""
import argparse
import asyncio
import json

import pandas as pd

from batch import metrics
from server.config import settings
from server.mission.loop import MissionRun
from server.mission.sweep import contains
from server.mission.truth import optimal_action

SEEDS = range(20)


def subject_rows(run):
    """Every placed subject with its zero point: the first capture that contained it."""
    rows = []
    for subject in run.scenario.subjects:
        index, t0 = None, None
        for position, capture in enumerate(run.sweep.captures()):
            if contains(capture, subject):
                # the real capture time: visits by the drone push later captures back
                index, t0 = position, run.capture_times.get(capture["id"], capture["t"])
                break
        rows.append({"seed": run.seed, "run_id": run.run_id, "object_id": subject["id"],
                     "visibility": subject["visibility"], "capture_index": index, "t0": t0})
    return rows


def lead_rows(run):
    return [{"seed": run.seed, "run_id": run.run_id, "lead_id": lead["lead_id"],
             "object_id": lead["object_id"], "pass": lead["pass"], "sector": lead["sector"],
             "status": lead["status"], "detector_conf": lead["detector_conf"], "box_px": lead["box_px"],
             "is_person": bool(lead["truth"]["is_person"]),
             "visibility": lead["truth"].get("visibility"),
             "optimal_action": optimal_action(lead, run.cfg),
             "baseline_rule": lead.get("baseline_rule"),
             "final_action": lead.get("final_action"),
             "human": lead.get("human"), "history": lead["history"],
             "status_history": lead["status_history"],
             "t_capture": lead["t_capture"]} for lead in run.leads.values()]


async def run_arm(policy, seeds, cfg, runtime, writer=None):
    leads, subjects, runs = [], [], 0
    for seed in seeds:
        run = MissionRun(seed, cfg, policy=policy, parse_mode="oracle", sim_human=True,
                         fast=True, runtime=runtime, writer=writer)
        try:
            await run.start()
        finally:
            await run.stop()
        leads.extend(lead_rows(run))
        subjects.extend(subject_rows(run))
        runs += 1
        dispatched = sum(lead["status"] == "dispatched" for lead in run.leads.values())
        print(f"  {policy} seed {seed}: {len(run.leads)} leads, {dispatched} dispatched, "
              f"{run.redecision_count} re-decisions", flush=True)
    return {"leads": leads, "runs": runs}, subjects


async def evaluate(seeds, arms, cfg, *, writer=None):
    runtime = None
    if "laya" in arms:
        from server.triage.laya_runtime import load
        try:
            runtime = load(cfg)
            print(f"Laya on {runtime.device}", flush=True)
        except Exception as exc:
            print(f"Laya unavailable ({exc}); the laya arm will record rule fallbacks.", flush=True)
    results, subjects_by_arm = {}, {}
    for policy in arms:
        results[policy], subjects_by_arm[policy] = await run_arm(policy, seeds, cfg, runtime, writer)
    gate = (f"LIVE_POLICY={cfg.LIVE_POLICY}; Laya reads a plain-language rendering of the state "
            f"(JSON scored 0.25 on the twenty hand cases; prose scores 0.75).")
    summary = metrics.summarize(results, subjects_by_arm, list(seeds), cfg, policy_gate=gate)
    frames = pd.DataFrame([{**row, "arm": policy, "history": json.dumps(row["history"]),
                            "status_history": json.dumps(row["status_history"]),
                            "human": json.dumps(row["human"])}
                           for policy, data in results.items() for row in data["leads"]])
    subjects = pd.DataFrame([{**row, "arm": policy} for policy, rows in subjects_by_arm.items() for row in rows])
    cfg.RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    frames.to_parquet(cfg.RESULTS_DIR / "raw.parquet", index=False)
    subjects.to_parquet(cfg.RESULTS_DIR / "subjects.parquet", index=False)
    (cfg.RESULTS_DIR / "summary.json").write_text(json.dumps(summary, indent=2, default=float) + "\n")
    return summary


def report(summary):
    for policy, arm in summary["arms"].items():
        dispatch = arm["time_to_dispatch_s"]
        print(f"\n[{policy}] {arm['leads']} leads over {arm['runs']} runs")
        print(f"  time to dispatch: median {_fmt(dispatch['median'])} s (IQR {_fmt(dispatch['iqr'])}, n={dispatch['n']})")
        print(f"  under_structure:  median {_fmt(arm['under_structure_time_to_dispatch_s']['median'])} s "
              f"(n={arm['under_structure_time_to_dispatch_s']['n']}, inspection only)")
        print(f"  subjects found:   {arm['subjects']['dispatched']}/{arm['subjects']['placed']} "
              f"({arm['subjects']['found_share']})")
        print(f"  action accuracy:  decision {arm['action_accuracy']['decision']}, final {arm['action_accuracy']['final']}")
        print(f"  dispatch:         precision {arm['dispatch']['precision']}, recall {arm['dispatch']['recall']}")
        print(f"  routed {arm['routing_rate']}, fallback {arm['fallback_rate']}, re-decisions {arm['redecisions']}")
        print(f"  latency p50/p95:  {arm['latency_ms']['p50']}/{arm['latency_ms']['p95']} ms")
        calibration = arm["calibration"]
        print(f"  ECE laya {calibration['laya_p_person']['ece']} vs detector {calibration['detector_conf']['ece']} "
              f"(n={calibration['laya_p_person']['n']})")
    print("\nFlyBy vs a manual overhead reviewer (visible and partial subjects)")
    for row in summary["comparison"]:
        print(f"  {row['arm']:5s} review {row['review_s']:>3d} s/image: FlyBy {_fmt(row['flyby_median_s'])} s "
              f"vs manual {_fmt(row['manual_median_s'])} s -> {row['speedup']}x")


def _fmt(value):
    return "n/a" if value is None else f"{value:.1f}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=int, nargs="*", default=list(SEEDS))
    parser.add_argument("--arms", nargs="*", default=["laya", "rule"], choices=("laya", "rule"))
    parser.add_argument("--no-mongo", action="store_true", help="skip Atlas and the local spool")
    args = parser.parse_args()
    cfg = settings.model_copy(update={"PARSE_MODE": "oracle"})

    async def go():
        writer = None
        if not args.no_mongo:
            from server.store.writer import Writer
            writer = Writer(cfg)
            await writer.start()
        try:
            return await evaluate(args.seeds, args.arms, cfg, writer=writer)
        finally:
            if writer is not None:
                try:
                    await writer.stop()
                except RuntimeError as exc:
                    print(f"Persistence warning: {exc}")

    report(asyncio.run(go()))
    print(f"\nResults: {cfg.RESULTS_DIR / 'summary.json'}")


if __name__ == "__main__":
    main()

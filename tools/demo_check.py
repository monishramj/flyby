"""T7: find a demo seed and verify every service the demo touches.

  uv run python -m tools.demo_check --find-seed
  uv run python -m tools.demo_check
"""
import argparse
import asyncio
import json

from server.config import ROOT, settings
from server.mission.loop import MissionRun

REQUIRED = ("routes_to_human", "early_rerank", "dispatches")


async def probe(seed, cfg, runtime=None):
    """Replays a seed headlessly with oracle intel and the live policy."""
    run = MissionRun(seed, cfg, policy=cfg.LIVE_POLICY, parse_mode="oracle", sim_human=True,
                     fast=True, runtime=runtime)
    rerank_times = []
    original = run.on_incident_update

    async def watch(picture):
        before = {lead_id: len(lead["history"]) for lead_id, lead in run.leads.items()}
        await original(picture)
        if any(len(run.leads[lead_id]["history"]) > count for lead_id, count in before.items()):
            rerank_times.append(run.clock.now)

    run.incident._hooks = [watch]
    try:
        await run.start()
    finally:
        await run.stop()
    routed = sum(any(entry["status"] == "awaiting_human" for entry in lead["status_history"])
                 for lead in run.leads.values())
    dispatches = sum(lead["status"] == "dispatched" for lead in run.leads.values())
    return {"seed": seed, "leads": len(run.leads), "routed_to_human": routed,
            "dispatches": dispatches, "redecisions": run.redecision_count,
            "first_rerank_s": round(min(rerank_times), 1) if rerank_times else None,
            "checks": {"routes_to_human": routed >= 1,
                       "early_rerank": bool(rerank_times) and min(rerank_times) <= 120,
                       "dispatches": dispatches >= 3}}


async def find_seed(cfg, limit):
    print(f"Scanning seeds 0-{limit - 1} with policy={cfg.LIVE_POLICY} and oracle intel", flush=True)
    best = []
    for seed in range(limit):
        result = await probe(seed, cfg)
        passed = sum(result["checks"].values())
        best.append(result)
        flags = " ".join(name for name, ok in result["checks"].items() if ok)
        print(f"  seed {seed:3d}: {result['leads']:2d} leads, {result['dispatches']} dispatched, "
              f"{result['routed_to_human']} routed, first re-rank "
              f"{result['first_rerank_s']}s  [{flags or 'none'}]", flush=True)
        if passed == len(REQUIRED):
            print(f"\nDEMO_SEED={seed} satisfies every T7 condition.")
            return result
    best.sort(key=lambda row: (-sum(row["checks"].values()), -row["dispatches"]))
    print(f"\nNo seed satisfied all three conditions. Closest: seed {best[0]['seed']} "
          f"({sum(best[0]['checks'].values())}/{len(REQUIRED)}).")
    return best[0]


async def verify(cfg):
    report = {}
    try:
        from server.triage.laya_runtime import load
        runtime = load(cfg)
        report["laya"] = {"ok": True, "device": runtime.device}
    except Exception as exc:
        runtime = None
        report["laya"] = {"ok": False, "detail": f"{type(exc).__name__}: {exc}",
                          "impact": "decisions fall back to the rule"}

    from server.grok.parse import parse_intel
    try:
        parse = await parse_intel("Two people on the roof at Elm School, water rising fast.",
                                  json.loads((ROOT / "data/gazetteer.json").read_text()), cfg=cfg)
        report["grok"] = {"ok": True, "reports": len(parse.reports), "unparseable": parse.unparseable}
    except Exception as exc:
        report["grok"] = {"ok": False, "detail": f"{type(exc).__name__}: {exc}",
                          "impact": "intel shows 'parse unavailable' and briefs use templates"}

    from server.store.writer import Writer
    writer = Writer(cfg)
    await writer.start()
    writer.put("runs", {"run_id": "demo-check", "kind": "check"})
    await writer.queue.join()
    similar = await writer.similar({"lead": {"detector_conf": .5, "box_px": 30}}, cfg.DEMO_SEED)
    await writer.stop()
    report["persistence"] = {"ok": True, "atlas": writer.available,
                             "target": "atlas" if writer.available else f"jsonl in {cfg.LOG_DIR}",
                             "mongo_writes": writer.mongo_writes, "local_writes": writer.local_writes}
    report["vector_search"] = {"ok": not similar["unavailable"] and similar["n"] > 0, **similar}
    if not report["vector_search"]["ok"]:
        report["vector_search"]["impact"] = "no similar-past-flags lookup; run tools.atlas_setup and tools.atlas_replay"

    files = {name: (cfg.RESULTS_DIR / name).is_file() for name in ("summary.json", "raw.parquet", "subjects.parquet")}
    report["results"] = {"ok": all(files.values()), "files": files}
    if files["summary.json"]:
        summary = json.loads((cfg.RESULTS_DIR / "summary.json").read_text())
        report["results"]["arms"] = list(summary["arms"])
        report["results"]["seeds"] = len(summary["seeds"])

    demo = await probe(cfg.DEMO_SEED, cfg, runtime=None)
    report["demo_seed"] = {"ok": all(demo["checks"].values()), **demo}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--find-seed", action="store_true", help="scan seeds for a demo-ready run")
    parser.add_argument("--limit", type=int, default=120)
    args = parser.parse_args()
    cfg = settings
    if args.find_seed:
        asyncio.run(find_seed(cfg, args.limit))
        return
    report = asyncio.run(verify(cfg))
    print(json.dumps(report, indent=2, default=str))
    failures = [name for name, section in report.items() if not section.get("ok", True)]
    if failures:
        print("\nDegraded, but the mission still runs: " + ", ".join(failures))
        print("Offline demo expectations: decisions keep flowing, briefs use templates, "
              "the intel feed shows 'parse unavailable', Ask reports offline, writes go to JSONL.")
    else:
        print("\nEvery demo dependency is ready.")


if __name__ == "__main__":
    main()

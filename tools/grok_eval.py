"""How Grok does its two jobs, measured with live calls (uses API credits).

  uv run python -m tools.grok_eval              # seeds 0-4 -> results/grok.json

1. Intel parsing: every radio message of each mission, parsed by Grok and scored field by field
   against the scripted ground-truth parse.
2. Crew orders: every lead Laya sent to a crew or a close-in inspection gets its order written,
   timed, and checked for digits (code strips them; numbers come only from code).

Missions run in fast mode with oracle intel, so Laya's decisions match the main eval. Orders are
written from the picture at the end of the mission, not at the moment of the decision.
"""
import argparse
import asyncio
import json
import re
from datetime import UTC, datetime
from time import perf_counter

from batch.metrics import _spread
from server.config import settings
from server.grok.briefs import order_facts, prepare_order
from server.grok.parse import parse_intel
from server.mission.loop import CREW_ACTIONS, MissionRun
from server.triage.laya_runtime import load

FIELDS = ("location", "subject_count", "urgency", "hazards", "source", "is_retraction")


def _agrees(truth, parsed, name):
    if name == "location":
        # Score what the message states: a landmark if it names one, else the sector. Grok adding the
        # landmark's sector is extra information, not an error.
        key = "landmark" if truth.get("landmark") else "sector"
        return truth.get(key) == parsed.get(key)
    if name == "hazards":
        return sorted(truth.get("hazards") or []) == sorted(parsed.get("hazards") or [])
    return truth.get(name) == parsed.get(name)


def score_parse(truth, parsed):
    """Per-field agreement between report pairs, plus whether the report count and 'unparseable' match."""
    pairs = list(zip(truth.get("reports", []), parsed.get("reports", [])))
    return {"count_match": len(truth.get("reports", [])) == len(parsed.get("reports", [])),
            "unparseable_match": bool(truth.get("unparseable")) == bool(parsed.get("unparseable")),
            "fields": {name: [_agrees(a, b, name) for a, b in pairs] for name in FIELDS}}


async def timed(coroutine):
    started = perf_counter()
    try:
        return await coroutine, "ok", (perf_counter() - started) * 1000
    except TimeoutError:
        return None, "timeout", (perf_counter() - started) * 1000
    except Exception:
        return None, "error", (perf_counter() - started) * 1000


async def evaluate(seeds, cfg):
    runtime = load(cfg)
    slots = asyncio.Semaphore(3)  # the live app's order concurrency
    intel_rows, order_rows = [], []

    async def parse_one(message, gazetteer):
        async with slots:
            parsed, outcome, ms = await timed(parse_intel(message["raw"], gazetteer, cfg=cfg))
        row = {"outcome": outcome, "latency_ms": ms}
        if parsed is not None:
            row.update(score_parse(message["oracle_parse"], parsed.model_dump(mode="json")))
        intel_rows.append(row)

    async def order_one(facts):
        async with slots:
            text, outcome, ms = await timed(prepare_order(facts, cfg=cfg))
        order_rows.append({"outcome": outcome, "latency_ms": ms, "action": facts["action"],
                           "digits": text is not None and any(re.search(r"\d", v) for v in text.model_dump().values())})

    for seed in seeds:
        run = MissionRun(seed, cfg, policy="laya", parse_mode="oracle", sim_human=True, fast=True, runtime=runtime)
        try:
            await run.start()
        finally:
            await run.stop()
        picture, intel = run.incident.snapshot(), list(run.intel_log.values())
        crew = []
        for lead in run.leads.values():
            calls = [entry for entry in lead["history"] if entry["action"] in CREW_ACTIONS]
            if calls:
                crew.append(order_facts({**lead, "decision": calls[-1]}, picture, run.scenario.gazetteer, intel, cfg))
        print(f"  seed {seed}: {len(run.intel)} radio messages, {len(crew)} crew orders", flush=True)
        await asyncio.gather(*(parse_one(message, run.scenario.gazetteer) for message in run.intel),
                             *(order_one(facts) for facts in crew))
    return summarize(seeds, cfg, intel_rows, order_rows)


def _outcomes(rows):
    return {name: sum(row["outcome"] == name for row in rows) for name in ("ok", "timeout", "error")}


def summarize(seeds, cfg, intel_rows, order_rows):
    parsed = [row for row in intel_rows if row["outcome"] == "ok"]
    field_share = {}
    for name in FIELDS:
        hits = [hit for row in parsed for hit in row["fields"][name]]
        field_share[name] = {"n": len(hits), "share": round(sum(hits) / len(hits), 3) if hits else None}
    ok_orders = [row for row in order_rows if row["outcome"] == "ok"]
    return {
        "generated_at": datetime.now(UTC).isoformat(), "model": cfg.XAI_MODEL, "seeds": list(seeds),
        "intel": {"n": len(intel_rows), **_outcomes(intel_rows),
                  "latency_ms": _spread([row["latency_ms"] for row in parsed]),
                  "count_match": round(sum(row["count_match"] for row in parsed) / len(parsed), 3) if parsed else None,
                  "unparseable_match": round(sum(row["unparseable_match"] for row in parsed) / len(parsed), 3) if parsed else None,
                  "fields": field_share},
        "orders": {"n": len(order_rows), **_outcomes(order_rows), "timeout_s": cfg.GROK_ORDER_TIMEOUT_S,
                   "latency_ms": _spread([row["latency_ms"] for row in ok_orders]),
                   "digits_caught": sum(row["digits"] for row in ok_orders)},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seeds", type=int, nargs="*", default=list(range(5)))
    args = parser.parse_args()
    cfg = settings.model_copy(update={"PARSE_MODE": "oracle"})
    if not cfg.XAI_API_KEY:
        raise SystemExit("XAI_API_KEY is not set; this tool makes live Grok calls.")
    summary = asyncio.run(evaluate(args.seeds, cfg))
    cfg.RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (cfg.RESULTS_DIR / "grok.json").write_text(json.dumps(summary, indent=2) + "\n")
    intel, orders = summary["intel"], summary["orders"]
    print(f"intel: {intel['ok']}/{intel['n']} parsed, median {intel['latency_ms']['median']} ms, "
          + ", ".join(f"{name} {row['share']}" for name, row in intel["fields"].items()))
    print(f"orders: {orders['ok']}/{orders['n']} written, {orders['timeout']} timed out, median "
          f"{orders['latency_ms']['median']} ms, {orders['digits_caught']} with digits caught")
    print(f"Results: {cfg.RESULTS_DIR / 'grok.json'}")


if __name__ == "__main__":
    main()

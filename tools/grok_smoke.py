"""T0.3: one structured parse and one tool round trip against the live xAI API."""
import argparse
import asyncio
import json
from time import perf_counter

from xai_sdk.chat import system, user

from server.config import ROOT, settings
from server.grok.client import chat_with_tools
from server.grok.parse import parse_intel
from server.grok.tools import NoArguments
from xai_sdk.chat import tool

MESSAGE = "Command, this is Engine 4 at the Cedar Church. Two people on the porch, water is rising fast, we need help now."


async def main(cfg):
    gazetteer = json.loads((ROOT / "data/gazetteer.json").read_text())
    print(f"model={cfg.XAI_MODEL} prompt_version={cfg.GROK_PROMPT_VERSION}")

    started = perf_counter()
    parse = await parse_intel(MESSAGE, gazetteer, cfg=cfg)
    print(f"\nparse_intel in {(perf_counter() - started) * 1000:.0f} ms")
    print(json.dumps(parse.model_dump(mode="json"), indent=2))
    assert not parse.unparseable and parse.reports, "a clear firsthand report must parse"

    calls = []

    def get_mission_status():
        calls.append("get_mission_status")
        return {"t": 128.0, "coverage_pct": 41.5, "drone": {"x": 90.0, "y": 210.0},
                "lead_counts": {"awaiting_human": 2, "dispatched": 1}}

    declarations = [tool("get_mission_status", "Read simulated mission status.", NoArguments.model_json_schema())]
    started = perf_counter()
    answer, trace = await chat_with_tools(
        [system("You are read-only. Answer only from tool results and cite numbers exactly."),
         user("How much of the area is covered and how many leads await a human?")],
        declarations, {"get_mission_status": get_mission_status},
        cfg.ASK_MAX_TOOL_ROUNDS, cfg.GROK_ASK_TIMEOUT_S, cfg=cfg)
    print(f"\nchat_with_tools in {(perf_counter() - started) * 1000:.0f} ms")
    print(f"tools called: {calls}")
    print(f"trace: {json.dumps(trace, indent=2)}")
    print(f"answer: {answer}")
    assert calls, "Grok must call the read-only tool before answering"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=settings.XAI_MODEL)
    args = parser.parse_args()
    asyncio.run(main(settings.model_copy(update={"XAI_MODEL": args.model})))

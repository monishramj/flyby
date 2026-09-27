"""Replay the local JSONL outage spool into Atlas, then mark each file replayed.
Leads, incidents, runs and intel are upserts by key, so an interrupted replay can simply run again."""
import asyncio
import json

from pymongo import AsyncMongoClient

from server.config import settings
from server.store.writer import COLLECTIONS, ops

CHUNK = 1000


def seed_of(document, seeds):
    """Older spooled leads predate the seed field; recover it so Writer.similar() can exclude a mission's own seed."""
    if document.get("seed") is not None:
        return document["seed"]
    if document["run_id"] in seeds:
        return seeds[document["run_id"]]
    parts = document["run_id"].split("-")  # MissionRun ids are {timestamp}-{seed}-{hex}
    return int(parts[1]) if len(parts) == 3 and parts[1].isdigit() else None


def read(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


async def main(cfg=settings):
    if not cfg.MONGODB_URI:
        raise SystemExit("MONGODB_URI is not set.")
    client = AsyncMongoClient(cfg.MONGODB_URI)
    db = client[cfg.MONGODB_DATABASE]
    runs = cfg.LOG_DIR / "runs.jsonl"
    seeds = {run["run_id"]: run.get("seed") for run in read(runs)} if runs.exists() else {}
    for name in COLLECTIONS:
        path = cfg.LOG_DIR / f"{name}.jsonl"
        if not path.exists():
            continue
        documents = [document for document in read(path) if document.get("run_id")]
        skipped = 0
        if name == "leads":
            for document in documents:
                document["seed"] = seed_of(document, seeds)
            kept = [document for document in documents if document["seed"] is not None]
            skipped, documents = len(documents) - len(kept), kept
        for start in range(0, len(documents), CHUNK):
            await db[name].bulk_write(ops(name, documents[start:start + CHUNK]), ordered=True)
        path.rename(path.with_suffix(".jsonl.replayed"))
        print(f"{name}: replayed {len(documents)} documents{f', skipped {skipped} with no known seed' if skipped else ''}")
    total = await db["leads"].count_documents({"vector": {"$exists": True}})
    print(f"leads searchable by vector in Atlas: {total}")
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())

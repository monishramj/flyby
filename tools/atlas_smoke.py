"""T0.4: prove put() never blocks, then show where the documents actually landed."""
import argparse
import asyncio
import json
from time import perf_counter
from uuid import uuid4

from server.config import settings
from server.store.writer import Writer


async def main(cfg):
    run_id = f"atlas-smoke-{uuid4().hex[:8]}"
    writer = Writer(cfg)
    await writer.start()
    documents = [{"run_id": run_id, "lead_id": f"L-{index}", "status": "captured"} for index in range(50)]
    started = perf_counter()
    writer.put_many("leads", documents)
    enqueue_ms = (perf_counter() - started) * 1000
    print(f"put_many of {len(documents)} documents returned in {enqueue_ms:.3f} ms "
          f"({enqueue_ms / len(documents):.4f} ms each)")
    assert enqueue_ms / len(documents) < 5, "put() must stay off the decision path"

    writer.put("incidents", {"run_id": run_id, "sector_priority": {"S3": "critical"}})
    writer.put("incidents", {"run_id": run_id, "sector_priority": {"S3": "critical", "S7": "high"}})
    await writer.stop()
    print(f"target: {'Atlas' if writer.available else 'local JSONL spool'}")
    print(f"mongo_writes={writer.mongo_writes} local_writes={writer.local_writes}")

    if writer.available:
        from pymongo import AsyncMongoClient
        client = AsyncMongoClient(cfg.MONGODB_URI, serverSelectionTimeoutMS=cfg.MONGO_TIMEOUT_MS)
        database = client[cfg.MONGODB_DATABASE]
        leads = await database["leads"].count_documents({"run_id": run_id})
        incidents = await database["incidents"].count_documents({"run_id": run_id})
        picture = await database["incidents"].find_one({"run_id": run_id})
        print(f"in Atlas: {leads} leads, {incidents} incident document (upserted by run_id)")
        print(f"latest picture: {json.dumps(picture.get('sector_priority'))}")
        assert leads == len(documents) and incidents == 1, "leads upsert per lead, incidents once per run"
        await database["leads"].delete_many({"run_id": run_id})
        await database["incidents"].delete_many({"run_id": run_id})
        await client.close()
        print("cleaned up the smoke documents")
    else:
        path = cfg.LOG_DIR / "leads.jsonl"
        spooled = sum(1 for line in path.read_text().splitlines() if run_id in line)
        print(f"in {path}: {spooled} spooled lead documents")
        assert spooled == len(documents), "an outage must not lose documents"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uri", default=None, help="override MONGODB_URI (empty string forces the spool)")
    args = parser.parse_args()
    cfg = settings if args.uri is None else settings.model_copy(update={"MONGODB_URI": args.uri})
    asyncio.run(main(cfg))

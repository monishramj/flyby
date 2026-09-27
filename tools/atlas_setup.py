"""One-time, idempotent Atlas setup: collections with a run_id validator, unique upsert-key indexes,
and the vector search index behind Writer.similar()."""
import asyncio
import time

from pymongo import AsyncMongoClient
from pymongo.errors import CollectionInvalid
from pymongo.operations import SearchIndexModel

from server.config import settings
from server.store.writer import COLLECTIONS, KEYS, VECTOR_DIMS, VECTOR_INDEX

VALIDATOR = {"$jsonSchema": {"bsonType": "object", "required": ["run_id"],
                             "properties": {"run_id": {"bsonType": "string"}}}}
VECTOR_DEFINITION = {"fields": [
    {"type": "vector", "path": "vector", "numDimensions": VECTOR_DIMS, "similarity": "euclidean"},
    {"type": "filter", "path": "seed"},
]}


async def main(cfg=settings, wait_s=180):
    if not cfg.MONGODB_URI:
        raise SystemExit("MONGODB_URI is not set.")
    client = AsyncMongoClient(cfg.MONGODB_URI)
    db = client[cfg.MONGODB_DATABASE]
    for name in COLLECTIONS:
        try:
            await db.create_collection(name, validator=VALIDATOR)
        except CollectionInvalid:  # already exists: attach the validator instead
            await db.command("collMod", name, validator=VALIDATOR)
        keys = [(key, 1) for key in KEYS.get(name, ("run_id",))]
        index = await db[name].create_index(keys, unique=name in KEYS)
        print(f"{name}: run_id validator, index {index}{' (unique)' if name in KEYS else ''}")

    leads = db["leads"]
    existing = {index["name"]: index async for index in await leads.list_search_indexes()}
    if VECTOR_INDEX in existing:
        await leads.update_search_index(VECTOR_INDEX, VECTOR_DEFINITION)
        print(f"leads: updated vector search index {VECTOR_INDEX}")
    else:
        await leads.create_search_index(SearchIndexModel(VECTOR_DEFINITION, name=VECTOR_INDEX, type="vectorSearch"))
        print(f"leads: created vector search index {VECTOR_INDEX} ({VECTOR_DIMS} dims, filter on seed)")

    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        index = [index async for index in await leads.list_search_indexes(VECTOR_INDEX)][0]
        if index.get("queryable") and index.get("status") == "READY":
            print("vector search index is READY")
            break
        await asyncio.sleep(5)
    else:
        print(f"vector search index still building ({index.get('status')}); it becomes queryable on its own")
    await client.close()


if __name__ == "__main__":
    asyncio.run(main())

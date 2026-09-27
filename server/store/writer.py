"""Write-behind Mongo persistence with an append-only local outage spool."""
import asyncio
import json
import time
from copy import deepcopy

import numpy as np
from pymongo import AsyncMongoClient, InsertOne, ReplaceOne

from server.config import settings

COLLECTIONS = ("runs", "leads", "intel", "incidents", "qa")
# Upsert keys: rewriting or replaying a document is harmless. qa has no natural key and is insert-only.
KEYS = {"leads": ("run_id", "lead_id"), "incidents": ("run_id",), "runs": ("run_id",), "intel": ("run_id", "intel_id")}
BATCH = 500
VECTOR_INDEX = "lead_vectors"
PRIORITY = ("low", "moderate", "high", "critical")


def vector(state, cfg=settings):
    """A lead's built (truth-free) state as numbers in [0, 1] for Atlas Vector Search."""
    lead, context = state.get("lead", {}), state.get("context", {})
    priority = context.get("sector_priority")
    return [
        float(lead.get("detector_conf", 0)),
        min(float(lead.get("box_px", 0)) / cfg.LARGE_BOX_PX, 1.0),
        float(bool(lead.get("near_structure"))),
        float(lead.get("passes", 1) > 1),
        (PRIORITY.index(priority) + 1) / len(PRIORITY) if priority in PRIORITY else 0.0,
        float(bool(context.get("near_last_known_point"))),
        min(len(context.get("hazards_nearby", [])), 3) / 3,
        float(context.get("reported_subjects_in_sector", 0) > 0),
    ]


VECTOR_DIMS = len(vector({}))


def ops(collection, documents):
    """Bulk operations for one collection; leads with a built state carry their search vector."""
    result = []
    for document in documents:
        if collection == "leads" and document.get("state"):
            document = {**document, "vector": vector(document["state"])}
        if collection in KEYS:
            result.append(ReplaceOne({key: document.get(key) for key in KEYS[collection]}, document, upsert=True))
        else:
            result.append(InsertOne(document))
    return result


class Writer:
    def __init__(self, cfg=settings):
        self.cfg = cfg
        self.queue = asyncio.Queue()
        self.client = None
        self.db = None
        self.task = None
        self.available = False
        self._retry_at = 0.0
        self._accepting = False
        self._failure = None
        self.mongo_writes = 0
        self.local_writes = 0

    async def start(self):
        if self.task is not None:
            return
        self._accepting = True
        self.task = asyncio.create_task(self._worker())

    def put(self, collection, document):
        if collection not in COLLECTIONS:
            raise ValueError("Unknown collection")
        if not document.get("run_id"):
            raise ValueError("Every document requires run_id")
        if not self._accepting:
            raise RuntimeError("Writer is not running")
        self.queue.put_nowait((collection, deepcopy(document)))

    def put_many(self, collection, documents):
        for document in documents:
            self.put(collection, document)

    async def stop(self):
        if self.task is None:
            return
        self._accepting = False
        self.queue.put_nowait(None)
        await self.task
        self.task = None
        if self.client is not None:
            await self.client.close()
        if self._failure:
            raise RuntimeError("Local persistence failed; logs may be incomplete") from self._failure

    def _append_jsonl(self, collection, documents):
        self.cfg.LOG_DIR.mkdir(parents=True, exist_ok=True)
        with (self.cfg.LOG_DIR / f"{collection}.jsonl").open("a", encoding="utf-8") as file:
            for document in documents:
                file.write(json.dumps(document, default=str, allow_nan=False) + "\n")

    async def _write(self, collection, documents):
        """One round trip per collection per batch; ordered, so the last incident picture wins."""
        if not self.cfg.MONGODB_URI or time.monotonic() < self._retry_at:
            raise ConnectionError("Using local spool")
        if self.client is None:
            self.client = AsyncMongoClient(
                self.cfg.MONGODB_URI,
                timeoutMS=self.cfg.MONGO_TIMEOUT_MS,
                serverSelectionTimeoutMS=self.cfg.MONGO_TIMEOUT_MS,
                connectTimeoutMS=self.cfg.MONGO_TIMEOUT_MS,
            )
            self.db = self.client[self.cfg.MONGODB_DATABASE]
        await self.db[collection].bulk_write(ops(collection, documents), ordered=True)

    async def _flush(self, collection, documents):
        try:
            await self._write(collection, documents)
            self.available = True
            self.mongo_writes += len(documents)
        except Exception:
            self.available = False
            if time.monotonic() >= self._retry_at:
                self._retry_at = time.monotonic() + self.cfg.MONGO_RETRY_S
            try:
                await asyncio.to_thread(self._append_jsonl, collection, documents)
                self.local_writes += len(documents)
            except Exception as exc:
                self._failure = exc

    async def _worker(self):
        while True:
            batch = [await self.queue.get()]
            while batch[-1] is not None and len(batch) < BATCH and not self.queue.empty():
                batch.append(self.queue.get_nowait())
            try:
                groups = {}
                for item in batch:
                    if item is not None:
                        groups.setdefault(item[0], []).append(item[1])
                for collection, documents in groups.items():
                    await self._flush(collection, documents)
            finally:
                for _ in batch:
                    self.queue.task_done()
            if batch[-1] is None:
                return

    async def decision_stats(self, run_id):
        if self.db is None or not self.available:
            return {"unavailable": True, "reason": "Atlas is unavailable; mission logs are stored locally."}
        pipeline = [
            {"$match": {"run_id": run_id}},
            {"$project": {"history": {"$ifNull": ["$history", []]}}},
            {"$facet": {
                "leads": [{"$group": {"_id": None, "count": {"$sum": 1}, "redecisions": {"$sum": {"$max": [0, {"$subtract": [{"$size": "$history"}, 1]}]}}}}],
                "decisions": [{"$unwind": "$history"}, {"$group": {
                    "_id": {"action": "$history.action", "source": "$history.source"},
                    "count": {"$sum": 1},
                    "fallbacks": {"$sum": {"$cond": ["$history.used_fallback", 1, 0]}},
                    "routed": {"$sum": {"$cond": ["$history.routed_to_human", 1, 0]}},
                    "latencies": {"$push": {"$cond": [{"$eq": ["$history.source", "laya"]}, "$history.latency_ms", None]}},
                }}],
            }},
        ]
        try:
            cursor = await self.db["leads"].aggregate(pipeline)
            rows = await cursor.to_list()
            result = rows[0] if rows else {"leads": [], "decisions": []}
            groups = result["decisions"]
            total = sum(group["count"] for group in groups)
            latencies = [latency for group in groups for latency in group["latencies"] if latency is not None]
            return {
                "unavailable": False,
                "decision_count": total,
                "counts": [{**group["_id"], "count": group["count"]} for group in groups],
                "fallback_rate": sum(group["fallbacks"] for group in groups) / total if total else 0,
                "routed_rate": sum(group["routed"] for group in groups) / total if total else 0,
                "redecision_count": result["leads"][0]["redecisions"] if result["leads"] else 0,
                "laya_latency_ms": {"p50": float(np.percentile(latencies, 50)), "p95": float(np.percentile(latencies, 95))} if latencies else None,
            }
        except Exception:
            return {"unavailable": True, "reason": "Atlas decision statistics are unavailable."}

    async def similar(self, state, seed, limit=25):
        """What the nearest past flags turned out to be, by Atlas Vector Search over every logged lead.
        Other seeds only: the same seed replays the same leads, which would leak this mission's truth."""
        if self.db is None or not self.available:
            return {"unavailable": True, "reason": "Atlas is unavailable."}
        pipeline = [
            {"$vectorSearch": {"index": VECTOR_INDEX, "path": "vector", "queryVector": vector(state, self.cfg),
                               "numCandidates": limit * 8, "limit": limit, "filter": {"seed": {"$ne": seed}}}},
            {"$group": {"_id": "$truth.type", "count": {"$sum": 1}}},
        ]
        try:
            cursor = await self.db["leads"].aggregate(pipeline)
            types = {row["_id"]: row["count"] for row in await cursor.to_list()}
        except Exception:
            return {"unavailable": True, "reason": "Atlas vector search is unavailable."}
        return {"unavailable": False, "n": sum(types.values()), "people": types.pop("subject", 0),
                "not_people": dict(sorted(types.items(), key=lambda item: -item[1]))}

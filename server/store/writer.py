"""Write-behind Mongo persistence with an append-only local outage spool."""
import asyncio
import json
import time
from copy import deepcopy

import numpy as np
from pymongo import AsyncMongoClient

from server.config import settings


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
        if collection not in {"runs", "leads", "intel", "incidents", "qa", "proposals"}:
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

    def _append_jsonl(self, collection, document):
        self.cfg.LOG_DIR.mkdir(parents=True, exist_ok=True)
        with (self.cfg.LOG_DIR / f"{collection}.jsonl").open("a", encoding="utf-8") as file:
            file.write(json.dumps(document, default=str, allow_nan=False) + "\n")

    async def _write(self, collection, document):
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
        target = self.db[collection]
        if collection in {"incidents", "leads"}:
            key = {"run_id": document["run_id"]}
            if collection == "leads":
                key["lead_id"] = document["lead_id"]
            await target.replace_one(key, document, upsert=True)
        else:
            await target.insert_one(document)
        self.available = True
        self.mongo_writes += 1

    async def _worker(self):
        while True:
            item = await self.queue.get()
            try:
                if item is None:
                    return
                collection, document = item
                try:
                    await self._write(collection, document)
                except Exception:
                    self.available = False
                    if time.monotonic() >= self._retry_at:
                        self._retry_at = time.monotonic() + self.cfg.MONGO_RETRY_S
                    try:
                        await asyncio.to_thread(self._append_jsonl, collection, document)
                        self.local_writes += 1
                    except Exception as exc:
                        self._failure = exc
            finally:
                self.queue.task_done()

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

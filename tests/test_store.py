import json

from pymongo import InsertOne, ReplaceOne

from server.store.writer import VECTOR_DIMS, Writer, ops, vector
from tests.conftest import fast_settings


def recording_writer(tmp_path, fail=False):
    writer = Writer(fast_settings(LOG_DIR=tmp_path))
    calls = []

    async def write(collection, documents):
        calls.append((collection, [document["n"] for document in documents]))
        if fail:
            raise ConnectionError("Atlas down")

    writer._write = write
    return writer, calls


async def test_a_burst_of_puts_is_one_bulk_write_per_collection_in_order(tmp_path):
    writer, calls = recording_writer(tmp_path)
    await writer.start()
    for n in range(5):
        writer.put("leads", {"run_id": "r", "lead_id": f"L{n}", "n": n})
        writer.put("intel", {"run_id": "r", "intel_id": f"I{n}", "n": n})
    await writer.stop()
    assert sorted(calls) == [("intel", [0, 1, 2, 3, 4]), ("leads", [0, 1, 2, 3, 4])]
    assert writer.mongo_writes == 10 and writer.local_writes == 0


async def test_a_failed_bulk_write_spools_the_whole_batch(tmp_path):
    writer, _ = recording_writer(tmp_path, fail=True)
    await writer.start()
    for n in range(3):
        writer.put("qa", {"run_id": "r", "n": n})
    await writer.stop()
    lines = (tmp_path / "qa.jsonl").read_text().splitlines()
    assert [json.loads(line)["n"] for line in lines] == [0, 1, 2]
    assert writer.local_writes == 3 and not writer.available


def test_ops_upsert_by_key_and_insert_qa():
    lead = {"run_id": "r", "lead_id": "L1", "state": {"lead": {"detector_conf": .5}}}
    [replace] = ops("leads", [lead])
    assert isinstance(replace, ReplaceOne)
    assert replace._filter == {"run_id": "r", "lead_id": "L1"}
    assert len(replace._doc["vector"]) == VECTOR_DIMS and "vector" not in lead
    [incident] = ops("incidents", [{"run_id": "r"}])
    assert incident._filter == {"run_id": "r"}
    [insert] = ops("qa", [{"run_id": "r"}])
    assert isinstance(insert, InsertOne)


def test_vector_is_fixed_length_and_bounded():
    full = {"lead": {"detector_conf": .9, "box_px": 500, "near_structure": True, "passes": 2},
            "context": {"sector_priority": "critical", "near_last_known_point": True,
                        "hazards_nearby": ["fire", "wires", "water", "gas"], "reported_subjects_in_sector": 3}}
    for state in ({}, full):
        values = vector(state)
        assert len(values) == VECTOR_DIMS and all(0 <= value <= 1 for value in values)
    assert vector(full)[1] == 1 and vector(full)[4] == 1


async def test_similar_is_unavailable_without_atlas(tmp_path):
    writer = Writer(fast_settings(LOG_DIR=tmp_path))
    assert (await writer.similar({}, seed=7))["unavailable"]

import json

from server.config import ROOT, Settings
from server.incident import merge
from server.incident.schemas import IntelParse
from server.incident.store import IncidentStore

GAZETTEER = json.loads((ROOT / "data/gazetteer.json").read_text())
CFG = Settings()


def report(**fields):
    return {"sector": None, "landmark": None, "subject_count": None, "hazards": [],
            "source": "unverified", "is_retraction": False, **fields}


def apply(picture, reports, intel_id, t):
    return merge.apply(picture, {"reports": reports, "unparseable": False}, intel_id, t, GAZETTEER, CFG)


def test_priority_is_the_maximum_urgency_and_counts_are_the_maximum():
    picture = apply(merge.empty("r"), [report(sector="S3", urgency="high", subject_count=2)], "I1", 1)
    picture = apply(picture, [report(sector="S3", urgency="low", subject_count=4)], "I2", 2)
    picture = apply(picture, [report(sector="S7", urgency="critical")], "I3", 3)
    assert picture["sector_priority"] == {"S3": "high", "S7": "critical"}
    assert picture["reported_subjects"] == {"S3": 4}


def test_landmark_only_report_maps_to_its_sector_and_places_hazards():
    picture = apply(merge.empty("r"), [report(landmark="river_bridge", urgency="high", hazards=["downed_line"])], "I1", 1)
    assert picture["sector_priority"] == {"S3": "high"}
    assert picture["hazards"] == [{"type": "downed_line", "x": 255.0, "y": 55.0}]
    centered = apply(merge.empty("r"), [report(sector="S5", urgency="low", hazards=["fire"])], "I1", 1)
    assert centered["hazards"] == [{"type": "fire", "x": 150.0, "y": 150.0}]


def test_retraction_removes_the_most_recent_matching_earlier_report():
    picture = apply(merge.empty("r"), [report(landmark="elm_school", urgency="critical")], "I1", 1)
    picture = apply(picture, [report(landmark="elm_school", urgency="moderate")], "I2", 2)
    picture = apply(picture, [report(landmark="elm_school", urgency="low", is_retraction=True)], "I3", 3)
    assert [item["report_id"] for item in picture["reports"] if item["retracted"]] == ["I2-0"]
    assert picture["sector_priority"] == {"S1": "critical"}
    # A retraction naming only the sector still matches the landmark report inside it.
    picture = apply(picture, [report(sector="S1", urgency="low", is_retraction=True)], "I4", 4)
    assert picture["sector_priority"] == {}


def test_firsthand_outranks_a_newer_secondhand_last_known_point():
    picture = apply(merge.empty("r"), [report(landmark="oak_clinic", urgency="high", source="firsthand")], "I1", 10)
    picture = apply(picture, [report(landmark="maple_tower", urgency="high", source="secondhand")], "I2", 20)
    assert picture["last_known_point"]["landmark"] == "oak_clinic"
    picture = apply(picture, [report(landmark="willow_park", urgency="high", source="firsthand")], "I3", 30)
    assert picture["last_known_point"]["landmark"] == "willow_park"
    # With no firsthand report at all, the newest landmark report wins.
    relayed = apply(merge.empty("r"), [report(landmark="oak_clinic", urgency="low", source="secondhand")], "I1", 1)
    relayed = apply(relayed, [report(sector="S9", urgency="low", source="unverified")], "I2", 2)
    assert relayed["last_known_point"]["landmark"] == "oak_clinic"


def test_unparseable_and_empty_parses_leave_the_picture_unchanged():
    before = apply(merge.empty("r"), [report(sector="S2", urgency="high")], "I1", 1)
    after = merge.apply(before, IntelParse(reports=[], unparseable=True), "I2", 2, GAZETTEER, CFG)
    assert {key: after[key] for key in ("sector_priority", "hazards", "last_known_point")} == \
           {key: before[key] for key in ("sector_priority", "hazards", "last_known_point")}


async def test_snapshot_is_immutable_and_hooks_receive_each_update():
    store = IncidentStore("r", GAZETTEER, CFG)
    seen = []
    store.on_update(lambda picture: seen.append(picture["sector_priority"].copy()))
    snapshot = store.snapshot()
    await store.apply(IntelParse(reports=[{"sector": "S4", "urgency": "high", "source": "firsthand"}]), "I1", 1)
    assert snapshot["reports"] == [] and snapshot["sector_priority"] == {}
    snapshot["sector_priority"]["S4"] = "low"
    assert store.snapshot()["sector_priority"] == {"S4": "high"}
    assert seen == [{"S4": "high"}]
    assert json.dumps(store.public())

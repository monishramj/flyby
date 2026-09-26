import json
import re

from server.config import settings
from server.grok.client import parse
from server.incident.schemas import BriefText


def _categorical_facts(lead, picture):
    decision = lead.get("decision", {})
    return {
        "action": decision.get("action"),
        "urgency": decision.get("urgency"),
        "image_size": lead.get("state", {}).get("lead", {}).get("size_band", "unknown"),
        "detector_band": lead.get("state", {}).get("lead", {}).get("detector_band", "unknown"),
        "near_structure": lead.get("near_structure", False),
        "inspection_found": lead.get("inspection_found", False),
        "hazards": sorted({h["type"] for h in picture.get("hazards", [])}),
    }


def _template_text(lead, picture):
    facts = _categorical_facts(lead, picture)
    return BriefText(
        headline="Ground team dispatch approved",
        what_drone_saw="A possible person was flagged by the drone detector.",
        access_notes="Check access and reported hazards before approach." if facts["hazards"] else "Approach cautiously; access has not been verified.",
        confidence_statement="A person was confirmed by inspection." if facts["inspection_found"] else "An automated lead requires verification by the responding crew.",
    )


def assemble_brief(lead, picture, text, *, gazetteer=None, t=None, source="template"):
    """Only this function supplies numerical mission facts."""
    raw = text.model_dump()
    flagged = any(re.search(r"\d", value) for value in raw.values())
    clean = {key: re.sub(r"\s+", " ", re.sub(r"\d", "", value)).strip() for key, value in raw.items()}
    landmark = lead.get("nearest_landmark")
    if landmark is None and gazetteer:
        landmark = min(gazetteer, key=lambda key: (gazetteer[key]["x"] - lead["x"]) ** 2 + (gazetteer[key]["y"] - lead["y"]) ** 2)
    decision = lead.get("decision", {})
    return {
        "lead_id": lead["lead_id"],
        "coordinates": {"x": lead["x"], "y": lead["y"]},
        "sector": lead["sector"],
        "nearest_landmark": landmark,
        "p_person": decision.get("p_person"),
        "urgency": decision.get("urgency"),
        "time": lead.get("t_capture") if t is None else t,
        "text": clean,
        "source": source,
        "digits_stripped": flagged,
    }


def template_brief(lead, picture, *, gazetteer=None, t=None):
    return assemble_brief(lead, picture, _template_text(lead, picture), gazetteer=gazetteer, t=t)


async def write_brief(lead, picture, *, cfg=settings, client=None):
    facts = _categorical_facts(lead, picture)
    # Urgency is encoded as an ordinal internally; send a category to Grok.
    if isinstance(facts["urgency"], int):
        facts["urgency"] = ("low", "moderate", "high", "critical")[facts["urgency"]]
    prompt = (
        f"FlyBy dispatch text {cfg.GROK_PROMPT_VERSION}. A human approved this dispatch. "
        "Write a concise crew brief using only supplied categorical facts. "
        "Never invent a route, observation, certainty, or completed action. "
        "Do not include any digits or numbers, even spelled out. Numerical facts are inserted separately by code. "
        "Hazards are incident-wide reports, not verified at this lead. Distinguish detection from confirmed inspection."
    )
    return await parse(prompt, json.dumps(facts), BriefText, cfg.GROK_BRIEF_TIMEOUT_S, cfg=cfg, client=client)


async def create_brief(lead, picture, *, gazetteer=None, t=None, cfg=settings, client=None):
    try:
        text = await write_brief(lead, picture, cfg=cfg, client=client)
        return assemble_brief(lead, picture, text, gazetteer=gazetteer, t=t, source="grok")
    except Exception:
        return template_brief(lead, picture, gazetteer=gazetteer, t=t)

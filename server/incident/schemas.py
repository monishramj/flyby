"""Validated incident and briefing payloads shared by oracle and Grok paths."""
import json
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from server.config import ROOT

Sector = Literal["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"]
Urgency = Literal["low", "moderate", "high", "critical"]
Hazard = Literal["downed_line", "rising_water", "collapse_risk", "fire", "gas"]
Landmark = StrEnum("Landmark", {key: key for key in json.loads((ROOT / "data/gazetteer.json").read_text())})


class Report(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sector: Sector | None = None
    landmark: Landmark | None = None
    subject_count: int | None = Field(default=None, ge=0, le=20)
    urgency: Urgency
    hazards: list[Hazard] = Field(default_factory=list)
    source: Literal["firsthand", "secondhand", "unverified"]
    is_retraction: bool = False


class IntelParse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reports: list[Report] = Field(default_factory=list)
    unparseable: bool = False


class BriefText(BaseModel):
    model_config = ConfigDict(extra="forbid")

    headline: str = Field(max_length=80)
    what_drone_saw: str = Field(max_length=240)
    access_notes: str = Field(max_length=240)
    confidence_statement: str = Field(max_length=160)

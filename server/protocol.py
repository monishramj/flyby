"""Browser commands are validated before they touch the mission."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter

Action = Literal["dispatch_ground_team", "reimage_zoom", "close_in_inspect", "ignore"]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Control(Payload):
    cmd: Literal["start", "pause", "reset"]
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)


class LeadId(Payload):
    lead_id: str = Field(min_length=1, max_length=80)


class Override(LeadId):
    action: Action


class InspectResult(LeadId):
    reached: bool = True  # legacy clients treated their answer as a completed visit
    found: bool | None = None
    collided: bool


class MissionControl(Payload):
    type: Literal["mission.control"]
    payload: Control


class LeadApprove(Payload):
    type: Literal["lead.approve"]
    payload: LeadId


class LeadOverride(Payload):
    type: Literal["lead.override"]
    payload: Override


class InspectionResult(Payload):
    type: Literal["inspect.result"]
    payload: InspectResult


command_adapter = TypeAdapter(Annotated[MissionControl | LeadApprove | LeadOverride | InspectionResult, Field(discriminator="type")])


class ServerEvent(BaseModel):
    type: Literal["mission.snapshot", "mission.state", "lead.new", "lead.decided", "lead.status", "intel.new", "intel.parsed", "incident.update", "dispatch.created", "inspect.request", "lead.order", "error"]
    payload: dict


def event(kind: str, payload: dict) -> dict:
    return {"type": kind, "payload": payload}

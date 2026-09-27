"""Grok vision: does the drone's close-in photo show a person?

Advisory only. It reports what it sees for the human; it never changes a lead, and no
mission decision or flight result waits on it (the panel asks after the flight ends).
"""
import asyncio
import re
import time

from pydantic import BaseModel, Field
from xai_sdk.chat import image, system, user

from server.config import settings
from server.grok.client import GrokUnavailable, _connection

DATA_URL = re.compile(r"data:image/(jpeg|png);base64,[A-Za-z0-9+/]+=*")
SYSTEM = ("You check one camera frame from a search-and-rescue drone in a simulation. "
          "Report only what is visible in the frame. Say whether a person is visible, how confident "
          "you are (0 to 1), and describe in one short sentence where they are and their apparent "
          "posture. Do not recommend actions and do not guess beyond the image.")


class VisionReport(BaseModel):
    person_visible: bool
    confidence: float = Field(ge=0, le=1)
    description: str = Field(max_length=300)


async def check_person(image_url: str, *, cfg=settings, client=None) -> dict:
    """Raise ValueError for a malformed image, GrokUnavailable when Grok cannot answer."""
    if len(image_url) > cfg.VISION_MAX_IMAGE_CHARS or not DATA_URL.fullmatch(image_url):
        raise ValueError("Expected a JPEG or PNG data URL")
    started = time.perf_counter()
    try:
        async with asyncio.timeout(cfg.GROK_VISION_TIMEOUT_S):
            async with _connection(cfg, client, cfg.GROK_VISION_TIMEOUT_S) as connection:
                chat = connection.chat.create(model=cfg.XAI_MODEL, messages=[
                    system(SYSTEM),
                    user("Is there a person in this drone camera frame?", image(image_url, detail="high")),
                ])
                _, report = await chat.parse(VisionReport)
    except GrokUnavailable:
        raise
    except Exception as exc:
        raise GrokUnavailable() from exc
    return {**report.model_dump(), "model": cfg.XAI_MODEL,
            "ms": round((time.perf_counter() - started) * 1000)}

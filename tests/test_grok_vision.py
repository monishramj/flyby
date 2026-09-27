"""Grok vision reports what the drone's photo shows; it is advisory and changes nothing."""
import base64

import pytest

from conftest import fast_settings
from server.grok.client import GrokUnavailable
from server.grok.vision import VisionReport, check_person
from test_app import client  # noqa: F401  (fixture)
from test_grok import FakeClient

JPEG = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xff\xe0 not a real jpeg, the fake never decodes it").decode()


async def test_a_report_comes_back_with_model_and_latency_and_the_image_is_sent():
    report = VisionReport(person_visible=True, confidence=0.9, description="A person lying under the roof.")
    client = FakeClient(result=report)
    out = await check_person(JPEG, cfg=fast_settings(XAI_MODEL="grok-test"), client=client)
    assert out["person_visible"] is True and out["confidence"] == 0.9 and out["model"] == "grok-test"
    assert out["ms"] >= 0
    kwargs, _ = client.chats[0]
    user_message = kwargs["messages"][1]
    assert any(part.image_url.image_url == JPEG for part in user_message.content)


async def test_malformed_images_are_rejected_before_any_call():
    client = FakeClient()
    for bad in ["https://example.com/x.jpg", "data:image/gif;base64,AAAA", "data:image/jpeg;base64,@@@"]:
        with pytest.raises(ValueError):
            await check_person(bad, cfg=fast_settings(), client=client)
    assert client.chats == []


async def test_grok_errors_and_missing_credentials_are_reported_as_unavailable():
    with pytest.raises(GrokUnavailable):
        await check_person(JPEG, cfg=fast_settings(XAI_MODEL="m"), client=FakeClient(error=RuntimeError("no network")))
    with pytest.raises(GrokUnavailable):
        await check_person(JPEG, cfg=fast_settings())  # hermetic: no key, no call


async def test_a_slow_grok_times_out():
    with pytest.raises(GrokUnavailable):
        await check_person(JPEG, cfg=fast_settings(XAI_MODEL="m", GROK_VISION_TIMEOUT_S=0.05), client=FakeClient(delay=0.5))


def test_the_route_reports_offline_grok_and_bad_images(client):  # noqa: F811
    assert client.post("/api/vision", json={"lead_id": "L-1", "image": JPEG}).status_code == 503
    assert client.post("/api/vision", json={"lead_id": "L-1", "image": "data:image/gif;base64," + "A" * 40}).status_code == 422


def test_the_route_returns_the_report_and_changes_no_state(client, monkeypatch):  # noqa: F811
    from server import app as app_module

    async def fake(image, *, cfg):
        return {"person_visible": False, "confidence": 0.8, "description": "Empty concrete floor.", "model": "m", "ms": 5}
    monkeypatch.setattr(app_module, "check_person", fake)
    before = client.get("/api/health").json()
    body = client.post("/api/vision", json={"lead_id": "L-1", "image": JPEG}).json()
    assert body == {"lead_id": "L-1", "person_visible": False, "confidence": 0.8,
                    "description": "Empty concrete floor.", "model": "m", "ms": 5}
    assert client.get("/api/health").json() == before

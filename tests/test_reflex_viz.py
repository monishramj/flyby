"""Step 7.1 viz stream: byte layout, command-byte enum, rate limit, and no effect on commands."""

import json
import struct

from fastapi.testclient import TestClient
import numpy as np
import pytest

import reflex.server as reflex_server
from reflex import viz
from reflex.config import DT_S, EXPECTED_NODES, HOVER_S, VIZ_HZ
from reflex.frames import Mode, encode_frame
from tests.test_reflex_protocol import StubEye, pixels

CMDS = {"none": 0, "brake": 1, "saccade_left": 2, "saccade_right": 3, "arrived": 4}


def half_to_float(h: int) -> float:
    """Manual IEEE 754 binary16 decode (the algorithm web/src/flyviz/stream.ts uses)."""
    sign = -1.0 if h & 0x8000 else 1.0
    exp, frac = (h >> 10) & 0x1F, h & 0x3FF
    if exp == 0:
        return sign * frac * 2.0**-24
    if exp == 31:
        return sign * float("inf") if frac == 0 else float("nan")
    return sign * (1 + frac / 1024) * 2.0 ** (exp - 15)


def reference_decode(data: bytes) -> dict:
    """Written from README §4.7: 16-byte LE header k u32, S f32, dLR f32, cmd u8, 3 pad; f16 body at 16."""
    k, S, dLR = struct.unpack_from("<Iff", data, 0)
    cmd, pad = data[12], data[13:16]
    halves = struct.unpack_from(f"<{(len(data) - 16) // 2}H", data, 16)
    return {"k": k, "S": S, "dLR": dLR, "cmd": cmd, "pad": pad, "values": np.array([half_to_float(h) for h in halves])}


def test_command_byte_enum_is_fixed():
    assert {c.name: int(c) for c in viz.CmdByte} == CMDS


@pytest.mark.parametrize("cmd", list(CMDS))
def test_viz_message_round_trips_through_reference_decoder(cmd):
    deviation = np.random.default_rng(1).normal(0, 0.5, EXPECTED_NODES).astype(np.float32)
    deviation[:4] = [0.0, -0.0, 1e-6, 60000.0]  # zero, signed zero, subnormal, large normal
    data = viz.encode_viz(123456, 1.25, -0.375, cmd, deviation)
    assert len(data) == 16 + 2 * EXPECTED_NODES
    out = reference_decode(data)
    assert (out["k"], out["S"], out["dLR"], out["cmd"], out["pad"]) == (123456, 1.25, -0.375, CMDS[cmd], b"\0\0\0")
    assert len(out["values"]) == EXPECTED_NODES
    np.testing.assert_allclose(out["values"], deviation, rtol=2**-11, atol=2**-24)
    np.testing.assert_array_equal(out["values"], deviation.astype(np.float16).astype(np.float64))


def test_limiter_holds_viz_hz_on_frame_time():
    limiter = viz.VizLimiter()
    frames_per_s = round(1 / DT_S)
    sent = [k for k in range(10 * frames_per_s) if limiter.due(k)]
    assert len(sent) == 10 * VIZ_HZ
    assert min(np.diff(sent)) * DT_S >= 1 / VIZ_HZ - 1e-9
    limiter = viz.VizLimiter()  # dropped frames never produce a burst
    sent = [k for k in range(0, 500, 3) if limiter.due(k)]
    assert min(np.diff(sent)) * DT_S >= 1 / VIZ_HZ - 1e-9


class VizStubEye(StubEye):
    def deviation(self):
        return np.linspace(-1, 1, EXPECTED_NODES, dtype=np.float32) * (self.steps % 7)


@pytest.fixture
def eye(monkeypatch):
    stub = VizStubEye(q=1.0)  # S crosses theta, so commands change during the run
    monkeypatch.setattr(reflex_server.app.state, "eye", stub, raising=False)
    # protocol tests use the default readout, independent of fitted bench/readout_weights.json
    monkeypatch.setattr(reflex_server, "READOUT_WEIGHTS", None)
    return stub


def run(tmp_path, monkeypatch, mode, reflex_on, ks):
    monkeypatch.setattr(reflex_server, "BENCH_FRAMES_DIR", tmp_path / "frames")
    monkeypatch.setattr(reflex_server, "CLOSED_LOOP_PATH", tmp_path / "closed_loop.jsonl")
    """Every message the client receives, in order; the layout first."""
    messages = []
    with TestClient(reflex_server.app).websocket_connect("/ws/reflex") as ws:
        if mode != Mode.LIVE:
            ws.send_text(json.dumps({"type": "episode.begin", "episode": 3, "params": {}}))
        for k in ks:
            ws.send_bytes(encode_frame(3, k, reflex_on, mode, pixels(k)))
        ws.send_text(json.dumps({"type": "end-of-test", "episode": 0}))  # its error reply ends the stream
        while "end-of-test" not in ((message := ws.receive()).get("text") or ""):
            if not (message.get("text") or "").startswith('{"ack"'):
                messages.append(message)
    return messages


def test_layout_is_sent_once_on_connect(tmp_path, monkeypatch, eye):
    first, *rest = run(tmp_path, monkeypatch, Mode.LIVE, True, range(3))
    layout = json.loads(first["text"])
    assert layout["type"] == "eye.layout" and layout["S_theta"] == reflex_server.THETA
    assert len(layout["node_type"]) == EXPECTED_NODES and len(layout["col_x"]) == 721
    assert not any(m.get("text") and "eye.layout" in m["text"] for m in rest)


def test_live_stream_sends_viz_at_viz_hz_after_each_command(tmp_path, monkeypatch, eye):
    ks = range(round(2 / DT_S))  # 2 s of frames
    messages = run(tmp_path, monkeypatch, Mode.LIVE, True, ks)[1:]
    binaries = [m["bytes"] for m in messages if m.get("bytes") is not None]
    assert len(binaries) == 2 * VIZ_HZ
    assert all(len(b) == 16 + 2 * EXPECTED_NODES for b in binaries)
    for before, after in zip(messages, messages[1:]):
        if after.get("bytes") is not None:  # header matches the command reply just before it
            reply, decoded = json.loads(before["text"]), reference_decode(after["bytes"])
            assert decoded["k"] == reply["k"] and decoded["cmd"] == CMDS[reply["cmd"]]
            assert decoded["S"] == pytest.approx(reply["S"], rel=1e-6)
            assert decoded["dLR"] == pytest.approx(reply["dLR"], rel=1e-6, abs=1e-12)
    assert [reference_decode(b)["k"] for b in binaries] == list(range(0, len(ks), round(1 / (VIZ_HZ * DT_S))))
    assert {json.loads(m["text"])["cmd"] for m in messages if m.get("text")} >= {"none", "brake"}


@pytest.mark.parametrize("mode", list(Mode))
@pytest.mark.parametrize("reflex_on", [False, True])
def test_viz_does_not_change_command_replies(tmp_path, monkeypatch, eye, mode, reflex_on):
    ks = list(range(round(HOVER_S / DT_S) + 10))
    with_viz = run(tmp_path / "a", monkeypatch, mode, reflex_on, ks)
    monkeypatch.setattr(viz.VizLimiter, "due", lambda self, k: False)
    without_viz = run(tmp_path / "b", monkeypatch, mode, reflex_on, ks)

    def replies(messages):
        out = [json.loads(m["text"]) for m in messages[1:] if m.get("text") is not None]
        return [{key: v for key, v in r.items() if key != "ms"} for r in out]

    assert replies(with_viz) == replies(without_viz)
    assert not any(m.get("bytes") for m in without_viz)
    assert any(m.get("bytes") for m in with_viz) == (mode == Mode.LIVE)

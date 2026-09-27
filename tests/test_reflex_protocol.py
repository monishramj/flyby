import json
import struct

from fastapi.testclient import TestClient
import numpy as np
import pytest

import reflex.server as reflex_server
from reflex.config import DT_S, FRAME_R, HOVER_S
from reflex.frames import FRAME_BYTES, FrameError, Mode, decode_frame, encode_frame


def pixels(seed=0):
    return np.random.default_rng(seed).integers(0, 256, (FRAME_R, FRAME_R), dtype=np.uint8)


def test_frame_round_trip_uses_documented_little_endian_layout():
    img = pixels()
    data = encode_frame(0x01020304, 7, True, Mode.BENCH_CLOSED, img, goal_bearing=0.5, goal_dist=2.0)
    assert len(data) == 20 + FRAME_R**2 == FRAME_BYTES
    assert data[:12] == bytes([4, 3, 2, 1, 7, 0, 0, 0, 1, 2, 0, 0])
    assert data[12:20] == struct.pack("<ff", 0.5, 2.0)
    frame = decode_frame(data)
    assert (frame.episode, frame.k, frame.reflex_on, frame.mode) == (0x01020304, 7, True, Mode.BENCH_CLOSED)
    assert (frame.goal_bearing, frame.goal_dist) == (0.5, 2.0)
    assert np.isnan(decode_frame(encode_frame(1, 0, True, Mode.LIVE, img)).goal_dist)
    np.testing.assert_array_equal(frame.pixels, img)


@pytest.mark.parametrize(
    "data,match",
    [
        (b"", "bytes"),
        (encode_frame(1, 0, False, Mode.LIVE, pixels())[:-1], "bytes"),
        (encode_frame(1, 0, False, Mode.LIVE, pixels()) + b"\0", "bytes"),
        (struct.pack("<IIBBHff", 1, 0, 2, 0, 0, 0, 1) + bytes(FRAME_R**2), "reflex_on"),
        (struct.pack("<IIBBHff", 1, 0, 1, 3, 0, 0, 1) + bytes(FRAME_R**2), "mode"),
        (struct.pack("<IIBBHff", 1, 0, 1, 0, 1, 0, 1) + bytes(FRAME_R**2), "pad"),
        (struct.pack("<IIBBHff", 1, 0, 1, 0, 0, 4.0, 1) + bytes(FRAME_R**2), "goal_bearing"),
        (struct.pack("<IIBBHff", 1, 0, 1, 0, 0, float("inf"), 1) + bytes(FRAME_R**2), "goal_bearing"),
        (struct.pack("<IIBBHff", 1, 0, 1, 0, 0, 0, -1) + bytes(FRAME_R**2), "goal_dist"),
    ],
    # short ids: raw frame bytes in test ids overflow Windows' 32,767-char env var limit
    ids=["empty", "short", "long", "reflex_on", "mode", "pad", "bearing_range", "bearing_inf", "dist_negative"],
)
def test_malformed_frames_are_rejected(data, match):
    with pytest.raises(FrameError, match=match):
        decode_frame(data)


class StubEye:
    """Test double for FlyEye: outward motion from the image centre scaled by q; counts resets."""

    def __init__(self, q=0.0):
        self.q, self.resets, self.steps = q, 0, 0
        x, y = reflex_server.COL_X, reflex_server.COL_Y
        horiz = np.abs(x) >= np.abs(y)
        self.pattern = np.stack([horiz & (x < 0), horiz & (x > 0), ~horiz & (y > 0), ~horiz & (y < 0)]).astype(float)

    def reset(self):
        self.resets += 1

    def step(self, frame):
        self.steps += 1
        return self.q * self.pattern, None

    def deviation(self):  # viz stream (Step 7.1); only its length and dtype matter here
        return np.zeros(len(reflex_server._LAYOUT["node_type"]), dtype=np.float32)


@pytest.fixture
def eye(monkeypatch):
    stub = StubEye()
    monkeypatch.setattr(reflex_server.app.state, "eye", stub, raising=False)
    # protocol tests use the default readout, independent of fitted bench/readout_weights.json
    monkeypatch.setattr(reflex_server, "READOUT_WEIGHTS", None)
    return stub


@pytest.fixture
def ws(tmp_path, monkeypatch, eye):
    monkeypatch.setattr(reflex_server, "BENCH_FRAMES_DIR", tmp_path / "frames")
    monkeypatch.setattr(reflex_server, "CLOSED_LOOP_PATH", tmp_path / "closed_loop.jsonl")
    with TestClient(reflex_server.app).websocket_connect("/ws/reflex") as socket:
        assert socket.receive_json()["type"] == "eye.layout"  # Step 7.1: sent once on connect
        yield socket


def receive_reply(ws):
    """Next JSON reply, skipping live-mode viz binaries (tested in test_reflex_viz.py)."""
    while (message := ws.receive()).get("text") is None:
        pass
    return json.loads(message["text"])


def send_frame(ws, episode, k, reflex_on, mode, seed=0):
    ws.send_bytes(encode_frame(episode, k, reflex_on, mode, pixels(seed)))
    return receive_reply(ws)


def send_msg(ws, **msg):
    ws.send_text(json.dumps(msg))
    return ws.receive_json()


@pytest.mark.parametrize("reflex_on", [False, True])
def test_live_frames_return_scores_and_commands(ws, eye, reflex_on):
    eye.q = 1.0  # S rises well above theta within a few frames
    hover = round(HOVER_S / DT_S)  # looming is ignored while the scene hovers
    ks = [0, hover, hover + 1, hover + 2]
    replies = [send_frame(ws, 5, k, reflex_on, Mode.LIVE) for k in ks]
    assert replies[0]["cmd"] == "none"
    replies = replies[1:]
    for k, reply in zip(ks[1:], replies):
        assert set(reply) == {"k", "cmd", "speed", "yaw_rate", "S", "dLR", "ms"} and reply["k"] == k
        assert reply["ms"] >= 0
    assert replies[-1]["S"] > reflex_server.THETA
    assert replies[-1]["cmd"] == ("brake" if reflex_on else "none")
    assert eye.resets == 1 and eye.steps == 4


def test_each_episode_resets_the_eye(ws, eye):
    send_frame(ws, 1, 0, True, Mode.LIVE)
    send_frame(ws, 1, 1, True, Mode.LIVE)
    send_frame(ws, 2, 0, True, Mode.LIVE)
    assert eye.resets == 2


def test_frames_needing_the_model_report_an_error_without_it(ws, monkeypatch):
    monkeypatch.setattr(reflex_server.app.state, "eye", None)
    with TestClient(reflex_server.app).websocket_connect("/ws/reflex") as socket:
        socket.receive_json()  # eye.layout
        assert "model not loaded" in send_frame(socket, 1, 0, True, Mode.LIVE)["error"]
        socket.send_text(json.dumps({"type": "episode.begin", "episode": 2, "params": {}}))
        socket.receive_json()
        assert send_frame(socket, 2, 0, True, Mode.BENCH_RECORD)["cmd"] == "none"


def test_sequence_and_episode_consistency(ws):
    assert send_frame(ws, 1, 4, True, Mode.LIVE)["cmd"] == "none"
    assert "k must increase" in send_frame(ws, 1, 4, True, Mode.LIVE)["error"]
    assert "cannot change" in send_frame(ws, 1, 5, False, Mode.LIVE)["error"]
    assert send_frame(ws, 2, 0, False, Mode.LIVE)["k"] == 0  # new live episode resets state


def test_bench_frames_must_be_bracketed(ws):
    assert "outside episode" in send_frame(ws, 1, 0, True, Mode.BENCH_CLOSED)["error"]
    assert send_msg(ws, type="episode.begin", episode=1, params={"seed": 3}) == {"ack": "episode.begin", "episode": 1}
    assert "outside episode" in send_frame(ws, 2, 0, True, Mode.BENCH_CLOSED)["error"]
    assert "still open" in send_msg(ws, type="episode.begin", episode=2, params={})["error"]
    assert "still open" in send_frame(ws, 9, 0, True, Mode.LIVE)["error"]
    assert "not open" in send_msg(ws, type="episode.end", episode=2, result={})["error"]


@pytest.mark.parametrize(
    "text,match",
    [
        ("not json", "invalid JSON"),
        ("[1]", "JSON object"),
        ('{"type": "episode.reset", "episode": 1}', "unknown message type"),
        ('{"type": "episode.begin", "episode": -1}', "u32"),
        ('{"type": "episode.begin", "episode": true}', "u32"),
        ('{"type": "episode.begin", "episode": 1, "params": []}', "params"),
    ],
)
def test_malformed_text_messages_keep_connection_open(ws, text, match):
    ws.send_text(text)
    assert match in ws.receive_json()["error"]
    assert send_frame(ws, 1, 0, False, Mode.LIVE)["cmd"] == "none"


def test_bench_record_stores_frames_and_metadata(ws, eye, tmp_path):
    send_msg(ws, type="episode.begin", episode=12, params={"seed": 42, "obstacle": "post"})
    for k in range(4):
        assert send_frame(ws, 12, k, True, Mode.BENCH_RECORD, seed=k) == {"k": k, "cmd": "none", "speed": None, "yaw_rate": None, "S": None, "dLR": None, "ms": pytest.approx(0, abs=1e3)}
    assert send_msg(ws, type="episode.end", episode=12, result={"collided": True}) == {"ack": "episode.end", "episode": 12}
    with np.load(tmp_path / "frames" / "12.npz") as saved:
        assert saved["frames"].shape == (4, FRAME_R, FRAME_R) and saved["frames"].dtype == np.uint8
        np.testing.assert_array_equal(saved["frames"][2], pixels(2))
        np.testing.assert_array_equal(saved["k"], [0, 1, 2, 3])
        assert bool(saved["reflex_on"])
        assert json.loads(str(saved["params"])) == {"seed": 42, "obstacle": "post"}
        assert json.loads(str(saved["result"])) == {"collided": True}
    assert not (tmp_path / "closed_loop.jsonl").exists()
    assert eye.steps == 0  # recording does not run the model


def test_bench_closed_appends_episode_results(ws, tmp_path):
    for episode, reflex_on in [(1, False), (2, True)]:
        send_msg(ws, type="episode.begin", episode=episode, params={"seed": 7})
        assert send_frame(ws, episode, 0, reflex_on, Mode.BENCH_CLOSED)["cmd"] == "none"
        send_msg(ws, type="episode.end", episode=episode, result={"collided": not reflex_on})
    lines = [json.loads(line) for line in (tmp_path / "closed_loop.jsonl").read_text().splitlines()]
    assert lines == [
        {"episode": 1, "reflex_on": False, "theta": reflex_server.THETA, "params": {"seed": 7}, "result": {"collided": True}},
        {"episode": 2, "reflex_on": True, "theta": reflex_server.THETA, "params": {"seed": 7}, "result": {"collided": False}},
    ]
    assert not (tmp_path / "frames").exists()


def test_empty_bench_episode_is_reported_and_closed(ws, tmp_path):
    send_msg(ws, type="episode.begin", episode=3, params={})
    assert "without frames" in send_msg(ws, type="episode.end", episode=3, result={})["error"]
    assert send_msg(ws, type="episode.begin", episode=4, params={})["ack"] == "episode.begin"

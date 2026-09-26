import json
import struct

from fastapi.testclient import TestClient
import numpy as np
import pytest

import reflex.server as reflex_server
from reflex.config import FRAME_R
from reflex.frames import FRAME_BYTES, FrameError, Mode, decode_frame, encode_frame


def pixels(seed=0):
    return np.random.default_rng(seed).integers(0, 256, (FRAME_R, FRAME_R), dtype=np.uint8)


def test_frame_round_trip_uses_documented_little_endian_layout():
    img = pixels()
    data = encode_frame(0x01020304, 7, True, Mode.BENCH_CLOSED, img)
    assert len(data) == 12 + FRAME_R**2 == FRAME_BYTES
    assert data[:12] == bytes([4, 3, 2, 1, 7, 0, 0, 0, 1, 2, 0, 0])
    frame = decode_frame(data)
    assert (frame.episode, frame.k, frame.reflex_on, frame.mode) == (0x01020304, 7, True, Mode.BENCH_CLOSED)
    np.testing.assert_array_equal(frame.pixels, img)


@pytest.mark.parametrize(
    "data,match",
    [
        (b"", "bytes"),
        (encode_frame(1, 0, False, Mode.LIVE, pixels())[:-1], "bytes"),
        (encode_frame(1, 0, False, Mode.LIVE, pixels()) + b"\0", "bytes"),
        (struct.pack("<IIBBH", 1, 0, 2, 0, 0) + bytes(FRAME_R**2), "reflex_on"),
        (struct.pack("<IIBBH", 1, 0, 1, 3, 0) + bytes(FRAME_R**2), "mode"),
        (struct.pack("<IIBBH", 1, 0, 1, 0, 1) + bytes(FRAME_R**2), "pad"),
    ],
)
def test_malformed_frames_are_rejected(data, match):
    with pytest.raises(FrameError, match=match):
        decode_frame(data)


@pytest.fixture
def ws(tmp_path, monkeypatch):
    monkeypatch.setattr(reflex_server, "BENCH_FRAMES_DIR", tmp_path / "frames")
    monkeypatch.setattr(reflex_server, "CLOSED_LOOP_PATH", tmp_path / "closed_loop.jsonl")
    with TestClient(reflex_server.app).websocket_connect("/ws/reflex") as socket:
        yield socket


def send_frame(ws, episode, k, reflex_on, mode, seed=0):
    ws.send_bytes(encode_frame(episode, k, reflex_on, mode, pixels(seed)))
    return ws.receive_json()


def send_msg(ws, **msg):
    ws.send_text(json.dumps(msg))
    return ws.receive_json()


@pytest.mark.parametrize("reflex_on", [False, True])
def test_live_frames_return_commands_without_fabricated_scores(ws, reflex_on):
    for k in range(3):
        reply = send_frame(ws, 5, k, reflex_on, Mode.LIVE)
        assert set(reply) == {"k", "cmd", "S", "dLR", "ms"}
        assert reply["k"] == k and reply["cmd"] == "none"
        assert reply["S"] is None and reply["dLR"] is None
        assert reply["ms"] >= 0


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


def test_bench_record_stores_frames_and_metadata(ws, tmp_path):
    send_msg(ws, type="episode.begin", episode=12, params={"seed": 42, "obstacle": "post"})
    for k in range(4):
        assert send_frame(ws, 12, k, True, Mode.BENCH_RECORD, seed=k)["cmd"] == "none"
    assert send_msg(ws, type="episode.end", episode=12, result={"collided": True}) == {"ack": "episode.end", "episode": 12}
    with np.load(tmp_path / "frames" / "12.npz") as saved:
        assert saved["frames"].shape == (4, FRAME_R, FRAME_R) and saved["frames"].dtype == np.uint8
        np.testing.assert_array_equal(saved["frames"][2], pixels(2))
        np.testing.assert_array_equal(saved["k"], [0, 1, 2, 3])
        assert bool(saved["reflex_on"])
        assert json.loads(str(saved["params"])) == {"seed": 42, "obstacle": "post"}
        assert json.loads(str(saved["result"])) == {"collided": True}
    assert not (tmp_path / "closed_loop.jsonl").exists()


def test_bench_closed_appends_episode_results(ws, tmp_path):
    for episode, reflex_on in [(1, False), (2, True)]:
        send_msg(ws, type="episode.begin", episode=episode, params={"seed": 7})
        assert send_frame(ws, episode, 0, reflex_on, Mode.BENCH_CLOSED)["cmd"] == "none"
        send_msg(ws, type="episode.end", episode=episode, result={"collided": not reflex_on})
    lines = [json.loads(line) for line in (tmp_path / "closed_loop.jsonl").read_text().splitlines()]
    assert lines == [
        {"episode": 1, "reflex_on": False, "params": {"seed": 7}, "result": {"collided": True}},
        {"episode": 2, "reflex_on": True, "params": {"seed": 7}, "result": {"collided": False}},
    ]
    assert not (tmp_path / "frames").exists()


def test_empty_bench_episode_is_reported_and_closed(ws, tmp_path):
    send_msg(ws, type="episode.begin", episode=3, params={})
    assert "without frames" in send_msg(ws, type="episode.end", episode=3, result={})["error"]
    assert send_msg(ws, type="episode.begin", episode=4, params={})["ack"] == "episode.begin"

"""Viz stream for the browser (README Step 7.1, §4.7 eye.layout and viz).

eye.layout: one JSON text message on connect, {"type": "eye.layout", ...layout, "S_theta": θ}.
viz: binary, live mode only, at most VIZ_HZ per episode, timed on frame time k·DT_S.
Header (16 bytes, little-endian): k u32, S f32, dLR f32, cmd u8, 3 zero pad bytes.
Body at byte offset 16: N float16 (little-endian) deviations from rest, native node order.
"""

from enum import IntEnum
import json
import struct

import numpy as np

from reflex.config import DT_S, VIZ_HEADER_BYTES, VIZ_HZ

VIZ_HEADER = struct.Struct("<IffB3x")
assert VIZ_HEADER.size == VIZ_HEADER_BYTES


class CmdByte(IntEnum):
    """Command byte in the viz header; values match the JSON reply's cmd strings."""

    none = 0
    brake = 1
    saccade_left = 2
    saccade_right = 3
    arrived = 4


def layout_message(layout: dict, theta: float) -> str:
    return json.dumps({"type": "eye.layout", **layout, "S_theta": theta})


def encode_viz(k: int, S: float, dLR: float, cmd: str, deviation: np.ndarray) -> bytes:
    body = np.ascontiguousarray(deviation, dtype="<f2").ravel()
    return VIZ_HEADER.pack(k, S, dLR, CmdByte[cmd]) + body.tobytes()


class VizLimiter:
    """At most `hz` messages per second of frame time. First frame of an episode is sent."""

    def __init__(self, hz: float = VIZ_HZ, dt: float = DT_S):
        self.period, self.dt = 1.0 / hz, dt
        self.next_t: float | None = None

    def due(self, k: int) -> bool:
        t = k * self.dt
        if self.next_t is not None and t < self.next_t - 1e-9:
            return False
        self.next_t = t + self.period
        return True

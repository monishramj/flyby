"""Binary camera-frame decoding and validation for /ws/reflex (README §4.7, extended).

Header (little-endian, 20 bytes): episode u32, k u32, reflex_on u8, mode u8, pad u16,
goal_bearing f32 (radians, + = goal to the right of the camera axis), goal_dist f32
(metres; NaN = no goal). Body: FRAME_R² grayscale bytes, row 0 = image top.
"""

from dataclasses import dataclass
import math
from enum import IntEnum
import struct

import numpy as np

from reflex.config import FRAME_HEADER_BYTES, FRAME_R

HEADER = struct.Struct("<IIBBHff")
FRAME_BYTES = FRAME_HEADER_BYTES + FRAME_R * FRAME_R
assert HEADER.size == FRAME_HEADER_BYTES


class Mode(IntEnum):
    LIVE = 0
    BENCH_RECORD = 1
    BENCH_CLOSED = 2


class FrameError(ValueError):
    pass


@dataclass(frozen=True)
class Frame:
    episode: int
    k: int
    reflex_on: bool
    mode: Mode
    pixels: np.ndarray  # (FRAME_R, FRAME_R) uint8, row 0 = top of the image
    goal_bearing: float = 0.0
    goal_dist: float = math.nan


def decode_frame(data: bytes) -> Frame:
    if len(data) != FRAME_BYTES:
        raise FrameError(f"frame must be {FRAME_BYTES} bytes, got {len(data)}")
    episode, k, reflex_on, mode, pad, bearing, dist = HEADER.unpack_from(data)
    if reflex_on not in (0, 1):
        raise FrameError(f"reflex_on must be 0 or 1, got {reflex_on}")
    if mode not in Mode._value2member_map_:
        raise FrameError(f"unknown mode {mode}")
    if pad != 0:
        raise FrameError("header pad must be zero")
    if not (math.isfinite(bearing) and abs(bearing) <= math.pi + 1e-6):
        raise FrameError("goal_bearing must be finite radians in [-pi, pi]")
    if not (math.isnan(dist) or (math.isfinite(dist) and dist >= 0)):
        raise FrameError("goal_dist must be a non-negative distance or NaN")
    pixels = np.frombuffer(data, dtype=np.uint8, offset=FRAME_HEADER_BYTES).reshape(FRAME_R, FRAME_R)
    return Frame(episode, k, bool(reflex_on), Mode(mode), pixels, bearing, dist)


def encode_frame(episode: int, k: int, reflex_on: bool, mode: Mode, pixels: np.ndarray,
                 goal_bearing: float = 0.0, goal_dist: float = math.nan) -> bytes:
    pixels = np.ascontiguousarray(pixels, dtype=np.uint8)
    if pixels.shape != (FRAME_R, FRAME_R):
        raise FrameError(f"pixels must be {FRAME_R}x{FRAME_R}, got {pixels.shape}")
    return HEADER.pack(episode, k, int(reflex_on), int(mode), 0, goal_bearing, goal_dist) + pixels.tobytes()

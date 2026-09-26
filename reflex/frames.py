"""Binary camera-frame decoding and validation for /ws/reflex (README §4.7)."""

from dataclasses import dataclass
from enum import IntEnum
import struct

import numpy as np

from reflex.config import FRAME_HEADER_BYTES, FRAME_R

HEADER = struct.Struct("<IIBBH")  # episode, k, reflex_on, mode, pad; little-endian
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


def decode_frame(data: bytes) -> Frame:
    if len(data) != FRAME_BYTES:
        raise FrameError(f"frame must be {FRAME_BYTES} bytes, got {len(data)}")
    episode, k, reflex_on, mode, pad = HEADER.unpack_from(data)
    if reflex_on not in (0, 1):
        raise FrameError(f"reflex_on must be 0 or 1, got {reflex_on}")
    if mode not in Mode._value2member_map_:
        raise FrameError(f"unknown mode {mode}")
    if pad != 0:
        raise FrameError("header pad must be zero")
    pixels = np.frombuffer(data, dtype=np.uint8, offset=FRAME_HEADER_BYTES).reshape(FRAME_R, FRAME_R)
    return Frame(episode, k, bool(reflex_on), Mode(mode), pixels)


def encode_frame(episode: int, k: int, reflex_on: bool, mode: Mode, pixels: np.ndarray) -> bytes:
    pixels = np.ascontiguousarray(pixels, dtype=np.uint8)
    if pixels.shape != (FRAME_R, FRAME_R):
        raise FrameError(f"pixels must be {FRAME_R}x{FRAME_R}, got {pixels.shape}")
    return HEADER.pack(episode, k, int(reflex_on), int(mode), 0) + pixels.tobytes()

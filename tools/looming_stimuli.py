"""Synthetic camera clips for comparing looming readouts (x right, y up, row 0 = top).

Disc and texture clips: HOLD_S of the first frame held still, then motion.
Corridor clips: the drone is already flying at SPEED_MPS from frame 0 (after the
eye's gray warm-up); obstacles start at post_z0. `hold` marks where scoring starts.
Pinhole camera; `fov_deg` sets the horizontal and vertical field of view.
Clips carry ground truth: whether the path collides, and the contact frame.
"""

from dataclasses import dataclass

import numpy as np

from reflex import config as cfg

HOLD_S = 1.0
SPEED_MPS = 3.0
WALL_X_M = 1.5          # corridor half-width
WALL_Z_MAX_M = 12.0     # farther points render as mid-gray
CAMERA_H_M = 1.0        # camera height above the floor
CHECK_M = 0.5           # wall checker size
POST_RADIUS_M = 0.05    # README carport posts are 0.1 m
CONTACT_M = cfg.DRONE_RADIUS_M


@dataclass
class Clip:
    name: str
    frames: list[np.ndarray]
    hold: int
    collides: bool
    contact_k: int | None  # frame index of contact (collision truth), if any
    note: str


def _grid(fov_deg: float):
    x = np.linspace(-1, 1, cfg.FRAME_R)
    x, y = np.meshgrid(x, -x)
    return x * np.tan(np.radians(fov_deg) / 2), y * np.tan(np.radians(fov_deg) / 2)  # ray slopes


def _corridor(px, py, travelled):
    """Checkered side walls and floor (camera CAMERA_H_M above it); far points are gray."""
    img = np.full(px.shape, 128.0)
    z_wall = np.where(np.abs(px) > 1e-6, WALL_X_M / np.maximum(np.abs(px), 1e-6), np.inf)
    z_floor = np.where(py < -1e-6, CAMERA_H_M / np.maximum(-py, 1e-6), np.inf)
    z = np.minimum(z_wall, z_floor)
    ok = z < WALL_Z_MAX_M
    floor = ok & (z_floor <= z_wall)
    wall = ok & ~floor
    u = np.where(floor, px * z, py * z)  # floor: lateral X; wall: height Y
    zw = z + travelled
    check = (np.floor(zw / CHECK_M) + np.floor(u / CHECK_M)) % 2 == 0
    img[wall] = np.where(check[wall], 70, 190)
    img[floor] = np.where(check[floor], 95, 165)
    return img, z


def corridor_clip(fov_deg=90.0, post_x=None, post_z0=6.0, box_half_w=None, box_half_h=None, name=None, corridor=True,
                  speed=SPEED_MPS):
    """Forward flight; optional post (or box, full height unless box_half_h) at lateral post_x."""
    px, py = _grid(fov_deg)
    dt, v = cfg.DT_S, speed
    half_w = box_half_w if box_half_w is not None else POST_RADIUS_M
    collides = post_x is not None and abs(post_x) < half_w + CONTACT_M
    frames, k = [], 0
    n_total = round((post_z0 - CONTACT_M) / (v * dt)) if post_x is not None else round(6.0 / v / dt)
    for k in range(n_total):
        travelled = v * k * dt
        img, zwall = _corridor(px, py, travelled) if corridor else (np.full(px.shape, 128.0), np.full(px.shape, np.inf))
        if post_x is not None:
            zp = post_z0 - travelled
            hit = (np.abs(px * zp - post_x) <= half_w) & (zp < zwall)
            if box_half_h is not None:
                hit &= np.abs(py * zp) <= box_half_h
            img[hit] = 20
        frames.append(img.astype(np.uint8))
    hold = round(0.4 / dt)  # gray→scene onset settles before scoring starts
    contact = n_total if collides else None
    kind = "debris" if box_half_h is not None else "box" if box_half_w is not None else "post"
    label = name or ("corridor" if post_x is None else f"{kind} x={post_x:+.2f}m")
    note = f"fov {fov_deg:.0f}°, {v} m/s" + (", corridor walls" if corridor else ", plain gray")
    return Clip(label, frames, hold, collides, contact, note)


def disc_clip(cx=0.0, d0=3.0, r0=0.1, name=None):
    """Black disc of fixed size approaching head-on (legacy Step 6.4 stimulus)."""
    x = np.linspace(-1, 1, cfg.FRAME_R)
    x, y = np.meshgrid(x, -x)
    frames, k = [], 0
    while (r := r0 * d0 / (d0 - SPEED_MPS * k * cfg.DT_S)) < 1.0:
        img = np.full(x.shape, 128, np.uint8)
        img[(x - cx) ** 2 + y**2 <= r**2] = 0
        frames.append(img)
        k += 1
    hold = round(HOLD_S / cfg.DT_S)
    return Clip(name or f"disc cx={cx:+.1f}", [frames[0]] * hold + frames, hold, True,
                hold + round(d0 / SPEED_MPS / cfg.DT_S), "disc radius ∝ 1/distance")


def texture_clip(px_per_frame=1, n=100):
    rng = np.random.default_rng(0)
    base = rng.integers(0, 2, (cfg.FRAME_R // 4, cfg.FRAME_R // 2)).repeat(4, 0).repeat(4, 1) * 255
    frames = [np.roll(base, px_per_frame * k, axis=1)[:, : cfg.FRAME_R].astype(np.uint8) for k in range(n)]
    hold = round(HOLD_S / cfg.DT_S)
    return Clip("texture sliding right", [frames[0]] * hold + frames, hold, False, None, "50 px/s")


def standard_clips(fov_deg=90.0, speed=SPEED_MPS) -> list[Clip]:
    return [
        disc_clip(0.0, name="disc head-on"),
        disc_clip(-0.5, name="disc left"),
        texture_clip(),
        corridor_clip(fov_deg, speed=speed),
        corridor_clip(fov_deg, speed=speed, post_x=0.0),
        corridor_clip(fov_deg, speed=speed, post_x=-0.2),
        corridor_clip(fov_deg, speed=speed, post_x=0.2),
        corridor_clip(fov_deg, speed=speed, post_x=-0.8),
        corridor_clip(fov_deg, speed=speed, post_x=0.0, box_half_w=0.4),
        corridor_clip(fov_deg, speed=speed, post_x=-0.5, box_half_w=0.4),
        corridor_clip(fov_deg, speed=speed, post_x=0.0, box_half_w=0.3, box_half_h=0.3),
        corridor_clip(fov_deg, speed=speed, post_x=-0.4, box_half_w=0.3, box_half_h=0.3),
    ]

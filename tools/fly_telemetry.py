"""Measured fly-reflex telemetry for slides: real pretrained flyvis eye on synthetic approach clips.

Each clip: 1 s hover (first frame held), then straight flight at NAV_CRUISE_MPS toward an
obstacle. Every frame goes through the same path as reflex.server (FlyEye → Readout →
Controller) and is logged. Open loop: a brake does not stop the clip, so this measures
detection timing, not avoidance. Simulation only.

Run: uv run --extra fly python -m tools.fly_telemetry   → results/fly_telemetry/
"""

import csv
import json
import time

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from reflex import config as cfg
from reflex.controller import Controller, load_theta
from reflex.hexeye import FlyEye, load_layout
from reflex.looming import Cone, Readout, load_weights
from tools.looming_stimuli import corridor_clip

OUT = cfg.ROOT / "results" / "fly_telemetry"
V = cfg.NAV_CRUISE_MPS
Z0 = 6.0
HOVER = round(cfg.HOVER_S / cfg.DT_S)
CLIPS = {  # name: corridor_clip kwargs
    "clear": {},
    "debris ahead": {"post_x": 0.0, "box_half_w": 0.3, "box_half_h": 0.3},
    "post ahead": {"post_x": 0.0},
    "debris offset 0.4 m": {"post_x": -0.4, "box_half_w": 0.3, "box_half_h": 0.3},
    "debris passing 1.2 m aside": {"post_x": -1.2, "box_half_w": 0.3, "box_half_h": 0.3},  # no contact: must not brake
}
N_BINS = 12
INK, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"
COLORS = {"clear": "#8a8984", "debris ahead": "#2a78d6", "post ahead": "#eb6834", "debris offset 0.4 m": "#1baf7a",
          "debris passing 1.2 m aside": "#4a3aa7"}


def run(eye, layout, theta):
    col_x, col_y = np.asarray(layout["col_x"]), np.asarray(layout["col_y"])
    weights = load_weights()
    cone = Cone(col_x, col_y, float(weights["cone"]["sigma"]) if weights else 0.3)
    ecc = np.hypot(col_x, col_y)
    edges = np.linspace(0, ecc.max() + 1e-9, N_BINS + 1)
    bin_of = np.digitize(ecc, edges) - 1
    rows, heat = [], {}
    for name, kw in CLIPS.items():
        clip = corridor_clip(90.0, post_z0=Z0, speed=V, corridor=False, **kw)  # plain gray: the checker corridor is off-distribution for the fitted readout
        frames = [clip.frames[0]] * HOVER + clip.frames
        eye.reset()
        readout, ctrl = Readout(col_x, col_y, weights=weights), Controller(theta)
        h = []
        for k, f in enumerate(frames):
            t0 = time.perf_counter()
            drive, _ = eye.step(f)
            S, dLR = readout.update(drive)
            cmd = ctrl.step(k, S, dLR, True)  # no goal: pure reflex
            ms = (time.perf_counter() - t0) * 1000
            radial = cone.radial(drive)  # outward − inward T4/T5 motion per column
            h.append([radial[bin_of == b].mean() for b in range(N_BINS)])
            flown = max(k - HOVER, 0) * V * cfg.DT_S
            has_obstacle = clip.collides
            rows.append({
                "clip": name, "k": k, "t_s": round(k * cfg.DT_S, 3),
                "dist_to_obstacle_m": round(Z0 - flown, 3) if has_obstacle else "",
                "time_to_contact_s": round((Z0 - cfg.DRONE_RADIUS_M - flown) / V, 3) if has_obstacle else "",
                "t4t5_drive_total": round(float(drive.sum()), 4), "S": round(S, 4), "dLR": round(dLR, 4),
                "pathway": readout.pathway, "cmd": cmd["cmd"], "speed_cmd_mps": cmd["speed"],
                "yaw_cmd_dps": cmd["yaw_rate"], "compute_ms": round(ms, 2),
            })
        heat[name] = np.array(h)
        print(f"{name}: {len(frames)} frames", flush=True)
    return rows, heat, edges


def summarize(rows, theta):
    need = V / cfg.A_BRAKE_MPS2 + 0.04
    out = {"theta": theta, "speed_mps": V, "frame_hz": cfg.FRAME_HZ, "required_warning_s": round(need, 3),
           "model": cfg.FLYVIS_MODEL, "clips": {}}
    for name in CLIPS:
        r = [x for x in rows if x["clip"] == name]
        brakes = [x for x in r if x["cmd"] == "brake"]
        first = brakes[0] if brakes else None
        ms = np.array([x["compute_ms"] for x in r])
        c = {"frames": len(r), "duration_s": round(len(r) * cfg.DT_S, 2),
             "peak_S": max(x["S"] for x in r), "first_brake_t_s": first and first["t_s"],
             "compute_ms_median": round(float(np.median(ms)), 2), "compute_ms_p95": round(float(np.percentile(ms, 95)), 2)}
        if first and first["time_to_contact_s"] != "":
            c["warning_s"] = first["time_to_contact_s"]
            c["dist_at_brake_m"] = first["dist_to_obstacle_m"]
            c["in_time"] = first["time_to_contact_s"] >= need
        out["clips"][name] = c
    return out


def style(ax):
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(GRID)
    ax.tick_params(colors=MUTED, labelsize=9)
    ax.grid(axis="y", color=GRID, lw=0.8)
    ax.set_axisbelow(True)


def fig_timeline(rows, heat, edges, theta, name, path):
    r = [x for x in rows if x["clip"] == name]
    t = np.array([x["t_s"] for x in r])
    fig, axes = plt.subplots(3, 1, figsize=(10, 7), sharex=True, gridspec_kw={"height_ratios": [2.2, 1.3, 1]})
    ax = axes[0]
    vmax = np.percentile(np.abs(heat[name]), 99)
    im = ax.imshow(np.clip(heat[name].T, 0, None), aspect="auto", origin="lower", cmap="Blues", vmin=0, vmax=vmax,
                   extent=[t[0], t[-1] + cfg.DT_S, edges[0], edges[-1]])
    ax.set_ylabel("distance from\nimage centre", color=MUTED, fontsize=9)
    ax.set_title(f"Fly eye T4/T5 outward motion, per eccentricity band — {name}", loc="left", color=INK, fontsize=11)
    cb = fig.colorbar(im, cax=ax.inset_axes([1.005, 0, 0.012, 1]))  # inset: keeps x aligned with the panels below
    cb.set_label("outward − inward drive (raw)", color=MUTED, fontsize=8)
    cb.ax.tick_params(labelsize=7)
    ax = axes[1]
    style(ax)
    ax.plot(t, [x["S"] for x in r], color="#2a78d6", lw=2)
    ax.axhline(theta, color=MUTED, lw=1, ls="--")
    ax.text(t[1], theta, f" brake threshold θ={theta:.2f}", color=MUTED, fontsize=8, va="bottom")
    ax.set_ylabel("looming score S", color=MUTED, fontsize=9)
    ax = axes[2]
    style(ax)
    ax.step(t, [x["speed_cmd_mps"] for x in r], where="post", color=INK, lw=2)
    ax.set_ylabel("speed cmd (m/s)", color=MUTED, fontsize=9)
    ax.set_xlabel("time (s)", color=MUTED, fontsize=9)
    brakes = [x["t_s"] for x in r if x["cmd"] == "brake"]
    ttc = [x for x in r if x["time_to_contact_s"] != "" and x["time_to_contact_s"] <= 0]
    for a in axes:
        if brakes:
            a.axvline(brakes[0], color="#e34948", lw=1.2)
        if ttc:
            a.axvline(ttc[0]["t_s"], color=INK, lw=1.2, ls=":")
        a.axvspan(0, cfg.HOVER_S, color=GRID, alpha=0.35, lw=0)
    if brakes:
        axes[2].text(brakes[0], 0.2, " first brake", color="#e34948", fontsize=8)
    if ttc:
        axes[2].text(ttc[0]["t_s"], 0.8, " contact\n (if it hadn't braked)", color=INK, fontsize=8)
    axes[2].text(0.03, 0.6, "hover: scene held still,\nlooming ignored", color=MUTED, fontsize=8)
    fig.text(0.01, 0.005, "Simulation. flyvis pretrained eye (flow/0000/000), 50 Hz, 1.5 m/s, open loop; S from engineered LPLC2-style layer.",
             color=MUTED, fontsize=7)
    fig.tight_layout(rect=(0, 0.02, 0.94, 1))
    fig.savefig(path, dpi=200)
    plt.close(fig)


def fig_compare(rows, summary, theta, path):
    fig, (ax, bx) = plt.subplots(1, 2, figsize=(11, 4.2), gridspec_kw={"width_ratios": [1.6, 1]})
    style(ax)
    for name in CLIPS:
        r = [x for x in rows if x["clip"] == name and x["k"] >= HOVER]
        ax.plot([x["t_s"] - cfg.HOVER_S for x in r], [x["S"] for x in r], color=COLORS[name], lw=2, label=name)
    ax.axhline(theta, color=MUTED, lw=1, ls="--")
    ax.text(0, theta, " θ", color=MUTED, fontsize=9, va="bottom")
    ax.set_xlabel("time since takeoff (s)", color=MUTED, fontsize=9)
    ax.set_ylabel("looming score S", color=MUTED, fontsize=9)
    ax.set_title("Looming score by scenario", loc="left", color=INK, fontsize=11)
    ax.legend(frameon=False, fontsize=8, labelcolor=INK)
    style(bx)
    hits = [n for n in CLIPS if "warning_s" in summary["clips"][n]]
    y = np.arange(len(hits))
    w = [summary["clips"][n]["warning_s"] for n in hits]
    bx.barh(y, w, color=[COLORS[n] for n in hits], height=0.5)
    for i, v in enumerate(w):
        bx.text(v, i, f" {v:.2f} s", va="center", color=INK, fontsize=9)
    need = summary["required_warning_s"]
    bx.axvline(need, color="#e34948", lw=1.2, ls="--")
    bx.text(need, -0.45, f" needed to stop: {need:.2f} s", color="#e34948", fontsize=8)
    bx.set_yticks(y, hits)
    bx.invert_yaxis()
    bx.grid(axis="y", visible=False)
    bx.grid(axis="x", color=GRID, lw=0.8)
    bx.set_xlabel("warning before contact (s)", color=MUTED, fontsize=9)
    bx.set_title("Brake warning time", loc="left", color=INK, fontsize=11)
    safe = [n for n in CLIPS if "warning_s" not in summary["clips"][n]]
    fb = ", ".join(f"{n}: {'no brake' if summary['clips'][n]['first_brake_t_s'] is None else 'FALSE BRAKE'}" for n in safe)
    fig.text(0.01, 0.01, f"Controls — {fb}. "
             "Simulation, 1.5 m/s, 50 Hz, open loop.", color=MUTED, fontsize=7)
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(path, dpi=200)
    plt.close(fig)


def fig_latency(rows, path):
    ms = np.array([x["compute_ms"] for x in rows])
    budget = 1000 / cfg.FRAME_HZ
    fig, ax = plt.subplots(figsize=(7, 3.6))
    style(ax)
    ax.hist(ms, bins=np.arange(0, budget + 1, 0.25), color="#2a78d6", edgecolor="white", linewidth=0.5)
    ax.axvline(budget, color="#e34948", lw=1.2, ls="--")
    ax.text(budget, ax.get_ylim()[1] * 0.9, f" 50 Hz budget {budget:.0f} ms", color="#e34948", fontsize=8)
    ax.set_xlabel("per-frame compute: eye (45,669 cells) + readout + controller (ms)", color=MUTED, fontsize=9)
    ax.set_ylabel("frames", color=MUTED, fontsize=9)
    ax.set_title(f"Reflex latency on CPU — median {np.median(ms):.1f} ms, p95 {np.percentile(ms, 95):.1f} ms, "
                 f"{(ms <= budget).mean():.0%} within budget", loc="left", color=INK, fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=200)
    plt.close(fig)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    theta, calibrated = load_theta()
    layout = load_layout()
    eye = FlyEye("cpu", layout)
    rows, heat, edges = run(eye, layout, theta)
    with open(OUT / "telemetry.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    summary = summarize(rows, theta)
    summary["theta_calibrated"] = calibrated
    summary["total_frames"] = len(rows)
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    fig_timeline(rows, heat, edges, theta, "debris ahead", OUT / "fig1_debris_timeline.png")
    fig_compare(rows, summary, theta, OUT / "fig2_scenarios.png")
    fig_latency(rows, OUT / "fig3_latency.png")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()

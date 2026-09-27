# Simulation backup clips

Actual inspect.html flights, seed 0, 90-degree camera, reflex on, CPU PyTorch.
MP4 files preserve capture timing and add a final-frame hold and visible simulation caption.
JSON sidecars contain the measured outcomes and observed HUD state changes.

- debris_0_on.mp4: brake, saccade left, entry and target reached.
- clear_0_on.mp4: entry and target reached.
- beam_0_on.mp4: entry reached, target collided. This is the known failure case.

These are demo captures, not a held-out benchmark. Do not replace the detection
numbers with these three selected flights. The rendering fix draws the chase
view even when the lockstep reflex is slower than real time.

To capture again: run the reflex and Vite, run `python -m tools.record_inspection`,
open `/inspect.html?record=1&scenario=debris&seed=0`, wait for READY, and press Fly.
The collector binds only to 127.0.0.1:8002 and saves raw WebM plus measured JSON.
Use ffmpeg to encode H.264/yuv420p MP4 and add a visible simulation caption.

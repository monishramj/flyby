// Optional backup capture for inspect.html?record=1. The local collector is
// tools.record_inspection; nothing is uploaded to an external service.
import type { InspectOutcome } from './scene/flight';

export function recordInspection(host: HTMLElement, name: string) {
  const view = host.querySelector<HTMLCanvasElement>('canvas.view')!;
  const stream = view.captureStream(30);
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('This browser cannot record WebM.');
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 });
  const chunks: Blob[] = [];
  const timeline: { wall_s: number; state: string; hud: string }[] = [];
  const started = performance.now();
  let frame = 0;
  const sample = () => {
    const state = host.querySelector('.state')?.textContent ?? 'starting';
    if (timeline.at(-1)?.state !== state) timeline.push({
      wall_s: (performance.now() - started) / 1000,
      state, hud: host.querySelector('.hud')?.textContent ?? '',
    });
    frame = requestAnimationFrame(sample);
  };
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.start(); sample();
  return async (outcome: InspectOutcome) => {
    // Hold the final frame briefly so the outcome is visible in the backup.
    await new Promise(resolve => window.setTimeout(resolve, 1200));
    const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
    recorder.stop(); await stopped;
    cancelAnimationFrame(frame); stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(chunks, { type: mimeType });
    const save = async (suffix: string, body: BodyInit) => {
      const response = await fetch(`http://127.0.0.1:8002/${name}.${suffix}`, { method: 'POST', body });
      if (!response.ok) throw new Error(`Recording collector returned ${response.status}`);
    };
    await save('webm', blob);
    await save('json', JSON.stringify({ label: 'simulation', name, mimeType,
      wall_s: (performance.now() - started) / 1000, bytes: blob.size, outcome, timeline }));
    return blob.size;
  };
}

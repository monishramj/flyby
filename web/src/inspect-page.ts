// Standalone development page for the close-in inspection (the same code the mission UI
// calls on inspect.request), with the live 3D connectome view beside it.
import { SCENARIOS, type Scenario } from './scene/inspect';
import { runInspection } from './scene/flight';
import { mountLiveConnectome } from './flyviz/live';
import { recordInspection } from './inspect-recording';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scenarioSel = $<HTMLSelectElement>('scenario');
for (const s of SCENARIOS) scenarioSel.add(new Option(s.replace('_', ' '), s));
const query = new URLSearchParams(location.search);
if (SCENARIOS.includes(query.get('scenario') as Scenario)) scenarioSel.value = query.get('scenario')!;
if (query.has('seed')) $<HTMLInputElement>('seed').value = query.get('seed')!;

// Built now, before any flight; the flight never waits on it.
const live = mountLiveConnectome($<HTMLDivElement>('brain'));
(window as unknown as { flybyLive: typeof live }).flybyLive = live;

$<HTMLButtonElement>('start').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('start');
  button.disabled = true;
  const flight = runInspection($<HTMLDivElement>('stage'), {
    lead_id: `dev-${Date.now()}`,
    scenario: scenarioSel.value as Scenario,
    seed: Number($<HTMLInputElement>('seed').value) || 0,
    fovDeg: Number($<HTMLSelectElement>('fov').value),
    reflexOn: $<HTMLInputElement>('reflex').checked,
    person: $<HTMLInputElement>('person').checked,
    maxWallS: 30,
  });
  let finishRecording: ReturnType<typeof recordInspection> | undefined;
  if (query.get('record') === '1') {
    try {
      finishRecording = recordInspection($('stage'), `${scenarioSel.value}_${Number($<HTMLInputElement>('seed').value) || 0}_${$<HTMLInputElement>('reflex').checked ? 'on' : 'off'}`);
    } catch (error) { $('error').textContent = `Recording unavailable: ${String(error)}`; }
  }
  const outcome = await flight;
  $<HTMLPreElement>('result').textContent = `inspect.result → ${JSON.stringify(outcome, null, 1)}`;
  if (!outcome.reflex_ok) $<HTMLParagraphElement>('error').textContent = 'Reflex not reachable: start it with uv run --extra fly python -m reflex.server';
  if (finishRecording) {
    try {
      const bytes = await finishRecording(outcome);
      $('result').textContent += `\nSaved simulation recording (${bytes} bytes) to the local collector.`;
    } catch (error) { $('error').textContent = `Recording save failed: ${String(error)}`; }
  }
  button.disabled = false;
});

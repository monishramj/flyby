// Standalone development page for the close-in inspection (the same code the mission UI
// calls on inspect.request).
import { SCENARIOS, type Scenario } from './scene/inspect';
import { runInspection } from './scene/flight';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const scenarioSel = $<HTMLSelectElement>('scenario');
for (const s of SCENARIOS) scenarioSel.add(new Option(s.replace('_', ' '), s));

$<HTMLButtonElement>('start').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('start');
  button.disabled = true;
  const outcome = await runInspection($<HTMLDivElement>('stage'), {
    lead_id: `dev-${Date.now()}`,
    scenario: scenarioSel.value as Scenario,
    seed: Number($<HTMLInputElement>('seed').value) || 0,
    fovDeg: Number($<HTMLSelectElement>('fov').value),
    reflexOn: $<HTMLInputElement>('reflex').checked,
    person: $<HTMLInputElement>('person').checked,
    maxWallS: 30,
  });
  $<HTMLPreElement>('result').textContent = `inspect.result → ${JSON.stringify(outcome, null, 1)}`;
  if (!outcome.reflex_ok) $<HTMLParagraphElement>('error').textContent = 'Reflex not reachable: start it with uv run --extra fly python -m reflex.server';
  button.disabled = false;
});

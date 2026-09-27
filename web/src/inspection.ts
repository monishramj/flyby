import { mountLiveConnectome } from './flyviz/live';
import { runInspection, type InspectOutcome } from './scene/flight';
import { store, subscribe } from './store';
import { onInspectionRequest, send, type InspectionRequest } from './ws';

const AUTO_CLOSE_MS = 2500;

/** One visible flight per browser; busy requests retain the mission's timer. */
export function mountInspectionPanel(options: { maxWallS?: number } = {}) {
  const panel = document.createElement('section');
  panel.className = 'inspection-panel';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Close-in inspection');
  panel.innerHTML = `<header><h2>Close-in inspection</h2><button class="close">Close</button></header>
    <p class="inspection-status" role="status"></p>
    <div class="inspection-views"><div class="inspection-flight"></div><div class="inspection-brain"></div></div>`;
  document.body.append(panel);
  const status = panel.querySelector<HTMLElement>('.inspection-status')!;
  const host = panel.querySelector<HTMLElement>('.inspection-flight')!;
  const close = panel.querySelector<HTMLButtonElement>('.close')!;
  close.onclick = () => { panel.hidden = true; };
  // Geometry loads before the first request; the view resizes when opened.
  const live = mountLiveConnectome(panel.querySelector<HTMLElement>('.inspection-brain')!);
  let busy = false;
  let activeRun = '';
  let invalidated = false;
  subscribe(type => {
    if (busy && ((type === 'mission.snapshot' && store.snapshot?.run_id !== activeRun)
      || (type === 'connection' && !store.connected))) invalidated = true;
  });

  async function inspect(request: InspectionRequest) {
    const snapshot = store.snapshot;
    if (busy || !snapshot || !store.connected) return;
    const lead = snapshot.leads.find(item => item.lead_id === request.lead_id);
    if (lead?.status !== 'inspecting') return;
    busy = true; invalidated = false; activeRun = snapshot.run_id;
    panel.hidden = false; close.disabled = true;
    status.textContent = `${request.lead_id} · flying with the local reflex`;
    const started = performance.now();
    const vizBefore = live.stats.vizShown;
    // The mission sends maxWallS 2 s under its INSPECT_HOVER_S truth fallback, so this answer lands first.
    const requestedCap = request.maxWallS ?? options.maxWallS ?? 27;
    const maxWallS = Number.isFinite(requestedCap) && requestedCap > 0 ? requestedCap : 27;
    let sent = false;
    const finish = (outcome: Pick<InspectOutcome, 'reached' | 'collided' | 'found'>, detail: string) => {
      if (sent) return;
      sent = true;
      const current = store.snapshot?.leads.find(item => item.lead_id === request.lead_id);
      if (invalidated || store.snapshot?.run_id !== activeRun || !store.connected || current?.status !== 'inspecting') {
        status.textContent = `${request.lead_id} · result discarded: mission changed or already resolved.`;
        return;
      }
      send({ type: 'inspect.result', payload: { lead_id: request.lead_id, ...outcome } });
      status.textContent = `${request.lead_id} · ${outcome.reached && !outcome.collided ? 'target reached' : 'inspection incomplete — needs a human'} · ${detail}`;
      // Render measured evidence in the panel; never infer a reflex rate from flight frames.
      status.textContent += ` · ${((performance.now() - started) / 1000).toFixed(2)} s wall · ${live.stats.vizShown - vizBefore} live activity updates`;
    };
    // Also bounds socket connection / render failure; runInspection's wall cap starts later.
    const deadline = window.setTimeout(() => finish({ reached: false, collided: false, found: null }, 'deadline reached'), (maxWallS + 0.5) * 1000);
    try {
      // Always debris for the demo: the reflex's strongest case (20/20 held out); the lead's seed still varies the drop.
      const outcome = await runInspection(host, { ...request, scenario: 'debris', maxWallS });
      const route = outcome.waypoints.map(({ id, status }) => `${id}: ${status}`).join(' → ');
      finish({ reached: outcome.reached, collided: outcome.collided, found: outcome.found },
        `${outcome.reflex_ok ? 'reflex connected' : 'reflex unavailable'} · ${route} · ${outcome.frames} flight frames · ${outcome.realtime_factor.toFixed(2)}× real time`);
    } catch (error) {
      finish({ reached: false, collided: false, found: null }, `flight error: ${String(error)}`);
    } finally {
      window.clearTimeout(deadline);
      busy = false; close.disabled = false;
      // Auto-close after a moment to read the outcome, unless a new flight has started.
      window.setTimeout(() => { if (!busy) panel.hidden = true; }, AUTO_CLOSE_MS);
    }
  }
  onInspectionRequest(request => { void inspect(request); });
}

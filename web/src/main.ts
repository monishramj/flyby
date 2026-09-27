import './style.css';
import { mountMap, renderMap, setCameraMode, type CameraMode } from './map';
import { briefHtml, dismissed, renderAssistant, renderIncident, renderIntel } from './panels';
// Ask Ground Control is disabled in the UI; the /api/ask backend is intact. Restore renderAsk to re-enable.
// import { renderAsk } from './panels';
import { bindQueue, renderQueue } from './queue';
import { renderResults } from './results';
import { notify, store, subscribe, type Lead } from './store';
import { connect, send } from './ws';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header class="top">
  <div class="brand"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 8h8l3 6 3-6h8M5 24h8l3-6 3 6h8M16 14v4"/><circle cx="5" cy="8" r="3"/><circle cx="27" cy="8" r="3"/><circle cx="5" cy="24" r="3"/><circle cx="27" cy="24" r="3"/></svg><div><h1>FLYBY</h1><span>Search & rescue / Ground control</span></div></div>
  <span class="simulation-badge">SIMULATION</span>
  <div class="controls">
    <label>Scenario <input id="seed" type="number" min="0" value="0" /></label>
    <button id="start" class="primary">Start search</button>
    <button id="pause">Pause</button>
    <button id="reset">Reset</button>
    <button id="demo" class="accent">Run demo</button>
  </div>
</header>
<div class="workspace-bar"><nav class="tabs" aria-label="Workspace"><button data-tab="mission" class="on" aria-pressed="true">Operations</button><button data-tab="results" aria-pressed="false">Evaluation</button></nav><span class="workspace-note">Human approval required for dispatch</span><div class="status" id="connection"></div></div>
<section class="telemetry" aria-label="Mission overview">
  <div class="operation-title"><span class="eyebrow">ACTIVE SCENARIO</span><strong>Coastal flood response</strong><span id="operation-state">Awaiting ground station</span></div>
  <div class="metric"><span>Mission elapsed</span><strong id="metric-time">00:00</strong><small>simulation time</small></div>
  <div class="metric coverage-metric"><span>Search coverage</span><strong id="metric-coverage">—</strong><progress id="coverage-progress" max="100" value="0" aria-label="Search coverage"></progress></div>
  <div class="metric"><span>Awaiting review</span><strong id="metric-pending">—</strong><small>commander decision</small></div>
  <div class="metric"><span>Dispatched</span><strong id="metric-dispatched">—</strong><small>approved leads</small></div>
</section>
<main id="tab-mission" class="mission">
  <section class="view">
    <canvas id="map" aria-label="3D mission view"></canvas>
    <div id="labels"></div>
    <div class="hud tl"><span class="eyebrow">TACTICAL VIEW</span><b>Search area <span class="map-unit">/ <span id="area-size">300 × 300 m</span></span></b><small id="mission-meta">Waiting for mission data…</small></div>
    <div class="hud tr">
      <span class="seg" aria-label="Camera view"><button data-cam="orbit" class="on" aria-pressed="true">Orbit</button><button data-cam="follow" aria-pressed="false">Follow</button><button data-cam="top" aria-pressed="false">Top-down</button></span>
      <label class="check" title="Reveal simulated subject and decoy locations"><input id="truth" type="checkbox" /> Ground truth</label>
    </div>
    <div class="hud bl legend"><span><i style="background:#dca464"></i>Camera</span><span><i style="background:#7fae9c"></i>Covered</span><span><i class="line-key"></i>Sweep path</span></div>
    <div class="map-help">Drag to orbit <span>·</span> Scroll to zoom</div>
    <div class="map-loading" id="map-loading" role="status">Connecting to ground station<span>The search area will appear when mission data arrives.</span></div>
  </section>
  <section class="panel queue">
    <div class="queue-heading"><span class="eyebrow">DECISION DESK</span><h2>Triage queue <span id="pending-badge">0</span></h2><small id="queue-meta">Waiting for mission data</small></div>
    <div class="queue-guide">Human review first · then urgency & confidence</div>
    <div id="queue"></div>
    <div class="queue-footnote">Select a lead to locate it on the map.<div class="system-status" id="status"></div></div>
  </section>
  <div class="dock">
    <section class="panel incident-panel"><h2><span class="panel-index">01</span> Incident picture</h2><dl class="incident" id="incident"></dl></section>
    <section class="panel feed">
      <h2><span class="panel-index">02</span> Radio & intel</h2>
      <ul id="intel"></ul>
    </section>
    <section class="panel assistant">
      <h2><span class="panel-index">03</span> Grok assistant <small>Advisory</small></h2>
      <ul id="assistant"></ul>
    </section>
    <!-- Ask Ground Control (disabled)
    <section class="panel ask">
      <h2>Ask Ground Control</h2>
      <ul id="ask"></ul>
      <form id="ask-form"><input id="ask-input" placeholder="What is still unresolved near Elm?" autocomplete="off" /><button class="primary">Ask</button></form>
    </section>
    -->
  </div>
</main>
<main id="tab-results" class="results" hidden></main>
<dialog id="brief"><div id="brief-body"></div><form method="dialog"><button class="primary">Close</button></form></dialog>`;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('map');
const queueRoot = element('queue');
// const exchanges: { question: string; answer: string; tool_calls: any[] }[] = [];

function openBrief(lead: Lead) {
  element('brief-body').innerHTML = briefHtml(lead);
  element<HTMLDialogElement>('brief').showModal();
}

function select(leadId: string) {
  store.selected = store.selected === leadId ? '' : leadId;
  notify('selected');
}

bindQueue(queueRoot, select, openBrief);
element('assistant').addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const accept = target.closest('[data-accept]') as HTMLElement | null;
  const dismiss = target.closest('[data-dismiss]') as HTMLElement | null;
  const link = target.closest('[data-lead-link]') as HTMLElement | null;
  const proposal = store.snapshot?.proposals?.find(p => p.proposal_id === (accept ?? dismiss)?.dataset[accept ? 'accept' : 'dismiss']);
  if (accept && proposal) {
    // Highlighting is the only effect: no lead changes state until the commander approves or overrides it.
    store.highlight = store.highlight.join() === proposal.lead_ids.join() ? [] : proposal.lead_ids;
    store.selected = store.highlight[0] ?? '';
    notify('selected');
  } else if (dismiss && proposal) {
    dismissed.add(proposal.proposal_id);
    if (store.highlight.join() === proposal.lead_ids.join()) store.highlight = [];
    notify('selected');
  } else if (link) select(link.dataset.leadLink!);
});
mountMap(canvas, element('labels'), leadId => select(leadId));
document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('[data-cam]').forEach(other => { other.classList.toggle('on', other === button); other.setAttribute('aria-pressed', String(other === button)); });
    setCameraMode(button.dataset.cam as CameraMode);
  };
});
element<HTMLInputElement>('truth').onchange = event => {
  store.showTruth = (event.target as HTMLInputElement).checked;
  renderMap();
};
/* Ask Ground Control (disabled)
element('ask').addEventListener('click', event => {
  const link = (event.target as HTMLElement).closest('[data-lead-link]') as HTMLElement | null;
  if (!link) return;
  event.preventDefault();
  select(link.dataset.leadLink!);
});
*/

const seedInput = element<HTMLInputElement>('seed');
element('start').onclick = () => send({ type: 'mission.control', payload: { cmd: 'start' } });
element('pause').onclick = () => send({ type: 'mission.control', payload: { cmd: 'pause' } });
element('reset').onclick = () => send({ type: 'mission.control', payload: { cmd: 'reset', seed: Number(seedInput.value) } });
element('demo').onclick = () => {
  const seed = store.snapshot?.config.DEMO_SEED ?? 0;
  seedInput.value = String(seed);
  send({ type: 'mission.control', payload: { cmd: 'reset', seed } });
  window.setTimeout(() => send({ type: 'mission.control', payload: { cmd: 'start' } }), 250);
};

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('[data-tab]').forEach(other => { other.classList.toggle('on', other === button); other.setAttribute('aria-pressed', String(other === button)); });
    const results = button.dataset.tab === 'results';
    element('tab-mission').hidden = results;
    element('tab-results').hidden = !results;
    if (results) renderResults(element('tab-results'));
  };
});

/* Ask Ground Control (disabled)
element<HTMLFormElement>('ask-form').onsubmit = async event => {
  event.preventDefault();
  const input = element<HTMLInputElement>('ask-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  exchanges.push({ question, answer: 'Asking Ground Control…', tool_calls: [] });
  // renderAsk(element('ask'), exchanges);
  try {
    const response = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
    const body = await response.json();
    exchanges[exchanges.length - 1] = { question, answer: body.answer ?? body.detail ?? 'No answer was returned.', tool_calls: body.tool_calls ?? [] };
  } catch {
    exchanges[exchanges.length - 1] = { question, answer: 'Ground Control is offline. No action was taken.', tool_calls: [] };
  }
  // renderAsk(element('ask'), exchanges);
};
*/

function renderStatus() {
  const snapshot = store.snapshot;
  const state = snapshot?.state;
  element('status').innerHTML = [
    `<span class="dot ${store.connected ? 'on' : 'off'}"></span>${store.connected ? 'live link' : 'reconnecting'}`,
    snapshot ? `policy <b>${snapshot.config.LIVE_POLICY}</b>` : '',
    snapshot ? `intel <b>${snapshot.config.PARSE_MODE}</b>` : '',
    snapshot ? `logs <b>${snapshot.services.persistence}</b>` : '',
    store.error ? `<span class="warn">${store.error}</span>` : '',
  ].filter(Boolean).join(' · ');
  element('connection').textContent = store.error || (store.connected ? 'Ground station connected' : 'Waiting for connection');
  element('connection').classList.toggle('connected', store.connected);
  element('map-loading').hidden = Boolean(snapshot);
  if (!snapshot || !state) return;
  const counts = snapshot.leads.reduce<Record<string, number>>((total, lead) => ({ ...total, [lead.status]: (total[lead.status] ?? 0) + 1 }), {});
  element('mission-meta').textContent = `t+${Math.round(state.t)}s · ${state.coverage_pct.toFixed(0)}% covered · ${state.finished ? 'sweep complete' : state.running ? 'flying' : 'paused'}`;
  element('queue-meta').textContent = `${(counts.awaiting_human ?? 0) + (counts.awaiting_approval ?? 0)} waiting · ${counts.dispatched ?? 0} dispatched · ${counts.auto_closed ?? 0} auto-closed · ${counts.ignored ?? 0} ignored`;
  const pending = (counts.awaiting_human ?? 0) + (counts.awaiting_approval ?? 0);
  element('metric-time').textContent = `${String(Math.floor(state.t / 60)).padStart(2, '0')}:${String(Math.floor(state.t % 60)).padStart(2, '0')}`;
  element('metric-coverage').textContent = `${state.coverage_pct.toFixed(0)}%`;
  element<HTMLProgressElement>('coverage-progress').value = state.coverage_pct;
  element('metric-pending').textContent = String(pending);
  element('metric-pending').classList.toggle('attention', pending > 0);
  element('pending-badge').textContent = String(pending);
  element('metric-dispatched').textContent = String(counts.dispatched ?? 0);
  element('operation-state').textContent = state.finished ? 'Sweep complete' : state.running ? 'Search in progress' : 'Search paused';
  element('area-size').textContent = `${snapshot.scene.area_m} × ${snapshot.scene.area_m} m`;
}

let frame = 0;
function scheduleDraw() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; renderMap(); });
}

subscribe(type => {
  if (type === 'mission.snapshot' && store.snapshot) seedInput.value = String(store.snapshot.seed);
  if (type === 'truth') element<HTMLInputElement>('truth').checked = store.showTruth;
  renderStatus();
  scheduleDraw();
  if (type !== 'mission.state') {
    renderQueue(queueRoot);
    renderIntel(element('intel'));
    renderIncident(element('incident'));
    renderAssistant(element('assistant'));
  }
  if (type === 'dispatch.created' && store.dispatched) {
    const lead = store.snapshot?.leads.find(item => item.lead_id === store.dispatched);
    if (lead) openBrief(lead);
  }
});

window.addEventListener('resize', scheduleDraw);
renderStatus();
renderQueue(queueRoot);
renderIntel(element('intel'));
renderAssistant(element('assistant'));
// renderAsk(element('ask'), exchanges);
connect();

import './style.css';
import { mountMap, renderMap, setCameraMode, type CameraMode } from './map';
import { briefHtml, renderAsk, renderIncident, renderIntel, renderLog } from './panels';
import { bindQueue, renderQueue } from './queue';
import { renderResults } from './results';
import { notify, store, subscribe, type Lead } from './store';
import { connect, send } from './ws';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header class="top">
  <h1>FlyBy <span>Triage</span></h1>
  <div class="controls">
    <label>seed <input id="seed" type="number" min="0" value="0" /></label>
    <button id="start" class="primary">Start</button>
    <button id="pause">Pause</button>
    <button id="reset">Reset</button>
    <button id="demo" class="accent">Demo</button>
  </div>
  <div class="status" id="status"></div>
</header>
<nav class="tabs"><button data-tab="mission" class="on">Mission</button><button data-tab="results">Results</button></nav>
<main id="tab-mission" class="mission">
  <section class="view">
    <canvas id="map" aria-label="3D mission view"></canvas>
    <div id="labels"></div>
    <div class="hud tl"><b>Search area</b> <small id="mission-meta"></small></div>
    <div class="hud tr">
      <span class="seg"><button data-cam="orbit" class="on">Orbit</button><button data-cam="follow">Follow drone</button><button data-cam="top">Top-down</button></span>
      <label class="check"><input id="truth" type="checkbox" /> show truth</label>
    </div>
    <div class="hud bl legend"><span><i style="background:#cf653c"></i>camera footprint</span><span><i style="background:#54c88c"></i>covered</span><span><i style="background:#7fc3ac"></i>planned sweep</span></div>
  </section>
  <div class="dock">
    <section class="panel incident-panel"><h2>Incident</h2><dl class="incident" id="incident"></dl></section>
    <section class="panel queue">
      <h2>Triage queue <small id="queue-meta"></small></h2>
      <div id="queue"></div>
    </section>
    <section class="panel feed">
      <h2>Intel feed</h2>
      <ul id="intel"></ul>
    </section>
    <section class="panel log">
      <h2>Decision log</h2>
      <ul id="log"></ul>
    </section>
    <section class="panel ask">
      <h2>Ask Ground Control</h2>
      <ul id="ask"></ul>
      <form id="ask-form"><input id="ask-input" placeholder="What is still unresolved near Elm?" autocomplete="off" /><button class="primary">Ask</button></form>
    </section>
  </div>
</main>
<main id="tab-results" class="results" hidden></main>
<dialog id="brief"><div id="brief-body"></div><form method="dialog"><button class="primary">Close</button></form></dialog>`;

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = element<HTMLCanvasElement>('map');
const queueRoot = element('queue');
const exchanges: { question: string; answer: string; tool_calls: any[] }[] = [];

function openBrief(lead: Lead) {
  element('brief-body').innerHTML = briefHtml(lead);
  element<HTMLDialogElement>('brief').showModal();
}

function select(leadId: string) {
  store.selected = store.selected === leadId ? '' : leadId;
  notify('selected');
}

bindQueue(queueRoot, select, openBrief);
mountMap(canvas, element('labels'), leadId => select(leadId));
document.querySelectorAll<HTMLButtonElement>('[data-cam]').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('[data-cam]').forEach(other => other.classList.toggle('on', other === button));
    setCameraMode(button.dataset.cam as CameraMode);
  };
});
element<HTMLInputElement>('truth').onchange = event => {
  store.showTruth = (event.target as HTMLInputElement).checked;
  renderMap();
};
element('ask').addEventListener('click', event => {
  const link = (event.target as HTMLElement).closest('[data-lead-link]') as HTMLElement | null;
  if (!link) return;
  event.preventDefault();
  select(link.dataset.leadLink!);
});

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
    document.querySelectorAll('[data-tab]').forEach(other => other.classList.toggle('on', other === button));
    const results = button.dataset.tab === 'results';
    element('tab-mission').hidden = results;
    element('tab-results').hidden = !results;
    if (results) renderResults(element('tab-results'));
  };
});

element<HTMLFormElement>('ask-form').onsubmit = async event => {
  event.preventDefault();
  const input = element<HTMLInputElement>('ask-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';
  exchanges.push({ question, answer: 'Asking Ground Control…', tool_calls: [] });
  renderAsk(element('ask'), exchanges);
  try {
    const response = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) });
    const body = await response.json();
    exchanges[exchanges.length - 1] = { question, answer: body.answer ?? body.detail ?? 'No answer was returned.', tool_calls: body.tool_calls ?? [] };
  } catch {
    exchanges[exchanges.length - 1] = { question, answer: 'Ground Control is offline. No action was taken.', tool_calls: [] };
  }
  renderAsk(element('ask'), exchanges);
};

function renderStatus() {
  const snapshot = store.snapshot;
  const state = snapshot?.state;
  element('status').innerHTML = [
    `<span class="dot ${store.connected ? 'on' : 'off'}"></span>${store.connected ? 'live' : 'reconnecting'}`,
    snapshot ? `policy <b>${snapshot.config.LIVE_POLICY}</b>` : '',
    snapshot ? `intel <b>${snapshot.config.PARSE_MODE}</b>` : '',
    snapshot ? `logs <b>${snapshot.services.persistence}</b>` : '',
    store.error ? `<span class="warn">${store.error}</span>` : '',
  ].filter(Boolean).join(' · ');
  if (!snapshot || !state) return;
  const counts = snapshot.leads.reduce<Record<string, number>>((total, lead) => ({ ...total, [lead.status]: (total[lead.status] ?? 0) + 1 }), {});
  element('mission-meta').textContent = `t+${Math.round(state.t)}s · ${state.coverage_pct.toFixed(0)}% covered · ${state.finished ? 'sweep complete' : state.running ? 'flying' : 'paused'}`;
  element('queue-meta').textContent = `${(counts.awaiting_human ?? 0) + (counts.awaiting_approval ?? 0)} waiting · ${counts.dispatched ?? 0} dispatched · ${counts.ignored ?? 0} ignored`;
}

let frame = 0;
function scheduleDraw() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; renderMap(); });
}

subscribe(type => {
  if (type === 'truth') element<HTMLInputElement>('truth').checked = store.showTruth;
  renderStatus();
  scheduleDraw();
  if (type !== 'mission.state') {
    renderQueue(queueRoot);
    renderIntel(element('intel'));
    renderLog(element('log'));
    renderIncident(element('incident'));
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
renderLog(element('log'));
renderAsk(element('ask'), exchanges);
connect();

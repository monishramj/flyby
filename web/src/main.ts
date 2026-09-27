import './style.css';
import { mountMap, renderMap, setCameraMode, type CameraMode } from './map';
import { briefHtml, contextSummary, renderIncident, renderIntel } from './panels';
// Ask Ground Control is disabled in the UI; the /api/ask backend is intact. Restore renderAsk to re-enable.
// import { renderAsk } from './panels';
import { bindQueue, renderQueue } from './queue';
import { renderResults } from './results';
import { notify, store, subscribe, type Lead, type Detour, type MissionItem, type MissionState } from './store';
import { connect, send } from './ws';
import { mountInspectionPanel } from './inspection';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<header class="top">
  <h1>FLYBY</h1>
  <div class="controls">
    <label>seed <input id="seed" type="number" min="0" value="0" /></label>
    <button id="start" class="primary">Start</button>
    <button id="pause" class="ghost">Pause</button>
    <button id="reset" class="ghost">Reset</button>
    <button id="demo" class="accent">Demo</button>
  </div>
  <div class="status" id="status"></div>
</header>
<nav class="tabs"><button data-tab="mission" class="on">Mission</button><button data-tab="results">Results</button></nav>
<main id="tab-mission" class="mission">
  <div class="stage">
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
    <!-- Background, not work: closed by default so the queue owns attention. -->
    <details class="context" id="context">
      <summary>Context <small id="context-meta"></small></summary>
      <div class="context-body">
        <section><h2>Incident</h2><dl class="incident" id="incident"></dl></section>
        <section><h2>Intel feed</h2><ul class="feed" id="intel"></ul></section>
      </div>
    </details>
    <!-- Ask Ground Control (disabled)
    <section class="panel ask">
      <h2>Ask Ground Control</h2>
      <ul id="ask"></ul>
      <form id="ask-form"><input id="ask-input" placeholder="What is still unresolved near Elm?" autocomplete="off" /><button class="primary">Ask</button></form>
    </section>
    -->
  </div>
  <aside class="work">
    <nav class="side-tabs"><button data-side="work" class="on">Work <small id="queue-meta"></small></button><button data-side="mission">Mission <span id="fmode" class="fmode"></span></button></nav>
    <div id="side-work">
      <div class="jump top"><button data-jump="up" tabindex="-1"></button></div>
      <div id="queue"></div>
      <div class="jump bottom"><button data-jump="down" tabindex="-1"></button></div>
    </div>
    <div id="side-mission" class="mission-pane" hidden><p id="guided-row" class="guided-row"></p><div id="mission-items"></div></div>
  </aside>
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

document.querySelectorAll<HTMLButtonElement>('[data-side]').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('[data-side]').forEach(other => other.classList.toggle('on', other === button));
    element('side-work').hidden = button.dataset.side !== 'work';
    element('side-mission').hidden = button.dataset.side !== 'mission';
  };
});

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('[data-tab]').forEach(other => other.classList.toggle('on', other === button));
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
    `<span class="dot ${store.connected ? 'on' : 'off'}"></span>${store.connected ? 'live' : 'reconnecting'}`,
    snapshot ? `policy <b>${snapshot.config.LIVE_POLICY}</b>` : '',
    snapshot ? `intel <b>${snapshot.config.PARSE_MODE}</b>` : '',
    snapshot ? `logs <b>${snapshot.services.persistence}</b>` : '',
    store.error ? `<span class="warn">${store.error}</span>` : '',
  ].filter(Boolean).join(' · ');
  if (!snapshot || !state) return;
  const counts = snapshot.leads.reduce<Record<string, number>>((total, lead) => ({ ...total, [lead.status]: (total[lead.status] ?? 0) + 1 }), {});
  // Visits push the search end back, so the server says when the search is done; freeze its timer there.
  const searchEnd = state.search_done ? state.search_end_t ?? state.t : null;
  const task = state.drone_task ? ` · drone ${state.drone_task.kind === 'reimage' ? 'rerouted to zoom on' : 'inspecting'} ${state.drone_task.lead_id}` : '';
  element('mission-meta').textContent = searchEnd != null
    ? `search complete in ${Math.round(searchEnd)}s · ${state.coverage_pct.toFixed(0)}% covered${task}`
    : `t+${Math.round(state.t)}s · ${state.coverage_pct.toFixed(0)}% covered · ${state.running ? 'flying' : 'paused'}${task}`;
  renderMissionList(snapshot.config.MISSION, state);
  element('queue-meta').textContent = `${counts.dispatched ?? 0} dispatched`;
  element('context-meta').textContent = contextSummary();
}

const COMMAND: Record<string, string> = { NAV_WAYPOINT: 'WAYPOINT', DO_SET_CAM_TRIGG_DIST: 'CAM_TRIGG_DIST' };
let missionKey = '';
// The mission as a GCS lists it, with each GUIDED detour inserted before the item it interrupted; queued ones wait before the current item.
function renderMissionList(items: MissionItem[], state: MissionState) {
  const mode = state.mode ?? 'AUTO', g = state.guided, current = state.mission_current ?? 0, detours = state.detours ?? [];
  const fmode = element('fmode'); fmode.textContent = mode; fmode.className = `fmode ${mode.toLowerCase()}`;
  const key = JSON.stringify([current, g?.phase, detours.map(d => d.status + d.lead_id), items.length]);
  if (key === missionKey) return;
  missionKey = key;
  element('guided-row').innerHTML = g ? `<b>GUIDED</b> → ${g.lead_id} ${g.kind} · hold ${g.hold_s}s · ${g.phase === 'back' ? 'returning to resume AUTO' : g.phase === 'out' ? 'flying out' : 'hovering'}`
    : mode === 'HOLD' ? 'Search complete, holding.' : `<b>AUTO</b> → waypoint ${current}`;
  const detourRow = (d: Detour) => `<tr class="detour ${d.status}"><td>${d.n ? `G${d.n}` : 'G'}</td><td>GUIDED ${d.kind} → ${d.lead_id}</td><td>${d.alt}</td>`
    + `<td>${d.hold_s != null ? `hold ${d.hold_s}s` : ''}</td><td>${d.status === 'active' ? g?.phase ?? 'active' : d.status}</td></tr>`;
  const rows = items.map(item => {
    const inserted = detours.filter(d => d.status !== 'queued' && d.before_seq === item.seq).map(detourRow).join('')
      + (item.seq === current ? detours.filter(d => d.status === 'queued').map(detourRow).join('') : '');
    const state = item.seq === current ? (mode === 'GUIDED' ? 'paused' : mode === 'HOLD' ? 'reached' : 'flying to') : item.seq < current ? 'reached' : '';
    return inserted + `<tr class="${item.seq === current ? 'on' : item.seq < current ? 'done' : ''}"><td>${item.seq}</td><td>${COMMAND[item.command] ?? item.command}</td>`
      + `<td>${item.alt ?? ''}</td><td>${item.command === 'DO_SET_CAM_TRIGG_DIST' ? `${item.param1}m` : ''}</td><td>${state}</td></tr>`;
  }).join('');
  element('mission-items').innerHTML = `<table class="mission-table"><thead><tr><th>#</th><th>Command</th><th>Alt</th><th>Param</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>`;
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
// renderAsk(element('ask'), exchanges);
mountInspectionPanel();
connect();

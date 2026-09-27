import { colors } from './map';
import { store, type Action, type Lead } from './store';
import { send } from './ws';

const ACTIONS: Action[] = ['dispatch_ground_team', 'reimage_zoom', 'close_in_inspect', 'ignore'];
export const LABELS: Record<string, string> = { dispatch_ground_team: 'Dispatch crew', reimage_zoom: 'Reimage (zoom)', close_in_inspect: 'Close-in inspect', ignore: 'Ignore' };
const URGENCY = ['low', 'moderate', 'high', 'critical'];
export const PENDING = ['awaiting_human', 'awaiting_approval'];
const CREW_ACTIONS = ['dispatch_ground_team', 'close_in_inspect'];
const CAMERA_TIP = "The drone detector's own score that this is a person.";

export const urgencyLabel = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${URGENCY[Math.min(3, Math.round(value))]} (${value.toFixed(1)})`);
export const pct = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);
const clean = (value: string) => value.replace(/[<>&]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[character]!));
const words = (value: string) => value.replaceAll('_', ' ');

/** Routed leads first, then urgency, then P(person); detector confidence breaks ties. */
export function rank(leads: Lead[]): Lead[] {
  const pending = leads.filter(lead => PENDING.includes(lead.status)).sort((a, b) => {
    const routed = Number(b.status === 'awaiting_human') - Number(a.status === 'awaiting_human');
    if (routed) return routed;
    const urgency = (b.decision?.urgency ?? -1) - (a.decision?.urgency ?? -1);
    if (urgency) return urgency;
    const person = (b.decision?.p_person ?? -1) - (a.decision?.p_person ?? -1);
    if (person) return person;
    return b.detector_conf - a.detector_conf;
  });
  // Dispatched leads stay listed below, so their brief is still reachable.
  const dispatched = leads.filter(lead => lead.status === 'dispatched').reverse();
  return [...pending, ...dispatched];
}

/** The card's one-line reason, from the same facts Laya read. Written by code: instant, offline, never wrong. */
export function reason(lead: Lead): string {
  const facts = lead.state?.lead ?? {};
  const context = lead.state?.context ?? {};
  return [
    ({ high: 'camera confident', medium: 'camera unsure', low: 'camera doubtful' } as Record<string, string>)[facts.detector_band],
    ({ small: 'tiny image', medium: 'clear image', large: 'large clear image' } as Record<string, string>)[facts.size_band],
    facts.near_structure ? 'by a building or roof' : 'in the open',
    (facts.passes ?? 1) > 1 ? 'zoomed second look' : '',
    ['high', 'critical'].includes(context.sector_priority) ? `${lead.sector} ${context.sector_priority}` : '',
    ...(context.hazards_nearby ?? []).map((hazard: string) => `${words(hazard)} nearby`),
    context.near_last_known_point ? 'near last known point' : '',
    context.reported_subjects_in_sector ? `${context.reported_subjects_in_sector} reported in sector` : '',
  ].filter(Boolean).join(' · ');
}

/** Why a lead reached a human, in the terms of the routing rule (loop._decide / decide.Decider). */
function routedBecause(lead: Lead): string {
  const decision = lead.decision!;
  const top = Math.max(...Object.values(decision.probs));
  const tau = store.snapshot?.config.TAU_ROUTE ?? 0.5;
  if (decision.used_fallback) return 'Laya was unavailable, so the rule decided and sent it to you.';
  if (decision.source === 'laya' && top < tau) return `Laya's top choice is under ${Math.round(tau * 100)}%, so it was sent to you.`;
  if (decision.action === 'ignore') return "Laya said ignore, but the camera score isn't low, so you decide.";
  return 'Already re-imaged once, so you decide.';
}

const openWhy = new Set<string>();

function why(lead: Lead): string {
  const decision = lead.decision;
  if (!decision) return '';
  const top = Math.max(...Object.values(decision.probs));
  const bars = decision.source === 'laya'
    ? `<h5>Laya's confidence in each action</h5>
      ${ACTIONS.map(action => {
        const share = Math.round((decision.probs[action] ?? 0) * 100);
        return `<div class="barrow ${decision.probs[action] === top ? 'best' : ''}"><span class="name">${LABELS[action]}</span>
          <span class="bar"><span style="width:${share}%;background:${colors[action]}"></span></span><em>${share}%</em></div>`;
      }).join('')}`
    : `<h5>How this was decided</h5><p>${decision.source === 'inspection' ? 'The close-in inspection found a person.' : 'Fixed rule on the camera score (no model probabilities).'}</p>`;
  const history = lead.history.map((entry, index) => `<li>t+${Math.round(entry.t)}s · ${LABELS[entry.action]} · ${entry.source}${index ? ' · re-decided' : ''}${entry.routed_to_human ? ' · sent to you' : ''}</li>`).join('');
  return `<div class="why">
    ${bars}
    ${lead.status === 'awaiting_human' ? `<p class="routed">${routedBecause(lead)}</p>` : ''}
    <dl>
      <div><dt title="${CAMERA_TIP}">Camera score</dt><dd>${pct(lead.detector_conf)} <small>${CAMERA_TIP}</small></dd></div>
      ${decision.urgency != null ? `<div><dt>Urgency</dt><dd>${decision.urgency.toFixed(1)} <small>Laya's rating: 0 low → 3 critical</small></dd></div>` : ''}
      ${decision.p_person != null ? `<div><dt>Chance it's a person</dt><dd>${pct(decision.p_person)} <span class="tag warn">experimental</span> <small>Laya's estimate; less reliable than the camera score in our evaluation</small></dd></div>` : ''}
    </dl>
    ${lead.model_text ? `<h5>What Laya read</h5><p class="model-text">${clean(lead.model_text)}</p>` : ''}
    <h5>History</h5><ul class="history">${history}</ul>
  </div>`;
}

/** Laya chose the action; Grok writes how a crew carries it out. Approve never waits for it. */
function order(lead: Lead): string {
  const value = lead.order;
  if (!value || !CREW_ACTIONS.includes(lead.decision?.action ?? '') || value.action !== lead.decision?.action) return '';
  if (value.pending) return '<div class="order pending">Grok is writing the crew order…</div>';
  if (value.unavailable || !value.text) return '<div class="order muted">Order unavailable; the template brief will be used.</div>';
  return `<div class="order"><b>Grok order</b> ${clean(value.text.headline)}
    <p>${clean(value.text.access_notes)}</p><small>On arrival: ${clean(value.text.confidence_statement)}</small></div>`;
}

function card(lead: Lead): string {
  const decision = lead.decision;
  const action = decision?.action ?? 'ignore';
  const settled = !PENDING.includes(lead.status);
  const ready = lead.order?.text && lead.order.action === action;
  const source = decision?.source === 'laya' ? 'Laya' : decision?.source === 'inspection' ? 'inspection' : 'rule';
  const urgency = decision?.urgency != null ? `${URGENCY[Math.min(3, Math.round(decision.urgency))]} urgency` : '';
  return `<article class="card ${settled ? 'settled' : ''} ${store.selected === lead.lead_id ? 'selected' : ''}" data-lead="${lead.lead_id}">
    <header>
      <span class="thumb" style="--tone:${colors[action]}" aria-hidden="true">
        <span class="box" style="width:${Math.min(38, Math.max(8, lead.box_px / 2))}px;height:${Math.min(38, Math.max(8, lead.box_px / 2))}px"></span>
      </span>
      <div>
        <strong>${lead.lead_id}</strong>
        <small>${lead.sector} · ${words(lead.nearest_landmark || '')}</small>
      </div>
      <div class="tags">
        ${settled ? `<span class="tag done">${words(lead.status)}</span>` : ''}
        ${lead.status === 'awaiting_human' ? '<span class="tag human">needs you</span>' : ''}
        ${lead.reranked ? '<span class="tag rerank">re-ranked</span>' : ''}
        ${decision?.used_fallback ? '<span class="tag warn">fallback</span>' : ''}
      </div>
    </header>
    <p class="action" style="--tone:${colors[action]}">${LABELS[action]} <small>${source}</small></p>
    <p class="reason">${reason(lead)}</p>
    <p class="facts">${urgency ? `<span class="urgency u${Math.min(3, Math.round(decision!.urgency!))}">${urgency}</span> · ` : ''}<span title="${CAMERA_TIP}">Camera ${pct(lead.detector_conf)}</span></p>
    ${settled ? '' : order(lead)}
    <footer>
      ${settled ? '' : `<button data-approve="${lead.lead_id}" class="primary">Approve ${LABELS[action].toLowerCase()}${ready ? ' with order' : ''}</button>
      <select data-override="${lead.lead_id}" aria-label="Override action for ${lead.lead_id}">
        <option value="">Override…</option>
        ${ACTIONS.filter(item => item !== action).map(item => `<option value="${item}">${LABELS[item]}</option>`).join('')}
      </select>`}
      <button data-why="${lead.lead_id}" class="ghost" aria-expanded="${openWhy.has(lead.lead_id)}">Why?</button>
      ${lead.dispatch ? `<button data-brief="${lead.lead_id}" class="ghost">Brief</button>` : ''}
    </footer>
    ${openWhy.has(lead.lead_id) ? why(lead) : ''}
  </article>`;
}

/** Why an auto-closed lead might still be a survivor, from the incident picture only. */
export function closedRisk(lead: Lead): string[] {
  const context = lead.state?.context ?? {};
  return [
    context.near_last_known_point ? 'near last known point' : '',
    ['critical', 'high'].includes(context.sector_priority) ? `${context.sector_priority} sector` : '',
    context.reported_subjects_in_sector ? `${context.reported_subjects_in_sector} reported in sector` : '',
  ].filter(Boolean);
}

let tab: 'work' | 'closed' = 'work';

function closedRow(lead: Lead): string {
  const risk = closedRisk(lead);
  return `<li class="${risk.length ? 'risky' : ''} ${store.selected === lead.lead_id ? 'selected' : ''}" data-lead="${lead.lead_id}">
    <b>${lead.lead_id}</b> <small>${lead.sector} · camera ${pct(lead.detector_conf)}</small>
    ${risk.map(item => `<span class="tag warn">${item}</span>`).join('')}
    <span class="row-actions"><button data-approve="${lead.lead_id}" class="ghost">Confirm ignore</button>
    <select data-override="${lead.lead_id}" aria-label="Reopen ${lead.lead_id}">
      <option value="">Reopen…</option>
      ${ACTIONS.filter(item => item !== 'ignore').map(item => `<option value="${item}">${LABELS[item]}</option>`).join('')}
    </select></span></li>`;
}

export function renderQueue(root: HTMLElement) {
  const leads = store.snapshot ? rank(store.snapshot.leads) : [];
  const waiting = leads.filter(lead => PENDING.includes(lead.status)).length;
  const closed = (store.snapshot?.leads ?? []).filter(lead => lead.status === 'auto_closed')
    .sort((a, b) => closedRisk(b).length - closedRisk(a).length || b.detector_conf - a.detector_conf);
  const flagged = closed.filter(lead => closedRisk(lead).length).length;
  const body = tab === 'work'
    ? (leads.length ? leads.map(card).join('') : '<p class="empty">Nothing needs you right now.</p>')
    : (closed.length
      ? `<p class="closed-note">Laya closed these low-camera-score leads. New intel re-decides them; reopen any you doubt.</p><ul class="closed-list">${closed.map(closedRow).join('')}</ul>`
      : '<p class="empty">Laya has not closed any leads.</p>');
  root.innerHTML = `<nav class="work-tabs">
      <button data-tab-work="work" class="${tab === 'work' ? 'on' : ''}">Needs you (${waiting})</button>
      <button data-tab-work="closed" class="${tab === 'closed' ? 'on' : ''}">Auto-closed (${closed.length})${flagged ? ` <span class="warn">· ${flagged} flagged</span>` : ''}</button>
    </nav>${body}`;
}

export function bindQueue(root: HTMLElement, onSelect: (leadId: string) => void, onBrief: (lead: Lead) => void) {
  root.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const approve = target.closest('[data-approve]') as HTMLElement | null;
    const brief = target.closest('[data-brief]') as HTMLElement | null;
    const whyButton = target.closest('[data-why]') as HTMLElement | null;
    const card = target.closest('[data-lead]') as HTMLElement | null;
    const tabButton = target.closest('[data-tab-work]') as HTMLElement | null;
    if (tabButton) { tab = tabButton.dataset.tabWork as typeof tab; renderQueue(root); return; }
    if (approve) { send({ type: 'lead.approve', payload: { lead_id: approve.dataset.approve! } }); return; }
    if (whyButton) {
      const id = whyButton.dataset.why!;
      if (!openWhy.delete(id)) openWhy.add(id);
      renderQueue(root);
      return;
    }
    if (brief) {
      const lead = store.snapshot?.leads.find(item => item.lead_id === brief.dataset.brief);
      if (lead) onBrief(lead);
      return;
    }
    if (card && !target.closest('select, .why')) onSelect(card.dataset.lead!);
  });
  root.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (!select.dataset.override || !select.value) return;
    send({ type: 'lead.override', payload: { lead_id: select.dataset.override, action: select.value as Action } });
    select.value = '';
  });
}

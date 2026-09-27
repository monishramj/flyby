import { colors } from './map';
import { store, type Action, type Lead } from './store';
import { send } from './ws';

const ACTIONS: Action[] = ['dispatch_ground_team', 'reimage_zoom', 'close_in_inspect', 'ignore'];
const SHORT: Record<Action, string> = { dispatch_ground_team: 'Dispatch', reimage_zoom: 'Reimage', close_in_inspect: 'Inspect', ignore: 'Ignore' };
export const LABELS: Record<string, string> = { dispatch_ground_team: 'Dispatch crew', reimage_zoom: 'Reimage (zoom)', close_in_inspect: 'Close-in inspect', ignore: 'Ignore' };
const URGENCY = ['low', 'moderate', 'high', 'critical'];
export const PENDING = ['awaiting_human', 'awaiting_approval'];

export const urgencyLabel = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${URGENCY[Math.min(3, Math.round(value))]} (${value.toFixed(1)})`);
export const pct = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);

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

function probabilityBar(lead: Lead) {
  const decision = lead.decision;
  if (decision?.source !== 'laya') return ''; // the rule policy's probabilities are one-hot, not evidence
  return `<div class="bars">${ACTIONS.map(action => {
    const share = Math.round((decision.probs[action] ?? 0) * 100);
    return `<div class="bar" title="${LABELS[action]} ${share}%"><span>${SHORT[action]}</span><div class="track"><span style="width:${share}%;background:${colors[action]}"></span></div><em>${share}%</em></div>`;
  }).join('')}</div>`;
}

function card(lead: Lead): string {
  const decision = lead.decision;
  const action = lead.status === 'dispatched' ? 'dispatch_ground_team' : decision?.action ?? 'ignore';
  const needsHuman = lead.status === 'awaiting_human';
  const settled = !PENDING.includes(lead.status);
  return `<article class="card ${settled ? 'settled' : ''} ${store.selected === lead.lead_id ? 'selected' : ''} ${store.highlight.includes(lead.lead_id) ? 'highlight' : ''}" data-lead="${lead.lead_id}" tabindex="0" aria-label="${lead.lead_id}, ${lead.sector}. Select to locate on map.">
    <header>
      <span class="thumb" style="--tone:${colors[action]}" title="Detection size indicator, not a camera image" aria-hidden="true">
        <span class="box" style="width:${Math.min(38, Math.max(8, lead.box_px / 2))}px;height:${Math.min(38, Math.max(8, lead.box_px / 2))}px"></span>
      </span>
      <div>
        <strong>${lead.lead_id}</strong>
        <small>${lead.sector} · ${(lead.nearest_landmark || '').replaceAll('_', ' ')} · pass ${lead.pass}</small>
      </div>
      <div class="tags">
        ${settled ? `<span class="tag done">${lead.status}</span>` : ''}
        ${needsHuman ? '<span class="tag human">needs human</span>' : ''}
        ${lead.reranked ? '<span class="tag rerank">re-ranked</span>' : ''}
        ${store.highlight.includes(lead.lead_id) ? '<span class="tag rerank">grok linked</span>' : ''}
        ${decision?.used_fallback ? '<span class="tag warn">fallback</span>' : ''}
      </div>
    </header>
    <p class="action" style="--tone:${colors[action]}">${lead.status === 'dispatched' ? 'Crew dispatched' : LABELS[action]}</p>
    ${probabilityBar(lead)}
    <dl>
      <div><dt>P(person)</dt><dd>${pct(decision?.p_person)}</dd></div>
      <div><dt>urgency</dt><dd>${urgencyLabel(decision?.urgency)}</dd></div>
      <div><dt>detector</dt><dd>${pct(lead.detector_conf)}</dd></div>
      <div><dt>source</dt><dd>${decision?.source ?? '—'} · ${Math.round(decision?.latency_ms ?? 0)} ms</dd></div>
    </dl>
    <footer>
      ${settled ? '' : `<button data-approve="${lead.lead_id}" class="primary">Approve ${LABELS[action].toLowerCase()}</button>
      <select data-override="${lead.lead_id}" aria-label="Override action for ${lead.lead_id}">
        <option value="">Override…</option>
        ${ACTIONS.filter(item => item !== action).map(item => `<option value="${item}">${LABELS[item]}</option>`).join('')}
      </select>`}
      ${lead.dispatch ? `<button data-brief="${lead.lead_id}" class="ghost">Brief</button>` : ''}
    </footer>
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

let binOpen = false;

function closedRow(lead: Lead): string {
  const risk = closedRisk(lead);
  return `<li class="${risk.length ? 'risky' : ''} ${store.selected === lead.lead_id || store.highlight.includes(lead.lead_id) ? 'selected' : ''}" data-lead="${lead.lead_id}">
    <b>${lead.lead_id}</b> <small>${lead.sector} · detector ${pct(lead.detector_conf)}</small>
    ${risk.map(reason => `<span class="tag warn">${reason}</span>`).join('')}
    <span class="row-actions"><button data-approve="${lead.lead_id}" class="ghost">Confirm ignore</button>
    <select data-override="${lead.lead_id}" aria-label="Reopen ${lead.lead_id}">
      <option value="">Reopen…</option>
      ${ACTIONS.filter(item => item !== 'ignore').map(item => `<option value="${item}">${LABELS[item]}</option>`).join('')}
    </select></span></li>`;
}

export function renderQueue(root: HTMLElement) {
  const focused = document.activeElement as HTMLElement | null;
  const focusId = focused?.matches('.card') && root.contains(focused) ? focused.dataset.lead : null;
  const leads = store.snapshot ? rank(store.snapshot.leads) : [];
  const closed = (store.snapshot?.leads ?? []).filter(lead => lead.status === 'auto_closed')
    .sort((a, b) => closedRisk(b).length - closedRisk(a).length || b.detector_conf - a.detector_conf);
  root.innerHTML = (leads.length
    ? leads.map(card).join('')
    : '<p class="empty"><strong>No pending decisions</strong>Start a search to collect leads. Detections needing review will appear here.</p>')
    + (closed.length ? `<details class="closed-bin" ${binOpen ? 'open' : ''}>
      <summary>Auto-closed (${closed.length})${closed.some(lead => closedRisk(lead).length) ? ' · <span class="warn">review flagged</span>' : ''}</summary>
      <ul>${closed.map(closedRow).join('')}</ul></details>` : '');
  root.querySelector('.closed-bin')?.addEventListener('toggle', event => { binOpen = (event.target as HTMLDetailsElement).open; });
  if (focusId) Array.from(root.querySelectorAll<HTMLElement>('.card')).find(card => card.dataset.lead === focusId)?.focus({ preventScroll: true });
}

export function bindQueue(root: HTMLElement, onSelect: (leadId: string) => void, onBrief: (lead: Lead) => void) {
  root.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (target.matches('.card') && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); onSelect(target.dataset.lead!);
    }
  });
  root.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const approve = target.closest('[data-approve]') as HTMLElement | null;
    const brief = target.closest('[data-brief]') as HTMLElement | null;
    const card = target.closest('[data-lead]') as HTMLElement | null;
    if (approve) { send({ type: 'lead.approve', payload: { lead_id: approve.dataset.approve! } }); return; }
    if (brief) {
      const lead = store.snapshot?.leads.find(item => item.lead_id === brief.dataset.brief);
      if (lead) onBrief(lead);
      return;
    }
    if (card && !target.closest('select, option')) onSelect(card.dataset.lead!);
  });
  root.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (!select.dataset.override || !select.value) return;
    send({ type: 'lead.override', payload: { lead_id: select.dataset.override, action: select.value as Action } });
    select.value = '';
  });
}

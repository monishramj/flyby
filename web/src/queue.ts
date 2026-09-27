import { colors } from './map';
import { store, type Action, type Lead } from './store';
import { send } from './ws';

const ACTIONS: Action[] = ['dispatch_ground_team', 'reimage_zoom', 'close_in_inspect', 'ignore'];
export const LABELS: Record<string, string> = { dispatch_ground_team: 'Dispatch crew', reimage_zoom: 'Reimage (zoom)', close_in_inspect: 'Close-in inspect', ignore: 'Ignore' };
const URGENCY = ['low', 'moderate', 'high', 'critical'];
export const PENDING = ['awaiting_human', 'awaiting_approval'];
const CREW_ACTIONS = ['dispatch_ground_team', 'close_in_inspect'];
const CAMERA_TIP = "The drone detector's own score that this is a person.";
const PERSON_TIP = 'Share of past flags like this one (camera score, cover) that were real people.';
const person = (lead: Lead) => `<span class="person" title="${PERSON_TIP}">Person ${pct(lead.person_chance)}</span>`;

export const urgencyLabel = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${URGENCY[Math.min(3, Math.round(value))]} (${value.toFixed(1)})`);
export const pct = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`);
const clean = (value: string) => value.replace(/[<>&]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[character]!));
const words = (value: string) => value.replaceAll('_', ' ');

/** Likely people first, whether or not Laya was sure: then urgency, then camera score. */
export function rank(leads: Lead[]): Lead[] {
  const pending = leads.filter(lead => PENDING.includes(lead.status)).sort((a, b) =>
    (b.person_chance ?? 0) - (a.person_chance ?? 0)
    || (b.decision?.urgency ?? -1) - (a.decision?.urgency ?? -1)
    || b.detector_conf - a.detector_conf);
  // Leads the drone is working on stay visible, then dispatched ones (their brief is still reachable).
  const inFlight = leads.filter(lead => lead.status === 'reimaging' || lead.status === 'inspecting');
  const dispatched = leads.filter(lead => lead.status === 'dispatched').reverse();
  return [...pending, ...inFlight, ...dispatched];
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
    </header>
    <div class="tags">
        ${topPriority(lead) ? '<span class="tag human">top priority</span>' : ''}
        ${settled ? '' : '<span class="tag need">needs you</span>'}
        ${settled ? `<span class="tag done">${lead.status === 'reimaging' ? 'drone zooming' : lead.status === 'inspecting' ? 'drone inspecting' : words(lead.status)}</span>` : ''}
        ${lead.reranked ? '<span class="tag rerank">re-ranked</span>' : ''}
        ${decision?.used_fallback ? '<span class="tag warn">fallback</span>' : ''}
    </div>
    <p class="action" style="--tone:${colors[action]}">${LABELS[action]} <small>${source}</small></p>
    <p class="reason">${reason(lead)}</p>
    <p class="facts">${person(lead)} · ${urgency ? `<span class="urgency u${Math.min(3, Math.round(decision!.urgency!))}">${urgency}</span> · ` : ''}<span title="${CAMERA_TIP}">Camera ${pct(lead.detector_conf)}</span></p>
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

/** Top priority: waiting on you and likely a person, or rated critical. */
const topPriority = (lead: Lead) => PENDING.includes(lead.status) && ((lead.person_chance ?? 0) >= 0.5 || (lead.decision?.urgency ?? 0) >= 2.5);
const FILTERS = {
  all: { label: 'All', test: (_: Lead) => true },
  top: { label: 'Top priority', test: topPriority },
  needs: { label: 'Needs you', test: (lead: Lead) => PENDING.includes(lead.status) },
  drone: { label: 'With drone', test: (lead: Lead) => lead.status === 'reimaging' || lead.status === 'inspecting' },
  dispatched: { label: 'Dispatched', test: (lead: Lead) => lead.status === 'dispatched' },
};
type Filter = keyof typeof FILTERS | 'closed';
let tab: Filter = 'all';

function closedRow(lead: Lead): string {
  const risk = closedRisk(lead);
  return `<li class="${risk.length ? 'risky' : ''} ${store.selected === lead.lead_id ? 'selected' : ''}" data-lead="${lead.lead_id}">
    <b>${lead.lead_id}</b> ${person(lead)} <small>${lead.sector} · camera ${pct(lead.detector_conf)}</small>
    ${risk.map(item => `<span class="tag warn">${item}</span>`).join('')}
    <span class="row-actions"><button data-approve="${lead.lead_id}" class="ghost">Confirm ignore</button>
    <select data-override="${lead.lead_id}" aria-label="Reopen ${lead.lead_id}">
      <option value="">Reopen…</option>
      ${ACTIONS.filter(item => item !== 'ignore').map(item => `<option value="${item}">${LABELS[item]}</option>`).join('')}
    </select></span></li>`;
}

// Reading position: the open card stays put while cards arrive around it, and cards that land out of
// view raise a pill (top/bottom, like unread messages) that clears once they've been on screen.
const fresh = new Set<string>();
let known: Set<string> | null = null;
const scrollerOf = (root: HTMLElement) => root.closest('.work') as HTMLElement | null;
const cards = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('.card[data-lead]')];

function anchorOf(root: HTMLElement) {
  const scroller = scrollerOf(root);
  if (!scroller) return null;
  const view = scroller.getBoundingClientRect(), list = cards(root);
  const shown = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.bottom > view.top && r.top < view.bottom; };
  const el = list.find(card => card.classList.contains('selected') && shown(card)) ?? (scroller.scrollTop > 0 ? list.find(shown) : undefined);
  return el ? { id: el.dataset.lead!, top: el.getBoundingClientRect().top } : null;
}

function updatePills(root: HTMLElement) {
  const scroller = scrollerOf(root);
  if (!scroller) return;
  const view = scroller.getBoundingClientRect();
  let above = 0, below = 0;
  for (const id of [...fresh]) {
    const el = root.querySelector<HTMLElement>(`.card[data-lead="${id}"]`);
    if (!el) { fresh.delete(id); continue; }
    const r = el.getBoundingClientRect();
    if (!view.height || (r.bottom > view.top && r.top < view.bottom)) fresh.delete(id);  // seen
    else if (r.bottom <= view.top) above++; else below++;
  }
  for (const [dir, n] of [['up', above], ['down', below]] as const) {
    const pill = scroller.querySelector<HTMLButtonElement>(`[data-jump="${dir}"]`);
    if (!pill) continue;
    if (n) pill.textContent = `${n} new ${dir === 'up' ? 'above' : 'below'}`;
    pill.classList.toggle('on', n > 0); pill.tabIndex = n ? 0 : -1;
  }
}

export function renderQueue(root: HTMLElement) {
  const anchor = anchorOf(root);
  const leads = store.snapshot ? rank(store.snapshot.leads) : [];
  const closed = (store.snapshot?.leads ?? []).filter(lead => lead.status === 'auto_closed')
    .sort((a, b) => closedRisk(b).length - closedRisk(a).length || b.detector_conf - a.detector_conf);
  const flagged = closed.filter(lead => closedRisk(lead).length).length;
  // A filter shows only when it narrows the list: one that matches nothing, or everything, is just noise.
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([key, filter]) => [key, leads.filter(filter.test).length]));
  const useful = (Object.keys(FILTERS) as (keyof typeof FILTERS)[]).filter(key => key !== 'all' && counts[key] > 0 && counts[key] < leads.length);
  if (tab === 'closed' ? !closed.length : tab !== 'all' && !useful.includes(tab)) tab = 'all';
  const shown = tab === 'closed' ? [] : leads.filter(FILTERS[tab].test);
  const body = tab !== 'closed'
    ? (shown.length ? shown.map(card).join('') : '<p class="empty">Nothing needs you right now.</p>')
    : `<p class="closed-note">Laya was sure these are not people. Nothing is final until you confirm; new intel re-decides them.</p>
        <button class="primary confirm-all" data-confirm-closed>Confirm ${closed.length} as not a person</button>
        <ul class="closed-list">${closed.map(closedRow).join('')}</ul>`;
  const chip = (key: Filter, text: string) => `<button data-tab-work="${key}" class="${tab === key ? 'on' : ''}">${text}</button>`;
  const chips = [
    ...(useful.length || closed.length ? ['all' as const, ...useful] : []).map(key => chip(key, `${FILTERS[key].label} (${counts[key]})`)),
    closed.length ? chip('closed', `Auto-closed (${closed.length})${flagged ? ` <span class="warn">· ${flagged} flagged</span>` : ''}`) : '',
  ].join('');
  root.innerHTML = `${chips ? `<nav class="work-tabs">${chips}</nav>` : ''}${body}`;
  const scroller = scrollerOf(root), moved = anchor && root.querySelector<HTMLElement>(`.card[data-lead="${anchor.id}"]`);
  if (scroller && moved) scroller.scrollTop += moved.getBoundingClientRect().top - anchor.top;
  const ids = new Set(leads.map(lead => lead.lead_id));
  if (known) ids.forEach(id => { if (!known!.has(id) && tab !== 'closed') fresh.add(id); });
  known = ids; if (tab === 'closed') fresh.clear();
  updatePills(root);
}

export function bindQueue(root: HTMLElement, onSelect: (leadId: string) => void, onBrief: (lead: Lead) => void) {
  const scroller = scrollerOf(root);
  scroller?.addEventListener('scroll', () => updatePills(root), { passive: true });
  scroller?.addEventListener('click', event => {
    const pill = (event.target as HTMLElement).closest<HTMLElement>('[data-jump]');
    if (!pill) return;
    const view = scroller.getBoundingClientRect(), rects = [...fresh].map(id => root.querySelector<HTMLElement>(`.card[data-lead="${id}"]`)?.getBoundingClientRect()).filter(Boolean) as DOMRect[];
    const side = rects.filter(r => (pill.dataset.jump === 'up' ? r.bottom <= view.top : r.top >= view.bottom));
    const target = side.sort((a, b) => a.top - b.top)[0];
    if (target) scroller.scrollBy?.({ top: target.top - view.top - 12, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });
  root.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    const approve = target.closest('[data-approve]') as HTMLElement | null;
    const brief = target.closest('[data-brief]') as HTMLElement | null;
    const whyButton = target.closest('[data-why]') as HTMLElement | null;
    const card = target.closest('[data-lead]') as HTMLElement | null;
    const tabButton = target.closest('[data-tab-work]') as HTMLElement | null;
    if (tabButton) { tab = tabButton.dataset.tabWork as typeof tab; renderQueue(root); return; }
    if (target.closest('[data-confirm-closed]')) {
      // One human glance closes the batch; each lead still gets its own ordinary approval.
      (store.snapshot?.leads ?? []).filter(lead => lead.status === 'auto_closed')
        .forEach(lead => send({ type: 'lead.approve', payload: { lead_id: lead.lead_id } }));
      return;
    }
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

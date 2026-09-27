import { pct, urgencyLabel } from './queue';
import { store, type Intel, type Lead, type Proposal } from './store';

const clean = (value: string) => value.replace(/[<>&]/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[character]!));

function chips(row: Intel): string {
  if (row.ok === false) return '<span class="chip warn">parse unavailable</span>';
  if (!row.parse) return '<span class="chip pending">parsing…</span>';
  const parse = row.parse as { reports: Record<string, any>[]; unparseable: boolean };
  if (parse.unparseable || !parse.reports.length) return '<span class="chip muted">no located report</span>';
  return parse.reports.map(report => {
    const parts = [report.sector, (report.landmark || '').replaceAll('_', ' '),
      report.subject_count != null ? `${report.subject_count} subj` : '',
      report.urgency, report.source, report.is_retraction ? 'RETRACTION' : '',
      ...(report.hazards || [])].filter(Boolean);
    return `<span class="chip ${report.is_retraction ? 'warn' : ''}">${parts.map(clean).join(' · ')}</span>`;
  }).join('');
}

export function renderIntel(root: HTMLElement) {
  const rows = [...(store.snapshot?.intel ?? [])].reverse();
  root.innerHTML = rows.length
    ? rows.map(row => `<li><header><b>${row.intel_id}</b><time>t+${Math.round(row.t)}s</time></header>
        <p>${clean(row.raw)}</p><div class="chips">${chips(row)}</div></li>`).join('')
    : '<li class="empty">No radio traffic yet.</li>';
}

export function renderIncident(root: HTMLElement) {
  const picture = store.snapshot?.incident;
  if (!picture) { root.innerHTML = ''; return; }
  const priorities = Object.entries(picture.sector_priority);
  const hazards = [...new Set(picture.hazards.map(hazard => hazard.type))];
  root.innerHTML = `
    <div><dt>sector priority</dt><dd>${priorities.length ? priorities.map(([sector, urgency]) => `<span class="chip ${urgency}">${sector} ${urgency}</span>`).join('') : '—'}</dd></div>
    <div><dt>reported subjects</dt><dd>${Object.entries(picture.reported_subjects).map(([sector, count]) => `${sector}:${count}`).join(' ') || '—'}</dd></div>
    <div><dt>hazards</dt><dd>${hazards.map(hazard => `<span class="chip warn">${hazard.replaceAll('_', ' ')}</span>`).join('') || '—'}</dd></div>
    <div><dt>last known point</dt><dd>${picture.last_known_point ? (picture.last_known_point.landmark || 'sector centre').replaceAll('_', ' ') : '—'}</dd></div>`;
}

export function briefHtml(lead: Lead): string {
  const brief = lead.dispatch as any;
  if (!brief) return '<p>No brief has been written for this lead.</p>';
  const text = brief.text as Record<string, string>;
  return `<h3>${clean(text.headline)}</h3>
    <p class="source">${brief.source === 'grok' ? 'Text by Grok' : 'Template text'}${brief.digits_stripped ? ' · digits stripped from model text' : ''} · every number below is inserted by code</p>
    <dl class="facts">
      <div><dt>lead</dt><dd>${brief.lead_id} · pass ${lead.pass}</dd></div>
      <div><dt>position</dt><dd>${brief.coordinates.x.toFixed(1)} m E, ${brief.coordinates.y.toFixed(1)} m N (${brief.sector})</dd></div>
      <div><dt>nearest landmark</dt><dd>${(brief.nearest_landmark || '—').replaceAll('_', ' ')}</dd></div>
      <div><dt>P(person)</dt><dd>${pct(brief.p_person)}</dd></div>
      <div><dt>urgency</dt><dd>${urgencyLabel(brief.urgency)}</dd></div>
      <div><dt>mission time</dt><dd>t+${Math.round(brief.time)}s</dd></div>
    </dl>
    <h4>What the drone saw</h4><p>${clean(text.what_drone_saw)}</p>
    <h4>Access notes</h4><p>${clean(text.access_notes)}</p>
    <h4>Confidence</h4><p>${clean(text.confidence_statement)}</p>`;
}

export function renderAsk(root: HTMLElement, exchanges: { question: string; answer: string; tool_calls: any[] }[]) {
  root.innerHTML = exchanges.length
    ? exchanges.map((exchange, index) => `<li>
        <p class="question">${clean(exchange.question)}</p>
        <p class="answer">${linkLeads(clean(exchange.answer))}</p>
        ${exchange.tool_calls.length ? `<details ${index === exchanges.length - 1 ? 'open' : ''}>
          <summary>${exchange.tool_calls.length} tool call${exchange.tool_calls.length > 1 ? 's' : ''}</summary>
          <ol>${exchange.tool_calls.map(entry => `<li><b>${clean(entry.name)}</b>(${clean(JSON.stringify(entry.arguments))})
            <pre>${clean(JSON.stringify(entry.result, null, 1)).slice(0, 1200)}</pre></li>`).join('')}</ol>
        </details>` : '<p class="muted">No tools were called.</p>'}
      </li>`).join('')
    : '<li class="empty">Ask about coverage, pending leads, hazards, or decision statistics.</li>';
}

function linkLeads(text: string): string {
  const ids = new Set((store.snapshot?.leads ?? []).map(lead => lead.lead_id));
  return text.replace(/L-[A-Za-z0-9]+/g, match => (ids.has(match) ? `<a href="#" data-lead-link="${match}">${match}</a>` : match));
}

const KINDS: Record<Proposal['kind'], string> = { link_intel: 'Intel ↔ leads', possible_duplicate: 'Possible duplicate', note: 'Look at this' };
export const dismissed = new Set<string>();

/** Grok proposes; every number shown here is computed by the server, never by the model. */
export function renderAssistant(root: HTMLElement) {
  const rows = (store.snapshot?.proposals ?? []).filter(p => !dismissed.has(p.proposal_id)).reverse();
  root.innerHTML = rows.length
    ? rows.map(p => {
      const evidence = p.evidence;
      const facts = evidence.leads.map(lead => `<span class="chip" data-lead-link="${lead.lead_id}">${lead.lead_id} · ${lead.sector} · ${lead.status.replaceAll('_', ' ')}${lead.distance_to_landmark_m != null ? ` · ${Math.round(lead.distance_to_landmark_m)} m from ${(evidence.landmark ?? '').replaceAll('_', ' ')}` : ''}</span>`).join('');
      return `<li class="${store.highlight.join() === p.lead_ids.join() ? 'on' : ''}">
        <header><b>${KINDS[p.kind]}</b>${p.intel_id ? ` <small>${p.intel_id}</small>` : ''}<time>t+${Math.round(p.t)}s</time></header>
        <p>${clean(p.text)}</p>
        <div class="chips">${facts}${evidence.max_separation_m != null ? `<span class="chip muted">${evidence.max_separation_m} m apart</span>` : ''}</div>
        <footer><button class="primary" data-accept="${p.proposal_id}">Show leads</button><button class="ghost" data-dismiss="${p.proposal_id}">Dismiss</button></footer>
      </li>`;
    }).join('')
    : `<li class="empty">${store.snapshot?.config.PARSE_MODE === 'grok' ? 'Watching intel. Suggestions appear here; they never act on their own.' : 'The assistant runs when intel is parsed by Grok (PARSE_MODE=grok).'}</li>`;
}

/**
 * Executes the built bundle in a DOM and replays a recorded mission.
 *
 * The browser is the one part of this project no Python test can reach, so this
 * asserts the panels actually fill from server events instead of staying empty.
 *
 *   node test/render.mjs          (after: npm run build)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const fixture = JSON.parse(readFileSync(new URL('./fixture.json', import.meta.url)));
const dist = new URL('../dist/', import.meta.url);
const html = readFileSync(new URL('index.html', dist), 'utf8');
const bundleName = readdirSync(new URL('assets/', dist)).find(name => name.endsWith('.js'));
const bundle = readFileSync(new URL(`assets/${bundleName}`, dist), 'utf8');

const errors = [];
const sent = [];
let socket;

const dom = new JSDOM(html.replace(/<script[^>]*><\/script>/, ''), {
  url: 'http://127.0.0.1:8000/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const { window } = dom;

// jsdom has no 2D context or layout; the canvas calls are exercised, not rasterised.
// jsdom has no WebGL either: null makes three throw, which the app answers with its fallback note.
window.HTMLCanvasElement.prototype.getContext = function (type) { return type === '2d' ? new Proxy({}, {
  get: (target, key) => (key in target ? target[key] : (target[key] = () => new Proxy({}, { get: () => () => {} }))),
  set: () => true,
}) : null; };
Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => 720, configurable: true });
window.requestAnimationFrame = callback => window.setTimeout(() => callback(Date.now()), 0);
window.cancelAnimationFrame = id => window.clearTimeout(id);
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
window.WebSocket = class {
  static OPEN = 1;
  constructor(url) { this.url = url; this.readyState = 1; socket = this; }
  send(payload) { sent.push(JSON.parse(payload)); }
  close() { this.readyState = 3; }
};
window.fetch = async (url, options) => {
  if (String(url).includes('/api/ask')) return { ok: true, json: async () => fixture.ask };
  if (String(url).includes('summary.json')) {
    const summary = JSON.parse(readFileSync(new URL('../../results/summary.json', import.meta.url)));
    return { ok: true, json: async () => summary };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
window.addEventListener('error', event => errors.push(`error: ${event.error?.stack || event.message}`));
window.addEventListener('unhandledrejection', event => errors.push(`rejection: ${event.reason}`));
// jsdom cannot rasterise: three.js and chart.js log their context failures and the app degrades; expected here.
const expected = /Error creating WebGL context|can't acquire context/;
const consoleError = (...args) => { const message = args.join(' '); if (!expected.test(message)) errors.push(`console.error: ${message}`); };
window.console = { ...console, error: consoleError };

window.eval(bundle);

const text = id => window.document.getElementById(id).textContent.trim();
const count = selector => window.document.querySelectorAll(selector).length;
const tick = () => new Promise(resolve => window.setTimeout(resolve, 0));

assert.ok(socket, 'the client must open a websocket');
assert.match(socket.url, /\/ws\/mission$/, 'the client must connect to /ws/mission');
socket.onopen?.();
// The recording ends with every card settled (the simulated human approved them), so the approve
// click is taken mid-replay, the moment a lead first awaits approval.
let approveSent, overrideSent, offered;
for (const event of fixture.events) {
  socket.onmessage({ data: JSON.stringify(event) });
  if (!approveSent && event.type === 'lead.decided' && event.payload.status === 'awaiting_approval') {
    await tick();
    offered = count('#queue [data-approve]') > 0 && count('#queue [data-override]') > 0;
    const before = sent.length;
    window.document.querySelector('#queue [data-approve]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
    approveSent = sent.length > before ? sent.at(-1) : null;
    const overrideSelect = window.document.querySelector('#queue [data-override]');
    overrideSelect.value = 'ignore';
    overrideSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
    await tick();
    overrideSent = sent.at(-1);
  }
}
await tick();

const snapshot = fixture.events[0].payload;
const results = [];
const check = (name, condition, detail = '') => {
  results.push(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
};

check('header renders', text('status').includes('live'), text('status'));
check('mission meta renders', /t\+\d+s|search complete in \d+s/.test(text('mission-meta')), text('mission-meta'));
check('queue meta renders', /dispatched/.test(text('queue-meta')), text('queue-meta'));
check('queue has lead cards', count('#queue .card') > 0, `${count('#queue .card')} cards`);
check('cards show an action', count('#queue .card .action') > 0,
  window.document.querySelector('#queue .card .action')?.textContent);
check('cards offer approve and override', offered);
check('intel feed has messages', count('#intel li:not(.empty)') > 0, `${count('#intel li:not(.empty)')} messages`);
check('intel feed shows parsed chips', count('#intel .chip') > 0, `${count('#intel .chip')} chips`);
check('incident panel renders', text('incident').length > 0);
check('3D view mounts or explains why not', Boolean(window.document.getElementById('map')) &&
  (Boolean(window.document.querySelector('#labels .labels')) || /3D view unavailable/.test(text('labels'))));
check('view has camera modes and a truth toggle', count('[data-cam]') === 3 && Boolean(window.document.getElementById('truth')));

const dispatched = fixture.events.find(event => event.type === 'dispatch.created');
check('a dispatch was recorded in the fixture', Boolean(dispatched));

// Selecting a lead from the queue must highlight it without touching the server.
const firstCard = window.document.querySelector('#queue .card');
const selectedId = firstCard.dataset.lead;
firstCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick();
check('clicking a card selects it', Boolean(window.document.querySelector('#queue .card.selected')), selectedId);

// Approve goes over the websocket as a lead.approve command.
check('approve sends lead.approve', approveSent?.type === 'lead.approve', JSON.stringify(approveSent));

check('override sends lead.override', overrideSent?.type === 'lead.override', JSON.stringify(overrideSent));

// The brief modal is the only place dispatch text appears.
const briefButton = window.document.querySelector('#queue [data-brief]');
if (briefButton) {
  briefButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  const body = text('brief-body');
  check('brief modal opens with code-supplied numbers', /m E/.test(body) && /P\(person\)/.test(body),
    body.slice(0, 90).replace(/\s+/g, ' '));
} else {
  results.push('skip brief modal — no dispatched lead is still in the queue');
}

// Auto-closed leads live in their own tab at the top of the Work column, reviewable and reopenable.
{
  const tabs = () => [...window.document.querySelectorAll('#queue [data-tab-work]')];
  check('work column has Needs you / Auto-closed tabs', tabs().length === 2 && /Needs you \(\d+\)/.test(tabs()[0].textContent) &&
    /Auto-closed \(\d+\)/.test(tabs()[1].textContent), tabs().map(node => node.textContent.trim()).join(' | '));
  tabs()[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  check('auto-closed tab lists closed leads', count('#queue .closed-list li') > 0 && count('#queue .card') === 0, `${count('#queue .closed-list li')} closed`);
  const reopen = window.document.querySelector('#queue .closed-list [data-override]');
  reopen.value = 'dispatch_ground_team';
  reopen.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick();
  check('reopening an auto-closed lead sends lead.override', sent.at(-1).type === 'lead.override' &&
    sent.at(-1).payload.action === 'dispatch_ground_team', JSON.stringify(sent.at(-1)));
  tabs()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  check('back on Needs you, the cards return', count('#queue .card') > 0);
}

// Layout: the queue is the work surface; incident and intel are background, closed by default.
check('work column holds the queue', Boolean(window.document.querySelector('.work #queue')));
check('context drawer holds intel and incident, closed', Boolean(window.document.querySelector('#context #intel')) &&
  Boolean(window.document.querySelector('#context #incident')) && !window.document.getElementById('context').open,
  text('context-meta'));

// Cards explain themselves in plain words.
{
  const first = window.document.querySelector('#queue .card');
  check('cards give a code-written reason', first.querySelector('.reason').textContent.trim().length > 0,
    first.querySelector('.reason').textContent.trim());
  check('cards label the camera score', /Camera \d+%/.test(first.querySelector('.facts').textContent), first.querySelector('.facts').textContent.trim());
  first.querySelector('[data-why]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  const why = window.document.querySelector('#queue .card .why')?.textContent ?? '';
  check('Why? labels every action bar', ['Dispatch crew', 'Reimage (zoom)', 'Close-in inspect', 'Ignore'].every(name => why.includes(name)) && /\d+%/.test(why));
  check('Why? explains the numbers and marks P(person) experimental', why.includes('Camera score') && why.includes('experimental'));
  check('Why? shows what Laya read', why.includes('What Laya read') && why.includes('The detector is'));
}

// Grok writes the crew order for a pending dispatch; Approve sends the ordinary approval.
{
  const lead = window.document.querySelectorAll('#queue .card')[0].dataset.lead;
  const send = (type, payload) => socket.onmessage({ data: JSON.stringify({ type, payload }) });
  send('lead.status', { lead_id: lead, status: 'awaiting_approval' });
  const card = () => window.document.querySelector(`#queue .card[data-lead="${lead}"]`);
  const action = card().querySelector('.action').textContent.includes('Dispatch') ? 'dispatch_ground_team' : 'close_in_inspect';
  send('lead.order', { lead_id: lead, order: { pending: true, version: 1, action } });
  await tick();
  check('order shows while Grok writes it', card().querySelector('.order.pending') !== null);
  send('lead.order', { lead_id: lead, order: { version: 1, action, source: 'grok', text: {
    headline: 'Crew to Elm School', what_drone_saw: 'Clear person', access_notes: 'Approach from the west; downed line to the NE', confidence_statement: 'Verify on arrival' } } });
  await tick();
  check('Grok order renders on its card', card().querySelector('.order').textContent.includes('Approach from the west'));
  check('approve says it carries the order', /with order/.test(card().querySelector('[data-approve]').textContent));
  const before = sent.length;
  card().querySelector('[data-approve]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  check('approving with an order sends exactly lead.approve', sent.length === before + 1 &&
    sent.at(-1).type === 'lead.approve' && sent.at(-1).payload.lead_id === lead, JSON.stringify(sent.at(-1)));
}

// Controls must map to the documented commands.
window.document.getElementById('demo').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick();
check('Demo resets to the demo seed', sent.at(-1).type === 'mission.control' &&
  sent.at(-1).payload.seed === snapshot.config.DEMO_SEED, JSON.stringify(sent.at(-1)));
for (const [id, cmd] of [['start', 'start'], ['pause', 'pause'], ['reset', 'reset']]) {
  window.document.getElementById(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
  check(`${id} sends mission.control ${cmd}`, sent.at(-1).payload.cmd === cmd);
}

// Ask Ground Control is disabled in the UI.
// window.document.getElementById('ask-input').value = 'What is still unresolved in S3?';
// window.document.getElementById('ask-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
// await new Promise(resolve => window.setTimeout(resolve, 20));
// check('ask renders the answer', text('ask').includes('awaiting approval'), text('ask').slice(0, 80));
// check('ask renders a tool trace', count('#ask details') > 0 && text('ask').includes('list_leads'));
// check('ask links lead ids', count('#ask [data-lead-link]') >= 0);

// Results tab draws from results/summary.json only.
window.document.querySelector('[data-tab="results"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise(resolve => window.setTimeout(resolve, 60));
const resultsRoot = window.document.getElementById('tab-results');
check('results tab renders metric cards', resultsRoot.querySelectorAll('.cards article').length > 0,
  `${resultsRoot.querySelectorAll('.cards article').length} arms`);
check('results tab renders its charts', resultsRoot.querySelectorAll('canvas').length === 3);
check('results lead with the validating numbers', resultsRoot.firstElementChild.classList.contains('kpis') && resultsRoot.querySelectorAll('.kpi').length === 4,
  [...resultsRoot.querySelectorAll('.kpi h4')].map(node => node.textContent).join(' | '));
check('results tab shows declared assumptions', resultsRoot.textContent.includes('Declared assumptions'));
check('results tab shows the human load', /Flags that needed you/.test(resultsRoot.textContent) && /manual review: all \d+/.test(resultsRoot.textContent));
check('results tab shows a speedup', /\d+(\.\d+)?×/.test(resultsRoot.textContent));

console.log(results.join('\n'));
if (errors.length) {
  console.log('\nJavaScript errors:\n' + errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('\nNo JavaScript errors.');
}

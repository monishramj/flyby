// Live 3D connectome view beside the inspection flight (README Step 7.1 + 7.4). The flight
// hands every eye.layout and viz packet to attachReflexStream(); a VizStream decodes them and
// each new viz packet's deviations (45,669 flyvis nodes, native order = fly-brain's order, see
// data/flybrain_node_map.json) go straight to Connectome3D.setActivity().
//
// The view is built as soon as the page mounts it, before any flight, so the geometry build
// never stalls a flight. The flight never waits on it: if the assets fail, only this panel
// shows an error.
import { attachReflexStream } from '../scene/flight';
import { Connectome3D } from './connectome3d';
import { VizStream } from './stream';

const CSS = `
.flyby-live{display:grid;grid-template-rows:auto minmax(0,1fr);height:100%;min-height:320px;border:1px solid #2b3a4f;border-radius:8px;overflow:hidden;background:#05070b;font:12px/1.4 Inter,"Segoe UI",Arial,sans-serif}
.flyby-live .cap{padding:5px 10px;color:#a9b4c6;background:#0c1119;font-variant-numeric:tabular-nums}
.flyby-live .cap b{color:#1b1307;background:#e0a33c;border-radius:3px;padding:0 5px;margin-right:6px}
.flyby-live .cap b.off{background:#344337;color:#c9d3c7}
.flyby-live .stage{position:relative;min-height:0;overflow:hidden}
.flyby-live .stage canvas{display:block}
.flyby-live .err{padding:12px;color:#ef6a5b}
`;

/** Counters for checking that the view follows the flight (exposed for measurement). */
export interface LiveStats {
  vizReceived: number; // viz packets decoded from the reflex
  vizShown: number; // of those, passed to setActivity()
  lastK: number | null; // frame index of the newest viz shown
  loadMs: number | null; // Connectome3D.create() time; null until loaded
  error: string | null;
}

export interface LiveConnectome {
  readonly stream: VizStream;
  readonly stats: LiveStats;
  view(): Connectome3D | null;
}

export function mountLiveConnectome(host: HTMLElement): LiveConnectome {
  if (!document.getElementById('flyby-live-css')) {
    const style = document.createElement('style'); style.id = 'flyby-live-css'; style.textContent = CSS;
    document.head.appendChild(style);
  }
  host.innerHTML = '<div class="flyby-live"><div class="cap"></div><div class="stage"></div></div>';
  const cap = host.querySelector<HTMLDivElement>('.cap')!;
  const stage = host.querySelector<HTMLDivElement>('.stage')!;
  const setCap = (badge: string, text: string, live = false) => {
    cap.innerHTML = `<b class="${live ? '' : 'off'}">${badge}</b>`;
    cap.append(text);
  };

  const stream = new VizStream();
  const stats: LiveStats = { vizReceived: 0, vizShown: 0, lastK: null, loadMs: null, error: null };
  let view: Connectome3D | null = null;

  const show = () => {
    const h = stream.header, dev = stream.latest;
    if (!view || !h || !dev) return;
    try {
      view.setActivity(dev);
      stats.vizShown += 1;
      stats.lastK = h.k;
      setCap('LIVE', `live flyvis model activity from the reflex during this flight · frame ${h.k} · ` +
        `S ${h.S.toFixed(2)} · ${h.cmd.replace('_', ' ')}`, true);
    } catch (err) {
      setCap('OFF', `viz not shown: ${(err as Error).message}`);
    }
  };

  // Never throws into the reflex socket: a malformed viz packet is dropped, and a binary
  // message is never a command reply either way.
  attachReflexStream({
    handle(data) {
      let consumed: boolean;
      try {
        consumed = stream.handle(data);
      } catch (err) {
        console.warn('reflex viz message dropped:', err);
        return typeof data !== 'string';
      }
      if (consumed && typeof data !== 'string') {
        stats.vizReceived += 1;
        show();
      }
      return consumed;
    },
  });

  setCap('OFF', 'loading connectome…');
  Connectome3D.create(stage, { onStatus: (s) => { if (!view) setCap('OFF', `loading connectome: ${s}`); } })
    .then((v) => {
      view = v;
      stats.loadMs = v.stats.loadMs;
      if (stream.header) show();
      else setCap('READY', 'press Fly: neurons will show the reflex\'s live flyvis model activity during the flight');
    })
    .catch((err: Error) => {
      stats.error = err.message;
      setCap('OFF', 'connectome view unavailable');
      stage.innerHTML = '<p class="err"></p>';
      stage.firstElementChild!.textContent = `Could not load the 3D connectome (${err.message}). The flight is unaffected.`;
    });

  return { stream, stats, view: () => view };
}

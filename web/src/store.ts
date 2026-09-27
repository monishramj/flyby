export type Action = 'dispatch_ground_team' | 'reimage_zoom' | 'close_in_inspect' | 'ignore';
export interface Decision { action: Action; probs: Record<Action, number>; urgency: number | null; p_person: number | null; latency_ms: number; used_fallback: boolean; routed_to_human: boolean; source: string; version: number }
export interface Lead { lead_id: string; x: number; y: number; sector: string; pass: number; detector_conf: number; box_px: number; nearest_landmark: string; status: string; decision?: Decision; history: (Decision & { t: number })[]; dispatch?: Record<string, unknown>; reranked?: boolean; state?: { lead?: Record<string, any>; context?: Record<string, any> }; model_text?: string; order?: Order; person_chance?: number }
/** Grok's crew order for a pending dispatch or inspection: how to carry out the action Laya chose. */
export interface Order { action: Action; pending?: boolean; unavailable?: boolean; source?: string; text?: { headline: string; what_drone_saw: string; access_notes: string; confidence_statement: string } }
export interface Intel { intel_id: string; t: number; raw: string; parse?: { reports: Record<string, unknown>[]; unparseable: boolean }; ok?: boolean }
export interface Scene { area_m: number; sector_grid: number; houses: { x: number; y: number; width: number; height: number; kind: string }[]; water: { x: number; y: number; width: number; height: number; kind?: string }[]; trees: { x: number; y: number; radius: number }[]; gazetteer: Record<string, { x: number; y: number; label?: string; sector: string }> }
export interface Picture { sector_priority: Record<string, string>; reported_subjects: Record<string, number>; hazards: { type: string; x: number; y: number }[]; last_known_point?: { x: number; y: number; landmark?: string } | null }
export interface MissionState { t: number; drone: { x: number; y: number }; coverage_pct: number; coverage_cells: { x: number; y: number }[]; running: boolean; finished: boolean }
export interface Snapshot { run_id: string; seed: number; scene: Scene; leads: Lead[]; intel: Intel[]; incident: Picture; state: MissionState; config: { DEMO_SEED: number; TAU_ROUTE: number; SWEEP_DURATION_S: number; COVERAGE_CELL_M: number; LIVE_POLICY: string; PARSE_MODE: string; ALT_M: number; FOV_DEG: number; FOOTPRINT_M: number; SWEEP_PATH: { x: number; y: number }[] }; services: Record<string, string> }
export type ServerMessage = { type: 'mission.snapshot'; payload: Snapshot } | { type: 'mission.state'; payload: MissionState } | { type: 'lead.new'; payload: Lead } | { type: 'lead.decided'; payload: { lead_id: string; decision: Decision; status: string; lead?: Lead } } | { type: 'lead.status'; payload: { lead_id: string; status: string; lead?: Lead } } | { type: 'intel.new'; payload: Intel } | { type: 'intel.parsed'; payload: { intel_id: string; parse?: Intel['parse']; ok: boolean } } | { type: 'incident.update'; payload: Picture } | { type: 'dispatch.created'; payload: { lead_id: string; brief: Record<string, unknown>; pin: { x: number; y: number } } } | { type: 'inspect.request'; payload: { lead_id: string } } | { type: 'lead.order'; payload: { lead_id: string; order: Order } } | { type: 'error'; payload: { message: string } };
export interface Truth { run_id: string; subjects: { id: string; x: number; y: number; visibility: string }[]; decoys: { id: string; x: number; y: number; type: string }[] }
export const store = { truth: null as Truth | null, showTruth: false, snapshot: null as Snapshot | null, selected: '', connected: false, error: '', dispatched: '', log: [] as { lead_id: string; decision: Decision; t: number }[] };
const listeners = new Set<(type: string) => void>();
export const subscribe = (listener: (type: string) => void) => { listeners.add(listener); return () => listeners.delete(listener); };
export const notify = (type: string) => listeners.forEach(fn => fn(type));
export function receive(message: ServerMessage) {
  const { type, payload } = message;
  if (type === 'mission.snapshot') {
    store.snapshot = payload; store.selected = ''; store.error = '';
    store.log = payload.leads.flatMap(lead => lead.history.map(decision => ({ lead_id: lead.lead_id, decision, t: decision.t }))).sort((a, b) => a.t - b.t);
  } else if (type === 'error') store.error = payload.message;
  else if (store.snapshot) {
    const s = store.snapshot;
    // Coverage cells only arrive when they change, so state updates merge.
    if (type === 'mission.state') s.state = { ...s.state, ...payload };
    if (type === 'lead.new') { const i = s.leads.findIndex(l => l.lead_id === payload.lead_id); if (i < 0) s.leads.push(payload); else s.leads[i] = payload; }
    if (type === 'lead.decided' || type === 'lead.status') {
      const lead = s.leads.find(l => l.lead_id === payload.lead_id);
      if (lead) {
        if (type === 'lead.decided') {
          const old = lead.decision;
          lead.reranked = Boolean(old && (old.action !== payload.decision.action || old.urgency !== payload.decision.urgency));
          store.log.push({ lead_id: lead.lead_id, decision: payload.decision, t: s.state.t });
          lead.decision = payload.decision;
        }
        const reranked = lead.reranked;
        if (payload.lead) Object.assign(lead, payload.lead);
        lead.reranked = reranked; lead.status = payload.status;
      }
    }
    if (type === 'intel.new') s.intel.push(payload);
    if (type === 'intel.parsed') { const row = s.intel.find(i => i.intel_id === payload.intel_id); if (row) Object.assign(row, payload); }
    if (type === 'incident.update') s.incident = payload;
    if (type === 'lead.order') { const lead = s.leads.find(l => l.lead_id === payload.lead_id); if (lead) lead.order = payload.order; }
    if (type === 'dispatch.created') {
      const lead = s.leads.find(l => l.lead_id === payload.lead_id);
      if (lead) { lead.dispatch = payload.brief; store.dispatched = lead.lead_id; }
    }
  }
  notify(type);
}

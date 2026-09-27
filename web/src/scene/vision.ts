// Grok vision person check on the drone's close-in photo. Advisory only: the mission server
// asks Grok and returns what it reports; nothing about the lead or the flight changes.
export interface VisionReport {
  lead_id: string; person_visible: boolean; confidence: number; description: string; model: string; ms: number;
}

export async function askVision(leadId: string, image: string, timeoutMs = 20000): Promise<VisionReport> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/vision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: leadId, image }), signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try { detail = (await res.json()).detail ?? detail; } catch { /* keep status */ }
      throw new Error(detail);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

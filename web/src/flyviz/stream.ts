// Step 7.1 viz stream (README §4.7): decodes eye.layout and the viz binary from /ws/reflex.
// Feed every /ws/reflex message to VizStream.handle(); it returns false for anything else
// (command replies, acks, errors). The socket needs binaryType = 'arraybuffer'.

export const VIZ_HEADER_BYTES = 16;
export const HISTORY_S = 10;
export const VIZ_HZ = 10; // reflex/config.py VIZ_HZ
const DT_S = 0.02; // reflex/config.py DT_S (50 Hz frames); k * DT_S is frame time

/** Command byte in the viz header (reflex/viz.py CmdByte). */
export const CMD_BY_BYTE = ['none', 'brake', 'saccade_left', 'saccade_right', 'arrived'] as const;
export type VizCmd = (typeof CMD_BY_BYTE)[number];

export interface TypeEdge { src: string; dst: string; weight: number; sign: number }

/** Contents of data/flyvis_layout.json plus the reflex's current θ. */
export interface EyeLayout {
  type: 'eye.layout';
  types: string[];
  node_type: number[]; // index into types, native flyvis node order
  u: number[];
  v: number[];
  node_col: number[];
  col_u: number[];
  col_v: number[];
  col_x: number[]; // image position, x right
  col_y: number[]; // image position, y up
  receptor_types: string[];
  t4t5_types: string[];
  subtype_dir: Record<string, string>;
  type_edges: TypeEdge[];
  S_theta: number | null;
}

export interface VizHeader { k: number; S: number; dLR: number; cmd: VizCmd }

/** IEEE 754 binary16 → number, written out by hand (no Float16Array). */
export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24; // zero and subnormals
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

let HALF_TABLE: Float32Array | null = null;
function halfTable(): Float32Array {
  if (!HALF_TABLE) {
    HALF_TABLE = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) HALF_TABLE[h] = halfToFloat(h);
  }
  return HALF_TABLE;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Decode one viz message. `out` is reused when it already has the right length. */
export function decodeViz(buf: ArrayBuffer, out?: Float32Array): { header: VizHeader; deviations: Float32Array } {
  if (buf.byteLength < VIZ_HEADER_BYTES || (buf.byteLength - VIZ_HEADER_BYTES) % 2) {
    throw new Error(`viz message has invalid length ${buf.byteLength}`);
  }
  const view = new DataView(buf);
  const cmdByte = view.getUint8(12);
  const cmd = CMD_BY_BYTE[cmdByte];
  if (cmd === undefined) throw new Error(`unknown viz command byte ${cmdByte}`);
  const header = { k: view.getUint32(0, true), S: view.getFloat32(4, true), dLR: view.getFloat32(8, true), cmd };
  const n = (buf.byteLength - VIZ_HEADER_BYTES) / 2;
  const deviations = out && out.length === n ? out : new Float32Array(n);
  const table = halfTable();
  if (LITTLE_ENDIAN) {
    const halves = new Uint16Array(buf, VIZ_HEADER_BYTES, n);
    for (let i = 0; i < n; i++) deviations[i] = table[halves[i]];
  } else {
    for (let i = 0; i < n; i++) deviations[i] = table[view.getUint16(VIZ_HEADER_BYTES + 2 * i, true)];
  }
  return { header, deviations };
}

/** Holds the layout, the latest deviation vector and a ring buffer of S and dLR. */
export class VizStream {
  layout: EyeLayout | null = null;
  latest: Float32Array | null = null; // deviation from rest per flyvis node; updated in place
  header: VizHeader | null = null;
  private readonly cap = HISTORY_S * VIZ_HZ;
  private readonly ringT = new Float64Array(this.cap); // frame time k * DT_S
  private readonly ringS = new Float32Array(this.cap);
  private readonly ringDLR = new Float32Array(this.cap);
  private readonly ringCmd = new Uint8Array(this.cap);
  private head = 0; // next slot to write
  private count = 0;

  /** Returns true if the message was eye.layout or viz; false for commands, acks and errors. */
  handle(data: string | ArrayBuffer): boolean {
    if (typeof data === 'string') {
      if (!data.startsWith('{"type"')) return false;
      const msg = JSON.parse(data);
      if (msg.type !== 'eye.layout') return false;
      this.layout = msg as EyeLayout;
      return true;
    }
    const { header, deviations } = decodeViz(data, this.latest ?? undefined);
    if (this.layout && deviations.length !== this.layout.node_type.length) {
      throw new Error(`viz has ${deviations.length} values; layout has ${this.layout.node_type.length} nodes`);
    }
    this.push(header);
    this.latest = deviations;
    this.header = header;
    return true;
  }

  /** S, dLR and cmd over the last HISTORY_S seconds of frame time, oldest first. */
  history(): { t: Float64Array; S: Float32Array; dLR: Float32Array; cmd: VizCmd[] } {
    const idx: number[] = [];
    const newest = this.ringT[(this.head - 1 + this.cap) % this.cap];
    for (let j = 0; j < this.count; j++) {
      const i = (this.head - this.count + j + this.cap) % this.cap;
      if (this.ringT[i] > newest - HISTORY_S) idx.push(i);
    }
    return {
      t: Float64Array.from(idx, (i) => this.ringT[i]),
      S: Float32Array.from(idx, (i) => this.ringS[i]),
      dLR: Float32Array.from(idx, (i) => this.ringDLR[i]),
      cmd: idx.map((i) => CMD_BY_BYTE[this.ringCmd[i]]),
    };
  }

  clearHistory() {
    this.head = 0;
    this.count = 0;
  }

  private push(h: VizHeader) {
    const t = h.k * DT_S;
    if (this.count && t <= this.ringT[(this.head - 1 + this.cap) % this.cap]) this.clearHistory(); // new episode
    this.ringT[this.head] = t;
    this.ringS[this.head] = h.S;
    this.ringDLR[this.head] = h.dLR;
    this.ringCmd[this.head] = CMD_BY_BYTE.indexOf(h.cmd);
    this.head = (this.head + 1) % this.cap;
    this.count = Math.min(this.count + 1, this.cap);
  }
}

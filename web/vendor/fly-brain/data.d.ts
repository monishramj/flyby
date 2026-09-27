// FlyBy type declarations for the vendored fly-brain loader (data.js). Not part of upstream.
export interface NeuronTable {
  N: number;
  bodyIds: BigInt64Array;
  /** soma position in 8 nm voxels, NaN when missing (xyz per neuron) */
  soma: Float32Array;
  cls: Uint16Array;
  nt: Uint8Array;
  superclass: Uint8Array;
  /** 0 unknown, 1 L, 2 R, 3 midline */
  side: Uint8Array;
}

export interface Skeletons {
  N: number;
  V: number;
  /** vertex xyz in µm */
  pos: Float32Array;
  /** line-segment vertex pairs */
  seg: Uint32Array;
  /** vertices of neuron n are vOff[n] .. vOff[n + 1] - 1 */
  vOff: Uint32Array;
  /** [xmin, ymin, zmin, xmax, ymax, zmax] in µm */
  bbox: number[];
}

export function loadNeurons(onStatus?: (s: string) => void): Promise<NeuronTable>;
export function loadSkeletons(onStatus?: (s: string) => void): Promise<Skeletons>;

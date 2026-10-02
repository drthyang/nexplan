/**
 * Experiment page state, kept in App so it survives tab switches. It holds no
 * instrument data: the presets are experimental and load with the page.
 */
export interface ExperimentState {
  readonly instrumentId: string;
  /** Goniometer angles (deg), one per axis of the instrument's goniometer. */
  readonly angles: readonly number[];
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  /** Rotation scan over one axis (single crystal). */
  readonly scan: { readonly axis: number; readonly start: number; readonly end: number; readonly step: number };
  /** Powder: the panel whose pattern is simulated (null = the one nearest 2θ = 90°). */
  readonly panel: number | null;
  /** Powder: relative resolution Δd/d (FWHM) of the simulated pattern. */
  readonly dOverD: number;
}

export const DEFAULT_EXPERIMENT: ExperimentState = {
  instrumentId: "topaz-cryo",
  angles: [0, 0, 0],
  lambdaMin: 0.4,
  lambdaMax: 3.5,
  scan: { axis: 0, start: 0, end: 360, step: 5 },
  panel: null,
  dOverD: 0.005,
};

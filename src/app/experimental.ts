/**
 * Experimental features: instrument presets with detector geometry (TOPAZ,
 * CORELLI, NOMAD, POWGEN). On in the dev server and in builds made with
 * VITE_EXPERIMENTAL=1; otherwise Vite replaces this with `false` and the
 * dynamically imported experimental module is left out of the build.
 */
export const EXPERIMENTAL: boolean = import.meta.env.DEV || import.meta.env.VITE_EXPERIMENTAL === "1";

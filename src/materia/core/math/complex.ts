// Copied from MATERIA (drthyang/web-refinement) src/core/math/complex.ts @ 0ee9a7e. Do not edit; see scripts/materia-sync.ts.
import type { Complex } from "@materia/core/math/types";

export const ZERO: Complex = { re: 0, im: 0 };

export function add(a: Complex, b: Complex): Complex {
  return { re: a.re + b.re, im: a.im + b.im };
}

export function scale(a: Complex, s: number): Complex {
  return { re: a.re * s, im: a.im * s };
}

/** e^{iθ} = cosθ + i·sinθ. */
export function expι(theta: number): Complex {
  return { re: Math.cos(theta), im: Math.sin(theta) };
}

export function modulusSquared(a: Complex): number {
  return a.re * a.re + a.im * a.im;
}


import { useLayoutEffect, useState } from "react";

/**
 * Width of a chart's wrapper, for drawing SVG at its displayed size: measured
 * synchronously when the wrapper mounts (no first frame at a guessed width, and
 * correct even before the page is painted), then on resize. A callback ref, so
 * a wrapper that mounts after the first render is still measured.
 */
export function useMeasuredWidth<T extends HTMLElement = HTMLDivElement>(initial: number, min: number): { ref: (el: T | null) => void; el: T | null; width: number } {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    if (!el) return;
    const set = (w: number) => setWidth(Math.max(min, Math.round(w)));
    set(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => set(e!.contentRect.width));
    ro.observe(el);
    const onResize = () => set(el.getBoundingClientRect().width);
    window.addEventListener("resize", onResize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [el, min]);
  return { ref: setEl, el, width };
}

/**
 * The root type size in px (15 px on 1080p-class windows, up to 21 px at 4K; see tokens.css), so chart heights can
 * grow with the type instead of turning into thin strips on large monitors. A height of 480 px at 15 px becomes
 * 672 px at 21 px.
 */
export function typeScale(): number {
  if (typeof document === "undefined") return 1;
  return (parseFloat(getComputedStyle(document.documentElement).fontSize) || 15) / 15;
}

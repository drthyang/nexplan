/**
 * Column sorting for the reflection tables: click a header to sort by it, click
 * again to reverse. The first click puts the largest values first for d and
 * intensity-like columns, the smallest first otherwise. Sorting is stable, so
 * ties keep the table's default order.
 */
import { useState, type ReactNode } from "react";
import { cx } from "./components.tsx";

export type SortDir = "asc" | "desc";

export interface Sort<K extends string> {
  readonly key: K;
  readonly dir: SortDir;
}

/**
 * The chosen order, falling back to `initial` while the chosen column is hidden
 * (e.g. 2θ when a TOF bank is shown); the choice comes back with the column.
 */
export function useSort<K extends string>(initial: Sort<K>, firstDir: Partial<Record<K, SortDir>>, shown: (key: K) => boolean = () => true) {
  const [chosen, setChosen] = useState(initial);
  const sort = shown(chosen.key) ? chosen : initial;
  const onSort = (key: K) => setChosen(sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDir[key] ?? "asc" });
  return [sort, onSort] as const;
}

/** NaN marks a "—" cell (no value); those rows go last in either direction. */
export function byNumber(a: number, b: number, dir: SortDir): number {
  const na = Number.isNaN(a);
  const nb = Number.isNaN(b);
  if (na || nb) return na === nb ? 0 : na ? 1 : -1;
  return dir === "asc" ? a - b : b - a;
}

/** h, then k, then l. */
export function byHkl(a: ArrayLike<number>, b: ArrayLike<number>, dir: SortDir): number {
  for (let j = 0; j < 3; j++) {
    const c = byNumber(a[j]!, b[j]!, dir);
    if (c !== 0) return c;
  }
  return 0;
}

/** Natural order ("bank2" before "bank10"); undefined (e.g. a ray that misses) goes last. */
export function byText(a: string | undefined, b: string | undefined, dir: SortDir): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  const c = a.localeCompare(b, undefined, { numeric: true });
  return dir === "asc" ? c : -c;
}

/**
 * A header cell that sorts its table. The arrow sits before the label in
 * right-aligned (numeric) columns so the label stays flush with the numbers.
 */
export function SortTh<K extends string>({ id, sort, onSort, left, children }: { id: K; sort: Sort<K>; onSort: (key: K) => void; left?: boolean; children: ReactNode }) {
  const active = sort.key === id;
  const arrow = (
    <span className="th-sort__arrow" aria-hidden="true">
      {active && sort.dir === "asc" ? "▲" : "▼"}
    </span>
  );
  return (
    <th className={cx(left && "left")} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className={cx("th-sort", active && "is-active")} onClick={() => onSort(id)}>
        {left ? null : arrow}
        {children}
        {left ? arrow : null}
      </button>
    </th>
  );
}

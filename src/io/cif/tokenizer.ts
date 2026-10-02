/**
 * CIF 1.1 tokenizer and block parser (Hall, Allen & Brown 1991; CIF 1.1 syntax,
 * https://www.iucr.org/resources/cif/spec/version1.1/cifsyntax).
 *
 * Handles comments, single/double-quoted strings (closed only by a quote that is
 * followed by whitespace or end of line), semicolon text fields, loops whose rows
 * span lines, and the distinct special values `.` (inapplicable) and `?` (unknown).
 * CIF 2.0 files are rejected rather than half-read.
 */

export interface CifValue {
  readonly text: string;
  /** Unquoted `.`: inapplicable. Unquoted `?`: unknown. Quoted `'.'` is the literal text. */
  readonly special?: "inapplicable" | "unknown";
  readonly quoted: boolean;
  readonly line: number;
}

export interface CifLoop {
  readonly tags: readonly string[];
  readonly rows: readonly (readonly CifValue[])[];
  readonly line: number;
}

export interface CifBlock {
  readonly name: string;
  readonly line: number;
  /** Non-loop items keyed by lower-case tag. */
  readonly items: ReadonlyMap<string, CifValue>;
  readonly loops: readonly CifLoop[];
}

export class CifSyntaxError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`CIF line ${line}: ${message}`);
    this.line = line;
  }
}

type Token =
  | { kind: "data"; name: string; line: number }
  | { kind: "loop"; line: number }
  | { kind: "save"; name: string; line: number }
  | { kind: "reserved"; word: string; line: number }
  | { kind: "tag"; name: string; line: number }
  | { kind: "value"; value: CifValue };

const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === undefined;

export function tokenize(text: string): Token[] {
  if (/^﻿?#\\#CIF_2\.0/.test(text)) {
    throw new CifSyntaxError("CIF 2.0 files are not supported; export as CIF 1.1", 1);
  }
  const src = text.replace(/\r\n?/g, "\n");
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // Semicolon text field: ';' in column 1.
    if (c === ";" && (i === 0 || src[i - 1] === "\n")) {
      const startLine = line;
      const end = src.indexOf("\n;", i);
      if (end < 0) throw new CifSyntaxError("unterminated semicolon text field", startLine);
      const body = src.slice(i + 1, end);
      for (const ch of body) if (ch === "\n") line++;
      line++; // the newline before the closing ';'
      tokens.push({ kind: "value", value: { text: body.replace(/^\n/, ""), quoted: true, line: startLine } });
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      // Closed by the same quote followed by whitespace or end of line.
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\n") throw new CifSyntaxError(`unterminated ${c === "'" ? "single" : "double"}-quoted string`, line);
        if (src[j] === c && isWs(src[j + 1])) break;
        j++;
      }
      if (j >= n) throw new CifSyntaxError("unterminated quoted string", line);
      tokens.push({ kind: "value", value: { text: src.slice(i + 1, j), quoted: true, line } });
      i = j + 1;
      continue;
    }
    // Bare word.
    let j = i;
    while (j < n && !isWs(src[j])) j++;
    const word = src.slice(i, j);
    i = j;
    const lower = word.toLowerCase();
    if (lower.startsWith("data_")) tokens.push({ kind: "data", name: word.slice(5), line });
    else if (lower === "loop_") tokens.push({ kind: "loop", line });
    else if (lower.startsWith("save_")) tokens.push({ kind: "save", name: word.slice(5), line });
    else if (lower === "global_" || lower === "stop_") tokens.push({ kind: "reserved", word: lower, line });
    else if (word.startsWith("_")) tokens.push({ kind: "tag", name: lower, line });
    else if (word.startsWith("[") || word.startsWith("]") || word.startsWith("$")) {
      throw new CifSyntaxError(`a bare value may not start with '${word[0]}' ('${word}')`, line);
    } else {
      const special = word === "." ? "inapplicable" : word === "?" ? "unknown" : undefined;
      tokens.push({ kind: "value", value: { text: word, quoted: false, line, ...(special ? { special } : {}) } });
    }
  }
  return tokens;
}

/** Parse CIF 1.1 text into data blocks. Save frames (dictionaries) are rejected. */
export function parseCifBlocks(text: string): CifBlock[] {
  const tokens = tokenize(text);
  const blocks: CifBlock[] = [];
  let current: { name: string; line: number; items: Map<string, CifValue>; loops: CifLoop[]; seen: Set<string> } | undefined;
  let k = 0;
  const requireBlock = (line: number) => {
    if (!current) throw new CifSyntaxError("data item before the first data_ block", line);
    return current;
  };
  const claim = (tag: string, line: number) => {
    const b = requireBlock(line);
    if (b.seen.has(tag)) throw new CifSyntaxError(`duplicate data name ${tag} in block ${b.name}`, line);
    b.seen.add(tag);
  };
  while (k < tokens.length) {
    const t = tokens[k]!;
    if (t.kind === "data") {
      if (current) blocks.push(current);
      if (blocks.some((b) => b.name.toLowerCase() === t.name.toLowerCase())) throw new CifSyntaxError(`duplicate block name data_${t.name}`, t.line);
      current = { name: t.name, line: t.line, items: new Map(), loops: [], seen: new Set() };
      k++;
    } else if (t.kind === "save") {
      throw new CifSyntaxError("save frames are not supported in structure files", t.line);
    } else if (t.kind === "reserved") {
      throw new CifSyntaxError(`reserved word ${t.word} is not allowed here`, t.line);
    } else if (t.kind === "tag") {
      claim(t.name, t.line);
      const v = tokens[k + 1];
      if (!v || v.kind !== "value") throw new CifSyntaxError(`data name ${t.name} has no value`, t.line);
      current!.items.set(t.name, v.value);
      k += 2;
    } else if (t.kind === "loop") {
      const b = requireBlock(t.line);
      k++;
      const tags: string[] = [];
      while (k < tokens.length && tokens[k]!.kind === "tag") {
        const tag = tokens[k] as { kind: "tag"; name: string; line: number };
        claim(tag.name, tag.line);
        tags.push(tag.name);
        k++;
      }
      if (tags.length === 0) throw new CifSyntaxError("loop_ without data names", t.line);
      const values: CifValue[] = [];
      while (k < tokens.length && tokens[k]!.kind === "value") {
        values.push((tokens[k] as { kind: "value"; value: CifValue }).value);
        k++;
      }
      if (values.length === 0) throw new CifSyntaxError(`loop starting ${tags[0]} has no values`, t.line);
      if (values.length % tags.length !== 0) {
        throw new CifSyntaxError(`loop starting ${tags[0]} has ${values.length} values, not a multiple of its ${tags.length} data names`, t.line);
      }
      const rows: CifValue[][] = [];
      for (let r = 0; r < values.length; r += tags.length) rows.push(values.slice(r, r + tags.length));
      b.loops.push({ tags, rows, line: t.line });
    } else {
      throw new CifSyntaxError(`value '${t.value.text}' without a data name`, t.value.line);
    }
  }
  if (current) blocks.push(current);
  if (blocks.length === 0) throw new CifSyntaxError("no data_ block found", 1);
  return blocks;
}

/** Find the loop containing `tag` in a block. */
export function findLoop(block: CifBlock, tag: string): CifLoop | undefined {
  return block.loops.find((l) => l.tags.includes(tag));
}

/** A single value by tag, whether a plain item or a one-row loop. */
export function getValue(block: CifBlock, tag: string): CifValue | undefined {
  const item = block.items.get(tag);
  if (item) return item;
  const loop = findLoop(block, tag);
  if (loop && loop.rows.length === 1) return loop.rows[0]![loop.tags.indexOf(tag)];
  return undefined;
}

export interface NumberWithSu {
  readonly value: number;
  readonly su?: number;
}

/**
 * Parse a CIF numeric value with optional standard uncertainty in parentheses,
 * e.g. `5.4310(2)` → {5.431, 0.0002}, `120` → {120}, `1.2e-3(4)` → {0.0012, 0.0004}.
 * Returns undefined for `.`/`?`; throws for non-numeric text.
 */
export function parseNumber(v: CifValue | undefined): NumberWithSu | undefined {
  if (!v || v.special) return undefined;
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))(?:[eE]([-+]?\d+))?(?:\((\d+)\))?$/.exec(v.text.trim());
  if (!m) throw new CifSyntaxError(`'${v.text}' is not a number`, v.line);
  const mant = m[1]!;
  const exp = m[2] ? Number(m[2]) : 0;
  const value = Number(mant) * 10 ** exp;
  if (!Number.isFinite(value)) throw new CifSyntaxError(`'${v.text}' is not finite`, v.line);
  if (m[3] === undefined) return { value };
  const dot = mant.indexOf(".");
  const decimals = dot < 0 ? 0 : mant.length - dot - 1;
  return { value, su: Number(m[3]) * 10 ** (exp - decimals) };
}

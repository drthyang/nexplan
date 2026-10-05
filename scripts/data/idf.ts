/**
 * Minimal reader for Mantid Instrument Definition Files (IDF), enough to
 * flatten detector geometry into planar panels. Semantics follow Mantid's
 * docs/source/concepts/InstrumentDefinitionFile.rst (mantid @ 67c2f43):
 *
 *  - <location x y z> or spherical <location r t p> (t from +z toward +x,
 *    p the azimuth in the xy plane); position is relative to the parent and
 *    expressed in the parent's (rotated) frame.
 *  - Rotations: the location's own rot/axis-* attributes, then nested <rot>
 *    elements; "the outermost is applied first followed by the 2nd outermost
 *    … (of the frame which has just been rotated)", i.e. intrinsic rotations,
 *    R = R_outer·R_next·…; a <rot> without axis-* attributes turns about z.
 *  - type is="rectangular_detector": pixel (i, j) at (xstart + i·xstep,
 *    ystart + j·ystep, 0) in the panel frame.
 *  - type is="detector": a pixel leaf at the component origin.
 *  - Detector IDs: a component's idlist hands its IDs (<id start end step>
 *    or <id val>) to the detectors and monitors below it in document order,
 *    and must be used up exactly. A rectangular detector numbers pixel (i, j)
 *    from its component's idstart: filled along y first (idfillbyfirst="y",
 *    the default), id = idstart + i·idstepbyrow + j·idstep, else
 *    id = idstart + j·idstepbyrow + i·idstep (idstep defaults to 1).
 *
 * Output panels are in the Mantid lab frame (beam +z, up +y), metres, each
 * with its detector IDs as a linear map of (column, row), checked pixel by
 * pixel, and IDs unique across the instrument.
 */

export interface XmlNode {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
}

/** Parse well-formed XML without DTDs: elements, attributes, comments, PIs. Text is ignored. */
export function parseXml(text: string): XmlNode {
  const src = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  const root: XmlNode = { name: "#root", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [, closing, name, attrText, selfClose] = m;
    if (closing) {
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`IDF XML: mismatched </${name}>`);
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]!] = a[2] ?? a[3] ?? "";
    const node: XmlNode = { name: name!, attrs, children: [] };
    stack[stack.length - 1]!.children.push(node);
    if (!selfClose) stack.push(node);
  }
  if (stack.length !== 1) throw new Error(`IDF XML: unclosed <${stack[stack.length - 1]!.name}>`);
  return root;
}

type V3 = [number, number, number];
type M3 = [V3, V3, V3];
interface Frame {
  readonly R: M3;
  readonly t: V3;
}

const I3: M3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const mm = (A: M3, B: M3): M3 => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[i]![0] * B[0]![j]! + A[i]![1] * B[1]![j]! + A[i]![2] * B[2]![j]!)) as M3;
const mv = (A: M3, v: V3): V3 => [A[0][0] * v[0] + A[0][1] * v[1] + A[0][2] * v[2], A[1][0] * v[0] + A[1][1] * v[1] + A[1][2] * v[2], A[2][0] * v[0] + A[2][1] * v[1] + A[2][2] * v[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));

function axisRot(axis: V3, deg: number): M3 {
  const [x, y, z] = norm(axis);
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const C = 1 - c;
  return [
    [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
    [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
    [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
  ];
}

const num = (s: string | undefined, d = 0) => (s === undefined ? d : Number(s));
const axisOf = (a: Readonly<Record<string, string>>): V3 =>
  a["axis-x"] === undefined && a["axis-y"] === undefined && a["axis-z"] === undefined ? [0, 0, 1] : [num(a["axis-x"]), num(a["axis-y"]), num(a["axis-z"])];

/** Local frame of one <location>: translation in the parent frame and rotation of the child frame. */
function locationFrame(loc: XmlNode): Frame {
  const a = loc.attrs;
  let t: V3;
  if (a.r !== undefined || a.t !== undefined || a.p !== undefined) {
    const r = num(a.r);
    const th = (num(a.t) * Math.PI) / 180;
    const ph = (num(a.p) * Math.PI) / 180;
    t = [r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)];
  } else t = [num(a.x), num(a.y), num(a.z)];
  let R: M3 = a.rot !== undefined ? axisRot(axisOf(a), num(a.rot)) : I3;
  let node: XmlNode | undefined = loc.children.find((c) => c.name === "rot");
  while (node) {
    R = mm(R, axisRot(axisOf(node.attrs), num(node.attrs.val)));
    node = node.children.find((c) => c.name === "rot");
  }
  if (loc.children.some((c) => c.name === "trans") || loc.children.some((c) => c.name === "facing") || loc.attrs.facing !== undefined) {
    throw new Error("IDF: <trans> and <facing> are not supported by this reader");
  }
  return { R, t };
}

const compose = (parent: Frame, local: Frame): Frame => ({ R: mm(parent.R, local.R), t: add(parent.t, mv(parent.R, local.t)) });

export interface Panel {
  readonly name: string;
  readonly kind: "rectangular" | "tube-pack";
  readonly center: V3;
  /** Unit vector along increasing column (pixel x / tube index). */
  readonly base: V3;
  /** Unit vector along increasing row (pixel y / along the tube). */
  readonly up: V3;
  readonly width: number;
  readonly height: number;
  readonly nCols: number;
  readonly nRows: number;
  /** Largest pixel distance from the fitted plane (m); 0 for rectangular detectors. */
  readonly planarity: number;
  /** Detector IDs: id = ids[0] + column·ids[1] + row·ids[2] (columns and rows from 0). */
  readonly ids: readonly [number, number, number];
}

export interface InstrumentGeometry {
  readonly name: string;
  readonly l1: number;
  readonly panels: readonly Panel[];
}

/**
 * Flatten an IDF into panels. Rectangular detectors map exactly. Pixel-tube
 * detectors are grouped per pack (the instance two levels above a pixel:
 * pack → tube → pixel) and fitted with a rectangle: rows along the tubes,
 * columns across them. A pack is named after its nearest ancestor whose name
 * contains "bank", else its own path.
 */
export function flattenIdf(xml: string): InstrumentGeometry {
  const root = parseXml(xml).children.find((c) => c.name === "instrument");
  if (!root) throw new Error("IDF: no <instrument> element");
  const types = new Map<string, XmlNode>();
  for (const c of root.children) if (c.name === "type" && c.attrs.name) types.set(c.attrs.name, c);
  const kind = (t: XmlNode | undefined) => (t?.attrs.is ?? "").toLowerCase().replace(/_/g, "");

  const panels: Panel[] = [];
  const pixels: { pos: V3; path: string[]; id: number | undefined }[] = [];
  let l1 = NaN;
  const empty: XmlNode = { name: "location", attrs: {}, children: [] };

  const idlists = new Map<string, number[]>();
  for (const c of root.children) {
    if (c.name !== "idlist" || !c.attrs.idname) continue;
    const list: number[] = [];
    for (const id of c.children.filter((x) => x.name === "id")) {
      if (id.attrs.val !== undefined) list.push(num(id.attrs.val));
      else for (let v = num(id.attrs.start), step = num(id.attrs.step ?? "1"); v <= num(id.attrs.end); v += step) list.push(v);
    }
    idlists.set(c.attrs.idname, list);
  }
  let cursor: { name: string; list: number[]; next: number } | undefined;

  const visit = (typeName: string, frame: Frame, path: string[], comp: Record<string, string> = {}) => {
    const t = types.get(typeName);
    if (!t) return;
    const k = kind(t);
    if (k === "source") l1 = Math.hypot(...frame.t);
    if (k === "rectangulardetector") {
      const a = t.attrs;
      const nx = num(a.xpixels);
      const ny = num(a.ypixels);
      const xs = num(a.xstep);
      const ys = num(a.ystep);
      // Pixel (i, j) is column i, row j: `base` follows the sign of xstep, `up` that of ystep.
      const byY = (comp.idfillbyfirst ?? "y") === "y";
      const step = num(comp.idstep ?? "1");
      const byRow = num(comp.idstepbyrow ?? String(byY ? ny * step : nx * step));
      const ids: [number, number, number] = [num(comp.idstart ?? "0"), byY ? byRow : step, byY ? step : byRow];
      const cLocal: V3 = [num(a.xstart) + ((nx - 1) * xs) / 2, num(a.ystart) + ((ny - 1) * ys) / 2, 0];
      panels.push({
        name: path[path.length - 1] ?? typeName,
        kind: "rectangular",
        center: add(frame.t, mv(frame.R, cLocal)),
        base: norm(mv(frame.R, [Math.sign(xs), 0, 0])),
        up: norm(mv(frame.R, [0, Math.sign(ys), 0])),
        width: nx * Math.abs(xs),
        height: ny * Math.abs(ys),
        nCols: nx,
        nRows: ny,
        planarity: 0,
        ids,
      });
      return;
    }
    if (k === "detector" || k === "monitor") {
      const id = cursor ? cursor.list[cursor.next++] : undefined;
      if (cursor && id === undefined) throw new Error(`IDF: idlist "${cursor.name}" has fewer IDs than detectors`);
      if (k === "detector") pixels.push({ pos: frame.t, path, id });
      return;
    }
    for (const c of t.children) {
      if (c.name !== "component" || !c.attrs.type) continue;
      const outer = cursor;
      if (c.attrs.idlist) {
        const list = idlists.get(c.attrs.idlist);
        if (!list) throw new Error(`IDF: no idlist "${c.attrs.idlist}"`);
        cursor = { name: c.attrs.idlist, list, next: 0 };
      }
      const locs = c.children.filter((x) => x.name === "location");
      (locs.length ? locs : [empty]).forEach((loc, i) => {
        visit(c.attrs.type!, compose(frame, locationFrame(loc)), [...path, loc.attrs.name ?? (locs.length > 1 ? `${c.attrs.type}#${i}` : c.attrs.type!)], c.attrs);
      });
      if (c.attrs.idlist) {
        if (cursor!.next !== cursor!.list.length) throw new Error(`IDF: idlist "${cursor!.name}" has ${cursor!.list.length} IDs for ${cursor!.next} detectors`);
        cursor = outer;
      }
    }
  };

  const top: XmlNode = { name: "type", attrs: { name: "#top" }, children: root.children.filter((c) => c.name === "component") };
  types.set("#top", top);
  visit("#top", { R: I3, t: [0, 0, 0] }, []);

  // Group pixels: pack = path minus the last two levels, tube = path minus the last level.
  const packs = new Map<string, Map<string, { pos: V3; id: number | undefined }[]>>();
  for (const px of pixels) {
    if (px.path.length < 3) continue;
    const packKey = px.path.slice(0, -2).join("/");
    const tubeKey = px.path.slice(0, -1).join("/");
    let tubes = packs.get(packKey);
    if (!tubes) packs.set(packKey, (tubes = new Map()));
    let tube = tubes.get(tubeKey);
    if (!tube) tubes.set(tubeKey, (tube = []));
    tube.push({ pos: px.pos, id: px.id });
  }
  for (const [key, tubes] of packs) {
    const parts = key.split("/");
    // Name: the nearest "bank…" ancestor, else the pack's parent (ARCS/SEQUOIA "B1", "C25T"), else the path.
    const bank = [...parts].reverse().find((p) => /bank/i.test(p)) ?? (parts.length > 1 ? parts[parts.length - 2] : undefined);
    const list = [...tubes.values()];
    panels.push(fitPack(bank ?? key, list.map((t) => t.map((p) => p.pos)), packIds(bank ?? key, list.map((t) => t.map((p) => p.id)))));
  }
  // Every ID once: overlapping ranges would make a mask file ambiguous.
  const seen = new Set<number>();
  for (const p of panels)
    for (let c = 0; c < p.nCols; c++)
      for (let r = 0; r < p.nRows; r++) {
        const id = p.ids[0] + c * p.ids[1] + r * p.ids[2];
        if (seen.has(id)) throw new Error(`IDF: detector ID ${id} is used twice (${p.name})`);
        seen.add(id);
      }
  return { name: root.attrs.name ?? "", l1, panels };
}

/** A pack's IDs as id = start + tube·stepCol + pixel·stepRow, checked for every pixel. */
function packIds(name: string, ids: (number | undefined)[][]): [number, number, number] {
  const at = (c: number, r: number) => {
    const v = ids[c]?.[r];
    if (v === undefined) throw new Error(`IDF: ${name} tube ${c} pixel ${r} has no detector ID`);
    return v;
  };
  const start = at(0, 0);
  const stepCol = ids.length > 1 ? at(1, 0) - start : ids[0]!.length;
  const stepRow = ids[0]!.length > 1 ? at(0, 1) - start : 1;
  ids.forEach((tube, c) =>
    tube.forEach((_, r) => {
      if (at(c, r) !== start + c * stepCol + r * stepRow) throw new Error(`IDF: ${name}: detector IDs are not linear in tube and pixel`);
    }),
  );
  return [start, stepCol, stepRow];
}

/** Fit a rectangle to a pack of tubes (each tube an ordered list of pixel centres). */
function fitPack(name: string, tubes: V3[][], ids: [number, number, number]): Panel {
  const nCols = tubes.length;
  const nRows = Math.max(...tubes.map((t) => t.length));
  const all = tubes.flat();
  const center = scale(all.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / all.length);
  const along = norm(tubes.map((t) => sub(t[t.length - 1]!, t[0]!)).reduce((s, v) => add(s, v), [0, 0, 0] as V3));
  const mid = (t: V3[]) => scale(t.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / t.length);
  let across = sub(mid(tubes[nCols - 1]!), mid(tubes[0]!));
  across = norm(sub(across, scale(along, dot(across, along))));
  const normal = norm(cross(across, along));
  let planarity = 0;
  for (const p of all) planarity = Math.max(planarity, Math.abs(dot(sub(p, center), normal)));
  const tubeLen = Math.max(...tubes.map((t) => Math.abs(dot(sub(t[t.length - 1]!, t[0]!), along))));
  const span = Math.abs(dot(sub(mid(tubes[nCols - 1]!), mid(tubes[0]!)), across));
  return {
    name,
    kind: "tube-pack",
    center,
    base: across,
    up: along,
    width: nCols > 1 ? (span * nCols) / (nCols - 1) : 0.0254,
    height: nRows > 1 ? (tubeLen * nRows) / (nRows - 1) : tubeLen,
    nCols,
    nRows,
    planarity,
    ids,
  };
}

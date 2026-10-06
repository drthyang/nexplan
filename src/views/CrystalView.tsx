/**
 * 3D crystal-structure viewer (ball-and-stick), ported from MATERIA's
 * StructureView (web-refinement src/app/ui/StructureView.tsx @ 0ee9a7e):
 * occupancy-wedge spheres sized 0.38 × covalent radius, covalent-radius
 * bonds, cell wireframe, a/b/c arrows, orthographic/perspective camera,
 * view-along buttons and WebGL-rendered legend swatches. Magnetic moments,
 * displacements, the standard-cell overlay and MATERIA's light and finish
 * knobs are not ported. From the RMCProfile Workbench: theme-aware stage
 * background and labels, Reset view, PNG export and full resource disposal.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { covalentRadius, elementColor } from "@materia/app/ui/elementData";
import { buildCellAtoms } from "@materia/core/crystal/cellExpansion";
import type { StructureModel } from "@materia/core/crystal/types";
import { fractionalToCartesian } from "@materia/core/crystal/unitCell";
import type { Vec3 } from "@materia/core/math/types";
import { cx } from "../ui/components.tsx";
import { arrowBuilder, cssVar, disposeTree, makeLabelSprite, savePng } from "./three/helpers.ts";

const MAX_BOND_LABELS = 80;
const MAX_ATOM_LABELS = 400;
const MAX_BOND_ATOMS = 1600;

/** Scene light and sphere finish: MATERIA's light level 2 and glossy finish. */
const LIGHT = 2;
const SHININESS = 140;
const SPECULAR = 0x666666;

/** a, b, c arrow colours (MATERIA: red, green, blue). */
const AXIS_COLORS = { a: 0xd94a4a, b: 0x2ea043, c: 0x3b6ef1 } as const;

function renderAtomSwatches(elements: readonly string[], gl: { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement }): Record<string, string> {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.85 * LIGHT));
  const dl = new THREE.DirectionalLight(0xffffff, 0.55 * LIGHT);
  dl.position.set(1, 1.5, 1);
  scene.add(dl);
  const cam = new THREE.OrthographicCamera(-1.12, 1.12, 1.12, -1.12, -10, 10);
  cam.position.set(0, 0, 5);
  cam.lookAt(0, 0, 0);
  const geo = new THREE.SphereGeometry(1, 48, 48);
  const out: Record<string, string> = {};
  for (const el of elements) {
    const mat = new THREE.MeshPhongMaterial({ color: new THREE.Color(elementColor(el)), shininess: SHININESS, specular: SPECULAR });
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    gl.renderer.render(scene, cam);
    out[el] = gl.canvas.toDataURL();
    scene.remove(mesh);
    mat.dispose();
  }
  geo.dispose();
  return out;
}

export function CrystalView({ structure, theme, fileStem, minHeight = 420 }: { structure: StructureModel; theme: "light" | "dark"; fileStem: string; minHeight?: number }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [showBondLengths, setShowBondLengths] = useState(false);
  const [showAtomLabels, setShowAtomLabels] = useState(false);
  const [showAxes, setShowAxes] = useState(true);
  const [perspective, setPerspective] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const uniqueElements = useMemo(() => [...new Set(structure.sites.map((s) => s.element))], [structure]);
  const [swatches, setSwatches] = useState<Record<string, string>>({});
  const swatchGL = useRef<{ renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } | null>(null);
  const viewState = useRef<{ key: string; pos: number[]; target: number[]; up: number[]; zoom: number } | null>(null);
  const live = useRef<{ camera: THREE.PerspectiveCamera | THREE.OrthographicCamera; controls: OrbitControls; renderer: THREE.WebGLRenderer; scene: THREE.Scene; span: number } | null>(null);

  const atoms = useMemo(() => buildCellAtoms(structure), [structure]);
  const { corners, center, span } = useMemo(() => {
    const c: Vec3[] = [];
    for (const i of [0, 1]) for (const j of [0, 1]) for (const k of [0, 1]) c.push(fractionalToCartesian(structure.cell, [i, j, k]));
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const p of c) for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, p[a]!);
      hi[a] = Math.max(hi[a]!, p[a]!);
    }
    const ctr: Vec3 = [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2];
    return { corners: c, center: ctr, span: Math.max(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!, 1) };
  }, [structure]);

  const viewAlong = (axis: "a" | "b" | "c") => {
    const s = live.current;
    if (!s) return;
    const vec = (f: Vec3) => new THREE.Vector3(...fractionalToCartesian(structure.cell, f));
    const dir = (axis === "a" ? vec([1, 0, 0]) : axis === "b" ? vec([0, 1, 0]) : vec([0, 0, 1])).normalize();
    const up = (axis === "c" ? vec([0, 1, 0]) : vec([0, 0, 1])).normalize();
    const target = s.controls.target;
    const dist = s.camera.position.distanceTo(target) || s.span * 2.4;
    s.camera.up.copy(up);
    s.camera.position.copy(target).addScaledVector(dir, dist);
    s.camera.lookAt(target);
    s.controls.update();
  };

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const width = mount.clientWidth || 480;
    const height = mount.clientHeight || minHeight;
    const aspect = width / height;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(cssVar("--canvas-bg", theme === "dark" ? "#10141a" : "#f8fafc"));
    const labelColor = cssVar("--text-strong", theme === "dark" ? "#ffffff" : "#101828");
    const mutedColor = cssVar("--muted", "#667085");
    const camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspective
      ? new THREE.PerspectiveCamera(45, aspect, 0.05, 8000)
      : new THREE.OrthographicCamera(-span * 0.85 * aspect, span * 0.85 * aspect, span * 0.85, -span * 0.85, -8000, 8000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
    renderer.setSize(width, height);
    mount.innerHTML = "";
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    const ambient = new THREE.AmbientLight(0xffffff, 0.85 * LIGHT);
    const dl = new THREE.DirectionalLight(0xffffff, 0.55 * LIGHT);
    dl.position.set(1, 1.5, 1);
    scene.add(ambient, dl);
    const centerV = new THREE.Vector3(...center);
    const labelH = span * 0.05;

    // Atoms: spheres (0.38 × covalent radius); a shared site is drawn as occupancy wedges plus a grey vacancy slice.
    const geoCache = new Map<string, THREE.SphereGeometry>();
    const getGeo = (r: number, phiStart = 0, phiLength = Math.PI * 2) => {
      const key = `${r.toFixed(2)}|${phiStart.toFixed(3)}|${phiLength.toFixed(3)}`;
      let g = geoCache.get(key);
      if (!g) {
        const wSeg = phiLength >= Math.PI * 2 ? 24 : Math.max(3, Math.round((24 * phiLength) / (Math.PI * 2)));
        g = new THREE.SphereGeometry(r, wSeg, 18, phiStart, phiLength);
        geoCache.set(key, g);
      }
      return g;
    };
    const addSphere = (geo: THREE.SphereGeometry, color: THREE.ColorRepresentation, xyz: Vec3) => {
      const mat = new THREE.MeshPhongMaterial({ color: new THREE.Color(color), shininess: SHININESS, specular: SPECULAR });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(xyz[0], xyz[1], xyz[2]);
      scene.add(mesh);
    };
    for (const at of atoms) {
      if (at.mixture && at.mixture.length > 0) {
        let rNum = 0;
        let rDen = 0;
        for (const f of at.mixture) {
          rNum += covalentRadius(f.element) * f.occupancy;
          rDen += f.occupancy;
        }
        const r = (rDen > 0 ? rNum / rDen : covalentRadius(at.element)) * 0.38;
        const sumOcc = at.mixture.reduce((s, f) => s + f.occupancy, 0);
        const denom = Math.max(1, sumOcc);
        let phi = 0;
        for (const f of at.mixture) {
          const w = (Math.PI * 2 * f.occupancy) / denom;
          if (w <= 1e-4) continue;
          addSphere(getGeo(r, phi, w), elementColor(f.element), at.xyz);
          phi += w;
        }
        const vacancy = 1 - Math.min(1, sumOcc);
        if (vacancy > 1e-3) addSphere(getGeo(r, phi, (Math.PI * 2 * vacancy) / denom), 0xd1d5db, at.xyz);
      } else {
        addSphere(getGeo(covalentRadius(at.element) * 0.38), elementColor(at.element), at.xyz);
      }
    }
    if (showAtomLabels && atoms.length <= MAX_ATOM_LABELS) {
      for (const at of atoms) {
        const s = makeLabelSprite(at.label, labelH * 0.9, labelColor);
        s.position.set(at.xyz[0], at.xyz[1] + covalentRadius(at.element) * 0.38 + labelH * 0.55, at.xyz[2]);
        scene.add(s);
      }
    }

    // Bonds: 0.4 Å < d ≤ 1.15 × (r_cov,i + r_cov,j).
    if (atoms.length <= MAX_BOND_ATOMS) {
      const bondGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 10);
      bondGeo.translate(0, 0.5, 0);
      const bondMat = new THREE.MeshPhongMaterial({ color: 0x8a8f98, shininess: 20 });
      const Y0 = new THREE.Vector3(0, 1, 0);
      const pa = new THREE.Vector3();
      const pb = new THREE.Vector3();
      const dir = new THREE.Vector3();
      const bonds: { mid: THREE.Vector3; len: number }[] = [];
      for (let i = 0; i < atoms.length; i++) {
        const ri = covalentRadius(atoms[i]!.element);
        pa.set(...atoms[i]!.xyz);
        for (let j = i + 1; j < atoms.length; j++) {
          const cut = (ri + covalentRadius(atoms[j]!.element)) * 1.15;
          pb.set(...atoms[j]!.xyz);
          const len = pa.distanceTo(pb);
          if (len < 0.4 || len > cut) continue;
          const mesh = new THREE.Mesh(bondGeo, bondMat);
          dir.subVectors(pb, pa).normalize();
          mesh.quaternion.setFromUnitVectors(Y0, dir);
          mesh.position.copy(pa);
          mesh.scale.set(1, len, 1);
          scene.add(mesh);
          bonds.push({ mid: pa.clone().add(pb).multiplyScalar(0.5), len });
        }
      }
      if (showBondLengths && bonds.length <= MAX_BOND_LABELS) {
        for (const b of bonds) {
          const s = makeLabelSprite(`${b.len.toFixed(2)} Å`, labelH, mutedColor);
          s.position.copy(b.mid);
          scene.add(s);
        }
      }
    }

    // Cell wireframe.
    const edges: readonly [number, number][] = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
    const pts: THREE.Vector3[] = [];
    for (const [a, b] of edges) pts.push(new THREE.Vector3(...corners[a]!), new THREE.Vector3(...corners[b]!));
    scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x6366f1, transparent: true, opacity: 0.6 })));

    // a, b, c arrows from the cell origin (solid arrows that keep their thickness when zoomed).
    if (showAxes) {
      const origin = new THREE.Vector3(...corners[0]!);
      const alen = span * 0.32;
      for (const [name, f] of [["a", [1, 0, 0]], ["b", [0, 1, 0]], ["c", [0, 0, 1]]] as const) {
        const color = AXIS_COLORS[name];
        const dirV = new THREE.Vector3(...fractionalToCartesian(structure.cell, f as unknown as Vec3)).normalize();
        scene.add(arrowBuilder({ color, shaftRadius: alen * 0.022, headRadius: alen * 0.07, headLength: alen * 0.2 })(dirV, origin, alen));
        const label = makeLabelSprite(name, labelH * 1.25, `#${color.toString(16).padStart(6, "0")}`, "Inter, serif");
        label.position.copy(origin).addScaledVector(dirV, alen * 1.14);
        scene.add(label);
      }
    }

    // Camera: keep the user's view across rebuilds of the same structure; otherwise fit the cell.
    const { a, b, c, alpha, beta, gamma } = structure.cell;
    const viewKey = `${structure.id}|${a},${b},${c},${alpha},${beta},${gamma}|${resetToken}`;
    const saved = viewState.current;
    if (saved && saved.key === viewKey) {
      camera.position.fromArray(saved.pos);
      camera.up.fromArray(saved.up);
      controls.target.fromArray(saved.target);
      camera.zoom = saved.zoom;
      camera.updateProjectionMatrix();
      camera.lookAt(controls.target);
    } else {
      camera.position.copy(centerV).add(new THREE.Vector3(span * 0.55, span * 0.45, span * 1.1 + 4));
      camera.lookAt(centerV);
      controls.target.copy(centerV);
    }
    controls.update();
    live.current = { camera, controls, renderer, scene, span };

    let raf = 0;
    const renderOnce = () => {
      controls.update();
      renderer.render(scene, camera);
    };
    const loop = () => {
      raf = requestAnimationFrame(loop);
      renderOnce();
    };
    renderOnce();
    loop();
    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w < 1 || h < 1) return;
      const asp = w / h;
      if (camera instanceof THREE.PerspectiveCamera) camera.aspect = asp;
      else {
        const d = span * 0.85;
        camera.left = -d * asp;
        camera.right = d * asp;
        camera.top = d;
        camera.bottom = -d;
      }
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderOnce();
    });
    ro.observe(mount);

    return () => {
      viewState.current = { key: viewKey, pos: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), zoom: camera.zoom };
      live.current = null;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        /* context already gone */
      }
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [atoms, corners, center, span, showBondLengths, showAtomLabels, showAxes, perspective, structure, theme, resetToken, minHeight]);

  useEffect(() => {
    if (uniqueElements.length === 0) return;
    let gl = swatchGL.current;
    if (!gl) {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setSize(128, 128, false);
      gl = { renderer, canvas };
      swatchGL.current = gl;
    }
    setSwatches(renderAtomSwatches(uniqueElements, gl));
  }, [uniqueElements]);

  useEffect(
    () => () => {
      const gl = swatchGL.current;
      if (!gl) return;
      gl.renderer.dispose();
      try {
        gl.renderer.forceContextLoss();
      } catch {
        /* context already gone */
      }
      swatchGL.current = null;
    },
    [],
  );

  // Three times the on-screen resolution: enough for a slide or a figure.
  const exportPng = () => {
    const s = live.current;
    if (s) savePng(s.renderer, s.scene, s.camera, `${fileStem}-structure.png`, 3);
  };

  if (atoms.length === 0) return <p className="empty-note">No atomic sites to display.</p>;
  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <label className="ui-check"><input type="checkbox" checked={showBondLengths} onChange={(e) => setShowBondLengths(e.target.checked)} /> Bond lengths</label>
        <label className="ui-check"><input type="checkbox" checked={showAtomLabels} onChange={(e) => setShowAtomLabels(e.target.checked)} /> Atom labels</label>
        <label className="ui-check"><input type="checkbox" checked={showAxes} onChange={(e) => setShowAxes(e.target.checked)} /> Axes</label>
        <label className="ui-check"><input type="checkbox" checked={perspective} onChange={(e) => setPerspective(e.target.checked)} /> Perspective</label>
        <span className="viewer-toolbar__end">
          <span className="ui-seg ui-seg--frame" role="group" aria-label="View along an axis">
            {(["a", "b", "c"] as const).map((ax) => (
              <button key={ax} type="button" onClick={() => viewAlong(ax)} title={`View down the ${ax} axis`}>
                <span className="sym">{ax}</span>
              </button>
            ))}
          </span>
          <button type="button" className="ui-pill" onClick={() => setResetToken((n) => n + 1)}>Reset view</button>
          <button type="button" className="ui-pill" onClick={exportPng} title="Save the view as a PNG at three times the on-screen resolution">PNG</button>
        </span>
      </div>
      <div ref={mountRef} className={cx("viewer-stage")} style={{ minHeight }} />
      <div className="viewer-legend">
        {uniqueElements.map((el) => (
          <span key={el} className="viewer-legend__item">
            {swatches[el] ? <img src={swatches[el]} alt="" width={15} height={15} /> : <span className="viewer-legend__dot" style={{ background: elementColor(el) }} />}
            {el}
          </span>
        ))}
      </div>
      {atoms.length > MAX_BOND_ATOMS && <p className="empty-note">Bonds are hidden above {MAX_BOND_ATOMS} atoms.</p>}
    </div>
  );
}

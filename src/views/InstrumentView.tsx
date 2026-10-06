/**
 * Real-space instrument view (lab frame, metres): sample at the origin, beam
 * along +z, detector panels from the instrument definition, and (single
 * crystal) the spots where diffracted rays hit them, coloured by wavelength.
 * Panels can be coloured individually (powder: by 2θ), painted with an
 * image (powder rings), highlighted, and picked. Click a spot to select its reflection, or a panel to pick it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Vec3 } from "@materia/core/math/types";
import type { DetectorPanel } from "../core/instrument/detectors.ts";
import { lambdaColor } from "./ReciprocalView.tsx";
import { arrowBuilder, cssVar, disposeTree, makeLabelSprite, savePng } from "./three/helpers.ts";

export interface InstrumentSpot {
  /** Index into the shared reflection list. */
  readonly index: number;
  readonly position: Vec3;
  readonly lambda: number;
  readonly panel: number;
}

const PANEL_COLOR = 0x5b8def;
const SELECT_COLOR = 0xff3b5c;

export function InstrumentView({
  panels,
  spots = [],
  lambdaMin,
  lambdaMax,
  selected,
  onSelect,
  theme,
  fileStem,
  instrumentName,
  panelColors,
  highlight,
  selectedPanel = null,
  onPanelClick,
  summary,
  legend,
  panelImages,
  traces,
}: {
  panels: readonly DetectorPanel[];
  spots?: readonly InstrumentSpot[];
  lambdaMin: number;
  lambdaMax: number;
  selected: number | null;
  onSelect: (i: number | null) => void;
  theme: "light" | "dark";
  fileStem: string;
  instrumentName: string;
  /** Per-panel face colour (hex); default a uniform blue. */
  panelColors?: readonly number[];
  /** Panels drawn emphasised (others are dimmed when this is set). */
  highlight?: ReadonlySet<number>;
  selectedPanel?: number | null;
  onPanelClick?: (i: number) => void;
  summary?: ReactNode;
  legend?: ReactNode;
  /** Per-panel RGBA images (rows from the (−w/2, −h/2) corner, along `up`), drawn on the panel faces. */
  panelImages?: readonly { readonly width: number; readonly height: number; readonly data: Uint8Array }[];
  /** Polylines on the detectors (lab frame, m), drawn in the selection colour (e.g. a ray-traced powder ring). */
  traces?: readonly (readonly Vec3[])[];
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const live = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; spots: THREE.InstancedMesh; selection: THREE.Group; traces: THREE.Group; faces: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[]; edges: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>[]; R: number } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onPanelRef = useRef(onPanelClick);
  onPanelRef.current = onPanelClick;
  const spotsRef = useRef(spots);
  spotsRef.current = spots;

  // Static scene: panels, beam, sample (rebuilt when the instrument or theme changes).
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const width = mount.clientWidth || 600;
    const height = mount.clientHeight || 420;
    const R = Math.max(0.3, ...panels.map((p) => Math.hypot(...p.center) + Math.max(p.width, p.height) / 2));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(cssVar("--canvas-bg", theme === "dark" ? "#10141a" : "#f8fafc"));
    const muted = cssVar("--muted", "#667085");
    const camera = new THREE.PerspectiveCamera(40, width / height, R * 0.005, R * 50);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
    renderer.setSize(width, height);
    mount.innerHTML = "";
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.0);
    dl.position.set(1, 2, 1);
    scene.add(dl);

    // Panels: translucent faces with outlines (materials per panel; styled by the effect below).
    const faces: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = [];
    const edges: THREE.LineLoop<THREE.BufferGeometry, THREE.LineBasicMaterial>[] = [];
    panels.forEach((p, i) => {
      const n = new THREE.Vector3().crossVectors(new THREE.Vector3(...p.base), new THREE.Vector3(...p.up));
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...p.base), new THREE.Vector3(...p.up), n).setPosition(...p.center);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(p.width, p.height), new THREE.MeshBasicMaterial({ color: PANEL_COLOR, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
      face.applyMatrix4(m);
      face.userData.panel = i;
      scene.add(face);
      faces.push(face);
      const edge = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-p.width / 2, -p.height / 2, 0),
          new THREE.Vector3(p.width / 2, -p.height / 2, 0),
          new THREE.Vector3(p.width / 2, p.height / 2, 0),
          new THREE.Vector3(-p.width / 2, p.height / 2, 0),
        ]),
        new THREE.LineBasicMaterial({ color: PANEL_COLOR, transparent: true }),
      );
      edge.applyMatrix4(m);
      scene.add(edge);
      edges.push(edge);
      if (showLabels) {
        const label = makeLabelSprite(p.name, R * 0.02, muted);
        label.position.set(...p.center);
        scene.add(label);
      }
    });

    // Sample, beam (+z) and up (+y).
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(R * 0.012, 20, 14), new THREE.MeshPhongMaterial({ color: 0x98a2b3 })));
    const beam = arrowBuilder({ color: 0xd98a2b, shaftRadius: R * 0.004, headRadius: R * 0.013, headLength: R * 0.04 });
    scene.add(beam(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -R * 0.9), R * 0.75));
    const beamLabel = makeLabelSprite("beam", R * 0.035, "#d98a2b");
    beamLabel.position.set(0, R * 0.05, -R * 0.75);
    scene.add(beamLabel);
    const upArrow = arrowBuilder({ color: 0x98a2b3, shaftRadius: R * 0.003, headRadius: R * 0.01, headLength: R * 0.03 });
    scene.add(upArrow(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), R * 0.2));

    // Spots (instanced; updated in place by the effect below).
    const spotMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8), new THREE.MeshPhongMaterial({ shininess: 30 }), 20000);
    spotMesh.count = 0;
    scene.add(spotMesh);
    const selection = new THREE.Group();
    scene.add(selection);
    const traceGroup = new THREE.Group();
    scene.add(traceGroup);

    camera.position.set(R * 1.4, R * 1.1, R * 0.9);
    controls.target.set(0, 0, 0);
    camera.lookAt(0, 0, 0);
    controls.update();
    live.current = { renderer, scene, camera, spots: spotMesh, selection, traces: traceGroup, faces, edges, R };

    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
      const hit = spotMesh.count > 0 ? ray.intersectObject(spotMesh, false)[0] : undefined;
      const spot = hit?.instanceId !== undefined ? spotsRef.current[hit.instanceId] : undefined;
      if (spot) return onSelectRef.current(spot.index);
      const face = onPanelRef.current ? ray.intersectObjects(faces, false)[0] : undefined;
      if (face) return onPanelRef.current!(face.object.userData.panel as number);
      onSelectRef.current(null);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w < 1 || h < 1) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(mount);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      disposeTree(scene);
      renderer.dispose();
      try {
        renderer.forceContextLoss();
      } catch {
        /* context already gone */
      }
      live.current = null;
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [panels, theme, showLabels, resetToken]);

  // Panel styling, updated in place.
  useEffect(() => {
    const s = live.current;
    if (!s) return;
    const base = theme === "dark" ? 0.16 : 0.12;
    s.faces.forEach((face, i) => {
      const on = !highlight || highlight.has(i);
      const isSel = i === selectedPanel;
      const colour = panelColors?.[i] ?? PANEL_COLOR;
      const img = panelImages?.[i];
      let tex = face.material.map as THREE.DataTexture | null;
      if (img) {
        if (!tex || tex.image.width !== img.width || tex.image.height !== img.height) {
          tex?.dispose();
          tex = new THREE.DataTexture(new Uint8Array(img.data), img.width, img.height, THREE.RGBAFormat);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.magFilter = THREE.LinearFilter;
          tex.minFilter = THREE.LinearFilter;
          face.material.map = tex;
          face.material.needsUpdate = true;
        } else (tex.image.data as Uint8Array).set(img.data);
        tex.needsUpdate = true;
        face.material.color.setHex(0xffffff);
        face.material.opacity = on ? 1 : 0.2;
      } else {
        if (tex) {
          tex.dispose();
          face.material.map = null;
          face.material.needsUpdate = true;
        }
        face.material.color.setHex(colour);
        face.material.opacity = isSel ? 0.55 : !highlight ? (panelColors ? base * 2.6 : base) : on ? 0.42 : 0.04;
      }
      const edge = s.edges[i]!;
      edge.material.color.setHex(isSel ? SELECT_COLOR : img ? 0x8a94a6 : colour);
      edge.material.opacity = isSel ? 1 : on ? 0.8 : 0.15;
      edge.renderOrder = isSel ? 2 : 0;
    });
  }, [panelColors, panelImages, highlight, selectedPanel, theme, showLabels, panels, resetToken]);

  // Traces, drawn just in front of the panels.
  useEffect(() => {
    const s = live.current;
    if (!s) return;
    disposeTree(s.traces);
    s.traces.clear();
    const mat = new THREE.LineBasicMaterial({ color: SELECT_COLOR, depthTest: false });
    for (const line of traces ?? []) {
      if (line.length < 2) continue;
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line.map((v) => new THREE.Vector3(v[0] * 0.995, v[1] * 0.995, v[2] * 0.995))), mat);
      l.renderOrder = 3;
      s.traces.add(l);
    }
  }, [traces, theme, showLabels, panels, resetToken]);

  // Spots and selection, updated in place.
  useEffect(() => {
    const s = live.current;
    if (!s) return;
    const r = s.R * 0.009;
    const m4 = new THREE.Matrix4();
    const n = Math.min(spots.length, 20000);
    for (let i = 0; i < n; i++) {
      const sp = spots[i]!;
      const isSel = sp.index === selected;
      const k = isSel ? r * 2.2 : r;
      m4.makeScale(k, k, k).setPosition(...sp.position);
      s.spots.setMatrixAt(i, m4);
      s.spots.setColorAt(i, isSel ? new THREE.Color(SELECT_COLOR) : lambdaColor((sp.lambda - lambdaMin) / (lambdaMax - lambdaMin)));
    }
    s.spots.count = n;
    s.spots.instanceMatrix.needsUpdate = true;
    if (s.spots.instanceColor) s.spots.instanceColor.needsUpdate = true;
    s.spots.computeBoundingSphere();

    disposeTree(s.selection);
    s.selection.clear();
    const sel = spots.find((sp) => sp.index === selected);
    if (sel) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...sel.position)]), new THREE.LineBasicMaterial({ color: SELECT_COLOR }));
      s.selection.add(line);
    }
  }, [spots, selected, lambdaMin, lambdaMax, resetToken, theme, showLabels, panels]);

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <span className="dim-note">
          {summary ?? `${instrumentName}: ${panels.length} panels · ${spots.length.toLocaleString()} spots on detectors`}
        </span>
        <span className="viewer-toolbar__end">
          {legend}
          <label className="ui-check">
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Bank labels
          </label>
          <button type="button" className="ui-pill" onClick={() => setResetToken((n) => n + 1)}>
            Reset view
          </button>
          <button
            type="button"
            className="ui-pill"
            title="Save the view as a PNG at three times the on-screen resolution"
            onClick={() => {
              const s = live.current;
              if (s) savePng(s.renderer, s.scene, s.camera, `${fileStem}-${instrumentName}-detectors.png`, 3);
            }}
          >
            PNG
          </button>
        </span>
      </div>
      <div ref={mountRef} className="viewer-stage" style={{ minHeight: 420 }} />
    </div>
  );
}

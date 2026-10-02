/**
 * Real-space instrument view (lab frame, metres): sample at the origin, beam
 * along +z, detector panels from the instrument definition, and the spots
 * where diffracted rays hit them, coloured by wavelength. Click a spot to
 * select its reflection (shared with the reciprocal view and the table).
 */
import { useEffect, useRef, useState } from "react";
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

export function InstrumentView({
  panels,
  spots,
  lambdaMin,
  lambdaMax,
  selected,
  onSelect,
  theme,
  fileStem,
  instrumentName,
}: {
  panels: readonly DetectorPanel[];
  spots: readonly InstrumentSpot[];
  lambdaMin: number;
  lambdaMax: number;
  selected: number | null;
  onSelect: (i: number | null) => void;
  theme: "light" | "dark";
  fileStem: string;
  instrumentName: string;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const live = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; spots: THREE.InstancedMesh; selection: THREE.Group; panelMeshes: THREE.Mesh[]; R: number } | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
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

    // Panels: translucent faces with outlines.
    const faceMat = new THREE.MeshBasicMaterial({ color: 0x5b8def, transparent: true, opacity: theme === "dark" ? 0.16 : 0.12, side: THREE.DoubleSide, depthWrite: false });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x5b8def, transparent: true, opacity: 0.75 });
    const panelMeshes: THREE.Mesh[] = [];
    panels.forEach((p) => {
      const n = new THREE.Vector3().crossVectors(new THREE.Vector3(...p.base), new THREE.Vector3(...p.up));
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...p.base), new THREE.Vector3(...p.up), n).setPosition(...p.center);
      const face = new THREE.Mesh(new THREE.PlaneGeometry(p.width, p.height), faceMat);
      face.applyMatrix4(m);
      scene.add(face);
      panelMeshes.push(face);
      const edge = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(-p.width / 2, -p.height / 2, 0),
          new THREE.Vector3(p.width / 2, -p.height / 2, 0),
          new THREE.Vector3(p.width / 2, p.height / 2, 0),
          new THREE.Vector3(-p.width / 2, p.height / 2, 0),
        ]),
        edgeMat,
      );
      edge.applyMatrix4(m);
      scene.add(edge);
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

    camera.position.set(R * 1.4, R * 1.1, R * 0.9);
    controls.target.set(0, 0, 0);
    camera.lookAt(0, 0, 0);
    controls.update();
    live.current = { renderer, scene, camera, spots: spotMesh, selection, panelMeshes, R };

    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
      const hit = ray.intersectObject(spotMesh, false)[0];
      const spot = hit?.instanceId !== undefined ? spotsRef.current[hit.instanceId] : undefined;
      onSelectRef.current(spot ? spot.index : null);
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
      s.spots.setColorAt(i, isSel ? new THREE.Color(0xff3b5c) : lambdaColor((sp.lambda - lambdaMin) / (lambdaMax - lambdaMin)));
    }
    s.spots.count = n;
    s.spots.instanceMatrix.needsUpdate = true;
    if (s.spots.instanceColor) s.spots.instanceColor.needsUpdate = true;
    s.spots.computeBoundingSphere();

    disposeTree(s.selection);
    s.selection.clear();
    const sel = spots.find((sp) => sp.index === selected);
    if (sel) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(...sel.position)]), new THREE.LineBasicMaterial({ color: 0xff3b5c }));
      s.selection.add(line);
    }
  }, [spots, selected, lambdaMin, lambdaMax, resetToken, theme, showLabels, panels]);

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <span className="dim-note">
          {instrumentName}: {panels.length} panels · {spots.length.toLocaleString()} spots on detectors
        </span>
        <span className="viewer-toolbar__end">
          <label className="ui-check">
            <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} /> Bank labels
          </label>
          <button type="button" className="ui-pill" onClick={() => setResetToken((n) => n + 1)}>
            Reset view
          </button>
          <button
            type="button"
            className="ui-pill"
            onClick={() => {
              const s = live.current;
              if (s) savePng(s.renderer, s.scene, s.camera, `${fileStem}-${instrumentName}-detectors.png`, 3);
            }}
          >
            PNG 3×
          </button>
        </span>
      </div>
      <div ref={mountRef} className="viewer-stage" style={{ minHeight: 420 }} />
    </div>
  );
}

/**
 * Reciprocal space in the laboratory: the Ewald construction for a white /
 * time-of-flight beam (units 1/Å, no 2π).
 *
 * Lab frame (Mantid): beam +z, up +y. Lab-fixed objects: beam, up and x
 * arrows and the two Ewald spheres for λmin and λmax (centres at −k_i,
 * radius 1/λ, through the origin). Crystal-fixed objects: reciprocal-lattice
 * points at UB·h (instanced spheres, size ∝ (|F|²)^⅓) and the a*, b*, c*
 * arrows. In the lab view the crystal group carries the goniometer rotation R;
 * in the sample view the lab group carries Rᵀ instead — the same physics seen
 * from the other frame. A point is coloured by the wavelength at which it
 * diffracts when that lies in the band; grey otherwise. Clicking a point draws
 * its Ewald triangle k_i, k_f, q.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Mat3, Vec3 } from "@materia/core/math/types";
import { mulVec } from "@materia/core/math/mat3";
import { laueCondition } from "../core/ub/goniometer.ts";
import { arrowBuilder, cssVar, disposeTree, makeLabelSprite, savePng } from "./three/helpers.ts";

/** Reciprocal-axis colours shared with NEBULA3D (a* amber, b* blue, c* green). */
const RECIP_COLORS = { "a*": 0xf1a73a, "b*": 0x74a8ff, "c*": 0x34c98e } as const;

export interface ReciprocalPoint {
  readonly h: Vec3;
  readonly f2: number;
}

export interface ReciprocalViewProps {
  readonly UB: Mat3;
  readonly R: Mat3;
  readonly qSign: 1 | -1;
  readonly lambdaMin: number;
  readonly lambdaMax: number;
  readonly points: readonly ReciprocalPoint[];
  readonly frame: "lab" | "sample";
  readonly selected: number | null;
  readonly onSelect: (i: number | null) => void;
  readonly theme: "light" | "dark";
  readonly showEwald: boolean;
  readonly fileStem: string;
  /** Per point: 0 cannot diffract in the band, 1 in the band but misses every detector, 2 observed. */
  readonly status: Uint8Array;
  /** Per point: wavelength at which it diffracts (NaN if it cannot). */
  readonly lambdas: Float64Array;
  /** True when the instrument has detector geometry (status 1 is then possible). */
  readonly hasDetectors: boolean;
}

/** Viridis-like ramp for λ (short = purple, long = yellow). */
export function lambdaColor(t: number): THREE.Color {
  const stops = [
    [0.267, 0.005, 0.329],
    [0.229, 0.322, 0.546],
    [0.128, 0.567, 0.551],
    [0.369, 0.789, 0.383],
    [0.993, 0.906, 0.144],
  ];
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  return new THREE.Color(a[0]! + f * (b[0]! - a[0]!), a[1]! + f * (b[1]! - a[1]!), a[2]! + f * (b[2]! - a[2]!));
}

export const LAMBDA_RAMP_CSS = "linear-gradient(90deg, #440154, #3b528b, #21918c, #5ec962, #fde725)";

const toMatrix4 = (R: Mat3) => new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1);

export function ReciprocalView(props: ReciprocalViewProps) {
  const { UB, R, qSign, lambdaMin, lambdaMax, points, frame, selected, onSelect, theme, showEwald, fileStem, status, lambdas, hasDetectors } = props;
  const mountRef = useRef<HTMLDivElement | null>(null);
  const live = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    labGroup: THREE.Group;
    crystalGroup: THREE.Group;
    pointsMesh: THREE.InstancedMesh;
    triangle: THREE.Group;
    span: number;
  } | null>(null);
  const [resetToken, setResetToken] = useState(0);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  /** Sample-frame positions q = qSign·UB·h. */
  const qs = useMemo(() => points.map((p) => {
    const q = mulVec(UB, p.h);
    return [qSign * q[0], qSign * q[1], qSign * q[2]] as Vec3;
  }), [points, UB, qSign]);
  const qMax = useMemo(() => Math.max(0.5, ...qs.map((q) => Math.hypot(...q))), [qs]);
  const f2Max = useMemo(() => Math.max(1e-300, ...points.map((p) => p.f2)), [points]);

  // Build the scene (rebuilds only when the point set, UB or theme change).
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const width = mount.clientWidth || 600;
    const height = mount.clientHeight || 480;
    // Frame the lattice; the Ewald spheres keep their physical size and may extend past the view.
    const span = qMax * 1.15;
    const far = Math.max(span, 2 / lambdaMin) * 4;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(cssVar("--canvas-bg", theme === "dark" ? "#10141a" : "#f8fafc"));
    const textColor = cssVar("--text-strong", theme === "dark" ? "#ffffff" : "#101828");
    const camera = new THREE.PerspectiveCamera(40, width / height, span * 0.01, far * 10);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
    renderer.setSize(width, height);
    mount.innerHTML = "";
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const dl = new THREE.DirectionalLight(0xffffff, 1.1);
    dl.position.set(1, 1.5, 1);
    scene.add(dl);

    const labGroup = new THREE.Group();
    const crystalGroup = new THREE.Group();
    labGroup.matrixAutoUpdate = false;
    crystalGroup.matrixAutoUpdate = false;
    scene.add(labGroup, crystalGroup);
    const labelH = span * 0.045;

    // Lab axes: beam (+z), up (+y), x.
    const labArrow = arrowBuilder({ color: 0x98a2b3, shaftRadius: span * 0.006, headRadius: span * 0.02, headLength: span * 0.06 });
    const beamArrow = arrowBuilder({ color: 0xd98a2b, shaftRadius: span * 0.009, headRadius: span * 0.028, headLength: span * 0.08 });
    labGroup.add(beamArrow(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -span * 1.25), span * 0.5));
    const beamLabel = makeLabelSprite("beam", labelH, "#d98a2b");
    beamLabel.position.set(0, labelH * 1.1, -span * 1.05);
    labGroup.add(beamLabel);
    labGroup.add(labArrow(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), span * 0.35));
    const upLabel = makeLabelSprite("up", labelH, cssVar("--muted", "#667085"));
    upLabel.position.set(0, span * 0.4, 0);
    labGroup.add(upLabel);
    labGroup.add(labArrow(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0), span * 0.25));
    const xLabel = makeLabelSprite("x", labelH, cssVar("--muted", "#667085"));
    xLabel.position.set(span * 0.3, 0, 0);
    labGroup.add(xLabel);

    // Ewald spheres for λmin and λmax: centre (0, 0, −1/λ), radius 1/λ.
    if (showEwald) {
      for (const [lam, color] of [[lambdaMin, 0x5b8def], [lambdaMax, 0xd98a2b]] as const) {
        const r = 1 / lam;
        const shell = new THREE.Mesh(
          new THREE.SphereGeometry(r, 64, 40),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }),
        );
        shell.position.set(0, 0, -r);
        labGroup.add(shell);
        const ring = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, i) => new THREE.Vector3(r * Math.sin((2 * Math.PI * i) / 128), 0, -r + r * Math.cos((2 * Math.PI * i) / 128)))),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }),
        );
        labGroup.add(ring);
        const tag = makeLabelSprite(`λ ${lam} Å`, labelH * 0.85, `#${color.toString(16).padStart(6, "0")}`);
        tag.position.set(r * 0.72, labelH, -r - r * 0.72);
        labGroup.add(tag);
      }
    }

    // Reciprocal-lattice points.
    const base = Math.max(span * 0.006, (qMax / Math.cbrt(Math.max(points.length, 1))) * 0.3);
    const geo = new THREE.SphereGeometry(1, 12, 10);
    const mat = new THREE.MeshPhongMaterial({ shininess: 40, specular: 0x222222 });
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(points.length, 1));
    mesh.count = points.length;
    const m4 = new THREE.Matrix4();
    qs.forEach((q, i) => {
      const s = base * Math.max(0.45, Math.cbrt(points[i]!.f2 / f2Max));
      m4.makeScale(s, s, s).setPosition(q[0], q[1], q[2]);
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, new THREE.Color(0x9aa3b0));
    });
    mesh.instanceMatrix.needsUpdate = true;
    crystalGroup.add(mesh);
    // Origin (000).
    const origin = new THREE.Mesh(new THREE.SphereGeometry(base * 0.8, 16, 12), new THREE.MeshPhongMaterial({ color: new THREE.Color(textColor) }));
    crystalGroup.add(origin);

    // a*, b*, c* arrows (columns of UB).
    const recip = [
      ["a*", [1, 0, 0]],
      ["b*", [0, 1, 0]],
      ["c*", [0, 0, 1]],
    ] as const;
    for (const [name, h] of recip) {
      const v = mulVec(UB, h as unknown as Vec3);
      const dirV = new THREE.Vector3(qSign * v[0], qSign * v[1], qSign * v[2]);
      const len = dirV.length();
      const color = RECIP_COLORS[name];
      crystalGroup.add(arrowBuilder({ color, shaftRadius: span * 0.006, headRadius: span * 0.018, headLength: span * 0.05 })(dirV.clone().normalize(), new THREE.Vector3(), len));
      const label = makeLabelSprite(name, labelH, `#${color.toString(16).padStart(6, "0")}`);
      label.position.copy(dirV.clone().normalize().multiplyScalar(len + labelH * 1.2));
      crystalGroup.add(label);
    }

    const triangle = new THREE.Group();
    triangle.matrixAutoUpdate = false;
    scene.add(triangle);

    camera.position.set(span * 2.3, span * 1.1, span * 0.9);
    camera.up.set(0, 1, 0);
    controls.target.set(0, 0, -span * 0.15);
    camera.lookAt(controls.target);
    controls.update();
    live.current = { renderer, scene, camera, controls, labGroup, crystalGroup, pointsMesh: mesh, triangle, span };

    // Click picking with a drag allowance.
    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
      const hit = ray.intersectObject(mesh, false)[0];
      onSelectRef.current(hit?.instanceId ?? null);
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
  }, [qs, qMax, f2Max, points, UB, qSign, lambdaMin, lambdaMax, theme, showEwald, resetToken]);

  // Goniometer / frame / selection: update group transforms, point colours and the Ewald triangle in place.
  useEffect(() => {
    const s = live.current;
    if (!s) return;
    const Rm = toMatrix4(R);
    if (frame === "lab") {
      s.crystalGroup.matrix.copy(Rm);
      s.labGroup.matrix.identity();
    } else {
      s.crystalGroup.matrix.identity();
      s.labGroup.matrix.copy(Rm.clone().transpose());
    }
    s.crystalGroup.matrixWorldNeedsUpdate = true;
    s.labGroup.matrixWorldNeedsUpdate = true;

    const grey = new THREE.Color(0x9aa3b0);
    const missed = new THREE.Color(0xc9b48a);
    qs.forEach((_q, i) => {
      const st = status[i] ?? 0;
      s.pointsMesh.setColorAt(i, i === selected ? new THREE.Color(0xff3b5c) : st === 2 ? lambdaColor((lambdas[i]! - lambdaMin) / (lambdaMax - lambdaMin)) : st === 1 ? missed : grey);
    });
    if (s.pointsMesh.instanceColor) s.pointsMesh.instanceColor.needsUpdate = true;

    // Ewald triangle for the selected reflection: C = −k_i, O, Q; k_i = C→O, k_f = C→Q, q = O→Q.
    disposeTree(s.triangle);
    s.triangle.clear();
    if (selected !== null && qs[selected]) {
      const lab = mulVec(R, qs[selected]!);
      const spot = laueCondition(lab);
      if (Number.isFinite(spot.lambda)) {
        const C = new THREE.Vector3(0, 0, -1 / spot.lambda);
        const Q = new THREE.Vector3(...lab);
        const O = new THREE.Vector3();
        const arrow = arrowBuilder({ color: 0xff3b5c, shaftRadius: s.span * 0.005, headRadius: s.span * 0.016, headLength: s.span * 0.045 });
        const kiArrow = arrowBuilder({ color: 0xd98a2b, shaftRadius: s.span * 0.005, headRadius: s.span * 0.016, headLength: s.span * 0.045 });
        const kfArrow = arrowBuilder({ color: 0x16a34a, shaftRadius: s.span * 0.005, headRadius: s.span * 0.016, headLength: s.span * 0.045 });
        s.triangle.add(kiArrow(O.clone().sub(C), C, O.distanceTo(C)));
        s.triangle.add(kfArrow(Q.clone().sub(C), C, Q.distanceTo(C)));
        s.triangle.add(arrow(Q.clone().sub(O), O, Q.length()));
        // The Ewald circle in the scattering plane (spanned by the beam and q), centre C, radius 1/λ.
        const e1 = new THREE.Vector3(0, 0, 1);
        const qPerp = new THREE.Vector3(Q.x, Q.y, 0);
        const e2 = qPerp.lengthSq() > 1e-20 ? qPerp.normalize() : new THREE.Vector3(1, 0, 0);
        const r = 1 / spot.lambda;
        const ring = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(
            Array.from({ length: 160 }, (_, i) => {
              const t = (2 * Math.PI * i) / 160;
              return C.clone().addScaledVector(e1, r * Math.cos(t)).addScaledVector(e2, r * Math.sin(t));
            }),
          ),
          new THREE.LineBasicMaterial({ color: 0xff3b5c, transparent: true, opacity: 0.45 }),
        );
        s.triangle.add(ring);
      }
    }
    s.triangle.matrix.copy(frame === "lab" ? new THREE.Matrix4() : Rm.clone().transpose());
    s.triangle.matrixWorldNeedsUpdate = true;
  }, [R, frame, selected, qs, lambdaMin, lambdaMax, resetToken, status, lambdas]);

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <span className="lambda-legend">
          λ {lambdaMin} Å <span className="lambda-ramp" style={{ background: LAMBDA_RAMP_CSS }} /> {lambdaMax} Å
          {hasDetectors && (
            <>
              <span className="lambda-legend__grey" style={{ background: "#c9b48a" }} /> in band, misses the detectors
            </>
          )}
          <span className="lambda-legend__grey" /> not in band
        </span>
        <span className="viewer-toolbar__end">
          <button type="button" className="ui-pill" onClick={() => setResetToken((n) => n + 1)}>Reset view</button>
          <button
            type="button"
            className="ui-pill"
            onClick={() => {
              const s = live.current;
              if (s) savePng(s.renderer, s.scene, s.camera, `${fileStem}-reciprocal.png`, 3);
            }}
          >
            PNG 3×
          </button>
        </span>
      </div>
      <div ref={mountRef} className="viewer-stage" style={{ minHeight: 460 }} />
    </div>
  );
}

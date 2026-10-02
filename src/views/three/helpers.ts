/**
 * Shared three.js helpers for the crystal and reciprocal-space views.
 * makeLabelSprite and arrowBuilder are ported from MATERIA's StructureView
 * (web-refinement src/app/ui/StructureView.tsx @ 0ee9a7e); disposal and PNG
 * export follow the RMCProfile Workbench viewers.
 */
import * as THREE from "three";

/** Draw `text` to a canvas and wrap it in a camera-facing sprite of the given world height. */
export function makeLabelSprite(text: string, worldHeight: number, colorCss: string, fontFamily = "Inter, sans-serif"): THREE.Sprite {
  const pad = 8;
  const font = 48;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  ctx.font = `600 ${font}px ${fontFamily}`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = font + pad * 2;
  canvas.width = w;
  canvas.height = h;
  ctx.font = `600 ${font}px ${fontFamily}`;
  ctx.fillStyle = colorCss;
  ctx.textBaseline = "middle";
  ctx.fillText(text, pad, h / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set((worldHeight * w) / h, worldHeight, 1);
  return sprite;
}

/**
 * Solid arrows (cylinder shaft + cone head) that keep their world-space
 * thickness when zoomed, unlike THREE.ArrowHelper's one-pixel line shaft.
 * Every arrow from one builder shares shaft/head size; only length varies.
 */
export function arrowBuilder(opts: { color: THREE.ColorRepresentation; shaftRadius: number; headRadius: number; headLength: number; opacity?: number }) {
  const shaftGeo = new THREE.CylinderGeometry(1, 1, 1, 16);
  shaftGeo.translate(0, 0.5, 0);
  const headGeo = new THREE.ConeGeometry(1, 1, 20);
  headGeo.translate(0, 0.5, 0);
  const mat = new THREE.MeshPhongMaterial({
    color: new THREE.Color(opts.color),
    shininess: 55,
    specular: 0x333333,
    ...(opts.opacity !== undefined ? { transparent: true, opacity: opts.opacity } : {}),
  });
  const Y0 = new THREE.Vector3(0, 1, 0);
  return (dir: THREE.Vector3, origin: THREE.Vector3, length: number): THREE.Object3D => {
    const head = Math.min(opts.headLength, length * 0.55);
    const shaft = Math.max(length - head, 1e-4);
    const group = new THREE.Group();
    const s = new THREE.Mesh(shaftGeo, mat);
    s.scale.set(opts.shaftRadius, shaft, opts.shaftRadius);
    group.add(s);
    const h = new THREE.Mesh(headGeo, mat);
    h.scale.set(opts.headRadius, head, opts.headRadius);
    h.position.y = shaft;
    group.add(h);
    group.position.copy(origin);
    group.quaternion.setFromUnitVectors(Y0, dir.clone().normalize());
    return group;
  };
}

/** Dispose every geometry, material and texture under `root`. */
export function disposeTree(root: THREE.Object3D): void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) geos.add(m.geometry);
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => mats.add(x));
    else if (mat) mats.add(mat);
  });
  for (const g of geos) g.dispose();
  for (const m of mats) {
    const map = (m as THREE.SpriteMaterial).map;
    if (map) map.dispose();
    m.dispose();
  }
}

/** Read a CSS custom property from :root (e.g. --canvas-bg) as a THREE.Color-compatible string. */
export function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Save the current view as a PNG at `scale`× the on-screen size by
 * re-rendering at a higher pixel ratio (RMCProfile's approach), then
 * restoring the renderer.
 */
export function savePng(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, filename: string, scale: number): void {
  const prev = renderer.getPixelRatio();
  renderer.setPixelRatio(prev * scale);
  renderer.render(scene, camera);
  const url = renderer.domElement.toDataURL("image/png");
  renderer.setPixelRatio(prev);
  renderer.render(scene, camera);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

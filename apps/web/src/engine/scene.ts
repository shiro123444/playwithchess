import * as THREE from 'three';
import { PALETTE } from './config.ts';

/**
 * Daylight on a sheet of blue watercolour paper.
 *
 * The canvas is transparent and the paper itself is painted in CSS, so the
 * renderer only has to light the board and its pieces. That keeps the washes
 * crisp at any DPI, costs no extra texture memory, and lets the page paint the
 * background before WebGL has even started.
 *
 * Lighting is soft and even: a pale sky from above, a warm off-screen window
 * from the left, and a cool bounce from the right. No rim light — a rim light
 * is what made the old dark theme read as a stage.
 */

export interface SceneRig {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  resize: () => void;
  dispose: () => void;
}

const CAMERA_FOV = 42;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 200;

/** Vertical field of view, needed by the view layer to fit the board. */
export const SCENE_FOV = CAMERA_FOV;

/** Designed camera height/depth: red looks from +z, black from -z. */
export const CAMERA_RIG = { height: 12.6, depth: 11.4 } as const;

export function createSceneRig(canvas: HTMLCanvasElement): SceneRig {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearAlpha(0);
  renderer.shadowMap.enabled = true;
  // r186 dropped PCFSoftShadowMap from the public API; PCF with a tight shadow
  // camera and a small radius reads just as soft on this scale.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = null;
  // Fog in the paper's own blue: distant debris dissolves into the wash
  // instead of dropping out of a transparent canvas against a hard edge. It
  // has to start beyond the furthest board framing — a portrait phone sits
  // around 30 units out, and fogging there would bleach the whole board.
  scene.fog = new THREE.Fog(PALETTE.fog, 40, 95);

  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
  camera.position.set(0, 12.5, 11.5);
  camera.lookAt(0, 0, 0);

  // --- Lights -------------------------------------------------------------

  const sky = new THREE.HemisphereLight(0xffffff, 0xc4d6e2, 1.3);
  scene.add(sky);

  const sun = new THREE.DirectionalLight(0xfff6e6, 1.5);
  sun.position.set(-7.5, 14, 6.5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -11;
  sun.shadow.camera.right = 11;
  sun.shadow.camera.top = 11;
  sun.shadow.camera.bottom = -11;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 40;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun);

  const bounce = new THREE.DirectionalLight(0xbcd6e8, 0.75);
  bounce.position.set(8, 6, -9);
  scene.add(bounce);

  // --- Resize -------------------------------------------------------------

  const resize = (): void => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  const dispose = (): void => {
    window.removeEventListener('resize', resize);
    renderer.dispose();
  };

  return { renderer, scene, camera, resize, dispose };
}

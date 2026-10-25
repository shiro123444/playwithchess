import * as THREE from 'three';
import { REACTIONS, type Color, RED } from '@xiangqi/rules';

/**
 * Large 3D reaction stickers that pop up over the sender's half of the board.
 *
 * The source art is a flat render, so the third dimension has to come from the
 * presentation. Each sticker is built as a small stack: a back plate in shade,
 * the painted face, and a soft contact shadow on the table underneath. The
 * stack billboards toward the camera with a fixed yaw and tilt on top, which is
 * what makes it read as a card held in the air rather than a decal pasted on
 * the screen — as the camera moves, the face and its shaded back slide against
 * each other.
 *
 * Motion is a spring rather than a fade: the card flies up, overshoots, settles
 * with a slow breath, then lifts away. The shadow tightens as it rises, so the
 * height is legible without measuring pixels.
 */

export type ReactionSide = Color | null;

interface Sticker {
  root: THREE.Group;
  stack: THREE.Group;
  back: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  face: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  shadow: THREE.Sprite;
  bornAt: number;
  /** Height the sticker settles at, in world units above the table. */
  height: number;
  /** Seconds the sticker stays before it leaves. */
  life: number;
  yaw: number;
  tilt: number;
}

const LIFE_SECONDS = 3;
const ENTER_SECONDS = 0.5;
const LEAVE_SECONDS = 0.5;
/** Board cells are 1 unit, so a 2.3-unit sticker covers a little over two files. */
const STICKER_SIZE = 2.3;
const PLATE_GAP = 0.03;
const SHADOW_OPACITY = 0.26;
const TABLE_Y = 0.02;

const textureCache = new Map<string, THREE.Texture>();
const known = new Set(REACTIONS.map(reaction => reaction.id));

function textureFor(id: string): THREE.Texture | null {
  if (!known.has(id)) return null;
  const cached = textureCache.get(id);
  if (cached) return cached;
  const texture = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}emoji/${id}.png`);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  textureCache.set(id, texture);
  return texture;
}

function shadowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const wash = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
    wash.addColorStop(0, 'rgba(24, 44, 60, 0.9)');
    wash.addColorStop(0.5, 'rgba(24, 44, 60, 0.34)');
    wash.addColorStop(1, 'rgba(24, 44, 60, 0)');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Overshoot then settle — a card being pressed onto the table. */
function springIn(t: number): number {
  if (t >= 1) return 1;
  const c = 1.75;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t: number): number {
  return t * t * t;
}

export class ReactionLayer {
  private readonly group = new THREE.Group();
  private readonly stickers: Sticker[] = [];
  private readonly shadowMap = shadowTexture();
  // Owned by the layer rather than shared globally: disposing the scene must
  // not leave a future layer holding a freed geometry.
  private readonly plane = new THREE.PlaneGeometry(1, 1);
  private readonly tilt = new THREE.Quaternion();
  private count = 0;

  constructor(private readonly scene: THREE.Scene, private readonly camera: THREE.Camera) {
    this.group.renderOrder = 20;
    scene.add(this.group);
  }

  /** Pop a sticker above `side`'s back ranks; `null` means the viewer's side. */
  show(id: string, side: ReactionSide, now = performance.now()): boolean {
    const texture = textureFor(id);
    if (!texture) return false;

    // Red sits at +z. The sticker hovers over the sender's own back rank so the
    // opponent reads it as coming from across the board.
    const toward = (side ?? RED) === RED ? 1 : -1;
    const lane = (this.count++ % 4) - 1.5;
    const root = new THREE.Group();
    root.position.set(lane * 1.15, TABLE_Y, toward * 3.5);
    root.visible = false;

    const stack = new THREE.Group();
    stack.position.y = 0.001;
    root.add(stack);

    const back = new THREE.Mesh(this.plane, new THREE.MeshBasicMaterial({
      map: texture,
      // A tinted silhouette of the same art, a hair behind and below: enough to
      // suggest a cut edge without turning into a visible second copy.
      color: 0x2d465c,
      transparent: true,
      opacity: 0.22,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }));
    back.renderOrder = 21;
    back.position.set(0.012, -PLATE_GAP, -PLATE_GAP);
    stack.add(back);

    const face = new THREE.Mesh(this.plane, new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }));
    face.renderOrder = 22;
    stack.add(face);

    const shadow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.shadowMap,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      opacity: 0,
    }));
    shadow.renderOrder = 20;
    shadow.position.set(0.18, 0.002, -0.24);
    shadow.scale.setScalar(0.001);
    root.add(shadow);

    this.group.add(root);
    this.stickers.push({
      root, stack, back, face, shadow, bornAt: now,
      height: 1.5 + Math.abs(lane) * 0.05, life: LIFE_SECONDS,
      yaw: lane * 0.13, tilt: -0.1 + lane * 0.02,
    });
    return true;
  }

  update(now: number): void {
    for (let i = this.stickers.length - 1; i >= 0; i--) {
      const sticker = this.stickers[i]!;
      const age = (now - sticker.bornAt) / 1000;
      if (age >= sticker.life) {
        this.destroy(sticker);
        this.stickers.splice(i, 1);
        continue;
      }
      sticker.root.visible = true;

      const enter = Math.min(1, age / ENTER_SECONDS);
      const leaveStart = sticker.life - LEAVE_SECONDS;
      const leave = age > leaveStart ? Math.min(1, (age - leaveStart) / LEAVE_SECONDS) : 0;

      // Height: spring up from the table, settle, then lift away.
      const pop = springIn(enter);
      const settle = Math.sin(Math.min(1, age / 1.6) * Math.PI) * 0.05;
      const rise = easeOutCubic(leave) * 0.9;
      const height = Math.max(0.02, sticker.height * pop + settle + rise);
      sticker.stack.position.y = height;

      // Squash and stretch: the card stretches on the way up and squashes on
      // landing, which is what gives the pop its weight.
      const velocity = Math.sin(Math.min(1, enter) * Math.PI);
      const stretch = 1 + velocity * 0.12 - Math.min(1, leave) * 0.1;
      const widthBreathe = 1 + Math.sin(age * 2.6) * 0.015;
      const scale = STICKER_SIZE * widthBreathe * (1 - easeInCubic(leave) * 0.25);
      sticker.stack.scale.set(scale / Math.sqrt(stretch), scale * stretch, scale);

      // Billboard toward the camera, then tilt back into the scene. Without
      // the tilt a sprite is a hologram; with it the two plates separate.
      sticker.stack.quaternion.copy(this.camera.quaternion);
      const wobble = Math.sin(age * 2.2) * 0.05;
      this.tilt.setFromEuler(new THREE.Euler(sticker.tilt + wobble, sticker.yaw, Math.sin(age * 1.4) * 0.03, 'YXZ'));
      sticker.stack.quaternion.multiply(this.tilt);

      // The shadow stays on the table and spreads as the card drops.
      const drop = 1 - Math.min(1, height / sticker.height);
      const shadowScale = scale * (0.72 + drop * 0.5);
      sticker.shadow.scale.set(shadowScale, shadowScale * 0.62, 1);
      sticker.shadow.material.opacity = SHADOW_OPACITY * Math.min(1, enter * 1.5)
        * (1 - Math.min(1, leave)) * (0.45 + drop * 0.55);

      // The shaded back drifts further behind as the card rises: parallax.
      sticker.back.position.z = -PLATE_GAP - height * 0.012;
      sticker.back.position.y = -PLATE_GAP - height * 0.008;
    }
  }

  /** Drop every sticker at once, e.g. when the board is reloaded. */
  clear(): void {
    for (const sticker of this.stickers) this.destroy(sticker);
    this.stickers.length = 0;
  }

  dispose(): void {
    this.clear();
    this.scene.remove(this.group);
    this.shadowMap.dispose();
    this.plane.dispose();
    for (const texture of textureCache.values()) texture.dispose();
    textureCache.clear();
  }

  private destroy(sticker: Sticker): void {
    this.group.remove(sticker.root);
    sticker.face.material.dispose();
    sticker.back.material.dispose();
    sticker.shadow.material.dispose();
  }
}

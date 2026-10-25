import * as THREE from 'three';
import { PIECE_GLYPHS } from '@xiangqi/rules';
import { PALETTE, PIECE_HEIGHT, PIECE_RADIUS } from './config.ts';

/**
 * Pieces are porcelain discs: a pale glazed body, a thin cobalt or vermilion
 * ring, and the character brushed inside it. The body is a cylinder with a
 * separate textured cap so the glyph maps cleanly onto the face while the rim
 * still has a real bevel to catch the light.
 */

const GLYPH_FONT = '"Noto Serif SC", "Songti SC", "STSong", serif';

function createGlyphTexture(glyph: string, red: boolean): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');

  // Glazed face: porcelain white with a faint blue shadow at the low edge,
  // which is what makes a flat disc read as slightly domed.
  const face = ctx.createRadialGradient(
    size * 0.42,
    size * 0.36,
    size * 0.05,
    size * 0.5,
    size * 0.55,
    size * 0.55,
  );
  face.addColorStop(0, '#fffdf7');
  face.addColorStop(0.7, '#f2f4f1');
  face.addColorStop(1, '#dce6ec');
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // A wash of pigment bleeding from one side, so the glaze is not uniform.
  const bleed = ctx.createRadialGradient(
    size * 0.7,
    size * 0.72,
    0,
    size * 0.7,
    size * 0.72,
    size * 0.45,
  );
  bleed.addColorStop(0, red ? 'rgba(196, 96, 84, 0.2)' : 'rgba(96, 140, 172, 0.2)');
  bleed.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = bleed;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Two rings: a pale outer one that suggests the glaze puddling, and the
  // inked one that holds the character.
  ctx.strokeStyle = 'rgba(120, 150, 170, 0.22)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.455, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = red ? 'rgba(160, 62, 52, 0.72)' : 'rgba(47, 95, 134, 0.72)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.4, 0, Math.PI * 2);
  ctx.stroke();

  // Brushed character. A transparent off-register copy underneath fakes the
  // slight spread of wet ink; the crisp copy on top stays legible.
  const textY = size / 2 + size * 0.02;
  ctx.font = `700 ${Math.round(size * 0.52)}px ${GLYPH_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.save();
  ctx.globalAlpha = 0.28;
  ctx.filter = 'blur(3px)';
  ctx.fillStyle = red ? '#a03e34' : '#2f5f86';
  ctx.fillText(glyph, size / 2 + 2, textY + 2);
  ctx.restore();

  ctx.fillStyle = red ? '#a8402f' : '#2b4f6b';
  ctx.fillText(glyph, size / 2, textY);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

const bodyGeometry = new THREE.CylinderGeometry(
  PIECE_RADIUS * 0.985,
  PIECE_RADIUS,
  PIECE_HEIGHT,
  48,
  1,
);
const capGeometry = new THREE.CircleGeometry(PIECE_RADIUS * 0.985, 48);
capGeometry.rotateX(-Math.PI / 2);

/** Cache textures per piece type + colour so 32 pieces cost 14 canvases. */
const textureCache = new Map<string, THREE.CanvasTexture>();

function glyphTextureFor(type: number, red: boolean): THREE.CanvasTexture {
  const key = `${type}:${red ? 'r' : 'b'}`;
  const cached = textureCache.get(key);
  if (cached) return cached;
  const glyphs = PIECE_GLYPHS[type];
  if (!glyphs) throw new Error(`No glyph for piece type ${type}`);
  const texture = createGlyphTexture(red ? glyphs.red : glyphs.black, red);
  textureCache.set(key, texture);
  return texture;
}

export interface PieceVisual {
  mesh: THREE.Group;
  /** The inked face, kept so the glyph can be turned toward the viewer. */
  cap: THREE.Mesh;
  /** Position when the visual was created, used by the capture animation. */
  home: THREE.Vector3;
}

export function createPieceVisual(type: number, red: boolean): PieceVisual {
  const texture = glyphTextureFor(type, red);

  // Both sides are porcelain; only the ink differs. That is what a real set
  // looks like, and it keeps the board from splitting into two materials.
  const sideMaterial = new THREE.MeshStandardMaterial({
    color: red ? PALETTE.porcelain : PALETTE.porcelainShade,
    roughness: 0.62,
    metalness: 0,
  });
  // Ink must keep its contrast under the scene's bright daylight.
  const capMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    toneMapped: false,
  });

  const group = new THREE.Group();

  const body = new THREE.Mesh(bodyGeometry, sideMaterial);
  body.position.y = PIECE_HEIGHT / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const cap = new THREE.Mesh(capGeometry, capMaterial);
  cap.position.y = PIECE_HEIGHT + 0.001;
  cap.receiveShadow = true;
  group.add(cap);

  return { mesh: group, cap, home: new THREE.Vector3() };
}

/** Thin ring shown under the selected piece. */
export function createSelectionRing(): THREE.Mesh {
  const geometry = new THREE.RingGeometry(PIECE_RADIUS * 1.04, PIECE_RADIUS * 1.24, 64);
  const material = new THREE.MeshBasicMaterial({
    color: PALETTE.cobalt,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(geometry, material);
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  return ring;
}

/** Marker shown on every legal destination square. */
export function createMoveMarker(): THREE.Mesh {
  const geometry = new THREE.RingGeometry(PIECE_RADIUS * 0.2, PIECE_RADIUS * 0.32, 32);
  const material = new THREE.MeshBasicMaterial({
    color: PALETTE.jade,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const marker = new THREE.Mesh(geometry, material);
  marker.rotation.x = -Math.PI / 2;
  return marker;
}

/** Larger ring used to flag the last move's origin and destination. */
export function createLastMoveMarker(color: number = PALETTE.vermilion): THREE.Mesh {
  const geometry = new THREE.RingGeometry(PIECE_RADIUS * 0.95, PIECE_RADIUS * 1.06, 48);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const marker = new THREE.Mesh(geometry, material);
  marker.rotation.x = -Math.PI / 2;
  return marker;
}

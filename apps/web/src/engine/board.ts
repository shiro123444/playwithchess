import * as THREE from 'three';
import {
  BOARD_DEPTH,
  BOARD_FILES,
  BOARD_MARGIN,
  BOARD_RANKS,
  BOARD_THICKNESS,
  BOARD_WIDTH,
  CELL,
  GRID_DEPTH,
  GRID_WIDTH,
  PALETTE,
  SURFACE_Y,
} from './config.ts';

/**
 * The board is a sheet of watercolour paper with a thin cobalt grid washed
 * into it. Everything is painted into one canvas texture (rather than drawn as
 * line geometry), which keeps the strokes crisp at any zoom at the cost of a
 * single draw call.
 *
 * The washes are built from overlapping low-alpha blobs rather than a linear
 * gradient: a gradient reads as printed card, while layered translucent blobs
 * with ragged edges read as pigment soaking into paper.
 */

const TEXTURE_PX_PER_UNIT = 256;

function createCanvas(
  width: number,
  height: number,
): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

/** Deterministic value noise, so the paper looks the same on every reload. */
function makeNoise(seed: number): (x: number, y: number) => number {
  let state = seed >>> 0;
  const rand = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
  const grid = new Float32Array(64 * 64);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  return (x: number, y: number): number => {
    const gx = ((x % 64) + 64) % 64;
    const gy = ((y % 64) + 64) % 64;
    return grid[(gy | 0) * 64 + (gx | 0)] ?? 0;
  };
}

/** A wet blob: a radial wash with a slightly irregular rim. */
function wash(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  color: string,
  alpha: number,
  noise: (x: number, y: number) => number,
  seed: number,
): void {
  const gradient = ctx.createRadialGradient(cx, cy, radius * 0.12, cx, cy, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.65, color);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = gradient;
  ctx.beginPath();
  // Walk the rim with a radius that wanders, so the edge is not a perfect disc.
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const wobble = 1 + (noise(cx * 0.03 + i * 1.7, cy * 0.03 + seed) - 0.5) * 0.34;
    const x = cx + Math.cos(angle) * radius * wobble;
    const y = cy + Math.sin(angle) * radius * wobble;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function paintPaper(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const noise = makeNoise(0x51a1);

  // Sized, slightly warm paper.
  ctx.fillStyle = '#f7f5ee';
  ctx.fillRect(0, 0, width, height);

  // Cobalt washes pooling at the corners and drifting across the middle.
  wash(ctx, width * 0.12, height * 0.1, width * 0.55, 'rgba(126, 166, 196, 0.5)', 0.75, noise, 3);
  wash(ctx, width * 0.88, height * 0.16, width * 0.42, 'rgba(96, 142, 178, 0.45)', 0.6, noise, 11);
  wash(ctx, width * 0.78, height * 0.9, width * 0.5, 'rgba(132, 174, 202, 0.42)', 0.62, noise, 23);
  wash(ctx, width * 0.2, height * 0.84, width * 0.44, 'rgba(110, 152, 184, 0.4)', 0.55, noise, 37);
  wash(ctx, width * 0.5, height * 0.5, width * 0.6, 'rgba(226, 236, 243, 0.9)', 0.5, noise, 59);

  // A turquoise counter-wash keeps the blue from going flat.
  wash(ctx, width * 0.62, height * 0.34, width * 0.3, 'rgba(120, 170, 168, 0.3)', 0.4, noise, 71);

  // Paper fibre: sparse darker specks, no directional grain.
  ctx.globalAlpha = 0.1;
  for (let i = 0; i < 4200; i++) {
    const x = noise(i * 0.31, 7) * width;
    const y = noise(i * 0.57, 13) * height;
    const len = 1 + noise(i, 3) * 3;
    ctx.strokeStyle = noise(i, 5) > 0.5 ? '#8ba7bd' : '#ffffff';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + noise(i, 9) * 1.4 - 0.7);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Deckled edge: a thin uneven shadow where the paint pooled at the sheet edge.
  const edge = ctx.createLinearGradient(0, 0, 0, height);
  edge.addColorStop(0, 'rgba(80, 120, 152, 0.18)');
  edge.addColorStop(0.12, 'rgba(80, 120, 152, 0)');
  edge.addColorStop(0.88, 'rgba(80, 120, 152, 0)');
  edge.addColorStop(1, 'rgba(80, 120, 152, 0.16)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, width, height);
}

function gridToCanvas(
  file: number,
  rank: number,
  width: number,
  height: number,
): { x: number; y: number } {
  // The canvas covers the whole slab, so the playing grid is inset by the
  // same margin the 3D geometry uses.
  const marginX = (BOARD_MARGIN / BOARD_WIDTH) * width;
  const marginY = (BOARD_MARGIN / BOARD_DEPTH) * height;
  const stepX = (width - marginX * 2) / (BOARD_FILES - 1);
  const stepY = (height - marginY * 2) / (BOARD_RANKS - 1);
  return { x: marginX + stepX * file, y: marginY + stepY * rank };
}

/** Stroke a path twice, slightly offset, to look like a drawn pencil-ink line. */
function inkStroke(ctx: CanvasRenderingContext2D, draw: () => void, width: number, alpha: number): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = `rgba(47, 95, 134, ${alpha})`;
  ctx.lineWidth = width;
  ctx.beginPath();
  draw();
  ctx.stroke();
  // The second pass is fainter and a hair off, which is what makes a hand-drawn
  // line look drawn rather than plotted.
  ctx.translate(0.8, -0.6);
  ctx.strokeStyle = `rgba(47, 95, 134, ${alpha * 0.45})`;
  ctx.lineWidth = width * 0.7;
  ctx.beginPath();
  draw();
  ctx.stroke();
  ctx.restore();
}

function paintGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const p = (file: number, rank: number): { x: number; y: number } =>
    gridToCanvas(file, rank, width, height);

  const top = p(0, 0);
  const bottom = p(0, BOARD_RANKS - 1);
  const left = p(0, 0);
  const right = p(BOARD_FILES - 1, 0);

  // Outer frame — the heavier of the two ruled boxes.
  inkStroke(
    ctx,
    () => {
      const x = right.x - left.x + 18;
      const y = bottom.y - top.y + 18;
      ctx.rect(left.x - 9, top.y - 9, x, y);
    },
    2.6,
    0.8,
  );
  inkStroke(
    ctx,
    () => {
      const x = right.x - left.x + 36;
      const y = bottom.y - top.y + 36;
      ctx.rect(left.x - 18, top.y - 18, x, y);
    },
    1.3,
    0.34,
  );

  // Ranks: full lines on every rank.
  for (let rank = 0; rank < BOARD_RANKS; rank++) {
    const a = p(0, rank);
    const b = p(BOARD_FILES - 1, rank);
    inkStroke(
      ctx,
      () => {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      },
      1.7,
      0.68,
    );
  }

  // Files: continuous everywhere except the river, and only the outer files
  // are drawn across the river (as on a physical board).
  for (let file = 0; file < BOARD_FILES; file++) {
    const isEdge = file === 0 || file === BOARD_FILES - 1;
    const a = p(file, 0);
    const b = p(file, isEdge ? BOARD_RANKS - 1 : 4);
    inkStroke(
      ctx,
      () => {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      },
      1.7,
      0.68,
    );
    if (!isEdge) {
      const c = p(file, 5);
      const d = p(file, BOARD_RANKS - 1);
      inkStroke(
        ctx,
        () => {
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(d.x, d.y);
        },
        1.7,
        0.68,
      );
    }
  }

  // Palace diagonals.
  const palace = (fileMin: number, fileMax: number, rankMin: number, rankMax: number): void => {
    const a = p(fileMin, rankMin);
    const b = p(fileMax, rankMax);
    const c = p(fileMax, rankMin);
    const d = p(fileMin, rankMax);
    inkStroke(
      ctx,
      () => {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.moveTo(c.x, c.y);
        ctx.lineTo(d.x, d.y);
      },
      1.5,
      0.6,
    );
  };
  palace(3, 5, 0, 2);
  palace(3, 5, 7, 9);

  // Position markers at cannon and pawn starting points.
  const marker = (file: number, rank: number): void => {
    const { x, y } = p(file, rank);
    const arm = 11;
    const gap = 7;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        if (file === 0 && sx === -1) continue;
        if (file === BOARD_FILES - 1 && sx === 1) continue;
        inkStroke(
          ctx,
          () => {
            ctx.moveTo(x + sx * gap, y + sy * (gap + arm));
            ctx.lineTo(x + sx * gap, y + sy * gap);
            ctx.lineTo(x + sx * (gap + arm), y + sy * gap);
          },
          1.5,
          0.5,
        );
      }
    }
  };
  for (const file of [1, 7]) {
    marker(file, 2);
    marker(file, 7);
  }
  for (const file of [0, 2, 4, 6, 8]) {
    marker(file, 3);
    marker(file, 6);
  }

  // River calligraphy, in a washed rather than solid ink.
  const riverY = (p(0, 4).y + p(0, 5).y) / 2;
  ctx.save();
  ctx.globalAlpha = 0.62;
  ctx.fillStyle = '#2f5f86';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fontPx = Math.round((right.x - left.x) * 0.082);
  ctx.font = `${fontPx}px "Ma Shan Zheng", "Noto Serif SC", serif`;

  ctx.save();
  ctx.translate(width * 0.31, riverY);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('楚 河', 0, 0);
  ctx.restore();

  ctx.save();
  ctx.translate(width * 0.69, riverY);
  ctx.rotate(Math.PI / 2);
  ctx.fillText('漢 界', 0, 0);
  ctx.restore();
  ctx.restore();
}

/** Build the top texture: watercolour paper + pencil-ink grid. */
function createBoardTexture(): THREE.CanvasTexture {
  const width = Math.round(BOARD_WIDTH * TEXTURE_PX_PER_UNIT);
  const height = Math.round(BOARD_DEPTH * TEXTURE_PX_PER_UNIT);
  const { canvas, ctx } = createCanvas(width, height);
  paintPaper(ctx, width, height);
  paintGrid(ctx, width, height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** Streaky wash for the slab's cut edge, so the sides are paper, not plastic. */
function createEdgeTexture(): THREE.CanvasTexture {
  const { canvas, ctx } = createCanvas(256, 64);
  ctx.fillStyle = '#e4edf2';
  ctx.fillRect(0, 0, 256, 64);
  const noise = makeNoise(0x9a3);
  ctx.globalAlpha = 0.22;
  for (let i = 0; i < 90; i++) {
    const y = noise(i, 1) * 64;
    ctx.strokeStyle = noise(i, 2) > 0.5 ? '#a9c2d2' : '#ffffff';
    ctx.lineWidth = 0.5 + noise(i, 3) * 1.6;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(80, y + noise(i, 4) * 6, 170, y - noise(i, 5) * 6, 256, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export interface Board {
  group: THREE.Group;
  /** Raycast against this to convert pointer position to a board square. */
  pickPlane: THREE.Mesh;
}

export function createBoard(): Board {
  const group = new THREE.Group();
  const texture = createBoardTexture();
  const edgeTexture = createEdgeTexture();

  const topMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.86,
    metalness: 0,
  });
  const sideMaterial = new THREE.MeshStandardMaterial({
    color: PALETTE.boardEdge,
    map: edgeTexture,
    roughness: 0.9,
    metalness: 0,
  });

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD_WIDTH, BOARD_THICKNESS, BOARD_DEPTH),
    [sideMaterial, sideMaterial, topMaterial, sideMaterial, sideMaterial, sideMaterial],
  );
  slab.position.y = SURFACE_Y - BOARD_THICKNESS / 2;
  slab.castShadow = true;
  slab.receiveShadow = true;
  group.add(slab);

  // A single blue-grey rule around the edge, like a mat border.
  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(BOARD_WIDTH + 0.06, 0.04, BOARD_DEPTH + 0.06),
    new THREE.MeshStandardMaterial({
      color: PALETTE.boardRim,
      roughness: 0.75,
      metalness: 0,
    }),
  );
  rim.position.y = SURFACE_Y - BOARD_THICKNESS + 0.1;
  rim.receiveShadow = true;
  group.add(rim);

  // Invisible plane used for pointer picking (matches the playing surface).
  const pickPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(GRID_WIDTH + CELL, GRID_DEPTH + CELL),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  pickPlane.rotation.x = -Math.PI / 2;
  pickPlane.position.y = SURFACE_Y + 0.001;
  pickPlane.name = 'pickPlane';
  group.add(pickPlane);

  return { group, pickPlane };
}

/** Soft blue contact shadow under the board, so it doesn't float in the void. */
export function createBoardShadow(): THREE.Mesh {
  const { canvas, ctx } = createCanvas(512, 512);
  const gradient = ctx.createRadialGradient(256, 256, 40, 256, 256, 250);
  gradient.addColorStop(0, 'rgba(52, 84, 108, 0.34)');
  gradient.addColorStop(0.6, 'rgba(52, 84, 108, 0.14)');
  gradient.addColorStop(1, 'rgba(52, 84, 108, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 512, 512);

  const texture = new THREE.CanvasTexture(canvas);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(BOARD_WIDTH * 1.7, BOARD_DEPTH * 1.7),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      color: 0xffffff,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = SURFACE_Y - BOARD_THICKNESS - 0.02;
  return shadow;
}

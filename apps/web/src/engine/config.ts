/**
 * Board geometry and art-direction constants.
 *
 * The visual language is blue-and-white watercolour: pale blue paper, cobalt
 * washes, porcelain pieces, and a pencil-thin ink grid. Colours are defined
 * once here so the canvas textures, materials and CSS-HUD agree.
 */

/** Distance between two adjacent lines on the board, in world units. */
export const CELL = 1;

/** Xiangqi is 9 files wide and 10 ranks deep, so the grid is 8x9 cells. */
export const BOARD_FILES = 9;
export const BOARD_RANKS = 10;
export const GRID_WIDTH = (BOARD_FILES - 1) * CELL;
export const GRID_DEPTH = (BOARD_RANKS - 1) * CELL;

/** Margin between the playing grid and the edge of the wooden frame. */
export const BOARD_MARGIN = 0.85;
export const BOARD_WIDTH = GRID_WIDTH + BOARD_MARGIN * 2;
export const BOARD_DEPTH = GRID_DEPTH + BOARD_MARGIN * 2;
export const BOARD_THICKNESS = 0.5;

/** Top surface of the board slab (pieces rest on this plane). */
export const SURFACE_Y = 0;

export const PIECE_RADIUS = 0.44;
export const PIECE_HEIGHT = 0.2;
export const PIECE_LIFT = 0.06;

export const PALETTE = {
  /** Pale blue paper the whole scene sits on. */
  paper: 0xe9f1f6,
  fog: 0xdce8f0,
  /** Washed board slab: warm white with a cool shadow. */
  boardFace: 0xf6f4ec,
  boardEdge: 0xd9e2e8,
  boardRim: 0xb7cbd8,
  /** Cobalt used for the grid and for black's glyphs. */
  cobalt: 0x2f5f86,
  cobaltDeep: 0x244a68,
  cobaltSoft: 0x7fa3bd,
  /** Vermilion for red's glyphs and the last-move ring. */
  vermilion: 0xb4463c,
  vermilionSoft: 0xd07d70,
  /** Porcelain body and its shading. */
  porcelain: 0xf8f6ef,
  porcelainShade: 0xd7e2ea,
  ink: 0x23323d,
  jade: 0x6f9c8a,
} as const;

/** Convert an internal square index to a world position on the board. */
export function squareToWorld(
  square: number,
  width = BOARD_FILES,
  height = BOARD_RANKS,
): { x: number; z: number } {
  const file = square % width;
  const rank = (square / width) | 0;
  return {
    x: (file - (width - 1) / 2) * CELL,
    z: (rank - (height - 1) / 2) * CELL,
  };
}

/**
 * Piece codes, move encoding, and glyph tables.
 *
 * Board geometry lives in `variant.ts` so the same engine can host more than
 * one board size (Xiangqi is 9x10, Mini Xiangqi is 7x7).
 */

/** Piece type codes (low 3 bits of a piece byte). */
export const EMPTY = 0;
export const ADVISOR = 1;
export const ELEPHANT = 2;
export const HORSE = 3;
export const ROOK = 4;
export const CANNON = 5;
export const PAWN = 6;
export const KING = 7;

/** Colour bit stored in bit 3 of a piece byte. */
export const BLACK_BIT = 8;

export const RED = 0;
export const BLACK = 1;
export type Color = 0 | 1;

export const typeOf = (piece: number): number => piece & 7;
export const colorOf = (piece: number): Color => ((piece >> 3) & 1) as Color;
export const makePiece = (type: number, color: Color): number => type | (color === BLACK ? BLACK_BIT : 0);

// ---------------------------------------------------------------------------
// Move encoding: `from | (to << 7)`. Every supported board has fewer than 128
// squares, and Xiangqi has no promotions, castling, or en passant, so a
// from→to pair fully identifies a move.
// ---------------------------------------------------------------------------

export type Move = number;

export const encodeMove = (from: number, to: number): Move => from | (to << 7);
export const moveFrom = (m: Move): number => m & 127;
export const moveTo = (m: Move): number => (m >> 7) & 127;

export const FILE_CHARS = 'abcdefghi';

/**
 * UCI square names count ranks from the bottom (Red's side), so internal rank
 * `r` (0 = Black's back rank) becomes digit `height - 1 - r`.
 */
export function squareToUci(sq: number, width: number, height: number): string {
  const file = sq % width;
  const rank = (sq / width) | 0;
  return FILE_CHARS[file] + String(height - 1 - rank);
}

export function uciToSquare(text: string, width: number, height: number): number {
  const file = FILE_CHARS.indexOf(text[0]);
  const rank = height - 1 - Number(text[1]);
  if (file < 0 || file >= width || !Number.isInteger(rank)) return -1;
  if (rank < 0 || rank >= height) return -1;
  return rank * width + file;
}

export function moveToUci(m: Move, width: number, height: number): string {
  return squareToUci(moveFrom(m), width, height) + squareToUci(moveTo(m), width, height);
}

export function uciToMove(text: string, width: number, height: number): Move {
  if (text.length < 4) return -1;
  const from = uciToSquare(text.slice(0, 2), width, height);
  const to = uciToSquare(text.slice(2, 4), width, height);
  if (from < 0 || to < 0) return -1;
  return encodeMove(from, to);
}

/** Piece letters used by the standard Xiangqi FEN dialect (uppercase = Red). */
export const TYPE_TO_LETTER: Record<number, string> = {
  [KING]: 'k',
  [ADVISOR]: 'a',
  [ELEPHANT]: 'b',
  [HORSE]: 'n',
  [ROOK]: 'r',
  [CANNON]: 'c',
  [PAWN]: 'p',
};

export const LETTER_TO_TYPE: Record<string, number> = {
  k: KING,
  a: ADVISOR,
  b: ELEPHANT,
  n: HORSE,
  r: ROOK,
  c: CANNON,
  p: PAWN,
};

export const PIECE_NAMES: Record<number, string> = {
  [ADVISOR]: 'advisor',
  [ELEPHANT]: 'elephant',
  [HORSE]: 'horse',
  [ROOK]: 'rook',
  [CANNON]: 'cannon',
  [PAWN]: 'pawn',
  [KING]: 'king',
};

/** Traditional glyphs — Red and Black use distinct characters, as on real sets. */
export const PIECE_GLYPHS: Record<number, { red: string; black: string }> = {
  [KING]: { red: '帥', black: '將' },
  [ADVISOR]: { red: '仕', black: '士' },
  [ELEPHANT]: { red: '相', black: '象' },
  [HORSE]: { red: '傌', black: '馬' },
  [ROOK]: { red: '俥', black: '車' },
  [CANNON]: { red: '炮', black: '砲' },
  [PAWN]: { red: '兵', black: '卒' },
};

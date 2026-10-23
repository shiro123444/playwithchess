import { BLACK, RED, type Color } from '../types.ts';
import type { Position } from '../position.ts';

/**
 * Piece values in centipawns. Xiangqi material is flatter than chess: rooks
 * dominate, cannons and horses are comparable, and advisors/elephants are
 * purely defensive.
 */
export const PIECE_VALUE: Record<number, number> = {
  1: 120, // advisor
  2: 120, // elephant
  3: 270, // horse
  4: 600, // rook
  5: 285, // cannon
  6: 30, // pawn base (advancement adds to this)
  7: 100_000, // king
};

/**
 * Positional tables for Red, indexed with row 0 = Red's own back rank and
 * column 0 = Red's left file. Black reads the vertically mirrored square.
 *
 * Rows are therefore "distance from home": row 3 is the starting pawn rank,
 * rows 5-9 are increasingly deep in enemy territory.
 */
const HORSE_TABLE = [
  0, 2, 4, 4, 4, 4, 4, 2, 0,
  2, 4, 6, 8, 10, 8, 6, 4, 2,
  4, 8, 10, 12, 14, 12, 10, 8, 4,
  8, 12, 14, 18, 20, 18, 14, 12, 8,
  10, 14, 18, 22, 24, 22, 18, 14, 10,
  10, 16, 20, 24, 26, 24, 20, 16, 10,
  8, 14, 18, 22, 24, 22, 18, 14, 8,
  6, 12, 16, 18, 20, 18, 16, 12, 6,
  4, 8, 12, 12, 14, 12, 12, 8, 4,
  0, 4, 8, 6, 6, 6, 8, 4, 0,
];

const CANNON_TABLE = [
  4, 4, 4, 4, 4, 4, 4, 4, 4,
  8, 8, 10, 12, 14, 12, 10, 8, 8,
  6, 6, 8, 10, 12, 10, 8, 6, 6,
  4, 4, 6, 8, 10, 8, 6, 4, 4,
  2, 2, 4, 6, 8, 6, 4, 2, 2,
  0, 0, 2, 6, 8, 6, 2, 0, 0,
  0, 0, 0, 2, 4, 2, 0, 0, 0,
  2, 2, 0, 0, 0, 0, 0, 2, 2,
  4, 4, 0, 0, 0, 0, 0, 4, 4,
  6, 6, 2, 0, 0, 0, 2, 6, 6,
];

const ROOK_TABLE = [
  -2, 10, 6, 14, 12, 14, 6, 10, -2,
  8, 4, 8, 16, 8, 16, 8, 4, 8,
  4, 8, 6, 14, 12, 14, 6, 8, 4,
  6, 10, 8, 14, 14, 14, 8, 10, 6,
  12, 16, 14, 20, 20, 20, 14, 16, 12,
  12, 14, 12, 18, 18, 18, 12, 14, 12,
  12, 18, 16, 22, 22, 22, 16, 18, 12,
  12, 12, 12, 18, 18, 18, 12, 12, 12,
  16, 20, 18, 24, 26, 24, 18, 20, 16,
  14, 14, 12, 18, 16, 18, 12, 14, 14,
];

const PAWN_TABLE = [
  30, 34, 30, 26, 22, 26, 30, 34, 30,
  32, 36, 32, 26, 22, 26, 32, 36, 32,
  28, 30, 26, 22, 16, 22, 26, 30, 28,
  20, 24, 18, 14, 8, 14, 18, 24, 20,
  6, 4, 0, -8, -10, -8, 0, 4, 6,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
];

const ADVISOR_TABLE = [
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 10, 0, 10, 0, 0, 0,
  0, 0, 0, 0, 14, 0, 0, 0, 0,
  0, 0, 0, 6, 0, 6, 0, 0, 0,
];

const ELEPHANT_TABLE = [
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 2, 0, 0, 0, 0, 0, 2, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 0, 0, 0, 10, 0, 0, 0, 2,
  0, 0, 0, 6, 0, 6, 0, 0, 0,
];

const KING_TABLE = [
  0, 0, 0, 4, 8, 4, 0, 0, 0,
  0, 0, 0, 6, 12, 6, 0, 0, 0,
  0, 0, 0, 8, 16, 8, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0,
];

const TABLE_BY_TYPE: Record<number, number[]> = {
  1: ADVISOR_TABLE,
  2: ELEPHANT_TABLE,
  3: HORSE_TABLE,
  4: ROOK_TABLE,
  5: CANNON_TABLE,
  6: PAWN_TABLE,
  7: KING_TABLE,
};

/**
 * Static evaluation in centipawns, positive for Red.
 *
 * Tables are authored for the 9x10 board. Smaller variants scale the lookup
 * by column/row ratios so the shapes stay meaningful.
 */
export function evaluate(pos: Position): number {
  const { board, geo, config } = pos;
  const width = geo.width;
  const height = geo.height;
  const scaleX = width === 9 ? 1 : 9 / width;
  const scaleY = height === 10 ? 1 : 10 / height;
  let score = 0;

  for (let sq = 0; sq < geo.squares; sq++) {
    const piece = board[sq];
    if (piece === 0) continue;

    const type = piece & 7;
    const color: Color = piece & 8 ? BLACK : RED;
    const value = PIECE_VALUE[type] ?? 0;

    let positional = 0;
    const table = TABLE_BY_TYPE[type];
    if (table) {
      const file = sq % width;
      const rank = (sq / width) | 0;
      // Red reads rows from its own back rank; Black mirrors vertically.
      const row = color === RED ? height - 1 - rank : rank;
      const tx = Math.min(8, Math.round(file * scaleX));
      const ty = Math.min(9, Math.round(row * scaleY));
      positional = table[ty * 9 + tx] ?? 0;
    }

    score += color === RED ? value + positional : -(value + positional);
  }

  // Small tempo bonus stops the search from flip-flopping on equal positions.
  score += pos.sideToMove === RED ? 8 : -8;
  void config;
  return score;
}

import {
  ADVISOR,
  BLACK,
  CANNON,
  ELEPHANT,
  EMPTY,
  HORSE,
  KING,
  PAWN,
  RED,
  ROOK,
  type Color,
  type Move,
  moveFrom,
  moveTo,
} from './types.ts';
import type { Position } from './position.ts';

/** Red writes numerals as Chinese characters; Black uses plain digits. */
const RED_DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const BLACK_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

const NAMES: Record<number, { red: string; black: string }> = {
  [ADVISOR]: { red: '仕', black: '士' },
  [ELEPHANT]: { red: '相', black: '象' },
  [HORSE]: { red: '傌', black: '馬' },
  [ROOK]: { red: '俥', black: '車' },
  [CANNON]: { red: '炮', black: '砲' },
  [PAWN]: { red: '兵', black: '卒' },
  [KING]: { red: '帥', black: '將' },
};

/**
 * Convert a move to Chinese move notation (e.g. `炮二平五`).
 *
 * File numbers count from each side's own right. Red's rightmost file is 一,
 * Black's rightmost file is 1 — which is why Red's number is `9 - file` and
 * Black's is `file + 1`.
 *
 * When two identical pieces share a file, the moving one is prefixed with
 * 前 (front) or 后 (rear), matching standard notation.
 */
export function toChineseNotation(pos: Position, move: Move): string {
  const { geo, board } = pos;
  const from = moveFrom(move);
  const to = moveTo(move);
  const piece = board[from];
  if (piece === EMPTY) return '';

  const type = piece & 7;
  const color: Color = piece & 8 ? BLACK : RED;
  const name = NAMES[type]?.[color === RED ? 'red' : 'black'] ?? '';
  const digits = color === RED ? RED_DIGITS : BLACK_DIGITS;

  // File number as the moving side counts it.
  const fileNumber = (sq: number): number => {
    const file = sq % geo.width;
    return color === RED ? geo.width - file : file + 1;
  };

  const fromFile = geo.fileOf[from];
  const toFile = geo.fileOf[to];
  const fromRank = geo.rankOf[from];
  const toRank = geo.rankOf[to];

  // Disambiguation: pieces of the same type stacked on the moving file.
  let prefix = '';
  if (type === ROOK || type === CANNON || type === PAWN || type === HORSE) {
    const sameFile: number[] = [];
    for (let sq = from % geo.width; sq < geo.squares; sq += geo.width) {
      if (board[sq] === piece) sameFile.push(sq);
    }
    if (sameFile.length > 1) {
      // Red counts "front" as the lower rank (closer to Black); Black the reverse.
      sameFile.sort((a, b) => geo.rankOf[a] - geo.rankOf[b]);
      const index = sameFile.indexOf(from);
      if (color === RED) {
        prefix = index === 0 ? '前' : index === sameFile.length - 1 ? '后' : `中`;
      } else {
        prefix = index === sameFile.length - 1 ? '前' : index === 0 ? '后' : `中`;
      }
    }
  }

  const originPart = prefix ? `${prefix}${name}` : `${name}${digits[fileNumber(from) - 1]}`;

  if (fromRank === toRank) {
    return `${originPart}平${digits[fileNumber(to) - 1]}`;
  }

  const forward = color === RED ? toRank < fromRank : toRank > fromRank;
  const verb = forward ? '进' : '退';
  const distance = Math.abs(toRank - fromRank);

  // Rook, cannon, pawn, and king state the number of ranks travelled;
  // advisors, elephants, and horses state the destination file instead.
  const usesDistance = type === ROOK || type === CANNON || type === PAWN || type === KING;
  const value = usesDistance ? distance : fileNumber(to);
  return `${originPart}${verb}${digits[value - 1]}`;
}

/** Compact human-readable move list, e.g. `炮二平五 炮8平5`. */
export function movesToChinese(pos: Position, moves: Move[]): string[] {
  return moves.map((move) => toChineseNotation(pos, move));
}

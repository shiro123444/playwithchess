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
  encodeMove,
} from './types.ts';
import { crossedRiver, forwardStep, inPalace, type Geometry } from './variant.ts';

/** The slice of `Position` the generator needs. */
export interface PositionView {
  readonly board: Uint8Array;
  readonly geo: Geometry;
  readonly sideToMove: Color;
  readonly kingSq: Int8Array;
}

const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];

const DIAGONAL: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/** Elephant jumps two squares diagonally and may be blocked at the midpoint. */
const ELEPHANT_JUMPS: ReadonlyArray<readonly [number, number]> = [
  [-2, -2],
  [-2, 2],
  [2, -2],
  [2, 2],
];

/**
 * Horse: `[dx, dy, legDx, legDy]`, where the leg is the square adjacent to the
 * horse in the direction of travel. A piece on the leg blocks the move.
 */
export const HORSE_STEPS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, -2, 0, -1],
  [-1, -2, 0, -1],
  [1, 2, 0, 1],
  [-1, 2, 0, 1],
  [2, 1, 1, 0],
  [2, -1, 1, 0],
  [-2, 1, -1, 0],
  [-2, -1, -1, 0],
];

const ownBit = (color: Color): number => (color === BLACK ? 8 : 0);

export function generatePseudoLegal(pos: PositionView, capturesOnly = false): Move[] {
  const { board, geo, sideToMove: us } = pos;
  const usBit = ownBit(us);
  const width = geo.width;
  const height = geo.height;
  const moves: Move[] = [];

  for (let from = 0; from < geo.squares; from++) {
    const piece = board[from];
    if (piece === EMPTY || (piece & 8) !== usBit) continue;

    const x = geo.fileOf[from];
    const y = geo.rankOf[from];

    switch (piece & 7) {
      case KING:
        for (const [dx, dy] of ORTHOGONAL) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
          const to = ty * width + tx;
          if (!inPalace(geo, to, us)) continue;
          const target = board[to];
          if (target !== EMPTY && (target & 8) === usBit) continue;
          if (capturesOnly && target === EMPTY) continue;
          moves.push(encodeMove(from, to));
        }
        break;

      case ADVISOR:
        for (const [dx, dy] of DIAGONAL) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
          const to = ty * width + tx;
          if (!inPalace(geo, to, us)) continue;
          const target = board[to];
          if (target !== EMPTY && (target & 8) === usBit) continue;
          if (capturesOnly && target === EMPTY) continue;
          moves.push(encodeMove(from, to));
        }
        break;

      case ELEPHANT:
        for (const [dx, dy] of ELEPHANT_JUMPS) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
          // Elephants may never cross the river.
          if (us === BLACK ? ty > geo.blackElephantMaxRank : ty < geo.redElephantMinRank) continue;
          const to = ty * width + tx;
          const target = board[to];
          if (target !== EMPTY && (target & 8) === usBit) continue;
          if (capturesOnly && target === EMPTY) continue;
          if (geo.config.elephantEyeBlocks && board[(y + dy / 2) * width + (x + dx / 2)] !== EMPTY) continue;
          moves.push(encodeMove(from, to));
        }
        break;

      case HORSE:
        for (const [dx, dy, lx, ly] of HORSE_STEPS) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
          const to = ty * width + tx;
          const target = board[to];
          if (target !== EMPTY && (target & 8) === usBit) continue;
          if (capturesOnly && target === EMPTY) continue;
          if (board[(y + ly) * width + (x + lx)] !== EMPTY) continue;
          moves.push(encodeMove(from, to));
        }
        break;

      case ROOK:
        for (const [dx, dy] of ORTHOGONAL) {
          let tx = x + dx;
          let ty = y + dy;
          while (tx >= 0 && tx < width && ty >= 0 && ty < height) {
            const to = ty * width + tx;
            const target = board[to];
            if (target === EMPTY) {
              if (!capturesOnly) moves.push(encodeMove(from, to));
            } else {
              if ((target & 8) !== usBit) moves.push(encodeMove(from, to));
              break;
            }
            tx += dx;
            ty += dy;
          }
        }
        break;

      case CANNON:
        for (const [dx, dy] of ORTHOGONAL) {
          let tx = x + dx;
          let ty = y + dy;
          let screened = false;
          while (tx >= 0 && tx < width && ty >= 0 && ty < height) {
            const to = ty * width + tx;
            const target = board[to];
            if (!screened) {
              if (target === EMPTY) {
                if (!capturesOnly) moves.push(encodeMove(from, to));
              } else {
                screened = true;
              }
            } else if (target !== EMPTY) {
              if ((target & 8) !== usBit) moves.push(encodeMove(from, to));
              break;
            }
            tx += dx;
            ty += dy;
          }
        }
        break;

      case PAWN: {
        const ahead = from + forwardStep(geo, us);
        if (ahead >= 0 && ahead < geo.squares) {
          const target = board[ahead];
          if (target === EMPTY) {
            if (!capturesOnly) moves.push(encodeMove(from, ahead));
          } else if ((target & 8) !== usBit) {
            moves.push(encodeMove(from, ahead));
          }
        }
        if (crossedRiver(geo, from, us)) {
          for (const dx of [-1, 1]) {
            const tx = x + dx;
            if (tx < 0 || tx >= width) continue;
            const to = y * width + tx;
            const target = board[to];
            if (target !== EMPTY && (target & 8) === usBit) continue;
            if (capturesOnly && target === EMPTY) continue;
            moves.push(encodeMove(from, to));
          }
        }
        break;
      }
    }
  }

  return moves;
}

/**
 * Is `sq` attacked by `byColor`?
 *
 * Includes the flying-general rule (two kings facing on a clear file), since
 * that is exactly what makes a king move illegal.
 */
export function isSquareAttacked(pos: PositionView, sq: number, byColor: Color): boolean {
  const { board, geo } = pos;
  const byBit = ownBit(byColor);
  const width = geo.width;
  const height = geo.height;
  const x = geo.fileOf[sq];
  const y = geo.rankOf[sq];

  // Rook (no screen) and cannon (exactly one screen) along the four rays.
  for (const [dx, dy] of ORTHOGONAL) {
    let tx = x + dx;
    let ty = y + dy;
    let screens = 0;
    while (tx >= 0 && tx < width && ty >= 0 && ty < height) {
      const piece = board[ty * width + tx];
      if (piece !== EMPTY) {
        if ((piece & 8) === byBit) {
          const type = piece & 7;
          if (screens === 0 && type === ROOK) return true;
          if (screens === 1 && type === CANNON) return true;
        }
        screens++;
        if (screens > 1) break;
      }
      tx += dx;
      ty += dy;
    }
  }

  // Horses: search outward from the target; the leg is adjacent to the horse.
  for (const [dx, dy, lx, ly] of HORSE_STEPS) {
    const hx = x + dx;
    const hy = y + dy;
    if (hx < 0 || hx >= width || hy < 0 || hy >= height) continue;
    if (board[hy * width + hx] !== (HORSE | byBit)) continue;
    if (board[(hy - ly) * width + (hx - lx)] === EMPTY) return true;
  }

  // Pawns. A pawn attacks straight ahead, plus sideways once past the river.
  if (byColor === BLACK) {
    if (y - 1 >= 0 && board[(y - 1) * width + x] === (PAWN | byBit)) return true;
  } else if (y + 1 < height && board[(y + 1) * width + x] === PAWN) {
    return true;
  }
  for (const dx of [-1, 1]) {
    const tx = x + dx;
    if (tx < 0 || tx >= width) continue;
    const from = y * width + tx;
    if (board[from] === (PAWN | byBit) && crossedRiver(geo, from, byColor)) return true;
  }

  // Advisors: only reachable diagonally inside a palace.
  for (const [dx, dy] of DIAGONAL) {
    const tx = x + dx;
    const ty = y + dy;
    if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
    const to = ty * width + tx;
    if (board[to] === (ADVISOR | byBit) && inPalace(geo, to, byColor)) return true;
  }

  // Elephants: two squares diagonally, optionally blocked at the midpoint.
  for (const [dx, dy] of ELEPHANT_JUMPS) {
    const tx = x + dx;
    const ty = y + dy;
    if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
    const to = ty * width + tx;
    if (board[to] !== (ELEPHANT | byBit)) continue;
    if (byColor === BLACK ? ty > geo.blackElephantMaxRank : ty < geo.redElephantMinRank) continue;
    if (geo.config.elephantEyeBlocks && board[(y + dy / 2) * width + (x + dx / 2)] !== EMPTY) continue;
    return true;
  }

  // Kings: the flying-general rule, plus a direct adjacency guard (which only
  // matters for variants where the palaces can touch).
  const king = pos.kingSq[byColor];
  if (king >= 0) {
    const kx = geo.fileOf[king];
    const ky = geo.rankOf[king];
    if (Math.abs(kx - x) + Math.abs(ky - y) === 1) return true;
    if (kx === x && ky !== y) {
      const step = ky > y ? 1 : -1;
      let clear = true;
      for (let ty = y + step; ty !== ky; ty += step) {
        if (board[ty * width + x] !== EMPTY) {
          clear = false;
          break;
        }
      }
      if (clear) return true;
    }
  }

  return false;
}

export function isInCheck(pos: PositionView, color: Color): boolean {
  const king = pos.kingSq[color];
  if (king < 0) return true;
  return isSquareAttacked(pos, king, color === RED ? BLACK : RED);
}

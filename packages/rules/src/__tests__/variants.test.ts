import { describe, expect, test } from 'vitest';
import { Position } from '../position.ts';
import { MINI_XIANGQI, XIANGQI } from '../variant.ts';
import { BLACK, RED } from '../types.ts';

function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  const moves = pos.legalMoves();
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) {
    pos.makeMove(move);
    nodes += perft(pos, depth - 1);
    pos.unmakeMove();
  }
  return nodes;
}

/**
 * Mini Xiangqi reference counts from Fairy-Stockfish (`minixiangqi`), same
 * start FEN. It exercises the variant abstraction: 7x7 board, no river,
 * pawns that sidestep immediately, and corner palaces.
 */
describe('mini xiangqi perft (Fairy-Stockfish reference)', () => {
  test('start position depths 1-3', () => {
    const pos = new Position(MINI_XIANGQI);
    expect(perft(pos, 1)).toBe(19);
    expect(perft(pos, 2)).toBe(331);
    expect(perft(pos, 3)).toBe(6664);
  });

  test('pawns can step sideways without a river', () => {
    // Reference: Fairy-Stockfish on `2k4/7/7/3P3/7/7/4K2 w` returns
    // `d4c4 d4e4 d4d5` — a lone Red pawn sidesteps immediately.
    const pos = new Position(MINI_XIANGQI, '2k4/7/7/3P3/7/7/4K2 w - - 0 1');
    const moves = pos.legalMoves().map((m) => pos.moveToUci(m));
    expect(moves.filter((uci) => uci.startsWith('d3')).sort()).toEqual(
      ['d3c3', 'd3d4', 'd3e3'].sort(),
    );
  });

  test('king is confined to its 3x3 palace', () => {
    // Reference: Fairy-Stockfish on `3k3/7/7/7/7/7/3K3 w` returns
    // `d1c1 d1e1`, i.e. the king may only slide sideways inside c0..e0.
    const pos = new Position(MINI_XIANGQI, '3k3/7/7/7/7/7/3K3 w - - 0 1');
    const moves = pos.legalMoves().map((m) => pos.moveToUci(m));
    // d0→d1 is illegal because it would leave the file open to the enemy king.
    expect(moves.sort()).toEqual(['d0c0', 'd0e0'].sort());
  });
});

describe('variant switching', () => {
  test('board sizes differ but the engine API is identical', () => {
    const big = new Position(XIANGQI);
    const small = new Position(MINI_XIANGQI);
    expect(big.geo.squares).toBe(90);
    expect(small.geo.squares).toBe(49);
    expect(big.sideToMove).toBe(RED);
    expect(small.sideToMove).toBe(RED);
  });

  test('both variants round-trip their start FEN', () => {
    expect(new Position(XIANGQI).fen()).toContain('RNBAKABNR');
    expect(new Position(MINI_XIANGQI).fen()).toBe(MINI_XIANGQI.startFen);
  });

  test('make/unmake restores the exact position key', () => {
    const pos = new Position(MINI_XIANGQI);
    const before = `${pos.keyLo}:${pos.keyHi}:${pos.sideToMove}`;
    const move = pos.legalMoves()[0];
    pos.makeMove(move);
    expect(pos.sideToMove).toBe(BLACK);
    pos.unmakeMove();
    expect(`${pos.keyLo}:${pos.keyHi}:${pos.sideToMove}`).toBe(before);
  });
});

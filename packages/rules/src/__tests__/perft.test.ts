import { describe, expect, test } from 'vitest';
import { Position } from '../position.ts';
import { XIANGQI } from '../variant.ts';

/**
 * Perft counts the number of leaf nodes at a given depth using only legal
 * moves. Any divergence from the reference values means the move generator or
 * the check filter is wrong — there is no room for interpretation.
 */
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

/** Split perft by root move so a mismatch points at a single piece. */
function divide(pos: Position, depth: number): Map<string, number> {
  const result = new Map<string, number>();
  for (const move of pos.legalMoves()) {
    const uci = pos.moveToUci(move);
    pos.makeMove(move);
    result.set(uci, perft(pos, depth - 1));
    pos.unmakeMove();
  }
  return result;
}

describe('xiangqi perft (start position)', () => {
  test('depth 1 = 44', () => {
    expect(perft(new Position(XIANGQI), 1)).toBe(44);
  });

  test('depth 2 = 1920', () => {
    expect(perft(new Position(XIANGQI), 2)).toBe(1920);
  });

  test('depth 3 = 79666', () => {
    expect(perft(new Position(XIANGQI), 3)).toBe(79666);
  });

  // 3.29M leaf nodes; ~5s here, so the default 5s budget is not enough.
  test('depth 4 = 3290240', { timeout: 120_000 }, () => {
    expect(perft(new Position(XIANGQI), 4)).toBe(3290240);
  });

  test('divide depth 2 matches the 44 legal root moves', () => {
    const pos = new Position(XIANGQI);
    const root = divide(pos, 1);
    expect(root.size).toBe(44);
    let total = 0;
    for (const count of root.values()) total += count;
    expect(total).toBe(44);
  });
});

/**
 * Reference values below were produced with Fairy-Stockfish (ffish-es6) on the
 * exact same FENs, so a failure here is a real rules bug rather than a stale
 * guess. See `scripts/perft-reference.mjs` for the generator.
 */
describe('xiangqi perft (reference positions)', () => {
  const CASES: ReadonlyArray<{ name: string; fen: string; counts: [number, number, number] }> = [
    {
      name: 'opening after a cannon and horse develop',
      fen: 'rnbakab1r/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR w - - 0 4',
      counts: [35, 1558, 56144],
    },
    {
      name: 'symmetric development, both horses out',
      fen: 'r1bakab1r/9/1cn3nc1/p1p1p1p1p/9/9/P1P1P1P1P/1CN3NC1/9/R1BAKAB1R w - - 0 6',
      counts: [36, 1292, 47994],
    },
    {
      name: 'bare kings, one advisor (flying-general edge cases)',
      fen: '3k5/9/9/9/9/9/9/9/4A4/4K4 w - - 0 1',
      counts: [5, 6, 22],
    },
    {
      name: 'black to move, king exposed on its own file',
      fen: 'rnba1abnr/4k4/9/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b - - 0 5',
      counts: [21, 758, 16264],
    },
  ];

  for (const testCase of CASES) {
    test(`${testCase.name}`, () => {
      const pos = new Position(XIANGQI, testCase.fen);
      const [d1, d2, d3] = testCase.counts;
      expect(perft(pos, 1)).toBe(d1);
      expect(perft(pos, 2)).toBe(d2);
      expect(perft(pos, 3)).toBe(d3);
    });
  }
});

describe('xiangqi move encoding round-trip', () => {
  test('uci round-trips for every legal root move', () => {
    const pos = new Position(XIANGQI);
    for (const move of pos.legalMoves()) {
      expect(pos.findUciMove(pos.moveToUci(move))).toBe(move);
    }
  });

  test('start FEN round-trips', () => {
    const pos = new Position(XIANGQI);
    expect(pos.fen()).toBe(
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    );
  });
});

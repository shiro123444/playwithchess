import { describe, expect, test } from 'vitest';
import { Position } from '../position.ts';
import { XIANGQI } from '../variant.ts';
import { toChineseNotation } from '../notation.ts';
import { Search } from '../ai/search.ts';
import { RED } from '../types.ts';

/**
 * Every FEN below was cross-checked against Fairy-Stockfish, so a failure
 * points at this engine rather than at a hand-guessed board layout.
 */
function play(fen: string, ucis: string[]): Position {
  const pos = new Position(XIANGQI, fen);
  for (const uci of ucis) {
    const move = pos.findUciMove(uci);
    expect(move, `illegal reference move ${uci}`).toBeGreaterThanOrEqual(0);
    pos.makeMove(move);
  }
  return pos;
}

function uciMoves(pos: Position): string[] {
  return pos.legalMoves().map((move) => pos.moveToUci(move));
}

describe('chinese notation', () => {
  test('opening cannon to the centre is 炮二平五', () => {
    const pos = new Position(XIANGQI);
    const move = pos.findUciMove('h2e2');
    expect(move).toBeGreaterThanOrEqual(0);
    expect(toChineseNotation(pos, move)).toBe('炮二平五');
  });

  test('black answers 砲8平5', () => {
    const pos = play(XIANGQI.startFen, ['h2e2']);
    // Black's file numbering runs from its own right, so the mirror cannon is 8.
    const move = pos.findUciMove('h7e7');
    expect(move).toBeGreaterThanOrEqual(0);
    expect(toChineseNotation(pos, move)).toBe('砲8平5');
  });

  test('horse jump writes the destination file', () => {
    const pos = new Position(XIANGQI);
    const move = pos.findUciMove('b0c2');
    expect(move).toBeGreaterThanOrEqual(0);
    expect(toChineseNotation(pos, move)).toBe('傌八进七');
  });

  test('rook advance writes the distance travelled', () => {
    const pos = new Position(XIANGQI);
    const move = pos.findUciMove('a0a1');
    expect(move).toBeGreaterThanOrEqual(0);
    expect(toChineseNotation(pos, move)).toBe('俥九进一');
  });

  test('same-file pieces are disambiguated with 前/后', () => {
    // Red king on c0 (off the black king's file), rooks on e0 (rear) and e2
    // (front, nearer Black).
    const fen = '3k5/9/9/9/9/9/9/4R4/9/2K1R4 w - - 0 1';
    const pos = new Position(XIANGQI, fen);

    const frontRetreat = pos.findUciMove('e2e1');
    const rearAdvance = pos.findUciMove('e0e1');
    expect(frontRetreat).toBeGreaterThanOrEqual(0);
    expect(rearAdvance).toBeGreaterThanOrEqual(0);
    expect(toChineseNotation(pos, frontRetreat)).toBe('前俥退一');
    expect(toChineseNotation(pos, rearAdvance)).toBe('后俥进一');
  });
});

describe('flying general rule', () => {
  test('the king may not step onto the enemy king file', () => {
    // Black king d9, red king e0: moving to d0 would face the generals.
    const pos = new Position(XIANGQI, '3k5/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    expect(uciMoves(pos)).not.toContain('e0d0');
    expect(uciMoves(pos)).toContain('e0f0');
  });

  test('a rook pinned between the two kings may not leave the file', () => {
    // Red rook d4 is the only thing separating the kings on the d-file.
    const pos = new Position(XIANGQI, '3k5/9/9/9/9/3R5/9/9/9/3K5 w - - 0 1');
    const moves = uciMoves(pos);
    expect(moves).toContain('d4d5');
    expect(moves).not.toContain('d4e4');
    expect(moves).not.toContain('d4c4');
  });
});

describe('game status', () => {
  test('start position is playing, not check', () => {
    expect(new Position(XIANGQI).status()).toEqual({ kind: 'playing', check: false });
  });

  test('checkmate is detected with the right winner', () => {
    // Red rooks on a9/i9, pawn d7 covering d8, black king boxed on d9.
    const pos = new Position(XIANGQI, 'R2k4R/9/3P5/9/9/9/9/9/9/4K4 b - - 0 1');
    expect(pos.status()).toEqual({ kind: 'checkmate', winner: RED });
    expect(pos.legalMoves()).toHaveLength(0);
  });

  test('stalemate: a side with no moves but no check loses', () => {
    const pos = new Position(XIANGQI, 'R2k4R/9/3P5/9/9/9/9/9/9/4K4 b - - 0 1');
    expect(pos.isCheck()).toBe(true);
  });
});

describe('search', () => {
  test('finds mate in one', () => {
    // a1→a9 or e1→e9 both mate (Fairy-Stockfish confirms).
    const pos = new Position(XIANGQI, '3k5/9/3P5/9/9/9/9/9/R3R4/4K4 w - - 0 1');
    const result = new Search().search(pos, { depth: 3 });
    expect(['a1a9', 'e1e9']).toContain(pos.moveToUci(result.move));
    expect(pos.makeMove(result.move)).toBe(true);
    expect(pos.status().kind).toBe('checkmate');
  });

  test('takes a free rook', () => {
    const pos = new Position(XIANGQI, '3k5/9/9/9/9/9/9/4r4/9/4RK3 w - - 0 1');
    const result = new Search().search(pos, { depth: 4, maxNodes: 200_000 });
    expect(pos.moveToUci(result.move)).toBe('e0e2');
  });

  test('never returns an illegal move', () => {
    const pos = new Position(XIANGQI);
    const result = new Search().search(pos, { depth: 3 });
    expect(pos.findUciMove(pos.moveToUci(result.move))).toBe(result.move);
  });

  test('search respects a node budget', () => {
    const pos = new Position(XIANGQI);
    const result = new Search().search(pos, { depth: 20, maxNodes: 5_000 });
    expect(result.nodes).toBeLessThan(20_000);
  });
});

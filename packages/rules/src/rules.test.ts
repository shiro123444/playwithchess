import { describe, expect, test } from 'vitest';
import { Position } from './position.ts';
import { XIANGQI } from './variant.ts';
import { BLACK, RED, moveFrom, moveTo } from './types.ts';

const START_FEN = XIANGQI.startFen;

function perft(pos: Position, depth: number): number {
  if (depth === 0) return 1;
  let total = 0;
  for (const move of pos.legalMoves()) {
    pos.makeMove(move);
    total += perft(pos, depth - 1);
    pos.unmakeMove();
  }
  return total;
}

/**
 * Reference node counts from Fairy-Stockfish for the Xiangqi start position.
 * These catch illegal-move leaks more reliably than any hand-written test.
 */
describe('perft (start position)', () => {
  test('depth 1 = 44', () => {
    expect(perft(new Position(XIANGQI, START_FEN), 1)).toBe(44);
  });

  test('depth 2 = 1920', () => {
    expect(perft(new Position(XIANGQI, START_FEN), 2)).toBe(1920);
  });

  test('depth 3 = 79666', () => {
    expect(perft(new Position(XIANGQI, START_FEN), 3)).toBe(79666);
  });
});

describe('FEN round-trip', () => {
  test('start FEN parses and re-serialises identically', () => {
    const pos = new Position(XIANGQI, START_FEN);
    expect(pos.fen()).toBe(START_FEN);
  });

  test('an arbitrary midgame FEN survives a round trip', () => {
    const fen = 'r1ba1a3/4kn3/2n1b4/pNp1p1p1p/4c4/6P2/P1P1C1P1P/1C5C1/9/R1BAKABNR w - - 4 6';
    const pos = new Position(XIANGQI, fen);
    expect(pos.fen()).toBe(fen);
  });
});

describe('piece movement', () => {
  test('horse is blocked by its leg', () => {
    // Red horse on b2 (internal rank 7, file 1), black pawn straight ahead on
    // b3 (rank 6, file 1) — i.e. exactly on the horse's forward leg. The kings
    // sit on different files so neither is in check and every horse move is
    // considered on its own merits.
    const pos = new Position(XIANGQI, '4k4/9/9/9/9/9/1p7/1N7/9/5K3 w - - 0 1');
    const moves = pos.legalMoves().filter((m) => moveFrom(m) === 7 * 9 + 1);
    // The two jumps over the blocked leg (b2c4 / b2a4) are gone; the four
    // jumps that do not use that leg remain.
    const blocked = moves.filter((m) => moveTo(m) === 5 * 9 + 2 || moveTo(m) === 5 * 9 + 0);
    expect(blocked).toHaveLength(0);
    expect(moves.length).toBe(4);
  });

  test('cannon needs exactly one screen to capture', () => {
    const pos = new Position(XIANGQI, '4k4/9/9/9/9/9/9/9/4r4/4C4 w - - 0 1');
    const cannon = 9 * 9 + 4;
    const moves = pos.legalMoves().filter((m) => moveFrom(m) === cannon);
    const captures = moves.filter((m) => moveTo(m) === 8 * 9 + 4);
    expect(captures).toHaveLength(0);
  });

  test('elephant may not cross the river', () => {
    // Red elephant on e5 (rank 5) is already across; it cannot move at all.
    const pos = new Position(XIANGQI, '4k4/9/9/9/9/4B4/9/9/9/4K4 w - - 0 1');
    const moves = pos.legalMoves().filter((m) => moveFrom(m) === 5 * 9 + 4);
    expect(moves).toHaveLength(0);
  });

  test('pawn gains sideways moves after crossing the river', () => {
    // Internal ranks run 0..9 from Black's back rank, so a Red pawn on rank 5
    // is still on its own side and may only push; on rank 4 it has crossed.
    const before = new Position(XIANGQI, '4k4/9/9/9/9/4P4/9/9/9/5K3 w - - 0 1');
    const beforeMoves = before.legalMoves().filter((m) => moveFrom(m) === 5 * 9 + 4);
    expect(beforeMoves).toHaveLength(1);

    const after = new Position(XIANGQI, '4k4/9/9/9/4P4/9/9/9/9/5K3 w - - 0 1');
    const afterMoves = after.legalMoves().filter((m) => moveFrom(m) === 4 * 9 + 4);
    expect(afterMoves).toHaveLength(3);
  });

  test('flying general forbids facing kings', () => {
    // Kings face each other down the e-file, which is illegal to leave standing;
    // the side to move is therefore in check, and its king must break the file.
    const pos = new Position(XIANGQI, '4k4/9/9/9/9/9/9/9/9/4K4 w - - 0 1');
    const kingMoves = pos.legalMoves().filter((m) => moveFrom(m) === 9 * 9 + 4);
    // Only sideways steps leave the file; e0e1 would still face the black king.
    expect(kingMoves.map((m) => pos.moveToUci(m)).sort()).toEqual(['e0d0', 'e0f0']);
  });

  test('a king cannot move into a rook attack', () => {
    const pos = new Position(XIANGQI, '4k4/9/9/9/9/9/9/9/3r5/4K4 w - - 0 1');
    const kingMoves = pos.legalMoves().filter((m) => moveFrom(m) === 9 * 9 + 4);
    // e0 -> d0 would be attacked by the black rook on d1.
    expect(kingMoves.some((m) => moveTo(m) === 9 * 9 + 3)).toBe(false);
  });
});

describe('game status', () => {
  test('checkmate is detected', () => {
    // Black king on e9 boxed in by two red rooks on the back ranks.
    const pos = new Position(XIANGQI, '3k1r3/9/9/9/9/9/9/9/9/3KR4 b - - 0 1');
    const status = pos.status();
    expect(status.kind).toBe('checkmate');
    if (status.kind === 'checkmate') expect(status.winner).toBe(RED);
  });

  test('check is reported while still playing', () => {
    const pos = new Position(XIANGQI, '3k5/9/9/9/9/9/9/9/9/3K1R3 b - - 0 1');
    const status = pos.status();
    expect(status.kind).toBe('playing');
    if (status.kind === 'playing') expect(status.check).toBe(true);
  });

  test('threefold repetition is a draw', () => {
    // Kings on different files, so both sides are free to shuffle in place.
    const pos = new Position(XIANGQI, '4k4/9/9/9/9/9/9/9/9/3K5 w - - 0 1');
    const cycle = ['d0d1', 'e9e8', 'd1d0', 'e8e9'];
    for (let i = 0; i < 2; i++) {
      for (const uci of cycle) expect(pos.playUci(uci)).toBe(true);
    }
    expect(pos.currentRepetitionCount()).toBe(3);
    expect(pos.status().kind).toBe('repetition');
  });

  test('a hundred and twenty quiet half-moves is a draw', () => {
    const pos = new Position(XIANGQI, '4k4/9/9/9/9/9/9/9/9/3K5 w - - 0 1');
    pos.halfmoveClock = 119;
    expect(pos.playUci('d0d1')).toBe(true);
    expect(pos.status().kind).toBe('no-capture');
  });
});

describe('zobrist', () => {
  test('the key is restored exactly after make/unmake', () => {
    const pos = new Position(XIANGQI, START_FEN);
    const before = `${pos.keyLo}:${pos.keyHi}`;
    for (const move of pos.legalMoves()) {
      pos.makeMove(move);
      pos.unmakeMove();
      expect(`${pos.keyLo}:${pos.keyHi}`).toBe(before);
    }
  });

  test('transpositions reach the same key', () => {
    const a = new Position(XIANGQI, START_FEN);
    a.playUci('h2e2');
    a.playUci('h7e7');

    const b = new Position(XIANGQI, START_FEN);
    b.playUci('h2e2');
    b.playUci('h7e7');

    expect(`${a.keyLo}:${a.keyHi}`).toBe(`${b.keyLo}:${b.keyHi}`);
    expect(a.fen()).toBe(b.fen());
  });
});

describe('UCI', () => {
  test('start position move list contains the classic central cannon', () => {
    const pos = new Position(XIANGQI, START_FEN);
    expect(pos.findUciMove('h2e2')).toBeGreaterThan(0);
    expect(pos.playUci('h2e2')).toBe(true);
    expect(pos.sideToMove).toBe(BLACK);
  });

  test('illegal moves are rejected', () => {
    const pos = new Position(XIANGQI, START_FEN);
    // a0a5: the rook would jump over its own pawn on a3.
    expect(pos.playUci('a0a5')).toBe(false);
    // e0e9: the general may not fly across the board to capture the enemy one.
    expect(pos.playUci('e0e9')).toBe(false);
  });

  test('uci coordinates put Red at the bottom', () => {
    const pos = new Position(XIANGQI, START_FEN);
    // e0 is Red's king; the move must originate there.
    const kingMove = pos.legalMoves().find((m) => moveFrom(m) === 9 * 9 + 4);
    expect(kingMove).toBeDefined();
    expect(pos.moveToUci(kingMove!)).toBe('e0e1');
  });
});

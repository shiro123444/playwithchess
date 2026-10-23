import { describe, expect, test } from 'vitest';
import { cuesFor } from './cue.ts';

describe('cuesFor', () => {
  test('a quiet move knocks once', () => {
    expect(cuesFor({ kind: 'playing', check: false }, false)).toEqual(['move']);
  });

  test('a capture plays the capture hit', () => {
    expect(cuesFor({ kind: 'playing', check: false }, true)).toEqual(['capture']);
  });

  test('a checking move rings over the landing knock', () => {
    expect(cuesFor({ kind: 'playing', check: true }, false)).toEqual(['move', 'check']);
  });

  test('checkmate ends rather than checking twice', () => {
    expect(cuesFor({ kind: 'checkmate', winner: 0 }, true)).toEqual(['capture', 'end']);
  });

  test('a drawn game also resolves', () => {
    expect(cuesFor({ kind: 'repetition', winner: null }, false)).toEqual(['move', 'end']);
    expect(cuesFor({ kind: 'no-capture', winner: null }, false)).toEqual(['move', 'end']);
  });

  test('stalemate resolves too', () => {
    expect(cuesFor({ kind: 'stalemate', winner: 1 }, false)).toEqual(['move', 'end']);
  });
});

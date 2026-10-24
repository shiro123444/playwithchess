import { describe, expect, it } from 'vitest';
import { appendRecord, createRecord, replayRecord } from '../record.ts';

describe('durable move records', () => {
  it('restores a capture and real undo history, not just the final FEN', () => {
    let record = createRecord('test');
    for (const uci of ['h2e2', 'h9g7', 'e2e6']) record = appendRecord(record, uci);
    const loaded = replayRecord(JSON.parse(JSON.stringify(record)));
    expect(record.moves.map(move => move.notation)).toEqual(['炮二平五', '馬8进7', '炮五进四']);
    loaded.unmakeMove();
    expect(loaded.fen()).toBe(replayRecord(record, 2).fen());
    loaded.unmakeMove(); loaded.unmakeMove();
    expect(loaded.fen()).toBe(record.initialFen);
    expect(replayRecord(record, 0).fen()).toBe(record.initialFen);
  });
  it('rejects corrupted and impossible move sequences', () => {
    const record = createRecord('test');
    expect(() => replayRecord({ ...record, moves: [{ uci: 'a0a9', notation: '', at: 0 }] })).toThrow();
    expect(() => replayRecord(record, 1)).toThrow();
    expect(() => appendRecord(record, 'x0x1')).toThrow();
  });
  it('does not modify an archived game when a new move or undo branch is created', () => {
    const original = appendRecord(createRecord('test'), 'h2e2');
    const continued = appendRecord(original, 'h9g7');
    expect(original.moves).toHaveLength(1);
    expect(continued.moves).toHaveLength(2);
  });
});

import { Position, type GameStatus } from './position.ts';
import { getVariant } from './variant.ts';
import { toChineseNotation } from './notation.ts';
import type { Color } from './types.ts';

export interface GameResult {
  winner: Color | null;
  reason: 'checkmate' | 'stalemate' | 'repetition' | 'no-capture' | 'resign' | 'timeout';
}
export interface RecordedMove { uci: string; notation: string; at: number }
export interface GameRecord {
  version: 1;
  id: string;
  variantId: string;
  initialFen: string;
  moves: RecordedMove[];
  createdAt: number;
  updatedAt: number;
  result: GameResult | null;
}
export function createRecord(id: string, variantId = 'xiangqi'): GameRecord {
  return { version: 1, id, variantId, initialFen: getVariant(variantId).startFen,
    moves: [], createdAt: Date.now(), updatedAt: Date.now(), result: null };
}
export function resultFor(status: GameStatus): GameResult | null {
  return status.kind === 'playing' ? null : { winner: status.winner, reason: status.kind };
}
/** Replay legal moves, rebuilding undo and repetition history as well as FEN. */
export function replayRecord(record: GameRecord, ply = record.moves.length): Position {
  if (record.version !== 1 || !Array.isArray(record.moves) || record.moves.length > 10000 ||
      !Number.isInteger(ply) || ply < 0 || ply > record.moves.length) throw new Error('棋谱格式错误');
  const position = new Position(getVariant(record.variantId));
  position.setFen(record.initialFen);
  for (const entry of record.moves.slice(0, ply)) {
    const move = typeof entry.uci === 'string' ? position.findUciMove(entry.uci) : -1;
    if (move < 0 || position.status().kind !== 'playing') throw new Error('棋谱包含非法着法');
    position.makeMove(move);
  }
  return position;
}
export function appendRecord(record: GameRecord, uci: string): GameRecord {
  const position = replayRecord(record);
  if (record.result || position.status().kind !== 'playing') throw new Error('对局已结束');
  const move = position.findUciMove(uci);
  if (move < 0) throw new Error('不合规则的着法');
  const notation = toChineseNotation(position, move);
  position.makeMove(move);
  return { ...record, moves: [...record.moves, { uci, notation, at: Date.now() }],
    updatedAt: Date.now(), result: resultFor(position.status()) };
}

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { replayRecord, type GameRecord } from '@xiangqi/rules';

export type PlayerSeat = 'red' | 'black';
export interface Reservation { name: string; tokenHash: string }
export interface StoredMatch {
  version: 1;
  code: string;
  record: GameRecord;
  reservations: Partial<Record<PlayerSeat, Reservation>>;
  initialClockMs: number;
  incrementMs: number;
  clocks: { red: number; black: number };
  clockHistory: Array<{ red: number; black: number }>;
}
export const newSeatToken = (): string => randomBytes(32).toString('hex');
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Atomic per-match files. Keep XIANGQI_DATA_DIR on a persistent volume. */
export class MatchStore {
  constructor(readonly directory = resolve(process.env.XIANGQI_DATA_DIR ??
    fileURLToPath(new URL('../../../../.data/games/', import.meta.url)))) {}
  private file(code: string): string {
    if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('房间号格式错误');
    return join(this.directory, `${code}.json`);
  }
  load(code: string): StoredMatch | null {
    const path = this.file(code);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8')) as StoredMatch;
    if (data.version !== 1 || data.code !== code || !data.reservations || !data.clocks ||
        !/^[A-Za-z0-9-]{1,128}$/.test(data.record?.id ?? '')) throw new Error('房间存档损坏');
    replayRecord(data.record);
    return data;
  }
  save(match: StoredMatch): void {
    mkdirSync(this.directory, { recursive: true });
    const path = this.file(match.code);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(match), { mode: 0o600 });
    renameSync(temporary, path);
  }
}

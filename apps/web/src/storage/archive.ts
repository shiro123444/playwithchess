import { replayRecord, type GameRecord } from '@xiangqi/rules';
export interface ArchiveEntry {
  record: GameRecord;
  mode: 'local' | 'online';
  roomCode?: string;
  resumeToken?: string;
  seat?: 'red' | 'black' | 'spectator';
}
const KEY = 'xiangqi.archive.v1';
const ACTIVE = 'xiangqi.active-local';
export class GameArchive {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'>) {}
  entries(): ArchiveEntry[] {
    try {
      const entries = JSON.parse(this.storage.getItem(KEY) ?? '[]');
      return Array.isArray(entries) ? entries.filter(entry => entry?.record?.version === 1 &&
        typeof entry.record.id === 'string' && Array.isArray(entry.record.moves) &&
        ['local', 'online'].includes(entry.mode)).sort((a, b) => b.record.updatedAt - a.record.updatedAt) : [];
    } catch { return []; }
  }
  save(entry: ArchiveEntry): boolean {
    try {
      const existing = this.storage.getItem(KEY);
      if (existing && !Array.isArray(JSON.parse(existing))) return false;
      const entries = this.entries();
      const sameEntry = (old: ArchiveEntry) => old.record.id === entry.record.id && old.mode === entry.mode &&
        (entry.mode === 'local' || !entry.seat || !old.seat || old.seat === entry.seat);
      const previous = entries.find(sameEntry);
      const next = { ...previous, ...entry };
      this.storage.setItem(KEY, JSON.stringify([next, ...entries.filter(old => !sameEntry(old))]));
      if (entry.mode === 'local') this.storage.setItem(ACTIVE, entry.record.id);
      return true;
    } catch { return false; }
  }
  activeLocal(): ArchiveEntry | null {
    try { return this.entries().find(entry => entry.mode === 'local' && entry.record.id === this.storage.getItem(ACTIVE)) ?? null; }
    catch { return null; }
  }
  valid(entry: ArchiveEntry): boolean {
    try { replayRecord(entry.record); return true; } catch { return false; }
  }
}

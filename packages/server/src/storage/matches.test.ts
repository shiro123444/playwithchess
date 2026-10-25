import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayRecord } from '@xiangqi/rules';
import { MatchStore } from './matches.ts';

vi.mock('@colyseus/core', () => ({
  CloseCode: { CONSENTED: 4000 },
  ServerError: class extends Error { constructor(public code: number, message: string) { super(message); } },
  Room: class {
    clients: any[] = []; roomId = ''; maxClients = 8; autoDispose = true;
    handlers = new Map<string, (client: any, payload?: any) => void>();
    onMessage(type: string, fn: (client: any, payload?: any) => void) { this.handlers.set(type, fn); }
    broadcast(type: string, payload: any) { for (const client of this.clients) client.send(type, payload); }
    allowReconnection() { return Promise.reject(new Error('offline')); }
  },
}));
import { XiangqiRoom } from '../XiangqiRoom.ts';
let directory = '';
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'xiangqi-match-')); vi.stubEnv('XIANGQI_DATA_DIR', directory); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });
function room(code?: string, initialClockMs = 0) { const instance = new XiangqiRoom(); instance.onCreate(code ? { code } : { initialClockMs }); return instance as XiangqiRoom & { clients: any[]; handlers: Map<string, (client: any, payload?: any) => void> }; }
function joinRoom(instance: ReturnType<typeof room>, id: string, token?: string, preferredSeat?: string) {
  const messages: Array<{ type: string; payload: any }> = [];
  const client: any = { sessionId: id, send: (type: string, payload: any) => messages.push({ type, payload: structuredClone(payload) }) };
  instance.clients.push(client);
  try {
    instance.onJoin(client, {
      displayName: id,
      ...(token ? { resumeToken: token } : {}),
      ...(preferredSeat ? { preferredSeat } : {}),
    });
  }
  catch (error) { instance.clients.splice(instance.clients.indexOf(client), 1); throw error; }
  return { client, messages, token: () => messages.filter(m => m.type === 'identity').at(-1)?.payload.resumeToken,
    seat: () => messages.filter(m => m.type === 'seats').at(-1)?.payload.yourSeat,
    message: (type: string, payload?: any) => instance.handlers.get(type)!(client, payload) };
}
function saved(code: string) { return new MatchStore(directory).load(code)!; }

describe('server persistence and seat authority', () => {
  it('rehydrates a disposed room and resumes both original seats with the same position', () => {
    const first = room(); const a = joinRoom(first, 'A'); const b = joinRoom(first, 'B');
    a.message('move', { uci: 'h2e2' }); b.message('move', { uci: 'h9g7' });
    const fen = replayRecord(saved(first.code).record).fen();
    const second = room(first.code);
    const spectator = joinRoom(second, 'stranger');
    expect(spectator.token()).toBeNull();
    expect(() => joinRoom(second, 'impostor', 'wrong')).toThrow('续局凭据无效');
    const ar = joinRoom(second, 'A-resumed', a.token()); const br = joinRoom(second, 'B-resumed', b.token());
    expect(ar.messages.filter(m => m.type === 'snapshot').at(-1)?.payload.fen).toBe(fen);
    expect(br.messages.filter(m => m.type === 'seats').at(-1)?.payload.yourSeat).toBe('black');
    ar.message('move', { uci: 'e2e6' });
    expect(saved(second.code).record.moves).toHaveLength(3);
    expect(() => joinRoom(second, 'duplicate', a.token())).toThrow('另一页面');
    const publicMessages = ar.messages.filter(m => m.type !== 'identity');
    expect(JSON.stringify(publicMessages)).not.toContain(a.token());
    expect(readFileSync(join(directory, `${first.code}.json`), 'utf8')).not.toContain(a.token());
  });
  it('requires the opponent to accept undo and restores both replies and captured pieces', () => {
    const table = room(); const a = joinRoom(table, 'A'); const b = joinRoom(table, 'B');
    a.message('move', { uci: 'h2e2' }); b.message('move', { uci: 'h9g7' }); a.message('move', { uci: 'e2e6' });
    a.message('undo-request');
    a.message('undo-answer', { accept: true });
    expect(saved(table.code).record.moves).toHaveLength(3);
    b.message('undo-answer', { accept: true });
    expect(saved(table.code).record.moves).toHaveLength(2);
    a.message('undo-request'); b.message('undo-answer', { accept: true });
    expect(saved(table.code).record.moves).toHaveLength(0);
    expect(replayRecord(saved(table.code).record).fen()).toBe(saved(table.code).record.initialFen);
  });
  it('cancels stale undo requests when a new move arrives', () => {
    const table = room(); const a = joinRoom(table, 'A'); const b = joinRoom(table, 'B');
    a.message('move', { uci: 'h2e2' }); a.message('undo-request');
    b.message('move', { uci: 'h9g7' }); b.message('undo-answer', { accept: true });
    expect(saved(table.code).record.moves).toHaveLength(2);
  });
  it('does not forfeit an unfinished match on disconnect', async () => {
    const table = room(); const a = joinRoom(table, 'A'); const b = joinRoom(table, 'B');
    a.message('move', { uci: 'h2e2' }); table.onLeave(b.client, 1006);
    await Promise.resolve(); await Promise.resolve();
    expect(saved(table.code).record.result).toBeNull();
    expect(saved(table.code).reservations.black).toBeDefined();
  });
  it('keeps the published position unchanged if the disk write fails', () => {
    const table = room(); const a = joinRoom(table, 'A'); joinRoom(table, 'B');
    vi.spyOn(MatchStore.prototype, 'save').mockImplementationOnce(() => { throw new Error('disk unavailable'); });
    a.message('move', { uci: 'h2e2' }); a.message('sync');
    expect(saved(table.code).record.moves).toHaveLength(0);
    expect(a.messages.filter(m => m.type === 'snapshot').at(-1)?.payload.moveNumber).toBe(0);
    expect(a.messages.some(m => m.type === 'reject')).toBe(true);
  });
  it('persists resignations and archives the finished game when both agree to rematch', () => {
    const table = room(); const a = joinRoom(table, 'A'); const b = joinRoom(table, 'B');
    const id = saved(table.code).record.id;
    a.message('resign');
    expect(saved(table.code).record.result).toEqual({ reason: 'resign', winner: 1 });
    a.message('rematch'); b.message('rematch');
    expect(saved(table.code).record.id).not.toBe(id);
    expect(saved(table.code).record.result).toBeNull();
    expect(new MatchStore(join(directory, 'archive', id)).load(table.code)?.record.result?.reason).toBe('resign');
  });
  it('does not pause the players clock when a spectator leaves', () => {
    vi.useFakeTimers({ now: 10000 });
    const table = room(undefined, 5000); const a = joinRoom(table, 'A'); joinRoom(table, 'B');
    const spectator = joinRoom(table, 'viewer');
    vi.advanceTimersByTime(2000); table.onLeave(spectator.client, 4000);
    vi.advanceTimersByTime(2000); a.message('sync');
    expect(a.messages.filter(m => m.type === 'snapshot').at(-1)?.payload.clocks.red).toBe(1000);
    table.onDispose();
  });

  it('honours the side a joiner asked for while that seat is free', () => {
    const table = room();
    expect(joinRoom(table, 'want-black', undefined, 'black').seat()).toBe('black');
    // The second player asked for black too, so they get the only seat left.
    expect(joinRoom(table, 'also-black', undefined, 'black').seat()).toBe('red');
    expect(saved(table.code).reservations.red?.name).toBe('also-black');
    expect(saved(table.code).reservations.black?.name).toBe('want-black');
    const spectator = joinRoom(table, 'late', undefined, 'red');
    expect(spectator.seat()).toBe('spectator');
    expect(spectator.token()).toBeNull();
  });

  it('treats an unknown or random preference as "first free seat"', () => {
    const table = room();
    expect(joinRoom(table, 'A', undefined, 'random').seat()).toBe('red');
    expect(joinRoom(table, 'B', undefined, 'purple').seat()).toBe('black');
  });

  it('never lets a requested seat bypass a reserved one', () => {
    const table = room(); const a = joinRoom(table, 'A', undefined, 'red');
    table.onLeave(a.client, 4000);
    // A's seat is reserved but offline; a newcomer asking for red gets black.
    expect(joinRoom(table, 'B', undefined, 'red').seat()).toBe('black');
    // …and the reservation still belongs to A.
    expect(joinRoom(table, 'A-back', a.token()).seat()).toBe('red');
  });
});

import { CloseCode, Room, ServerError, type Client } from '@colyseus/core';
import { BLACK, RED, appendRecord, createRecord, replayRecord, type Color, type GameRecord, type Position } from '@xiangqi/rules';
import { MatchStore, newSeatToken, tokenHash, type PlayerSeat, type StoredMatch } from './storage/matches.ts';

export type Seat = PlayerSeat | 'spectator';
export interface RoomOptions { code?: string; variantId?: string; initialClockMs?: number; incrementMs?: number }
interface JoinOptions { displayName?: unknown; resumeToken?: unknown }
interface Player { seat: Seat; name: string; token: string | null; connected: boolean }
interface UndoRequest { seat: PlayerSeat; ply: number; count: number }
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const randomCode = () => Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');

/** Durable authority: moves and reserved seats survive room disposal and restart. */
export class XiangqiRoom extends Room {
  public code = '';
  private store = new MatchStore();
  private saved!: StoredMatch;
  private position!: Position;
  private players = new Map<string, Player>();
  private undoRequest: UndoRequest | null = null;
  private rematchVotes = new Set<Seat>();
  private clockStartedAt = 0;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  override onCreate(options: RoomOptions = {}): void {
    if (options.code) {
      this.code = options.code.trim().toUpperCase();
      const saved = this.store.load(this.code);
      if (!saved) throw new ServerError(404, '房间不存在或存档已删除');
      this.saved = saved;
    } else {
      do { this.code = randomCode(); } while (this.store.load(this.code));
      const initialClockMs = Math.max(0, Number(options.initialClockMs) || 0);
      this.saved = { version: 1, code: this.code, record: createRecord(newSeatToken(), options.variantId),
        reservations: {}, initialClockMs, incrementMs: Math.max(0, Number(options.incrementMs) || 0),
        clocks: { red: initialClockMs, black: initialClockMs }, clockHistory: [] };
      this.store.save(this.saved);
    }
    this.position = replayRecord(this.saved.record);
    this.roomId = this.code;
    this.maxClients = 8;
    this.autoDispose = true;
    this.onMessage('sync', client => { this.sendIdentity(client); this.broadcastSeats(); this.sendSnapshot(client); });
    this.onMessage('move', (client, message) => this.move(client, message?.uci));
    this.onMessage('undo-request', client => this.requestUndo(client));
    this.onMessage('undo-answer', (client, message) => this.answerUndo(client, message?.accept === true));
    this.onMessage('resign', client => this.resign(client));
    this.onMessage('rematch', client => this.rematch(client));
    this.onMessage('chat', (client, message) => {
      if (typeof message?.body === 'string') this.broadcast('chat', {
        from: this.players.get(client.sessionId)?.name ?? '棋友', body: message.body.trim().slice(0, 160),
      });
    });
  }

  override onJoin(client: Client, options: JoinOptions = {}): void {
    const name = typeof options.displayName === 'string' && options.displayName.trim()
      ? options.displayName.trim().slice(0, 24) : '棋友';
    let seat: Seat = 'spectator';
    let token: string | null = null;
    if (typeof options.resumeToken === 'string' && options.resumeToken) {
      token = options.resumeToken;
      const hash = tokenHash(token);
      seat = (['red', 'black'] as const).find(side => this.saved.reservations[side]?.tokenHash === hash) ?? 'spectator';
      if (seat === 'spectator') throw new ServerError(403, '续局凭据无效');
      if ([...this.players.values()].some(player => player.seat === seat && player.connected)) {
        throw new ServerError(409, '该座位已在另一页面，请先关闭原对局');
      }
    } else {
      seat = !this.saved.reservations.red ? 'red' : !this.saved.reservations.black ? 'black' : 'spectator';
      if (seat !== 'spectator') {
        token = newSeatToken();
        const next = structuredClone(this.saved);
        next.reservations[seat] = { name, tokenHash: tokenHash(token) };
        this.commit(next);
      }
    }
    this.players.set(client.sessionId, { seat, name: seat === 'spectator' ? name : this.saved.reservations[seat]!.name,
      token, connected: true });
    this.sendIdentity(client);
    this.broadcastSeats();
    this.sendSnapshot(client);
    this.armClock();
  }

  override onLeave(client: Client, code?: number): void {
    const player = this.players.get(client.sessionId);
    if (!player) return;
    player.connected = false;
    if (player.seat !== 'spectator') {
      this.pauseClock();
      this.cancelUndo();
    }
    this.broadcastSeats();
    // Leaving pauses a game, never forfeits it. The durable seat stays reserved.
    if (code === CloseCode.CONSENTED) { this.players.delete(client.sessionId); return; }
    void this.allowReconnection(client, 30).then(reconnected => {
      this.players.delete(client.sessionId);
      // A manual history resume may already have reclaimed the seat.
      if ([...this.players.values()].some(p => p.seat === player.seat && p.connected && player.seat !== 'spectator')) {
        void reconnected.leave();
        return;
      }
      this.players.set(reconnected.sessionId, { ...player, connected: true });
      this.sendIdentity(reconnected);
      this.broadcastSeats();
      this.sendSnapshot(reconnected);
      this.armClock();
    }).catch(() => { this.players.delete(client.sessionId); this.broadcastSeats(); });
  }

  override onDispose(): void { this.pauseClock(); }

  private commit(next: StoredMatch): void {
    // Persist before publishing: clients never see a move that failed to save.
    this.store.save(next);
    this.saved = next;
    this.position = replayRecord(next.record);
  }
  private ready(): boolean {
    return (['red', 'black'] as const).every(side => [...this.players.values()].some(p => p.seat === side && p.connected));
  }
  private snapshot() {
    const record = this.saved.record;
    const last = record.moves.at(-1);
    return { fen: this.position.fen(), sideToMove: this.position.sideToMove, status: this.position.status(),
      record, lastMove: last?.uci ?? null, notation: last?.notation ?? '', moveNumber: record.moves.length,
      gameOver: !!record.result, clocks: this.currentClocks(), ready: this.ready(), undo: this.undoRequest };
  }
  private sendSnapshot(client: Client): void { client.send('snapshot', this.snapshot()); }
  private broadcastSnapshot(type = 'snapshot', extra = {}): void { this.broadcast(type, { ...this.snapshot(), ...extra }); }
  private sendIdentity(client: Client): void {
    const player = this.players.get(client.sessionId);
    if (player) client.send('identity', { gameId: this.saved.record.id, code: this.code,
      seat: player.seat, resumeToken: player.token });
  }
  private broadcastSeats(): void {
    const seats = { red: this.saved.reservations.red?.name ?? null, black: this.saved.reservations.black?.name ?? null };
    const spectators = [...this.players.values()].filter(p => p.connected && p.seat === 'spectator').length;
    for (const client of this.clients) client.send('seats', { seats, spectators,
      yourSeat: this.players.get(client.sessionId)?.seat ?? 'spectator', ready: this.ready() });
  }
  private reject(client: Client, reason: string): void { client.send('reject', { reason }); }
  private move(client: Client, uci: unknown): void {
    const player = this.players.get(client.sessionId);
    if (!player || player.seat === 'spectator') return this.reject(client, '观战者不能走子');
    if (!this.ready()) return this.reject(client, '等待对手回到棋局');
    if (this.saved.record.result) return this.reject(client, '对局已结束');
    if ((player.seat === 'red' ? RED : BLACK) !== this.position.sideToMove) return this.reject(client, '还没轮到你');
    if (typeof uci !== 'string') return this.reject(client, '着法格式不正确');
    try {
      const next = structuredClone(this.saved);
      next.record = appendRecord(next.record, uci);
      const before = this.currentClocks();
      if (next.initialClockMs > 0 && before[player.seat] <= 0) return this.finish('timeout', player.seat === 'red' ? BLACK : RED);
      next.clockHistory.push(before);
      next.clocks = { ...before, [player.seat]: before[player.seat] + next.incrementMs };
      this.commit(next);
      this.stopClock();
      this.cancelUndo();
      this.broadcastSnapshot('move', { uci });
      this.armClock();
    } catch (error) { this.reject(client, error instanceof Error ? error.message : '保存失败，请重试'); }
  }
  private requestUndo(client: Client): void {
    const seat = this.players.get(client.sessionId)?.seat;
    const ply = this.saved.record.moves.length;
    if (!seat || seat === 'spectator' || !this.ready() || !ply || this.undoRequest) return this.reject(client, '当前不能请求悔棋');
    const mover = ply % 2 ? 'red' : 'black';
    const count = mover === seat ? 1 : 2;
    if (count > ply) return this.reject(client, '还没有可撤回的着法');
    this.undoRequest = { seat, ply, count };
    this.broadcast('undo-pending', this.undoRequest);
  }
  private answerUndo(client: Client, accept: boolean): void {
    const seat = this.players.get(client.sessionId)?.seat;
    const request = this.undoRequest;
    if (!request || !seat || seat === 'spectator' || seat === request.seat) return;
    if (!accept || !this.ready() || request.ply !== this.saved.record.moves.length) { this.cancelUndo('对手拒绝了悔棋'); return; }
    try {
      const next = structuredClone(this.saved);
      const length = next.record.moves.length - request.count;
      next.record.moves.length = length;
      next.record.result = null;
      next.record.updatedAt = Date.now();
      next.clocks = next.clockHistory[length] ?? { red: next.initialClockMs, black: next.initialClockMs };
      next.clockHistory.length = length;
      this.commit(next);
      this.stopClock();
      this.cancelUndo('已撤回着法');
      this.broadcastSnapshot();
      this.armClock();
    } catch { this.reject(client, '保存失败，悔棋未生效'); }
  }
  private cancelUndo(text = ''): void {
    if (!this.undoRequest) return;
    this.undoRequest = null;
    this.broadcast('undo-cleared', { text });
  }
  private resign(client: Client): void {
    const seat = this.players.get(client.sessionId)?.seat;
    if (!seat || seat === 'spectator' || this.saved.record.result) return;
    this.finish('resign', seat === 'red' ? BLACK : RED);
  }
  private finish(reason: 'resign' | 'timeout', winner: Color): void {
    const next = structuredClone(this.saved);
    next.record.result = { reason, winner };
    next.record.updatedAt = Date.now();
    next.clocks = this.currentClocks();
    try { this.commit(next); }
    catch (error) {
      this.stopClock();
      console.error('Could not save game result', error);
      this.broadcast('event', { type: 'storage-error' });
      return;
    }
    this.stopClock();
    this.cancelUndo();
    this.broadcastSnapshot();
  }
  private rematch(client: Client): void {
    const seat = this.players.get(client.sessionId)?.seat;
    if (!seat || seat === 'spectator' || !this.saved.record.result || !this.ready()) return;
    this.rematchVotes.add(seat);
    if (this.rematchVotes.size < 2) { this.broadcast('event', { type: 'rematch-pending' }); return; }
    try {
      const next = structuredClone(this.saved);
      // Archive the completed game before reusing the table and seat keys.
      const archive = new MatchStore(`${this.store.directory}/archive/${next.record.id}`);
      archive.save(next);
      next.record = createRecord(newSeatToken(), next.record.variantId);
      next.clocks = { red: next.initialClockMs, black: next.initialClockMs };
      next.clockHistory = [];
      this.commit(next);
    } catch { this.reject(client, '保存失败，新对局未开始'); return; }
    this.stopClock();
    this.rematchVotes.clear();
    for (const client of this.clients) this.sendIdentity(client);
    this.broadcastSnapshot('reset');
    this.armClock();
  }
  private currentClocks() {
    const clocks = { ...this.saved.clocks };
    if (this.clockStartedAt && !this.saved.record.result) {
      const side = this.position.sideToMove === RED ? 'red' : 'black';
      clocks[side] = Math.max(0, clocks[side] - (Date.now() - this.clockStartedAt));
    }
    return clocks;
  }
  private stopClock(): void { if (this.clockTimer) clearInterval(this.clockTimer); this.clockTimer = null; this.clockStartedAt = 0; }
  private pauseClock(): void {
    if (!this.clockStartedAt) return;
    const next = { ...this.saved, clocks: this.currentClocks() };
    this.stopClock();
    try { this.commit(next); } catch (error) { console.error('Clock checkpoint failed', error); }
  }
  private armClock(): void {
    if (this.clockStartedAt || !this.ready() || this.saved.record.result || !this.saved.initialClockMs) return;
    this.clockStartedAt = Date.now();
    this.clockTimer = setInterval(() => {
      const side = this.position.sideToMove === RED ? 'red' : 'black';
      if (this.currentClocks()[side] <= 0) this.finish('timeout', side === 'red' ? BLACK : RED);
    }, 250);
  }
}

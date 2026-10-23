import { CloseCode, Room, type Client } from '@colyseus/core';
import {
  BLACK,
  RED,
  Position,
  XIANGQI,
  getVariant,
  toChineseNotation,
  type Color,
  type GameStatus,
} from '@xiangqi/rules';

/**
 * Authoritative xiangqi room.
 *
 * The server owns the only Position instance that matters: every move is
 * validated here, and clients only ever receive FEN snapshots plus the move
 * that produced them. That keeps the wire format tiny and makes it impossible
 * for a modified client to play an illegal move.
 *
 * The room deliberately has no @colyseus/schema state. `Room` only pushes a
 * full state when `this.state` is set, and the default serializer is "none",
 * so the wire protocol here is plain messages — no schema version coupling
 * between client and server.
 */

export type Seat = 'red' | 'black' | 'spectator';

export interface RoomOptions {
  /** Room code players share. Generated when omitted. */
  code?: string;
  variantId?: string;
  /** Clock budget per side in milliseconds. 0 disables the clock. */
  initialClockMs?: number;
  incrementMs?: number;
}

interface PlayerRecord {
  sessionId: string;
  seat: Seat;
  displayName: string;
}

export interface SeatNames {
  red: string | null;
  black: string | null;
}

export interface Clocks {
  red: number;
  black: number;
}

/** Wire messages, server -> client. */
export interface SnapshotMessage {
  type: 'snapshot';
  fen: string;
  sideToMove: Color;
  status: GameStatus;
  lastMove: string | null;
  notation: string;
  moveNumber: number;
  seats: SeatNames;
  clocks: Clocks;
  gameOver: boolean;
}

export interface SeatsMessage {
  type: 'seats';
  seats: SeatNames;
  spectators: number;
  yourSeat: Seat;
}

export interface MoveMessage {
  type: 'move';
  uci: string;
  notation: string;
  fen: string;
  sideToMove: Color;
  status: GameStatus;
  moveNumber: number;
  clocks: Clocks;
  gameOver: boolean;
}

export interface RejectMessage {
  type: 'reject';
  reason: string;
}

export interface ChatMessage {
  type: 'chat';
  from: string;
  body: string;
  at: number;
}

/**
 * Clock defaults. Zero disables the clock entirely — the client has no clock
 * UI yet, so a silent forfeit on time would be surprising. Both values can be
 * enabled per room through the join/create options.
 */
const DEFAULT_CLOCK_MS = 0;
const DEFAULT_INCREMENT_MS = 0;
const MAX_CHAT_LENGTH = 160;
const RECONNECT_GRACE_SECONDS = 30;
/** Two players plus a handful of spectators. */
const MAX_CLIENTS = 8;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export class XiangqiRoom extends Room {
  /** Shared room code. Doubles as the room id so `joinById(code)` works. */
  public code = '';
  public variantId = XIANGQI.id;

  private position!: Position;
  private players = new Map<string, PlayerRecord>();
  private lastMoveUci: string | null = null;
  private lastNotation = '';
  private moveNumber = 0;
  private initialClockMs = DEFAULT_CLOCK_MS;
  private incrementMs = DEFAULT_INCREMENT_MS;
  private clocks: Clocks = { red: DEFAULT_CLOCK_MS, black: DEFAULT_CLOCK_MS };
  private clockStartedAt = 0;
  /** True while a side's clock is actually counting; `clockStartedAt` is 0 otherwise. */
  private clockArmed = false;
  private clockSide: Color = RED;
  private clockTimer: NodeJS.Timeout | null = null;
  private rematchVotes = new Set<string>();
  /** Set once a game end has been announced, so it is announced once only. */
  private settled = false;

  override onCreate(options: RoomOptions = {}): void {
    this.variantId = options.variantId ?? XIANGQI.id;
    this.position = new Position(getVariant(this.variantId));

    this.code = (options.code ?? randomCode()).toUpperCase();
    // Allowed during onCreate(): the code doubles as the joinable room id.
    this.roomId = this.code;

    this.initialClockMs = Math.max(0, options.initialClockMs ?? DEFAULT_CLOCK_MS);
    this.incrementMs = Math.max(0, options.incrementMs ?? DEFAULT_INCREMENT_MS);
    this.clocks = { red: this.initialClockMs, black: this.initialClockMs };
    this.clockStartedAt = 0;
    this.clockSide = RED;

    this.maxClients = MAX_CLIENTS;
    this.autoDispose = true;    this.onMessage('move', (client, payload: { uci?: unknown }) => {
      this.handleMove(client, payload);
    });
    this.onMessage('rematch', (client) => {
      this.handleRematch(client);
    });
    this.onMessage('chat', (client, payload: { body?: unknown }) => {
      this.handleChat(client, payload);
    });
    this.onMessage('resign', (client) => {
      this.handleResign(client);
    });
    // A client can miss the messages sent during `onJoin` — it has no handler
    // attached until the join promise resolves. Asking for a sync re-sends the
    // full picture, which makes joining race-free.
    this.onMessage('sync', (client) => {
      this.sendSeats(client);
      this.sendSnapshot(client);
    });
  }

  override onJoin(client: Client, options: { displayName?: unknown } = {}): void {
    const displayName =
      typeof options.displayName === 'string' && options.displayName.trim().length > 0
        ? options.displayName.trim().slice(0, 24)
        : `棋友${client.sessionId.slice(0, 4)}`;

    const seat = this.assignSeat();
    this.players.set(client.sessionId, { sessionId: client.sessionId, seat, displayName });

    this.broadcastSeats();
    this.sendSnapshot(client);
    this.broadcast('event', { type: 'joined', name: displayName, seat });

    // The first player to sit down starts the clock running.
    if (seat === 'red' && !this.clockArmed && this.initialClockMs > 0) {
      this.startClock(RED);
    }
  }

  override onLeave(client: Client, code?: number): void {
    const player = this.players.get(client.sessionId);
    if (!player) return;

    this.broadcast('event', { type: 'left', name: player.displayName, seat: player.seat });

    if (code === CloseCode.CONSENTED) {
      this.players.delete(client.sessionId);
      this.broadcastSeats();
      return;
    }

    // Keep the seat warm for a short reconnect window instead of forfeiting.
    void this.allowReconnection(client, RECONNECT_GRACE_SECONDS)
      .then((reconnected) => {
        this.players.delete(client.sessionId);
        this.players.set(reconnected.sessionId, { ...player, sessionId: reconnected.sessionId });
        this.broadcastSeats();
        this.sendSnapshot(reconnected);
      })
      .catch(() => {
        this.players.delete(client.sessionId);
        this.broadcastSeats();
        // Losing a player mid-game is a forfeit for the side that stayed.
        if (player.seat !== 'spectator' && this.position.status().kind === 'playing') {
          const loser = player.seat === 'red' ? RED : BLACK;
          this.settled = true;
          this.stopClock();
          this.broadcast('event', {
            type: 'forfeit',
            name: player.displayName,
            loser,
            winner: loser === RED ? BLACK : RED,
          });
        }
      });
  }

  override onDispose(): void {
    this.stopClock();
  }

  // -- Seating -------------------------------------------------------------

  private seatTaken(seat: Seat): boolean {
    for (const record of this.players.values()) {
      if (record.seat === seat) return true;
    }
    return false;
  }

  private assignSeat(): Seat {
    if (!this.seatTaken('red')) return 'red';
    if (!this.seatTaken('black')) return 'black';
    return 'spectator';
  }

  /** Name sitting in each seat, for the client's player labels. */
  private seatNames(): SeatNames {
    let red: string | null = null;
    let black: string | null = null;
    for (const record of this.players.values()) {
      if (record.seat === 'red') red = record.displayName;
      else if (record.seat === 'black') black = record.displayName;
    }
    return { red, black };
  }

  private seatOf(sessionId: string): Seat {
    return this.players.get(sessionId)?.seat ?? 'spectator';
  }

  private spectatorCount(): number {
    let count = 0;
    for (const record of this.players.values()) {
      if (record.seat === 'spectator') count += 1;
    }
    return count;
  }

  private sendSeats(client: Client): void {
    const message: SeatsMessage = {
      type: 'seats',
      seats: this.seatNames(),
      spectators: this.spectatorCount(),
      yourSeat: this.seatOf(client.sessionId),
    };
    client.send('seats', message);
  }

  private broadcastSeats(): void {
    for (const client of this.clients) this.sendSeats(client);
  }

  // -- Clock ---------------------------------------------------------------

  /** Whether clocks are in use for this room at all. */
  private clockEnabled(): boolean {
    return this.initialClockMs > 0 && this.position.status().kind === 'playing';
  }

  private elapsedFor(side: Color): number {
    if (!this.clockArmed || !this.clockEnabled()) return 0;
    if (this.clockSide !== side) return 0;
    return Math.max(0, Date.now() - this.clockStartedAt);
  }

  private currentClocks(): Clocks {
    return {
      red: Math.max(0, this.clocks.red - this.elapsedFor(RED)),
      black: Math.max(0, this.clocks.black - this.elapsedFor(BLACK)),
    };
  }

  private startClock(side: Color): void {
    this.stopClock();
    if (!this.clockEnabled()) return;
    this.clockSide = side;
    this.clockStartedAt = Date.now();
    this.clockArmed = true;
    this.clockTimer = setInterval(() => {
      const clocks = this.currentClocks();
      const remaining = side === RED ? clocks.red : clocks.black;
      if (remaining > 0) return;
      this.stopClock();
      const winner = side === RED ? BLACK : RED;
      this.settled = true;
      this.broadcast('event', { type: 'timeout', winner });
    }, 1000);
  }

  private stopClock(): void {
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.clockTimer = null;
    this.clockArmed = false;
    this.clockStartedAt = 0;
  }

  private commitClock(): void {
    if (!this.clockArmed || !this.clockEnabled()) return;
    const elapsed = this.elapsedFor(this.clockSide);
    if (this.clockSide === RED) {
      this.clocks = { red: Math.max(0, this.clocks.red - elapsed), black: this.clocks.black };
    } else {
      this.clocks = { red: this.clocks.red, black: Math.max(0, this.clocks.black - elapsed) };
    }
  }

  // -- Moves ---------------------------------------------------------------

  private handleMove(client: Client, payload: { uci?: unknown }): void {
    const seat = this.seatOf(client.sessionId);
    if (seat === 'spectator') {
      this.reject(client, '观战者不能走子');
      return;
    }
    const uci = payload?.uci;
    if (typeof uci !== 'string' || uci.length < 4 || uci.length > 5) {
      this.reject(client, '着法格式不正确');
      return;
    }
    if (this.settled || this.position.status().kind !== 'playing') {
      this.reject(client, '对局已结束');
      return;
    }
    const seatSide: Color = seat === 'red' ? RED : BLACK;
    if (this.position.sideToMove !== seatSide) {
      this.reject(client, '还没轮到你');
      return;
    }

    const move = this.position.findUciMove(uci);
    if (move < 0) {
      this.reject(client, '不合规则的着法');
      return;
    }

    const notation = toChineseNotation(this.position, move);
    this.commitClock();
    this.position.makeMove(move);
    this.lastMoveUci = uci;
    this.lastNotation = notation;
    this.moveNumber += 1;

    // Fischer increment goes to the player who just moved.
    if (this.initialClockMs > 0) {
      if (seatSide === RED) this.clocks.red += this.incrementMs;
      else this.clocks.black += this.incrementMs;
    }

    const status = this.position.status();
    const message: MoveMessage = {
      type: 'move',
      uci,
      notation,
      fen: this.position.fen(),
      sideToMove: this.position.sideToMove,
      status,
      moveNumber: this.moveNumber,
      clocks: this.currentClocks(),
      gameOver: status.kind !== 'playing',
    };
    this.broadcast('move', message);

    if (message.gameOver) {
      this.settled = true;
      this.stopClock();
      this.rematchVotes.clear();
    } else {
      this.startClock(this.position.sideToMove);
    }
  }

  private handleResign(client: Client): void {
    const seat = this.seatOf(client.sessionId);
    if (seat === 'spectator' || this.settled) return;
    const loser = seat === 'red' ? RED : BLACK;
    this.settled = true;
    this.stopClock();
    this.broadcast('event', { type: 'resign', loser, winner: loser === RED ? BLACK : RED });
  }

  private handleRematch(client: Client): void {
    if (this.seatOf(client.sessionId) === 'spectator') return;
    this.rematchVotes.add(client.sessionId);
    const seated = [...this.players.values()].filter((p) => p.seat !== 'spectator');
    // Everyone seated must agree, and the game must actually be over.
    if (this.position.status().kind === 'playing') return;
    if (seated.length < 2) return;
    if (this.rematchVotes.size < seated.length) {
      this.broadcast('event', { type: 'rematch-pending', votes: this.rematchVotes.size });
      return;
    }
    this.resetGame();
    this.broadcast('event', { type: 'rematch' });
  }

  private resetGame(): void {
    this.stopClock();
    this.position.setFen(this.position.config.startFen);
    this.lastMoveUci = null;
    this.lastNotation = '';
    this.moveNumber = 0;
    this.clocks = { red: this.initialClockMs, black: this.initialClockMs };
    this.rematchVotes.clear();
    this.settled = false;
    this.startClock(RED);
    this.broadcast('reset', { fen: this.position.fen() });
  }

  private handleChat(client: Client, payload: { body?: unknown }): void {
    const body = payload?.body;
    if (typeof body !== 'string') return;
    const trimmed = body.trim().slice(0, MAX_CHAT_LENGTH);
    if (trimmed.length === 0) return;
    const name = this.players.get(client.sessionId)?.displayName ?? '棋友';
    const message: ChatMessage = { type: 'chat', from: name, body: trimmed, at: Date.now() };
    this.broadcast('chat', message);
  }

  // -- Snapshots -----------------------------------------------------------

  private sendSnapshot(client: Client): void {
    const status = this.position.status();
    const message: SnapshotMessage = {
      type: 'snapshot',
      fen: this.position.fen(),
      sideToMove: this.position.sideToMove,
      status,
      lastMove: this.lastMoveUci,
      notation: this.lastNotation,
      moveNumber: this.moveNumber,
      seats: this.seatNames(),
      clocks: this.currentClocks(),
      gameOver: this.settled || status.kind !== 'playing',
    };
    client.send('snapshot', message);
  }

  private reject(client: Client, reason: string): void {
    const message: RejectMessage = { type: 'reject', reason };
    client.send('reject', message);
  }
}

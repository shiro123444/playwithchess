import { ColyseusSDK, type Room } from '@colyseus/sdk';
import { BLACK, RED, type Color, type GameStatus, type GameRecord } from '@xiangqi/rules';

/**
 * Online transport for the authoritative server.
 *
 * The server sends plain messages (no schema state): a `snapshot` on join,
 * `move` for each accepted move, `seats` when the seating changes, and
 * `event` for everything else. The client only ever applies positions the
 * server has produced, so a modified client cannot desync a game.
 */

export type Tone = 'idle' | 'ok' | 'error';

export interface SeatNames {
  red: string | null;
  black: string | null;
}

/** Everything the room dialog needs to draw itself. */
export interface RoomState {
  code: string;
  seats: SeatNames;
  spectators: number;
  /** One of the two seats is still empty, so the game has not begun. */
  waiting: boolean;
}

export interface OnlineHandlers {
  onStatus: (text: string, tone: Tone) => void;
  onRoom: (state: RoomState) => void;
  /** Transient roster/rematch chatter, shown as a short notice. */
  onNotice: (text: string) => void;
  /** Seat this client holds; `null` means spectator. */
  onSide: (side: Color | null) => void;
  /** The room is gone (closed by the server, or dropped for good). */
  onClosed: () => void;
  onConnection: (connected: boolean) => void;
  onRecord: (record: GameRecord) => void;
  onIdentity?: (identity: { code: string; gameId: string; seat: 'red' | 'black' | 'spectator'; resumeToken: string | null }) => void;
  onUndo?: (request: { seat: 'red' | 'black'; ply: number; count: number } | null) => void;
}

interface SnapshotMessage {
  record?: GameRecord;
  ready?: boolean;
  fen: string;
  sideToMove: Color;
  status: GameStatus;
  lastMove: string | null;
  notation: string;
  moveNumber: number;
  seats: SeatNames;
  clocks: { red: number; black: number };
  gameOver: boolean;
}

interface MoveMessage {
  record?: GameRecord;
  uci: string;
  notation: string;
  fen: string;
  sideToMove: Color;
  status: GameStatus;
  moveNumber: number;
  clocks: { red: number; black: number };
  gameOver: boolean;
}

interface SeatsMessage {
  seats: SeatNames;
  spectators: number;
  yourSeat: 'red' | 'black' | 'spectator';
  ready?: boolean;
}

interface RejectMessage {
  reason: string;
}

interface EventMessage {
  type: string;
  [key: string]: unknown;
}

const ROOM_NAME = 'xiangqi';
const DEFAULT_PORT = 2567;

/** Server endpoint: `VITE_SERVER_URL` wins, otherwise the page host on :2567. */
function resolveServerUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  if (typeof window === 'undefined') return `ws://localhost:${DEFAULT_PORT}`;
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${protocol}://${window.location.hostname}:${DEFAULT_PORT}`;
}

function displayName(): string {
  try {
    const stored = window.localStorage.getItem('xiangqi.displayName');
    if (stored && stored.trim().length > 0) return stored.trim().slice(0, 24);
  } catch {
    // Private-mode browsers can throw on storage access; a default name is fine.
  }
  return `棋友${Math.floor(Math.random() * 9000 + 1000)}`;
}

function seatToColor(seat: SeatsMessage['yourSeat']): Color | null {
  if (seat === 'red') return RED;
  if (seat === 'black') return BLACK;
  return null;
}

export class OnlineSession {
  private readonly sdk: ColyseusSDK;
  private room: Room | null = null;
  private seat: Color | null = null;
  private joined = false;
  private seats: SeatNames = { red: null, black: null };
  private spectators = 0;
  private cancelled = false;
  private ready = false;
  private syncing = true;

  constructor(private readonly handlers: OnlineHandlers) {
    this.sdk = new ColyseusSDK(resolveServerUrl());
  }

  get roomId(): string | null {
    return this.room?.roomId ?? null;
  }

  /** Seat held by this client; `null` while spectating or before joining. */
  get side(): Color | null {
    return this.seat;
  }

  isConnected(): boolean {
    return this.joined && this.room !== null;
  }

  /**
   * Join an existing room by code, or create a fresh table without a code.
   */
  async connect(code?: string | null, resumeToken?: string): Promise<void> {
    if (this.room) return;
    this.handlers.onStatus('连接中', 'idle');

    const requested = code?.trim().toUpperCase();
    const options = {
      displayName: displayName(),
      variantId: 'xiangqi',
      ...(resumeToken ? { resumeToken } : {}),
    };
    // Creating always makes a private table; entering a code never silently
    // creates a new room when the invitation is mistyped or expired.
    let room: Room;
    if (!requested) room = await this.sdk.create(ROOM_NAME, options);
    else {
      try { room = await this.sdk.joinById(requested, options); }
      catch (error) {
        const code = (error as { code?: number }).code;
        if (code !== 4212 && code !== 404 && code !== 522) throw error;
        // The server only recreates codes backed by a durable match file.
        room = await this.sdk.joinOrCreate(ROOM_NAME, { ...options, code: requested });
      }
    }
    if (this.cancelled) {
      await room.leave(true);
      return;
    }

    this.room = room;
    this.joined = true;
    this.bind(room);
    this.handlers.onConnection(true);
    // Messages sent during the server's onJoin land before these handlers
    // exist, so ask for the current seats + position once we are listening.
    room.send('sync', {});
    this.handlers.onStatus('已连接', 'ok');
    this.handlers.onRoom(this.roomState());
  }

  leave(): void {
    this.cancelled = true;
    const room = this.room;
    this.room = null;
    this.joined = false;
    this.seat = null;
    this.seats = { red: null, black: null };
    this.spectators = 0;
    if (room) void room.leave(true);
  }

  sendMove(uci: string): void {
    this.room?.send('move', { uci });
  }

  requestRematch(): void {
    this.room?.send('rematch');
  }

  requestUndo(): void { this.room?.send('undo-request'); }
  answerUndo(accept: boolean): void { this.room?.send('undo-answer', { accept }); }
  resign(): void { this.room?.send('resign'); }

  sendChat(body: string): void {
    this.room?.send('chat', { body });
  }

  // -- Wiring --------------------------------------------------------------

  private bind(room: Room): void {
    room.onMessage('identity', message => this.handlers.onIdentity?.(message));
    room.onMessage('undo-pending', message => this.handlers.onUndo?.(message));
    room.onMessage('undo-cleared', (message: { text?: string }) => {
      this.handlers.onUndo?.(null);
      if (message.text) this.handlers.onNotice(message.text);
    });
    room.onMessage('snapshot', (message: SnapshotMessage) => {
      if (!this.applyRecord(message.record)) return;
      this.syncing = false;
      if (typeof message.ready === 'boolean') this.ready = message.ready;
      this.handlers.onRoom(this.roomState());
    });

    room.onMessage('move', (message: MoveMessage) => {
      this.applyRecord(message.record);
    });

    room.onMessage('reset', (message: { fen: string; record?: GameRecord }) => {
      this.applyRecord(message.record);
      this.handlers.onNotice('新的一局');
    });

    room.onMessage('seats', (message: SeatsMessage) => {
      this.seats = message.seats;
      this.ready = message.ready ?? !!(message.seats.red && message.seats.black);
      this.spectators = message.spectators;
      const next = seatToColor(message.yourSeat);
      if (next !== this.seat) {
        this.seat = next;
        this.handlers.onSide(next);
      }
      this.handlers.onRoom(this.roomState());
    });

    room.onMessage('reject', (message: RejectMessage) => {
      this.handlers.onStatus(message.reason, 'error');
      this.handlers.onNotice(message.reason);
      room.send('sync', {});
    });

    room.onMessage('event', (message: EventMessage) => {
      this.handleEvent(message);
    });

    room.onMessage('chat', (message: { from: string; body: string }) => {
      this.handlers.onStatus(`${message.from}: ${message.body}`, 'idle');
    });

    room.onDrop(() => {
      if (this.cancelled) return;
      this.joined = false;
      this.syncing = true;
      this.handlers.onConnection(false);
      this.handlers.onStatus('连接断开 · 重连中', 'error');
    });

    room.onReconnect(() => {
      if (this.cancelled) return;
      this.joined = true;
      this.handlers.onConnection(true);
      this.handlers.onStatus('已重连', 'ok');
      room.send('sync', {});
    });

    room.onLeave((code: number) => {
      if (this.cancelled) return;
      this.joined = false;
      this.handlers.onStatus(code === 1000 ? '已离开' : '连接已关闭', 'idle');
      this.handlers.onClosed();
    });

    room.onError((code: number, message?: string) => {
      if (this.cancelled) return;
      this.joined = false;
      this.handlers.onStatus(message ?? `连接错误 ${code}`, 'error');
      this.handlers.onClosed();
    });
  }

  private applyRecord(record?: GameRecord): boolean {
    if (!record || record.version !== 1) {
      this.handlers.onNotice('联机服务需要升级，当前版本不支持存档');
      this.leave();
      this.handlers.onClosed();
      return false;
    }
    this.handlers.onRecord(record);
    return true;
  }

  private roomState(): RoomState {
    return {
      code: this.room?.roomId ?? '',
      seats: this.seats,
      spectators: this.spectators,
      waiting: this.syncing || !this.ready,
    };
  }

  private handleEvent(message: EventMessage): void {
    switch (message.type) {
      case 'joined': {
        const name = typeof message.name === 'string' ? message.name : '棋友';
        // Roster churn is a notice, not the connection pill — overwriting the
        // pill would hide which side this player holds.
        this.handlers.onNotice(`${name} 已加入`);
        break;
      }
      case 'left': {
        const name = typeof message.name === 'string' ? message.name : '棋友';
        this.handlers.onNotice(`${name} 已离开`);
        break;
      }
      case 'gameover':
        this.handlers.onStatus('对局结束', 'idle');
        break;
      case 'resign':
      case 'timeout':
      case 'forfeit': {
        const winner = message.winner;
        const label = winner === RED ? '红方' : winner === BLACK ? '黑方' : '对手';
        this.handlers.onStatus(`${label}胜`, 'ok');
        break;
      }
      case 'rematch-pending':
        this.handlers.onNotice('对手想再来一局');
        break;
      case 'rematch':
        this.handlers.onNotice('新的一局');
        break;
      case 'storage-error':
        this.handlers.onNotice('服务端保存失败，请稍后重试');
        break;
      default:
        break;
    }
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { XiangqiRoom } from './XiangqiRoom.ts';

let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'xiangqi-reactions-'));
  vi.stubEnv('XIANGQI_DATA_DIR', directory);
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function seatRoom() {
  const room = new XiangqiRoom() as XiangqiRoom & {
    clients: any[];
    handlers: Map<string, (client: any, payload?: any) => void>;
    code: string;
  };
  room.onCreate({});
  const join = (sessionId: string) => {
    const messages: Array<{ type: string; payload: any }> = [];
    const client = { sessionId, send: (type: string, payload: any) => { messages.push({ type, payload }); } } as never;
    room.clients.push(client);
    room.onJoin(client, { displayName: sessionId });
    return {
      client,
      messages,
      received: (type: string) => messages.filter(message => message.type === type).map(message => message.payload),
      react: (payload: unknown) => room.handlers.get('reaction')!(client, payload),
    };
  };
  return { room, red: join('A'), black: join('B'), spectator: join('C') };
}

describe('reaction relay', () => {
  it('forwards a known sticker to the other clients, not back to the sender', () => {
    const { red, black, spectator } = seatRoom();
    red.react({ id: 'joy' });
    expect(black.received('reaction')).toEqual([{ id: 'joy', seat: 'red', name: 'A' }]);
    expect(spectator.received('reaction')).toEqual([{ id: 'joy', seat: 'red', name: 'A' }]);
    expect(red.received('reaction')).toEqual([]);
  });

  it('drops unknown ids instead of relaying client text to the room', () => {
    const { red, black } = seatRoom();
    red.react({ id: '<script>' });
    red.react({ id: '../../etc/passwd' });
    red.react({});
    red.react(undefined);
    expect(black.received('reaction')).toEqual([]);
  });

  it('lets spectators react but never on behalf of a seat', () => {
    const { red, black, spectator } = seatRoom();
    spectator.react({ id: 'hundred' });
    expect(red.received('reaction')).toEqual([{ id: 'hundred', seat: 'spectator', name: 'C' }]);
    expect(black.received('reaction')).toEqual([{ id: 'hundred', seat: 'spectator', name: 'C' }]);
    expect(spectator.received('reaction')).toEqual([]);
  });

  it('throttles a client that holds the key down', () => {
    const { red, black } = seatRoom();
    red.react({ id: 'fire' });
    vi.advanceTimersByTime(100);
    red.react({ id: 'fire' });
    red.react({ id: 'cry' });
    expect(black.received('reaction')).toHaveLength(1);
    vi.advanceTimersByTime(400);
    red.react({ id: 'cry' });
    expect(black.received('reaction').map(message => message.id)).toEqual(['fire', 'cry']);
  });

  it('never touches the durable record', () => {
    const { room, red } = seatRoom();
    const before = JSON.stringify((room as unknown as { saved: unknown }).saved);
    red.react({ id: 'party' });
    expect(JSON.stringify((room as unknown as { saved: unknown }).saved)).toBe(before);
  });
});

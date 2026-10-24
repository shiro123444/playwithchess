import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BLACK, createRecord } from '@xiangqi/rules';
import { OnlineSession, type OnlineHandlers } from './online.ts';

const sdk = vi.hoisted(() => ({ create: vi.fn(), joinById: vi.fn(), joinOrCreate: vi.fn() }));
vi.mock('@colyseus/sdk', () => ({
  ColyseusSDK: class {
    create = sdk.create;
    joinById = sdk.joinById;
    joinOrCreate = sdk.joinOrCreate;
  },
}));

function fixture() {
  const messages = new Map<string, (message: any) => void>();
  const events = new Map<string, (...args: any[]) => void>();
  const room = {
    roomId: 'ABCD',
    send: vi.fn(),
    leave: vi.fn(async () => events.get('leave')?.(4000)),
    onMessage: (type: string, fn: (message: any) => void) => messages.set(type, fn),
    onDrop: (fn: () => void) => events.set('drop', fn),
    onReconnect: (fn: () => void) => events.set('reconnect', fn),
    onLeave: (fn: (...args: any[]) => void) => events.set('leave', fn),
    onError: (fn: (...args: any[]) => void) => events.set('error', fn),
  };
  const handlers: OnlineHandlers = {
    onStatus: vi.fn(), onRoom: vi.fn(), onNotice: vi.fn(), onRecord: vi.fn(),
    onSide: vi.fn(), onClosed: vi.fn(), onConnection: vi.fn(),
  };
  sdk.create.mockResolvedValue(room);
  sdk.joinById.mockResolvedValue(room);
  sdk.joinOrCreate.mockResolvedValue(room);
  return { room, messages, events, handlers, session: new OnlineSession(handlers) };
}

beforeEach(() => vi.resetAllMocks());

describe('online room lifecycle', () => {
  it('creates a fresh room and explicitly requests a snapshot', async () => {
    const { session, room } = fixture();
    await session.connect(null);
    expect(sdk.create).toHaveBeenCalledWith('xiangqi', expect.any(Object));
    expect(sdk.joinById).not.toHaveBeenCalled();
    expect(room.send).toHaveBeenCalledWith('sync', {});
    expect(session.isConnected()).toBe(true);
  });

  it('joins the requested room without creating one on a failed invitation', async () => {
    const { session } = fixture();
    sdk.joinById.mockRejectedValue(new Error('not found'));
    await expect(session.connect(' abcd ')).rejects.toThrow('not found');
    expect(sdk.joinById).toHaveBeenCalledWith('ABCD', expect.any(Object));
    expect(sdk.create).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
  });

  it('propagates the black seat and readiness when both players arrive', async () => {
    const { session, messages, handlers } = fixture();
    await session.connect('ABCD');
    messages.get('seats')!({ seats: { red: 'A', black: 'B' }, spectators: 1, yourSeat: 'black' });
    messages.get('snapshot')!({ record: createRecord('test'), ready: true });
    expect(session.side).toBe(BLACK);
    expect(handlers.onSide).toHaveBeenCalledWith(BLACK);
    expect(handlers.onRoom).toHaveBeenLastCalledWith({
      code: 'ABCD', seats: { red: 'A', black: 'B' }, spectators: 1, waiting: false,
    });
  });

  it('reports disconnect and resynchronizes after reconnect', async () => {
    const { session, events, room, handlers } = fixture();
    await session.connect('ABCD');
    events.get('drop')!();
    expect(session.isConnected()).toBe(false);
    expect(handlers.onConnection).toHaveBeenLastCalledWith(false);
    events.get('reconnect')!();
    expect(session.isConnected()).toBe(true);
    expect(handlers.onConnection).toHaveBeenLastCalledWith(true);
    expect(room.send).toHaveBeenLastCalledWith('sync', {});
  });

  it('restores the authoritative position after a rejected move', async () => {
    const { session, room, messages, handlers } = fixture();
    await session.connect('ABCD');
    messages.get('reject')!({ reason: '还没轮到你' });
    expect(handlers.onStatus).toHaveBeenLastCalledWith('还没轮到你', 'error');
    expect(room.send).toHaveBeenLastCalledWith('sync', {});
  });

  it('closes a room that arrives after the connection was cancelled', async () => {
    const { session, room, handlers } = fixture();
    let resolve!: (room: unknown) => void;
    sdk.create.mockReturnValue(new Promise((done) => { resolve = done; }));
    const connecting = session.connect(null);
    session.leave();
    resolve(room);
    await connecting;
    expect(room.leave).toHaveBeenCalledWith(true);
    expect(session.isConnected()).toBe(false);
    expect(handlers.onConnection).not.toHaveBeenCalled();
    expect(handlers.onClosed).not.toHaveBeenCalled();
  });

  it('does not re-enter local mode recursively on an intentional leave', async () => {
    const { session, handlers } = fixture();
    await session.connect('ABCD');
    session.leave();
    expect(handlers.onClosed).not.toHaveBeenCalled();
    expect(session.isConnected()).toBe(false);
  });
  it('recreates only a durable room after the live room has been disposed', async () => {
    const { session } = fixture();
    sdk.joinById.mockRejectedValue({ code: 4212 });
    await session.connect('ABCD', 'resume-secret');
    expect(sdk.joinOrCreate).toHaveBeenCalledWith('xiangqi', expect.objectContaining({ code: 'ABCD', resumeToken: 'resume-secret' }));
    expect(sdk.create).not.toHaveBeenCalled();
  });
  it('keeps input waiting until the authoritative replay arrives', async () => {
    const { session, messages, handlers } = fixture();
    await session.connect('ABCD');
    messages.get('seats')!({ seats: { red: 'A', black: 'B' }, spectators: 0, yourSeat: 'red', ready: true });
    expect(handlers.onRoom).toHaveBeenLastCalledWith(expect.objectContaining({ waiting: true }));
    messages.get('snapshot')!({ record: createRecord('test'), ready: true });
    expect(handlers.onRoom).toHaveBeenLastCalledWith(expect.objectContaining({ waiting: false }));
    expect(handlers.onRecord).toHaveBeenCalled();
  });

});

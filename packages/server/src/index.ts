import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineRoom, defineServer, Server, type ServerOptions } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { XiangqiRoom } from './XiangqiRoom.ts';

/**
 * Entrypoint for the authoritative game server.
 *
 * One room type for now. Players land in the same room by name (`xiangqi`);
 * `code` in the join options is also used as the room id, so a direct
 * `joinById(code)` finds the game a friend shared.
 */

const PORT = Number(process.env.PORT ?? 2567);
/** `0.0.0.0` keeps the server reachable from a phone on the same network. */
const HOST = process.env.HOST ?? '0.0.0.0';

const rooms = {
  // `code` is matched through the matchmaker's room listing, so joining with a
  // shared code lands in that exact table (and creates it if it is gone).
  xiangqi: defineRoom(XiangqiRoom).filterBy(['code']),
};

export function createGameServer(overrides: ServerOptions = {}): Server {
  return defineServer({
    rooms,
    transport: new WebSocketTransport(),
    greet: false,
    ...overrides,
  });
}

async function main(): Promise<void> {
  const server = createGameServer();
  await server.listen(PORT, HOST);

  console.info(`[xiangqi] authoritative server listening on ws://${HOST}:${PORT}`);
  console.info(`[xiangqi] room types: ${Object.keys(rooms).join(', ')}`);
}

// Only auto-start when executed directly (`pnpm server`), not when imported by a test.
// Compare resolved paths: argv[1] can be relative or a symlink while import.meta.url is absolute.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error: unknown) => {
    console.error('[xiangqi] failed to start server', error);
    process.exitCode = 1;
  });
}

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { ColyseusSDK } = require('@colyseus/sdk');
const directory = mkdtempSync(join(tmpdir(), 'xiangqi-online-'));
const port = Number(process.env.XIANGQI_TEST_PORT ?? 2569);
const sdk = new ColyseusSDK(`ws://127.0.0.1:${port}`);
let server;
const clients = new Set();
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timeout: ${message}`); await new Promise(done => setTimeout(done, 20)); }
}
async function start() {
  let ready = false;
  server = spawn(process.execPath, ['--experimental-strip-types', '--experimental-transform-types', 'packages/server/src/index.ts'], {
    cwd: resolve('.'), env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', XIANGQI_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', data => { if (data.toString().includes('listening')) ready = true; });
  server.stderr.on('data', data => { if (!data.toString().includes('ExperimentalWarning') && !data.toString().includes('--trace-warnings')) process.stderr.write(data); });
  await until(() => ready || server.exitCode !== null, 'server startup');
  assert(ready, 'server failed to start');
}
async function stop() { if (!server || server.exitCode !== null) return; const exited = new Promise(done => server.once('exit', done)); server.kill('SIGTERM'); await exited; }
function watch(room) {
  const state = { room, identity: null, snapshot: null, seats: null, pending: null, rejects: [], reactions: [] };
  for (const type of ['snapshot', 'move', 'reset']) room.onMessage(type, message => { state.snapshot = message; });
  room.onMessage('identity', message => { state.identity = message; });
  room.onMessage('seats', message => { state.seats = message; });
  room.onMessage('undo-pending', message => { state.pending = message; });
  room.onMessage('undo-cleared', () => { state.pending = null; });
  room.onMessage('reaction', message => { state.reactions.push(message); });
  room.onMessage('reject', message => state.rejects.push(message));
  room.onMessage('event', () => {}); room.onMessage('chat', () => {});
  clients.add(room); room.onLeave(() => clients.delete(room)); room.send('sync'); return state;
}
const pass = message => console.log(`PASS ${message}`);
try {
  await start();
  let a = watch(await sdk.create('xiangqi', { displayName: 'Red' }));
  await until(() => a.identity && a.snapshot, 'red snapshot');
  const code = a.room.roomId;
  let b = watch(await sdk.joinById(code, { displayName: 'Black' }));
  await until(() => b.identity && a.seats?.ready, 'both seats');
  const redToken = a.identity.resumeToken, blackToken = b.identity.resumeToken;
  assert.equal(a.identity.seat, 'red'); assert.equal(b.identity.seat, 'black'); pass('red and black seats');
  const spectator = watch(await sdk.joinById(code));
  await until(() => spectator.identity, 'spectator');
  assert.equal(spectator.identity.seat, 'spectator');
  spectator.room.send('move', { uci: 'h2e2' });
  await until(() => spectator.rejects.length, 'spectator rejection'); pass('spectator cannot move');
  a.room.send('move', { uci: 'h2e2' });
  await until(() => b.snapshot?.record.moves.length === 1, 'red move');
  b.room.send('move', { uci: 'h9g7' });
  await until(() => a.snapshot?.record.moves.length === 2, 'black reply'); pass('two-way authoritative moves');
  a.room.send('undo-request');
  await until(() => b.pending, 'undo request');
  assert.equal(b.pending.count, 2);
  b.room.send('undo-answer', { accept: true });
  await until(() => a.snapshot.record.moves.length === 0 && b.snapshot.record.moves.length === 0, 'accepted undo'); pass('accepted undo restores both clients');
  a.room.send('reaction', { id: 'handshake' });
  await until(() => b.reactions.length && spectator.reactions.length, 'relayed reaction');
  assert.deepEqual(b.reactions.at(-1), { id: 'handshake', seat: 'red', name: 'Red' });
  assert.equal(spectator.reactions.at(-1)?.seat, 'red');
  // The sender drew its own sticker locally, so no echo comes back to it.
  assert.equal(a.reactions.length, 0);
  a.room.send('reaction', { id: 'not-a-real-sticker' });
  await new Promise(done => setTimeout(done, 300));
  assert.equal(b.reactions.length, 1); pass('reaction reaches opponent and spectator only, unknown ids dropped');
  a.room.send('move', { uci: 'h2e2' }); await until(() => b.snapshot.record.moves.length === 1, 'move after undo');
  b.room.send('move', { uci: 'h9g7' }); await until(() => a.snapshot.record.moves.length === 2, 'reply after undo');
  const fen = a.snapshot.fen;
  await spectator.room.leave(true); await b.room.leave(true);
  await until(() => a.seats?.ready === false, 'offline seat');
  assert.equal(a.snapshot.record.result, null); pass('leaving pauses without forfeiting');
  await a.room.leave(true);
  await stop(); await start();
  const restore = async token => {
    let room;
    try { room = await sdk.joinById(code, { resumeToken: token }); }
    catch { room = await sdk.joinOrCreate('xiangqi', { code, resumeToken: token }); }
    return watch(room);
  };
  a = await restore(redToken); await until(() => a.identity && a.snapshot, 'restored red');
  b = await restore(blackToken); await until(() => b.identity && b.snapshot && a.seats?.ready, 'restored black');
  assert.equal(a.identity.seat, 'red'); assert.equal(b.identity.seat, 'black');
  assert.equal(a.snapshot.fen, fen); assert.equal(b.snapshot.record.moves.length, 2); pass('process restart restores position and original seats');
  a.room.send('move', { uci: 'e2e6' }); await until(() => b.snapshot.record.moves.length === 3, 'capture after restart'); pass('resumed game remains playable');
  b.room.send('resign'); await until(() => a.snapshot.record.result?.reason === 'resign', 'resignation');
  assert.equal(a.snapshot.record.result.winner, 0); pass('terminal result persisted and broadcast');
  const id = a.snapshot.record.id;
  a.room.send('rematch'); b.room.send('rematch');
  await until(() => a.snapshot.record.id !== id && b.snapshot.record.id !== id, 'rematch');
  assert.equal(a.snapshot.record.moves.length, 0); pass('agreed rematch creates a distinct history entry');
} finally {
  await Promise.allSettled([...clients].map(room => room.leave(true)));
  await stop(); rmSync(directory, { recursive: true, force: true });
}

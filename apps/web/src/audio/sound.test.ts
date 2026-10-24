import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundBoard } from './sound.ts';

function fixture(muted = false) {
  const data = new Map<string, string>(muted ? [['xiangqi.sound', 'off']] : []);
  const sources: any[] = [];
  let contexts = 0;
  let decoded = 0;
  const node = () => ({ connect: vi.fn(function (this: any) { return this; }), disconnect: vi.fn(), gain: { value: 0 } });
  class Context {
    state = 'running'; currentTime = 1; destination = {};
    suspend = vi.fn(async () => {}); resume = vi.fn(async () => {}); close = vi.fn(async () => {});
    constructor() { contexts++; }
    createGain = node;
    decodeAudioData = vi.fn(async () => ({ recording: ++decoded }));
    createBufferSource() {
      const source = { ...node(), buffer: null, playbackRate: { value: 1 }, start: vi.fn(), stop: vi.fn(), onended: null };
      sources.push(source); return source;
    }
  }
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value) }, AudioContext: Context });
  const fetcher = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
  vi.stubGlobal('fetch', fetcher);
  return { board: new SoundBoard(), sources, fetcher, contexts: () => contexts };
}
afterEach(() => vi.unstubAllGlobals());

describe('recorded collision playback', () => {
  it('does not initialize audio or fetch media for a muted player', () => {
    const { board, fetcher, contexts } = fixture(true);
    board.unlock(); board.play('capture');
    expect(contexts()).toBe(0); expect(fetcher).not.toHaveBeenCalled();
  });
  it('decodes recorded assets and uses them for movement and double capture hits', async () => {
    const { board, sources, fetcher } = fixture();
    board.unlock();
    await new Promise(done => setTimeout(done, 0));
    board.play('move'); board.play('capture');
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(sources).toHaveLength(3);
    expect(sources.every(source => source.buffer.recording >= 1)).toBe(true);
    expect(sources[2].start.mock.calls[0][0]).toBeGreaterThan(sources[1].start.mock.calls[0][0]);
    board.dispose();
  });
  it('stops active collisions on mute and schedules no further sound', async () => {
    const { board, sources } = fixture();
    board.unlock(); await new Promise(done => setTimeout(done, 0)); board.play('move');
    board.setEnabled(false); board.play('move');
    expect(sources).toHaveLength(1); expect(sources[0].stop).toHaveBeenCalled();
    board.dispose();
  });
});

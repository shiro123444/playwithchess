import { afterEach, describe, expect, it, vi } from 'vitest';
import { SoundBoard } from './sound.ts';

function fixture(muted = false) {
  const data = new Map<string, string>(muted ? [['xiangqi.sound', 'off']] : []);
  const sources: any[] = [];
  const tones: any[] = [];
  const bands: any[] = [];
  let contexts = 0;
  let decoded = 0;
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const node = () => ({ connect: vi.fn(function (this: any) { return this; }), disconnect: vi.fn(), gain: param() });
  class Context {
    state = 'running'; currentTime = 1; destination = {};
    suspend = vi.fn(async () => {}); resume = vi.fn(async () => {}); close = vi.fn(async () => {});
    constructor() { contexts++; }
    createGain = node;
    createOscillator() {
      const tone = { ...node(), type: 'sine', frequency: param(), start: vi.fn(), stop: vi.fn() };
      tones.push(tone); return tone;
    }
    createBiquadFilter() {
      const band = { ...node(), type: 'lowpass', Q: { value: 1 }, frequency: param() };
      bands.push(band); return band;
    }
    createBuffer() { return { getChannelData: () => new Float32Array(4) }; }
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
  return { board: new SoundBoard(), sources, tones, bands, fetcher, contexts: () => contexts };
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

describe('reaction voices', () => {
  it('plays each note of a multi-note voice, scheduled in order', () => {
    const { board, tones } = fixture();
    board.unlock();
    board.playReaction('joy');
    expect(tones).toHaveLength(2);
    const first = tones[0].start.mock.calls[0][0];
    const second = tones[1].start.mock.calls[0][0];
    expect(second).toBeGreaterThan(first);
    board.dispose();
  });

  it('glides a note that declares an end pitch and holds one that does not', () => {
    const { board, tones } = fixture();
    board.unlock();
    board.playReaction('eyeroll');
    expect(tones).toHaveLength(1);
    expect(tones[0].frequency.exponentialRampToValueAtTime).toHaveBeenCalled();
    board.dispose();
  });

  it('adds a filtered noise sweep only for reactions that declare one', () => {
    const { board, bands } = fixture();
    board.unlock();
    board.playReaction('handshake');
    expect(bands).toHaveLength(0);
    board.playReaction('party');
    expect(bands).toHaveLength(1);
    expect(bands[0].frequency.exponentialRampToValueAtTime).toHaveBeenCalled();
    board.dispose();
  });

  it('falls back to the default voice for an unknown id', () => {
    const { board, tones } = fixture();
    board.unlock();
    board.playReaction('not-a-reaction');
    expect(tones.length).toBeGreaterThan(0);
    board.dispose();
  });

  it('stays silent and does not open an audio device for a muted player', () => {
    const { board, tones, contexts } = fixture(true);
    board.playReaction('fire');
    expect(contexts()).toBe(0);
    expect(tones).toHaveLength(0);
  });

  it('cuts a reaction voice when the player mutes mid-sound', () => {
    const { board, tones } = fixture();
    board.unlock();
    board.playReaction('party');
    const playing = tones.length;
    board.setEnabled(false);
    board.playReaction('party');
    expect(tones).toHaveLength(playing);
    board.dispose();
  });
});

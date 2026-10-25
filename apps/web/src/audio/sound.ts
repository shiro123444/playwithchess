/**
 * Recorded collision samples with synthesis as a decoding/network fallback.
 *
 * Move and capture cues use CC0 tabletop collision recordings. Menu, check
 * and end cues stay synthesised; a short wooden synthesis is the fallback
 * when recorded samples cannot be fetched or decoded.
 *
 * The AudioContext is created lazily on the first cue so a muted visitor never
 * opens an audio device, and so the first cue — always triggered by a pointer
 * gesture — is allowed to start.
 */

import { voiceFor } from './reaction-voices.ts';

export type SoundCue = 'move' | 'capture' | 'check' | 'end' | 'click';

const STORAGE_KEY = 'xiangqi.sound';

/** Master trim; individual cues are mixed under this. */
const MASTER_GAIN = 0.55;

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Private mode or a blocked storage partition: sound still works, it just
    // cannot remember the choice.
    return true;
  }
}

function writePreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Non-fatal: the toggle stays correct for this page load.
  }
}

interface WoodOptions {
  /** Peak gain, 0–1. */
  level: number;
  /** Body pitch in Hz at the strike. */
  pitch: number;
  /** Decay in seconds. */
  decay: number;
  /** Centre frequency of the noise band. */
  noiseHz: number;
  /** Delay from `when`, in seconds. */
  offset?: number;
}

export class SoundBoard {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = readPreference();
  private samples: AudioBuffer[] = [];
  private loading: Promise<void> | null = null;
  private activeSamples = new Set<AudioBufferSourceNode>();

  /** Unlock on the selecting gesture, before the later landing animation. */
  unlock(): void {
    if (!this.enabled) return;
    const context = this.ensureContext();
    if (context?.state === 'suspended') void context.resume().catch(() => undefined);
  }

  private loadSamples(context: AudioContext): void {
    if (this.loading) return;
    this.loading = Promise.all([1, 2, 3].map(async id => {
      const response = await fetch(`${import.meta.env.BASE_URL}audio/collision-${id}.wav`);
      if (!response.ok) throw new Error('sample unavailable');
      return context.decodeAudioData(await response.arrayBuffer());
    })).then(samples => { if (this.context === context) this.samples = samples; }).catch(() => undefined);
  }

  private recorded(context: AudioContext, out: AudioNode, now: number, capture: boolean): boolean {
    if (this.samples.length !== 3) return false;
    const strike = (index: number, offset: number, level: number) => {
      const source = context.createBufferSource();
      source.buffer = this.samples[index];
      source.playbackRate.value = 0.97 + Math.random() * 0.06;
      const gain = context.createGain(); gain.gain.value = level;
      source.connect(gain).connect(out);
      this.activeSamples.add(source);
      source.onended = () => { this.activeSamples.delete(source); source.disconnect(); gain.disconnect(); };
      source.start(now + offset);
    };
    strike(capture ? 1 : Math.floor(Math.random() * 3), 0, capture ? 0.85 : 0.72);
    if (capture) strike(2, 0.045, 0.48);
    return true;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    writePreference(enabled);
    if (!enabled) {
      // Cut anything still ringing so the mute is immediate.
      for (const source of this.activeSamples) { try { source.stop(); } catch { /* already ended */ } }
      this.activeSamples.clear();
      this.context?.suspend().catch(() => undefined);
      return;
    }
    void this.context?.resume().catch(() => undefined);
  }

  toggle(): boolean {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  play(cue: SoundCue): void {
    if (!this.enabled) return;
    const context = this.ensureContext();
    if (!context) return;
    const out = this.master;
    if (!out) return;
    if (context.state === 'suspended') {
      // Autoplay policy: resume on the gesture that is asking for the sound.
      void context.resume().catch(() => undefined);
    }
    const now = context.currentTime + 0.002;
    switch (cue) {
      case 'move':
        if (this.recorded(context, out, now, false)) break;
        this.wood(context, out, now, { level: 0.22, pitch: 190, decay: 0.09, noiseHz: 1500 });
        break;
      case 'capture':
        if (this.recorded(context, out, now, true)) break;
        // Two hits a hair apart read as a piece tipping over, not a single tap.
        this.wood(context, out, now, { level: 0.4, pitch: 130, decay: 0.16, noiseHz: 950 });
        this.wood(context, out, now, { level: 0.22, pitch: 210, decay: 0.1, noiseHz: 1700, offset: 0.035 });
        break;
      case 'check':
        this.chime(context, out, now, [660, 990], 0.11, 0.9);
        break;
      case 'end':
        this.arpeggio(context, out, now, [523.25, 659.25, 783.99]);
        break;
      case 'click':
        this.wood(context, out, now, { level: 0.09, pitch: 340, decay: 0.035, noiseHz: 2600 });
        break;
    }
  }

  /**
   * Play the designed voice for a reaction sticker.
   *
   * Voices are mixed at roughly the level of a piece landing, not a UI click:
   * a reaction is something the other player sent, so it should be audible
   * across the room without competing with the move that follows it.
   */
  playReaction(id: string): void {
    if (!this.enabled) return;
    const context = this.ensureContext();
    const out = this.master;
    if (!context || !out) return;
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const start = context.currentTime + 0.002;
    const voice = voiceFor(id);
    for (const note of voice.notes) {
      const at = start + note.at;
      const tone = context.createOscillator();
      tone.type = note.type;
      tone.frequency.setValueAtTime(note.freq, at);
      if (note.glideTo !== undefined) {
        tone.frequency.exponentialRampToValueAtTime(Math.max(20, note.glideTo), at + note.dur);
      }
      const gain = context.createGain();
      // A few milliseconds of attack keeps the small speakers from clicking.
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(note.level, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur);
      tone.connect(gain).connect(out);
      tone.start(at);
      tone.stop(at + note.dur + 0.02);
    }
    if (voice.noise) {
      const at = start + voice.noise.at;
      const source = context.createBufferSource();
      source.buffer = this.noise(context);
      const band = context.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 0.9;
      band.frequency.setValueAtTime(voice.noise.hz, at);
      band.frequency.exponentialRampToValueAtTime(Math.max(40, voice.noise.hzTo), at + voice.noise.dur);
      const gain = context.createGain();
      gain.gain.setValueAtTime(voice.noise.level, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + voice.noise.dur);
      source.connect(band).connect(gain).connect(out);
      this.activeSamples.add(source);
      source.onended = () => { this.activeSamples.delete(source); source.disconnect(); gain.disconnect(); };
      source.start(at);
      source.stop(at + voice.noise.dur + 0.02);
    }
  }

  dispose(): void {
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.master = null;
    this.noiseBuffer = null;
    this.samples = [];
    this.loading = null;
  }

  // --- Building blocks ----------------------------------------------------

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      const context = new Ctor();
      const master = context.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(context.destination);
      this.context = context;
      this.master = master;
      this.loadSamples(context);
      return context;
    } catch (error: unknown) {
      // No audio output available (rare, but it must not break the game).
      console.warn('Audio unavailable, playing silently', error);
      return null;
    }
  }

  private noise(context: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    // One buffer serves every cue. 600 ms covers the longest noise decay —
    // the reaction sweeps run to 400 ms — with room to spare; a source that
    // outlives its buffer just goes silent, so being generous costs nothing
    // at runtime.
    const length = Math.floor(context.sampleRate * 0.6);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  /** A wooden strike: filtered noise attack plus a fast-dropping sine body. */
  private wood(context: AudioContext, out: AudioNode, now: number, options: WoodOptions): void {
    const at = now + (options.offset ?? 0);

    const source = context.createBufferSource();
    source.buffer = this.noise(context);
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = options.noiseHz;
    band.Q.value = 1.2;
    const attack = context.createGain();
    attack.gain.setValueAtTime(options.level, at);
    attack.gain.exponentialRampToValueAtTime(0.0001, at + options.decay);
    source.connect(band).connect(attack).connect(out);
    source.start(at);
    source.stop(at + options.decay + 0.02);

    const body = context.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(options.pitch, at);
    body.frequency.exponentialRampToValueAtTime(options.pitch * 0.55, at + options.decay);
    const bodyGain = context.createGain();
    bodyGain.gain.setValueAtTime(options.level * 0.8, at);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, at + options.decay * 1.4);
    body.connect(bodyGain).connect(out);
    body.start(at);
    body.stop(at + options.decay * 1.5);
  }

  /** A struck bell: a small stack of partials sharing one envelope. */
  private chime(
    context: AudioContext,
    out: AudioNode,
    now: number,
    partials: number[],
    level: number,
    decay: number,
  ): void {
    for (const frequency of partials) {
      const tone = context.createOscillator();
      tone.type = 'triangle';
      tone.frequency.value = frequency;
      const gain = context.createGain();
      // A 6 ms ramp avoids the click of a hard start.
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(level, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);
      tone.connect(gain).connect(out);
      tone.start(now);
      tone.stop(now + decay + 0.02);
    }
  }

  private arpeggio(context: AudioContext, out: AudioNode, now: number, notes: number[]): void {
    notes.forEach((frequency, index) => {
      const at = now + index * 0.12;
      this.chime(context, out, at, [frequency], 0.1, 0.65);
    });
  }
}

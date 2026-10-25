/**
 * A designed voice for each reaction sticker.
 *
 * These are data, not code, so the whole set can be reviewed as one instrument:
 * every reaction answers a different emotional register, and the mix stays
 * inside a narrow band of loudness so a burst of stickers never clips. The
 * palette mirrors the board sounds — short wooden knocks for agreement, small
 * bell stacks for delight, filtered noise for the two explosive reactions —
 * with no sample licensing to carry.
 */

export interface VoiceNote {
  /** Seconds after the sticker is pressed. */
  at: number;
  /** Starting pitch in Hz. */
  freq: number;
  /** Optional end pitch; a note glides when this is set. */
  glideTo?: number;
  /** Seconds the note rings, including its release. */
  dur: number;
  type: OscillatorType;
  /** Peak gain, 0–1, before the master trim. */
  level: number;
}

export interface VoiceNoise {
  at: number;
  dur: number;
  /** Band centre in Hz at the start. */
  hz: number;
  /** Band centre at the end; a rising sweep reads as "whoosh". */
  hzTo: number;
  level: number;
}

export interface ReactionVoice {
  notes: ReadonlyArray<VoiceNote>;
  noise?: VoiceNoise;
}

/** Agree: two low wooden taps, the same body as the board's own knocks. */
const AGREEMENT: ReactionVoice = {
  notes: [
    { at: 0, freq: 232, dur: 0.1, type: 'sine', level: 0.16 },
    { at: 0.11, freq: 196, dur: 0.16, type: 'sine', level: 0.13 },
  ],
};

export const REACTION_VOICES: Readonly<Record<string, ReactionVoice>> = {
  // Laughter: two quick upward blips.
  joy: {
    notes: [
      { at: 0, freq: 660, dur: 0.09, type: 'triangle', level: 0.1 },
      { at: 0.085, freq: 880, dur: 0.12, type: 'triangle', level: 0.1 },
    ],
  },
  // Affection: a warm third, a touch longer than laughter.
  love: {
    notes: [
      { at: 0, freq: 523.25, dur: 0.22, type: 'sine', level: 0.11 },
      { at: 0.06, freq: 783.99, dur: 0.26, type: 'sine', level: 0.09 },
    ],
  },
  // Celebration: four-note arpeggio with confetti noise on top.
  party: {
    notes: [523.25, 659.25, 783.99, 1046.5].map((freq, index) => ({
      at: index * 0.075, freq, dur: 0.3, type: 'triangle' as const, level: 0.085,
    })),
    noise: { at: 0, dur: 0.34, hz: 3200, hzTo: 6200, level: 0.05 },
  },
  // Respect for a good game: the board's own knock, twice, then a held tone.
  handshake: AGREEMENT,
  // Praise: a bright rising third played as one clean gesture.
  hundred: {
    notes: [
      { at: 0, freq: 659.25, dur: 0.1, type: 'triangle', level: 0.1 },
      { at: 0.07, freq: 987.77, dur: 0.2, type: 'triangle', level: 0.09 },
    ],
  },
  // Resignation with dignity: a slow, low falling pair.
  crown: {
    notes: [
      { at: 0, freq: 392, dur: 0.26, type: 'sine', level: 0.11 },
      { at: 0.14, freq: 261.63, dur: 0.4, type: 'sine', level: 0.1 },
    ],
  },
  // Pondering: two hesitant notes with a gap between them.
  thinking: {
    notes: [
      { at: 0, freq: 466.16, dur: 0.14, type: 'sine', level: 0.09 },
      { at: 0.19, freq: 349.23, dur: 0.22, type: 'sine', level: 0.085 },
    ],
  },
  // A sigh: one long descending slide.
  eyeroll: {
    notes: [{ at: 0, freq: 587.33, glideTo: 233.08, dur: 0.5, type: 'triangle', level: 0.075 }],
  },
  // Nerd: a dry pencil tick, then a knowing chime.
  nerd: {
    notes: [
      { at: 0, freq: 1400, dur: 0.04, type: 'square', level: 0.045 },
      { at: 0.05, freq: 880, dur: 0.16, type: 'triangle', level: 0.075 },
    ],
  },
  // Momentum: a rising air sweep under a low body hit.
  fire: {
    notes: [{ at: 0, freq: 130.81, dur: 0.3, type: 'sine', level: 0.12 }],
    noise: { at: 0, dur: 0.4, hz: 420, hzTo: 2400, level: 0.09 },
  },
  // Shock: a deep boom with a star twinkle falling out of it.
  mindblown: {
    notes: [
      { at: 0, freq: 82.41, dur: 0.26, type: 'sine', level: 0.16 },
      { at: 0.1, freq: 1567.98, dur: 0.3, type: 'triangle', level: 0.05 },
    ],
    noise: { at: 0, dur: 0.2, hz: 900, hzTo: 160, level: 0.06 },
  },
  // Regret: three notes stepping down, the shortest of the sad figures.
  cry: {
    notes: [
      { at: 0, freq: 493.88, dur: 0.18, type: 'sine', level: 0.1 },
      { at: 0.13, freq: 392, dur: 0.2, type: 'sine', level: 0.09 },
      { at: 0.27, freq: 329.63, dur: 0.32, type: 'sine', level: 0.08 },
    ],
  },
};

/** Fallback used only if a sticker ships without a voice. */
export const FALLBACK_VOICE: ReactionVoice = {
  notes: [{ at: 0, freq: 523.25, dur: 0.16, type: 'triangle', level: 0.08 }],
};

export function voiceFor(id: string): ReactionVoice {
  return REACTION_VOICES[id] ?? FALLBACK_VOICE;
}

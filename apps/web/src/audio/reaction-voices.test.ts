import { describe, expect, it } from 'vitest';
import { REACTIONS } from '@xiangqi/rules';
import { FALLBACK_VOICE, REACTION_VOICES, voiceFor } from './reaction-voices.ts';

describe('reaction voices', () => {
  it('gives every shipping sticker a designed voice', () => {
    for (const reaction of REACTIONS) {
      expect(REACTION_VOICES[reaction.id], `${reaction.id} has no voice`).toBeDefined();
    }
  });

  it('does not ship voices for stickers that are not in the catalogue', () => {
    const known = new Set(REACTIONS.map(reaction => reaction.id));
    for (const id of Object.keys(REACTION_VOICES)) expect(known.has(id)).toBe(true);
  });

  it('keeps every voice inside the loudness band so a burst cannot clip', () => {
    for (const [id, voice] of Object.entries(REACTION_VOICES)) {
      const peak = Math.max(...voice.notes.map(note => note.level), voice.noise?.level ?? 0);
      expect(peak, `${id} is too loud`).toBeLessThanOrEqual(0.18);
      expect(peak, `${id} is inaudible`).toBeGreaterThanOrEqual(0.04);
    }
  });

  it('schedules every voice within a short window and with audible pitches', () => {
    for (const [id, voice] of Object.entries(REACTION_VOICES)) {
      for (const note of voice.notes) {
        expect(note.at, `${id} starts late`).toBeLessThan(0.5);
        expect(note.dur, `${id} rings too long`).toBeLessThanOrEqual(0.6);
        expect(note.freq, `${id} is below hearing`).toBeGreaterThan(60);
        if (note.glideTo !== undefined) expect(note.glideTo).toBeGreaterThan(20);
      }
      if (voice.noise) expect(voice.noise.at + voice.noise.dur).toBeLessThan(0.7);
    }
  });

  it('falls back rather than going silent for an unknown id', () => {
    expect(voiceFor('not-a-reaction')).toBe(FALLBACK_VOICE);
    expect(FALLBACK_VOICE.notes.length).toBeGreaterThan(0);
  });
});

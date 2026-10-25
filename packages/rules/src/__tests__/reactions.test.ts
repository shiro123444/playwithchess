import { describe, expect, it } from 'vitest';
import { REACTIONS, isReactionId } from '../reactions.ts';

describe('reaction catalogue', () => {
  it('has unique ids, because an id is also the asset file name', () => {
    const ids = REACTIONS.map(reaction => reaction.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses only ids that are safe as file names', () => {
    for (const reaction of REACTIONS) expect(reaction.id).toMatch(/^[a-z][a-z0-9-]{1,23}$/);
  });

  it('accepts a known id and rejects everything else', () => {
    expect(isReactionId('joy')).toBe(true);
    expect(isReactionId('JOY')).toBe(false);
    expect(isReactionId('joy\n')).toBe(false);
    expect(isReactionId('')).toBe(false);
    expect(isReactionId(undefined)).toBe(false);
    expect(isReactionId(7)).toBe(false);
    expect(isReactionId({ id: 'joy' })).toBe(false);
  });

  it('gives every reaction a non-empty Chinese label for its button', () => {
    for (const reaction of REACTIONS) expect(reaction.label.trim().length).toBeGreaterThan(0);
  });
});

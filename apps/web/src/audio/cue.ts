import type { GameStatus } from '@xiangqi/rules';

/**
 * Which cues one completed move should play, in order.
 *
 * Pure and dependency-free so the mix can be unit-tested without a browser:
 * the landing knock always plays, then a check rings over it or a finished
 * game resolves into an arpeggio. A finished game never also gets the check
 * cue — a mate is already final, and two cues overlapping sounds like a bug.
 */
export function cuesFor(status: GameStatus, captured: boolean): ReadonlyArray<'move' | 'capture' | 'check' | 'end'> {
  const cues: Array<'move' | 'capture' | 'check' | 'end'> = [captured ? 'capture' : 'move'];
  if (status.kind !== 'playing') cues.push('end');
  else if (status.check) cues.push('check');
  return cues;
}

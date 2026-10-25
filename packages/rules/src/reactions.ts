/**
 * Reaction ids shared by the web client and the authoritative server.
 *
 * Kept here rather than in the web app because the server must be able to
 * reject an id it does not know: a relaying server that trusts the client
 * turns a reaction picker into an arbitrary-string broadcast. The ids are also
 * the file names under `apps/web/public/emoji/`, so a client and server that
 * disagree about this list cannot silently render a blank tile — one of them
 * fails loudly instead.
 */

export interface Reaction {
  id: string;
  /** Short Chinese label, used for the accessible button name. */
  label: string;
}

export const REACTIONS: readonly Reaction[] = [
  { id: 'joy', label: '大笑' },
  { id: 'love', label: '喜欢' },
  { id: 'party', label: '庆祝' },
  { id: 'handshake', label: '承让' },
  { id: 'hundred', label: '好棋' },
  { id: 'crown', label: '认输' },
  { id: 'thinking', label: '思考' },
  { id: 'eyeroll', label: '无语' },
  { id: 'nerd', label: '棋理' },
  { id: 'fire', label: '气势' },
  { id: 'mindblown', label: '惊了' },
  { id: 'cry', label: '懊恼' },
];

const ids = new Set(REACTIONS.map(reaction => reaction.id));

export function isReactionId(value: unknown): value is string {
  return typeof value === 'string' && ids.has(value);
}

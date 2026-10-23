import { BLACK, RED, type Color } from './types.ts';

/**
 * A variant describes a Xiangqi-family board. The move generator is written
 * against this configuration rather than hard-coded geometry, which is what
 * lets one engine host several rule sets.
 */
export interface VariantConfig {
  /** Stable identifier used by the network protocol and FEN loads. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Board width in files. */
  width: number;
  /** Board height in ranks. Rank 0 is Black's back rank, rank height-1 Red's. */
  height: number;
  /** Starting position in the standard Xiangqi FEN dialect. */
  startFen: string;
  /** Whether the river restricts elephants and enables sideways pawn moves. */
  hasRiver: boolean;
  /** Whether an elephant's "eye" square must be empty. */
  elephantEyeBlocks: boolean;
  /** Half-moves without a capture before the game is drawn (0 disables). */
  noCaptureLimit: number;
  /** Repetitions of a position before the game is drawn (0 disables). */
  repetitionLimit: number;
}

export const XIANGQI: VariantConfig = {
  id: 'xiangqi',
  name: '中国象棋',
  width: 9,
  height: 10,
  startFen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
  hasRiver: true,
  elephantEyeBlocks: true,
  noCaptureLimit: 120,
  repetitionLimit: 3,
};

/**
 * Mini Xiangqi — the 7x7 variant documented by Fairy-Stockfish as
 * `minixiangqi`. Same piece *kinds* as Xiangqi but no elephants, no advisors,
 * and no river: pawns may step sideways from the start, and each king is
 * confined to a 3x3 palace in its own corner.
 *
 * Kept byte-for-byte compatible with the Fairy-Stockfish start position so the
 * perft suite can cross-check this engine against a reference implementation.
 */
export const MINI_XIANGQI: VariantConfig = {
  id: 'minixiangqi',
  name: '迷你象棋 7×7',
  width: 7,
  height: 7,
  startFen: 'rcnkncr/p1ppp1p/7/7/7/P1PPP1P/RCNKNCR w - - 0 1',
  hasRiver: false,
  elephantEyeBlocks: true,
  noCaptureLimit: 120,
  repetitionLimit: 3,
};

export const VARIANTS: Record<string, VariantConfig> = {
  [XIANGQI.id]: XIANGQI,
  [MINI_XIANGQI.id]: MINI_XIANGQI,
};

export function getVariant(id: string): VariantConfig {
  const variant = VARIANTS[id];
  if (!variant) throw new Error(`Unknown variant: ${id}`);
  return variant;
}

/** Geometry derived from a config once, then queried on the hot path. */
export interface Geometry {
  readonly config: VariantConfig;
  readonly width: number;
  readonly height: number;
  readonly squares: number;
  readonly palaceFileMin: number;
  readonly palaceFileMax: number;
  readonly redPalaceRankMin: number;
  readonly redPalaceRankMax: number;
  readonly blackPalaceRankMin: number;
  readonly blackPalaceRankMax: number;
  /** Red elephants may never sit on a rank below this (the river boundary). */
  readonly redElephantMinRank: number;
  /** Black elephants may never sit on a rank above this (the river boundary). */
  readonly blackElephantMaxRank: number;
  /** Last rank of Red's half; pawns on or below it may move sideways. */
  readonly redRiverRank: number;
  /** First rank of Black's half; pawns on or above it may move sideways. */
  readonly blackRiverRank: number;
  readonly rankOf: Uint8Array;
  readonly fileOf: Uint8Array;
  /** Vertical mirror, used to reuse Red piece-square tables for Black. */
  readonly mirror: Uint8Array;
}

export function geometryOf(config: VariantConfig): Geometry {
  const { width, height } = config;
  const squares = width * height;
  const rankOf = new Uint8Array(squares);
  const fileOf = new Uint8Array(squares);
  for (let sq = 0; sq < squares; sq++) {
    fileOf[sq] = sq % width;
    rankOf[sq] = (sq / width) | 0;
  }
  const mirror = new Uint8Array(squares);
  for (let sq = 0; sq < squares; sq++) {
    mirror[sq] = (height - 1 - rankOf[sq]) * width + fileOf[sq];
  }

  const center = (width - 1) / 2;
  return {
    config,
    width,
    height,
    squares,
    palaceFileMin: center - 1,
    palaceFileMax: center + 1,
    redPalaceRankMin: height - 3,
    redPalaceRankMax: height - 1,
    blackPalaceRankMin: 0,
    blackPalaceRankMax: 2,
    // Without a river the elephant may use the whole board. With one, Red
    // elephants stay on ranks height/2..height-1 and Black on 0..height/2-1.
    redElephantMinRank: config.hasRiver ? height / 2 : 0,
    blackElephantMaxRank: config.hasRiver ? height / 2 - 1 : height - 1,
    redRiverRank: config.hasRiver ? height / 2 - 1 : -1,
    blackRiverRank: config.hasRiver ? height / 2 : height,
    rankOf,
    fileOf,
    mirror,
  };
}

export function inPalace(geo: Geometry, sq: number, color: Color): boolean {
  const file = geo.fileOf[sq];
  if (file < geo.palaceFileMin || file > geo.palaceFileMax) return false;
  const rank = geo.rankOf[sq];
  return color === RED
    ? rank >= geo.redPalaceRankMin && rank <= geo.redPalaceRankMax
    : rank >= geo.blackPalaceRankMin && rank <= geo.blackPalaceRankMax;
}

/** True once a pawn has crossed the river and may step sideways. */
export function crossedRiver(geo: Geometry, sq: number, color: Color): boolean {
  // Variants without a river let pawns sidestep from the very first move.
  if (!geo.config.hasRiver) return true;
  const rank = geo.rankOf[sq];
  return color === RED ? rank <= geo.redRiverRank : rank >= geo.blackRiverRank;
}

/** Board-index delta for one forward step. Red advances up (toward rank 0). */
export function forwardStep(geo: Geometry, color: Color): number {
  return color === RED ? -geo.width : geo.width;
}

export const isBlackColor = (color: Color): boolean => color === BLACK;

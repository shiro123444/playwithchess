/**
 * @xiangqi/rules — a variant-driven Xiangqi engine.
 *
 * The engine is deliberately dependency-free and deterministic so the same
 * code can run on the authoritative server, inside a Web Worker bot, and in
 * the browser for local move validation.
 */

export * from './types.ts';
export * from './variant.ts';
export * from './movegen.ts';
export * from './position.ts';
export * from './ai/evaluate.ts';
export * from './ai/search.ts';
export * from './notation.ts';

import { BLACK, RED, type Color, type Move, moveFrom, moveTo } from '../types.ts';
import type { Position } from '../position.ts';
import { evaluate, PIECE_VALUE } from './evaluate.ts';

export const MATE_SCORE = 30_000;
const INFINITY = 1_000_000;
const TT_LIMIT = 200_000;

export interface SearchResult {
  move: Move;
  score: number;
  depth: number;
  nodes: number;
  /** Principal variation as UCI strings, best move first. */
  pv: string[];
  timeMs: number;
}

export interface SearchOptions {
  /** Fixed depth in plies. */
  depth?: number;
  /** Time budget; the search returns the best move found so far. */
  movetimeMs?: number;
  /** Node budget, useful for deterministic tests. */
  maxNodes?: number;
  /** Called after each completed iteration so callers can stream progress. */
  onProgress?: (result: SearchResult) => void;
}

interface TTEntry {
  depth: number;
  score: number;
  flag: 0 | 1 | 2; // exact / lower bound / upper bound
  move: Move;
}

interface Budget {
  nodes: number;
  deadline: number;
  maxNodes: number;
  aborted: boolean;
}

/**
 * Iterative-deepening alpha-beta with a transposition table, killer moves,
 * late-move reductions, and a quiescence search over captures.
 *
 * Deliberately compact: strong enough to be a credible opponent at shallow
 * depths, fast enough to run inside a Web Worker without stalling the UI.
 */
export class Search {
  private pos!: Position;
  private budget: Budget = { nodes: 0, deadline: Infinity, maxNodes: Infinity, aborted: false };
  private tt = new Map<string, TTEntry>();
  private killers: Move[][] = [];
  private history = new Float64Array(1 << 14);

  search(position: Position, options: SearchOptions = {}): SearchResult {
    this.pos = position;
    this.tt = new Map();
    this.killers = [];
    this.history = new Float64Array(1 << 14);

    const started = performance.now();
    this.budget = {
      nodes: 0,
      deadline: options.movetimeMs ? started + options.movetimeMs : Infinity,
      maxNodes: options.maxNodes ?? Infinity,
      aborted: false,
    };

    const rootMoves = position.legalMoves();
    if (rootMoves.length === 0) {
      return { move: -1, score: 0, depth: 0, nodes: 0, pv: [], timeMs: 0 };
    }

    const maxDepth = options.depth ?? (options.movetimeMs ? 32 : 4);
    let best: SearchResult = {
      move: rootMoves[0],
      score: 0,
      depth: 0,
      nodes: 0,
      pv: [position.moveToUci(rootMoves[0])],
      timeMs: 0,
    };

    for (let depth = 1; depth <= maxDepth; depth++) {
      const result = this.searchRoot(depth, started);
      if (result.move >= 0) best = result;
      options.onProgress?.(best);

      const done = this.budget.aborted || Math.abs(best.score) > MATE_SCORE - 200;
      if (done) break;
    }

    return best;
  }

  private abort(): boolean {
    const b = this.budget;
    if (b.aborted) return true;
    if (b.nodes >= b.maxNodes) {
      b.aborted = true;
      return true;
    }
    if (b.deadline !== Infinity && performance.now() >= b.deadline) {
      b.aborted = true;
      return true;
    }
    return false;
  }

  private searchRoot(depth: number, started: number): SearchResult {
    const pos = this.pos;
    const moves = this.orderMoves(pos.legalMoves(), -1, 0);
    let alpha = -INFINITY;
    const beta = INFINITY;
    let bestMove: Move = moves[0] ?? -1;
    let bestScore = -INFINITY;
    const pv: string[] = [];

    for (const move of moves) {
      pos.makeMove(move);
      const childPv: string[] = [];
      const score = -this.negamax(depth - 1, -beta, -alpha, 1, childPv);
      pos.unmakeMove();

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        pv.length = 0;
        pv.push(pos.moveToUci(move), ...childPv);
      }
      if (score > alpha) alpha = score;
      if (this.budget.aborted) break;
    }

    return {
      move: bestMove,
      score: bestScore,
      depth,
      nodes: this.budget.nodes,
      pv: pv.length > 0 ? pv : bestMove >= 0 ? [pos.moveToUci(bestMove)] : [],
      timeMs: performance.now() - started,
    };
  }

  private negamax(depth: number, alphaIn: number, beta: number, ply: number, pv: string[]): number {
    this.budget.nodes++;
    if ((this.budget.nodes & 2047) === 0 && this.abort()) return this.sideScore();

    const pos = this.pos;
    const inCheck = pos.isCheck();

    // Never allow the search to stand pat while in check.
    if (inCheck && depth <= 0) depth = 1;
    if (depth <= 0) return this.quiescence(alphaIn, beta, ply);

    const key = `${pos.keyLo >>> 0}:${pos.keyHi >>> 0}`;
    const entry = this.tt.get(key);
    if (entry && entry.depth >= depth) {
      if (entry.flag === 0) return entry.score;
      if (entry.flag === 1 && entry.score >= beta) return entry.score;
      if (entry.flag === 2 && entry.score <= alphaIn) return entry.score;
    }

    const moves = this.orderMoves(pos.legalMoves(), entry?.move ?? -1, ply);
    if (moves.length === 0) {
      // Mate scores are relative to the root so shorter mates win.
      return inCheck ? -MATE_SCORE + ply : 0;
    }

    const alphaStart = alphaIn;
    let alpha = alphaIn;
    let bestScore = -INFINITY;
    let bestMove: Move = -1;

    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      const quiet = pos.pieceAt(moveTo(move)) === 0;
      pos.makeMove(move);

      let score: number;
      if (i === 0) {
        score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, pv);
      } else {
        // Late move reductions: search quiet late moves shallower first, then
        // re-search at full depth if they beat alpha.
        const reduction = depth >= 3 && i >= 4 && quiet && !inCheck ? 1 : 0;
        score = -this.negamax(depth - 1 - reduction, -alpha - 1, -alpha, ply + 1, []);
        if (score > alpha && score < beta) {
          score = -this.negamax(depth - 1, -beta, -alpha, ply + 1, pv);
        }
      }

      pos.unmakeMove();

      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        if (score > alpha) alpha = score;
      }

      if (alpha >= beta) {
        if (quiet) {
          const slot = (this.killers[ply] ??= [-1, -1]);
          if (slot[0] !== move) {
            slot[1] = slot[0];
            slot[0] = move;
          }
          this.history[(ply * 1024 + (move & 1023)) & 16383] += depth * depth;
        }
        break;
      }
    }

    const flag: 0 | 1 | 2 = bestScore <= alphaStart ? 2 : bestScore >= beta ? 1 : 0;
    this.tt.set(key, { depth, score: bestScore, flag, move: bestMove });

    if (this.tt.size > TT_LIMIT) {
      const oldest = this.tt.keys().next().value;
      if (oldest !== undefined) this.tt.delete(oldest);
    }

    return bestScore;
  }

  /** Search captures (and forced evasions) until the position is quiet. */
  private quiescence(alphaIn: number, beta: number, ply: number): number {
    this.budget.nodes++;
    if ((this.budget.nodes & 2047) === 0 && this.abort()) return this.sideScore();

    const pos = this.pos;
    const standPat = this.sideScore();
    if (standPat >= beta) return beta;

    let alpha = Math.max(alphaIn, standPat);
    // Depth cap prevents pathological capture chains from exploding.
    if (ply > 16) return alpha;

    for (const move of this.orderMoves(pos.pseudoLegalMoves(true), -1, ply)) {
      pos.makeMove(move);
      const mover = pos.sideToMove === RED ? BLACK : RED;
      if (pos.isInCheck(mover)) {
        pos.unmakeMove();
        continue;
      }
      const score = -this.quiescence(-beta, -alpha, ply + 1);
      pos.unmakeMove();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  private sideScore(): number {
    const score = evaluate(this.pos);
    return this.pos.sideToMove === RED ? score : -score;
  }

  /** TT move first, then MVV-LVA captures, then killers, then history. */
  private orderMoves(moves: Move[], ttMove: Move, ply: number): Move[] {
    const pos = this.pos;
    const killers = this.killers[ply];
    const scored = moves.map((move) => {
      if (move === ttMove) return { move, score: 1_000_000 };
      const victim = pos.pieceAt(moveTo(move));
      if (victim !== 0) {
        const attacker = pos.pieceAt(moveFrom(move)) & 7;
        return {
          move,
          score: 100_000 + (PIECE_VALUE[victim & 7] ?? 0) * 10 - (PIECE_VALUE[attacker] ?? 0),
        };
      }
      if (killers) {
        if (move === killers[0]) return { move, score: 90_000 };
        if (move === killers[1]) return { move, score: 80_000 };
      }
      return { move, score: this.history[(ply * 1024 + (move & 1023)) & 16383] };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map((entry) => entry.move);
  }
}

export function winnerOfScore(score: number, sideToMove: Color): Color | null {
  if (Math.abs(score) < MATE_SCORE - 1000) return null;
  return score > 0 ? sideToMove : sideToMove === RED ? BLACK : RED;
}

import {
  ADVISOR,
  BLACK,
  BLACK_BIT,
  CANNON,
  ELEPHANT,
  EMPTY,
  HORSE,
  KING,
  LETTER_TO_TYPE,
  PAWN,
  RED,
  ROOK,
  TYPE_TO_LETTER,
  type Color,
  type Move,
  encodeMove,
  moveFrom,
  moveTo,
  moveToUci,
  uciToMove,
} from './types.ts';
import { type Geometry, type VariantConfig, geometryOf } from './variant.ts';
import { generatePseudoLegal, isSquareAttacked } from './movegen.ts';

// ---------------------------------------------------------------------------
// Zobrist hashing — deterministic so client and server agree on position keys.
// Two 32-bit words are tracked to keep collisions negligible.
// ---------------------------------------------------------------------------

interface ZobristTable {
  lo: Int32Array;
  hi: Int32Array;
  sideLo: number;
  sideHi: number;
}

const zobristCache = new Map<number, ZobristTable>();

function zobristFor(squares: number): ZobristTable {
  const cached = zobristCache.get(squares);
  if (cached) return cached;

  // xorshift32 with a fixed seed: identical tables on every runtime.
  let state = 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state | 0;
  };

  const lo = new Int32Array(squares * 14);
  const hi = new Int32Array(squares * 14);
  for (let i = 0; i < lo.length; i++) {
    lo[i] = next();
    hi[i] = next();
  }
  const table: ZobristTable = { lo, hi, sideLo: next(), sideHi: next() };
  zobristCache.set(squares, table);
  return table;
}

/** Piece byte -> Zobrist slot. Red pieces take 0..6, Black pieces 7..13. */
const pieceSlot = (piece: number): number => (piece & BLACK_BIT ? 7 : 0) + (piece & 7);

interface Undo {
  move: Move;
  captured: number;
  halfmoveClock: number;
  fullmoveNumber: number;
  keyLo: number;
  keyHi: number;
  side: Color;
}

export type GameStatus =
  | { kind: 'playing'; check: boolean }
  | { kind: 'checkmate'; winner: Color }
  | { kind: 'stalemate'; winner: Color }
  | { kind: 'repetition'; winner: null }
  | { kind: 'no-capture'; winner: null };

export class Position {
  readonly config: VariantConfig;
  readonly geo: Geometry;
  readonly board: Uint8Array;
  readonly kingSq: Int8Array;
  sideToMove: Color = RED;
  halfmoveClock = 0;
  fullmoveNumber = 1;
  keyLo = 0;
  keyHi = 0;

  private readonly undoStack: Undo[] = [];
  private readonly repetition = new Map<string, number>();
  private readonly zobrist: ZobristTable;

  constructor(config: VariantConfig, fen?: string) {
    this.config = config;
    this.geo = geometryOf(config);
    this.board = new Uint8Array(this.geo.squares);
    this.kingSq = new Int8Array(2).fill(-1);
    this.zobrist = zobristFor(this.geo.squares);
    this.setFen(fen ?? config.startFen);
  }

  // -- FEN ----------------------------------------------------------------

  setFen(fen: string): void {
    const parts = fen.trim().split(/\s+/);
    this.board.fill(EMPTY);
    this.kingSq.fill(-1);

    let rank = 0;
    let file = 0;
    for (const ch of parts[0] ?? '') {
      if (ch === '/') {
        rank++;
        file = 0;
        continue;
      }
      if (ch >= '1' && ch <= '9') {
        file += Number(ch);
        continue;
      }
      const type = LETTER_TO_TYPE[ch.toLowerCase()];
      if (type === undefined) continue;
      const color: Color = ch === ch.toLowerCase() ? BLACK : RED;
      const sq = rank * this.geo.width + file;
      if (sq < 0 || sq >= this.geo.squares) continue;
      this.board[sq] = type | (color === BLACK ? BLACK_BIT : 0);
      if (type === KING) this.kingSq[color] = sq;
      file++;
    }

    this.sideToMove = parts[1] === 'b' ? BLACK : RED;
    this.halfmoveClock = Number(parts[4] ?? 0) || 0;
    this.fullmoveNumber = Number(parts[5] ?? 1) || 1;

    this.recomputeKey();
    this.undoStack.length = 0;
    this.repetition.clear();
    this.repetition.set(this.keyString(), 1);
  }

  fen(): string {
    const rows: string[] = [];
    for (let rank = 0; rank < this.geo.height; rank++) {
      let row = '';
      let empty = 0;
      for (let file = 0; file < this.geo.width; file++) {
        const piece = this.board[rank * this.geo.width + file];
        if (piece === EMPTY) {
          empty++;
          continue;
        }
        if (empty > 0) {
          row += String(empty);
          empty = 0;
        }
        const letter = TYPE_TO_LETTER[piece & 7];
        row += piece & BLACK_BIT ? letter : letter.toUpperCase();
      }
      if (empty > 0) row += String(empty);
      rows.push(row);
    }
    const side = this.sideToMove === RED ? 'w' : 'b';
    return `${rows.join('/')} ${side} - - ${this.halfmoveClock} ${this.fullmoveNumber}`;
  }

  // -- Position key -------------------------------------------------------

  private recomputeKey(): void {
    const z = this.zobrist;
    let lo = 0;
    let hi = 0;
    for (let sq = 0; sq < this.geo.squares; sq++) {
      const piece = this.board[sq];
      if (piece === EMPTY) continue;
      const idx = sq * 14 + pieceSlot(piece);
      lo ^= z.lo[idx];
      hi ^= z.hi[idx];
    }
    if (this.sideToMove === BLACK) {
      lo ^= z.sideLo;
      hi ^= z.sideHi;
    }
    this.keyLo = lo;
    this.keyHi = hi;
  }

  private keyString(): string {
    return `${this.keyLo >>> 0}:${this.keyHi >>> 0}`;
  }

  // -- Move generation ----------------------------------------------------

  pseudoLegalMoves(capturesOnly = false): Move[] {
    return generatePseudoLegal(this, capturesOnly);
  }

  legalMoves(): Move[] {
    const moves = this.pseudoLegalMoves();
    const legal: Move[] = [];
    for (const move of moves) {
      this.makeMove(move);
      const mover = this.sideToMove === RED ? BLACK : RED;
      if (!this.isInCheck(mover)) legal.push(move);
      this.unmakeMove();
    }
    return legal;
  }

  isLegal(move: Move): boolean {
    const from = moveFrom(move);
    const piece = this.board[from];
    if (piece === EMPTY || ((piece >> 3) & 1) !== this.sideToMove) return false;
    if (!this.pseudoLegalMoves().includes(move)) return false;
    this.makeMove(move);
    const mover = this.sideToMove === RED ? BLACK : RED;
    const safe = !this.isInCheck(mover);
    this.unmakeMove();
    return safe;
  }

  // -- Making moves -------------------------------------------------------

  makeMove(move: Move): boolean {
    const from = moveFrom(move);
    const to = moveTo(move);
    const piece = this.board[from];
    if (piece === EMPTY) return false;
    const captured = this.board[to];
    const z = this.zobrist;

    this.undoStack.push({
      move,
      captured,
      halfmoveClock: this.halfmoveClock,
      fullmoveNumber: this.fullmoveNumber,
      keyLo: this.keyLo,
      keyHi: this.keyHi,
      side: this.sideToMove,
    });

    this.keyLo ^= z.lo[from * 14 + pieceSlot(piece)];
    this.keyHi ^= z.hi[from * 14 + pieceSlot(piece)];
    if (captured !== EMPTY) {
      this.keyLo ^= z.lo[to * 14 + pieceSlot(captured)];
      this.keyHi ^= z.hi[to * 14 + pieceSlot(captured)];
    }
    this.board[from] = EMPTY;
    this.board[to] = piece;
    this.keyLo ^= z.lo[to * 14 + pieceSlot(piece)];
    this.keyHi ^= z.hi[to * 14 + pieceSlot(piece)];

    if ((piece & 7) === KING) {
      this.kingSq[piece & BLACK_BIT ? BLACK : RED] = to;
    }

    this.halfmoveClock = captured === EMPTY ? this.halfmoveClock + 1 : 0;
    if (this.sideToMove === BLACK) this.fullmoveNumber++;

    this.sideToMove = this.sideToMove === RED ? BLACK : RED;
    this.keyLo ^= z.sideLo;
    this.keyHi ^= z.sideHi;

    const key = this.keyString();
    this.repetition.set(key, (this.repetition.get(key) ?? 0) + 1);
    return true;
  }

  unmakeMove(): Move | null {
    const undo = this.undoStack.pop();
    if (!undo) return null;

    // Leave the repetition table before touching the key.
    const key = this.keyString();
    const count = this.repetition.get(key);
    if (count !== undefined) {
      if (count <= 1) this.repetition.delete(key);
      else this.repetition.set(key, count - 1);
    }

    const from = moveFrom(undo.move);
    const to = moveTo(undo.move);
    const piece = this.board[to];
    this.board[from] = piece;
    this.board[to] = undo.captured;

    if ((piece & 7) === KING) {
      this.kingSq[piece & BLACK_BIT ? BLACK : RED] = from;
    }

    this.sideToMove = undo.side;
    this.halfmoveClock = undo.halfmoveClock;
    this.fullmoveNumber = undo.fullmoveNumber;
    this.keyLo = undo.keyLo;
    this.keyHi = undo.keyHi;
    return undo.move;
  }

  /** How many times the current position (incl. side to move) has occurred. */
  currentRepetitionCount(): number {
    return this.repetition.get(this.keyString()) ?? 1;
  }

  // -- Attack / check -----------------------------------------------------

  isInCheck(color: Color): boolean {
    const king = this.kingSq[color];
    if (king < 0) return true;
    return isSquareAttacked(this, king, color === RED ? BLACK : RED);
  }

  isCheck(): boolean {
    return this.isInCheck(this.sideToMove);
  }

  // -- Game state ---------------------------------------------------------

  /**
   * Draw rules use a simplified convention: threefold repetition and 120
   * half-moves without a capture are draws. Strict Asian rules award a
   * perpetual-check win to the checked side; that needs move-history analysis
   * that this engine deliberately leaves to the rules layer above.
   */
  status(): GameStatus {
    const inCheck = this.isCheck();
    if (this.legalMoves().length === 0) {
      const winner: Color = this.sideToMove === RED ? BLACK : RED;
      return inCheck ? { kind: 'checkmate', winner } : { kind: 'stalemate', winner };
    }
    if (this.config.repetitionLimit > 0 && this.currentRepetitionCount() >= this.config.repetitionLimit) {
      return { kind: 'repetition', winner: null };
    }
    if (this.config.noCaptureLimit > 0 && this.halfmoveClock >= this.config.noCaptureLimit) {
      return { kind: 'no-capture', winner: null };
    }
    return { kind: 'playing', check: inCheck };
  }

  isGameOver(): boolean {
    return this.status().kind !== 'playing';
  }

  // -- UCI ----------------------------------------------------------------

  moveToUci(move: Move): string {
    return moveToUci(move, this.geo.width, this.geo.height);
  }

  findUciMove(uci: string): Move {
    const move = uciToMove(uci, this.geo.width, this.geo.height);
    if (move < 0) return -1;
    return this.isLegal(move) ? move : -1;
  }

  playUci(uci: string): boolean {
    const move = this.findUciMove(uci);
    return move >= 0 ? this.makeMove(move) : false;
  }

  clone(): Position {
    const copy = new Position(this.config, this.fen());
    copy.repetition.clear();
    for (const [key, value] of this.repetition) copy.repetition.set(key, value);
    return copy;
  }

  /** Piece at `sq`, or EMPTY. */
  pieceAt(sq: number): number {
    return this.board[sq] ?? EMPTY;
  }
}

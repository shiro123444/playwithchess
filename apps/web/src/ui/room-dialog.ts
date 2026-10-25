/**
 * The online room dialog.
 *
 * Two views share one card: an entry form (create a table or join one by
 * code) and a waiting view that shows the code and a painted bloom until the
 * second seat fills. The bloom is the point — "waiting" should look like
 * something growing, not like a spinner.
 *
 * The entry form also asks which side the player wants. The wish is sent with
 * the join and honoured only while that seat is free, so somebody who asked
 * for black an invitation too late still lands in the game instead of being
 * bounced — the waiting view then says which side they actually got.
 */

import type { PreferredSeat } from '../net/online.ts';

export interface RoomDialogHandlers {
  /** Create or join. `code` is what the user typed, `null` creates a table. */
  onEnter: (code: string | null, preferredSeat: PreferredSeat) => void;
  /** Leave the current room and close. */
  onLeave: () => void;
  onCancel: () => void;
  onCopy: (text: string) => void;
}

/** What the waiting view knows about the table right now. */
export interface SeatStatus {
  red: string | null;
  black: string | null;
  yourSeat: 'red' | 'black' | 'spectator';
  spectators: number;
}

const CODE_LENGTH = 4;
const CODE_PATTERN = /^[A-Z0-9]{4}$/;
const SEAT_KEY = 'xiangqi.seat';

const SEAT_CHOICES: ReadonlyArray<{ id: PreferredSeat; label: string; hint: string }> = [
  { id: 'random', label: '随机', hint: '哪个空位就坐哪边' },
  { id: 'red', label: '执红', hint: '先手' },
  { id: 'black', label: '执黑', hint: '后手' },
];

function readSeatPreference(): PreferredSeat {
  try {
    const stored = window.localStorage.getItem(SEAT_KEY);
    if (stored === 'red' || stored === 'black' || stored === 'random') return stored;
  } catch {
    // Storage can be blocked; the default still works.
  }
  return 'random';
}

function writeSeatPreference(seat: PreferredSeat): void {
  try { window.localStorage.setItem(SEAT_KEY, seat); } catch { /* non-fatal */ }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Six petals + a heart, drawn once and re-used by every waiting view. */
function createBloom(): HTMLElement {
  const NS = 'http://www.w3.org/2000/svg';
  const wrap = el('span', 'bloom');
  wrap.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  for (let i = 0; i < 6; i++) {
    const petal = document.createElementNS(NS, 'ellipse');
    petal.setAttribute('class', 'petal');
    petal.setAttribute('cx', '50');
    petal.setAttribute('cy', '34');
    petal.setAttribute('rx', '15');
    petal.setAttribute('ry', '24');
    petal.setAttribute('transform', `rotate(${i * 60} 50 50)`);
    petal.setAttribute('style', `--i:${i}`);
    svg.append(petal);
  }
  const heart = document.createElementNS(NS, 'circle');
  heart.setAttribute('class', 'heart');
  heart.setAttribute('cx', '50');
  heart.setAttribute('cy', '50');
  heart.setAttribute('r', '9');
  svg.append(heart);
  wrap.append(svg);
  return wrap;
}

export class RoomDialog {
  private readonly backdrop: HTMLElement;
  private readonly card: HTMLElement;
  private readonly entry: HTMLElement;
  private readonly waiting: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly entryStatus: HTMLElement;
  private readonly entryEnterButton: HTMLButtonElement;
  private readonly createButton: HTMLButtonElement;
  private readonly codeText: HTMLElement;
  private readonly waitingStatus: HTMLElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly seatButtons: Map<PreferredSeat, HTMLButtonElement>;
  private readonly seatCards: Map<'red' | 'black', { card: HTMLElement; name: HTMLElement; tag: HTMLElement }>;
  private readonly seatSummary: HTMLElement;
  private seat: PreferredSeat = 'random';
  private open = false;
  private busy = false;
  private lastFocus: HTMLElement | null = null;
  private code = '';
  /** Remembers the local player's seat so the roster can mark it. */
  private yourSeat: SeatStatus['yourSeat'] = 'spectator';

  constructor(container: HTMLElement, private readonly handlers: RoomDialogHandlers) {
    this.backdrop = el('div', 'room-backdrop');
    this.backdrop.hidden = true;
    this.backdrop.addEventListener('mousedown', (event) => {
      if (event.target === this.backdrop) this.close();
    });

    this.card = el('div', 'room-card');
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-labelledby', 'room-title');

    this.closeButton = el('button', 'room-close');
    this.closeButton.type = 'button';
    this.closeButton.setAttribute('aria-label', '关闭');
    this.closeButton.textContent = '✕';
    this.closeButton.addEventListener('click', () => this.close());

    // --- Entry view -----------------------------------------------------
    this.entry = el('div', 'room-entry');
    const title = el('h2', 'room-title', '联机');
    title.id = 'room-title';

    this.input = el('input', 'room-input');
    this.input.type = 'text';
    this.input.inputMode = 'text';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.maxLength = CODE_LENGTH;
    this.input.placeholder = '房间号';
    this.input.setAttribute('aria-label', '房间号');
    this.input.addEventListener('input', () => {
      this.input.value = this.input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
      this.refreshEntry();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.submit();
    });

    const field = el('div', 'room-field');
    field.append(this.input);

    // --- Side picker ----------------------------------------------------
    // Same segmented idiom as the mode switch, so the two choices read as
    // one family of controls rather than a form bolted onto the card.
    const seatGroup = el('div', 'seat-picker');
    seatGroup.setAttribute('role', 'group');
    seatGroup.setAttribute('aria-label', '执子');
    this.seatButtons = new Map();
    for (const choice of SEAT_CHOICES) {
      const button = el('button', 'seat-choice');
      button.type = 'button';
      button.dataset.seat = choice.id;
      button.title = choice.hint;
      button.append(el('span', 'seat-choice-dot'), el('span', 'seat-choice-label', choice.label));
      button.addEventListener('click', () => this.chooseSeat(choice.id));
      seatGroup.append(button);
      this.seatButtons.set(choice.id, button);
    }
    const seatLabel = el('p', 'room-hint room-hint-seat', '空位先到先得，另一边会为你留位');
    this.chooseSeat(readSeatPreference());

    const actions = el('div', 'room-actions');
    this.entryEnterButton = el('button', 'primary-button', '进入');
    this.entryEnterButton.type = 'button';
    this.entryEnterButton.addEventListener('click', () => this.submit());
    const create = el('button', 'ghost-button', '新房间');
    this.createButton = create;
    create.type = 'button';
    create.addEventListener('click', () => this.enter(null));
    actions.append(this.entryEnterButton, create);

    this.entryStatus = el('p', 'room-status');
    this.entryStatus.setAttribute('role', 'status');

    this.entry.append(title, field, seatGroup, seatLabel, actions, this.entryStatus);

    // --- Waiting view ---------------------------------------------------
    this.waiting = el('div', 'room-waiting');
    this.waiting.hidden = true;
    const waitingTitle = el('h2', 'room-title', '等待对手');
    waitingTitle.id = 'room-title-waiting';
    this.codeText = el('div', 'room-code', '—');
    const codeLabel = el('p', 'room-code-label', '房间号');
    this.waitingStatus = el('p', 'room-status');
    this.waitingStatus.setAttribute('role', 'status');

    const waitingRow = el('div', 'room-waiting-row');
    this.copyButton = el('button', 'ghost-button', '复制邀请');
    this.copyButton.type = 'button';
    this.copyButton.addEventListener('click', () => {
      const link = this.inviteLink();
      this.handlers.onCopy(link);
    });
    this.leaveButton = el('button', 'ghost-button', '离开');
    this.leaveButton.type = 'button';
    this.leaveButton.addEventListener('click', () => {
      this.hide();
      this.handlers.onLeave();
    });
    waitingRow.append(this.copyButton, this.leaveButton);

    // --- Seat roster ----------------------------------------------------
    // Two seats side by side, each showing who holds it. This is the part the
    // waiting view was missing: before, the only way to learn which side you
    // were given was to start playing.
    const roster = el('div', 'seat-roster');
    this.seatCards = new Map();
    for (const side of ['red', 'black'] as const) {
      const card = el('div', 'seat-card');
      card.dataset.side = side;
      const dot = el('span', 'seat-card-dot');
      const name = el('span', 'seat-card-name', '空位');
      const tag = el('span', 'seat-card-tag');
      card.append(dot, name, tag);
      roster.append(card);
      this.seatCards.set(side, { card, name, tag });
    }
    this.seatSummary = el('p', 'room-hint seat-summary');

    this.waiting.append(createBloom(), waitingTitle, this.codeText, codeLabel, roster, this.seatSummary, waitingRow, this.waitingStatus);

    this.card.append(this.closeButton, this.entry, this.waiting);
    this.backdrop.append(this.card);
    container.append(this.backdrop);

    this.backdrop.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.close();
      } else if (event.key === 'Tab') {
        const focusable = [...this.card.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')]
          .filter((node) => node.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Open on the entry form. */
  showEntry(message = '', code = ''): void {
    this.code = '';
    this.input.value = code;
    this.busy = false;
    this.showView('entry');
    this.setEntryStatus(message, 'idle');
    this.refreshEntry();
    this.openDialog();
    // A keyboard user typing a code should land in the field, not on the ✕.
    this.input.focus();
    this.input.select();
  }

  showConnecting(code: string): void {
    this.showEntry('', code);
    this.busy = true;
    this.refreshEntry();
    this.setEntryStatus('正在恢复棋局…', 'idle');
  }

  /** Open on the waiting view for `code`. */
  showWaiting(code: string, waiting: boolean, status = '', seats?: SeatStatus): void {
    this.code = code;
    this.busy = false;
    this.showView('waiting');
    this.codeText.textContent = code || '—';
    // Never carry the previous table's roster into a new one.
    this.setSeats(seats ?? { red: null, black: null, yourSeat: 'spectator', spectators: 0 });
    this.setWaitingStatus(status || (waiting ? '等待对手加入' : '对手已就位'), waiting);
    this.openDialog();
  }

  /** Update the live state of an already-open waiting view. */
  updateWaiting(waiting: boolean, status: string, seats?: SeatStatus): void {
    if (!this.open) return;
    this.setWaitingStatus(status, waiting);
    if (seats) this.setSeats(seats);
  }

  /**
   * Reflect who holds each seat, and which one is yours.
   *
   * The roster is the answer to "did I get the colour I asked for?" — a
   * requested side is only a wish, so the dialog has to show the outcome
   * rather than repeat the wish back.
   */
  setSeats(seats: SeatStatus): void {
    this.yourSeat = seats.yourSeat;
    for (const side of ['red', 'black'] as const) {
      const card = this.seatCards.get(side);
      if (!card) continue;
      const name = seats[side];
      card.name.textContent = name ?? '空位';
      const mine = seats.yourSeat === side;
      card.card.classList.toggle('is-empty', !name);
      card.card.classList.toggle('is-you', mine);
      card.tag.textContent = mine ? '你' : name ? '已就座' : '等待';
    }
    this.waiting.dataset.you = seats.yourSeat;
    const spectators = seats.spectators > 0 ? ` · ${seats.spectators} 人观战` : '';
    this.seatSummary.textContent = seats.yourSeat === 'spectator'
      ? `观战中${spectators}` : `你执${seats.yourSeat === 'red' ? '红' : '黑'}${spectators}`;
  }

  /** Show a failure on the entry view without closing the dialog. */
  fail(message: string): void {
    this.busy = false;
    this.refreshEntry();
    this.showView('entry');
    this.setEntryStatus(message, 'error');
    this.input.focus();
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.backdrop.hidden = true;
    this.lastFocus?.focus();
    this.lastFocus = null;
  }

  /** Backdrop click and Esc both land here. */
  private close(): void {
    this.hide();
    if (this.busy) {
      this.busy = false;
      this.handlers.onCancel();
    }
  }

  private showView(view: 'entry' | 'waiting'): void {
    const waiting = view === 'waiting';
    this.entry.hidden = waiting;
    this.waiting.hidden = !waiting;
    // Only one heading can carry the dialog name at a time.
    this.card.setAttribute(
      'aria-labelledby',
      waiting ? 'room-title-waiting' : 'room-title',
    );
    // Leaving the room is only meaningful from the waiting view.
    this.closeButton.hidden = false;
  }

  private openDialog(): void {
    if (!this.open) {
      this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.open = true;
      this.backdrop.hidden = false;
    }
    this.closeButton.focus({ preventScroll: true });
  }

  private submit(): void {
    const value = this.input.value.trim().toUpperCase();
    if (value.length !== CODE_LENGTH || !CODE_PATTERN.test(value)) {
      this.setEntryStatus('四位房间号', 'error');
      this.input.focus();
      return;
    }
    this.enter(value);
  }

  private enter(code: string | null): void {
    if (this.busy) return;
    this.busy = true;
    writeSeatPreference(this.seat);
    this.refreshEntry();
    this.setEntryStatus(code ? '正在进入…' : '正在创建…', 'idle');
    this.handlers.onEnter(code, this.seat);
  }

  private chooseSeat(seat: PreferredSeat): void {
    this.seat = seat;
    for (const [id, button] of this.seatButtons) {
      button.classList.toggle('is-active', id === seat);
      button.setAttribute('aria-pressed', String(id === seat));
    }
  }

  private refreshEntry(): void {
    const filled = this.input.value.trim().length === CODE_LENGTH;
    this.entryEnterButton.disabled = !filled || this.busy;
    this.createButton.disabled = this.busy;
    this.input.disabled = this.busy;
  }

  private setEntryStatus(text: string, tone: 'idle' | 'error'): void {
    this.entryStatus.textContent = text;
    this.entryStatus.dataset.tone = tone;
  }

  private setWaitingStatus(text: string, waiting: boolean): void {
    this.waitingStatus.textContent = text;
    this.waitingStatus.dataset.tone = 'idle';
    this.waiting.classList.toggle('is-waiting', waiting);
    const heading = this.waiting.querySelector('h2');
    if (heading) heading.textContent = waiting ? '等待对手' : '已就位';
    this.copyButton.disabled = !this.code;
  }

  private inviteLink(): string {
    if (typeof window === 'undefined') return this.code;
    const url = new URL(window.location.href);
    url.searchParams.set('room', this.code);
    return url.toString();
  }
}

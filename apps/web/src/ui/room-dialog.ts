/**
 * The online room dialog.
 *
 * Two views share one card: an entry form (create a table or join one by
 * code) and a waiting view that shows the code and a painted bloom until the
 * second seat fills. The bloom is the point — "waiting" should look like
 * something growing, not like a spinner.
 */

export interface RoomDialogHandlers {
  /** Create a fresh room. `code` is what the user typed, if anything. */
  onEnter: (code: string | null) => void;
  /** Leave the current room and close. */
  onLeave: () => void;
  onCancel: () => void;
  onCopy: (text: string) => void;
}

const CODE_LENGTH = 4;
const CODE_PATTERN = /^[A-Z0-9]{4}$/;

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
  private open = false;
  private busy = false;
  private lastFocus: HTMLElement | null = null;
  private code = '';

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

    this.entry.append(title, field, actions, this.entryStatus);

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

    this.waiting.append(createBloom(), waitingTitle, this.codeText, codeLabel, waitingRow, this.waitingStatus);

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
  showWaiting(code: string, waiting: boolean, status = ''): void {
    this.code = code;
    this.busy = false;
    this.showView('waiting');
    this.codeText.textContent = code || '—';
    this.setWaitingStatus(status || (waiting ? '等待对手加入' : '对手已就位'), waiting);
    this.openDialog();
  }

  /** Update the live state of an already-open waiting view. */
  updateWaiting(waiting: boolean, status: string): void {
    if (!this.open) return;
    this.setWaitingStatus(status, waiting);
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
    this.refreshEntry();
    this.setEntryStatus(code ? '正在进入…' : '正在创建…', 'idle');
    this.handlers.onEnter(code);
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

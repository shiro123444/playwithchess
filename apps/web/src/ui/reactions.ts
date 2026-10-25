import { REACTIONS } from '@xiangqi/rules';

/**
 * The reaction tray: one small button in the top bar, and a fan of 3D stickers
 * that opens above it.
 *
 * The stickers are the Fluent Emoji 3D renders, drawn at their natural size
 * rather than as text glyphs — a phone shows the same painted figures a desktop
 * does, instead of whichever emoji font the OS happens to ship. The tray closes
 * itself on pick, on Escape, on a click elsewhere, and when the board takes a
 * pointer, so it never sits between the player and their own move.
 */

export interface ReactionTrayHandlers {
  /** Called with a reaction id after the tray has closed. */
  onPick: (id: string) => void;
  /** Called whenever the tray opens, so the shell can unlock audio first. */
  onOpen?: () => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export class ReactionTray {
  private readonly wrap: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly stickers: HTMLButtonElement[] = [];
  private open = false;

  constructor(container: HTMLElement, private readonly handlers: ReactionTrayHandlers) {
    this.wrap = el('div', 'reaction-tray');
    this.button = el('button', 'ghost-button reaction-toggle');
    this.button.type = 'button';
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.setAttribute('aria-expanded', 'false');
    const icon = el('img', 'reaction-icon');
    icon.src = `${import.meta.env.BASE_URL}emoji/joy.png`;
    icon.alt = '';
    icon.draggable = false;
    this.button.append(icon, el('span', 'reaction-label', '表情'));
    this.button.addEventListener('click', event => {
      event.stopPropagation();
      this.toggle();
    });

    this.panel = el('div', 'reaction-panel');
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', '发送表情');
    this.panel.tabIndex = -1;
    const grid = el('div', 'reaction-grid');
    for (const reaction of REACTIONS) {
      const sticker = el('button', 'reaction-sticker');
      sticker.type = 'button';
      sticker.dataset.reaction = reaction.id;
      sticker.setAttribute('aria-label', reaction.label);
      sticker.title = reaction.label;
      const art = el('img');
      art.src = `${import.meta.env.BASE_URL}emoji/${reaction.id}.png`;
      art.alt = '';
      art.decoding = 'async';
      art.draggable = false;
      sticker.append(art);
      sticker.addEventListener('click', event => {
        event.stopPropagation();
        this.close();
        this.handlers.onPick(reaction.id);
      });
      grid.append(sticker);
      this.stickers.push(sticker);
    }
    this.panel.append(grid);
    this.wrap.append(this.button, this.panel);
    container.append(this.wrap);

    // A pointer outside the tray dismisses it. Capture-phase on the document
    // so the canvas sees its own pointerdown first and a click on a piece is
    // never swallowed by the backdrop.
    document.addEventListener('pointerdown', this.onDocumentPointer, true);
    this.panel.addEventListener('keydown', this.onKeyDown);
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.panel.classList.add('is-open');
    this.button.setAttribute('aria-expanded', 'true');
    // Stickers cascade in, so the tray reads as a dealt hand rather than a
    // menu appearing at once.
    this.stickers.forEach((sticker, index) => {
      sticker.style.setProperty('--i', String(index));
    });
    this.handlers.onOpen?.();
    this.panel.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.panel.classList.remove('is-open');
    this.button.setAttribute('aria-expanded', 'false');
  }

  dispose(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointer, true);
    this.panel.removeEventListener('keydown', this.onKeyDown);
    this.wrap.remove();
  }

  private onDocumentPointer = (event: PointerEvent): void => {
    if (!this.open) return;
    if (event.target instanceof Node && this.wrap.contains(event.target)) return;
    this.close();
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      this.button.focus({ preventScroll: true });
      return;
    }
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' &&
        event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const active = document.activeElement;
    const index = this.stickers.findIndex(sticker => sticker === active);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = (index + step + this.stickers.length) % this.stickers.length;
    this.stickers[next]!.focus();
  };
}

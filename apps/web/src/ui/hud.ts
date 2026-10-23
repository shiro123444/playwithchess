import type { GameStatusSnapshot } from '../game/game.ts';
import { RED, type Color } from '@xiangqi/rules';

/**
 * The HUD is plain DOM layered over the canvas. Keeping it out of WebGL means
 * crisp CJK type, real focus rings, and text that stays readable at any DPI.
 */

export interface HudHandlers {
  onUndo: () => void;
  onRestart: () => void;
  onFlip: () => void;
  onModeChange: (mode: 'local' | 'online') => void;
  onOpenRoom: () => void;
  /** Returns the state the switch should now show. */
  onToggleSound: () => boolean;
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

const EMPTY_MOVE_TEXT = '—';
const NOTICE_MS = 5200;

export class Hud {
  private readonly root: HTMLElement;
  private readonly turnPill: HTMLElement;
  private readonly turnText: HTMLElement;
  private readonly moveText: HTMLElement;
  private readonly movesValue: HTMLElement;
  private readonly undoButton: HTMLButtonElement;
  private readonly restartButton: HTMLButtonElement;
  private readonly resultBanner: HTMLElement;
  private readonly resultTitle: HTMLElement;
  private readonly resultSub: HTMLElement;
  private readonly netPill: HTMLElement;
  private readonly connectRow: HTMLElement;
  private readonly roomChip: HTMLButtonElement;
  private readonly roomCodeText: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly modeButtons: Map<string, HTMLButtonElement> = new Map();
  private readonly soundButton: HTMLButtonElement;
  private readonly soundIcon: HTMLElement;
  private readonly soundLabel: HTMLElement;
  private noticeTimer: number | null = null;

  constructor(container: HTMLElement, private readonly handlers: HudHandlers) {
    this.root = el('div', 'hud-layer');
    container.append(this.root);

    // --- Top bar: title, mode switch, room, sound, camera ---------------
    const top = el('header', 'hud-top');
    const brand = el('div', 'brand');
    brand.append(el('h1', 'brand-title', '弈'));

    const controls = el('div', 'hud-controls');

    const modeSwitch = el('div', 'segmented');
    modeSwitch.setAttribute('role', 'group');
    modeSwitch.setAttribute('aria-label', '对局模式');
    const modes: Array<{ id: 'local' | 'online'; label: string }> = [
      { id: 'local', label: '双人' },
      { id: 'online', label: '联机' },
    ];
    for (const mode of modes) {
      const button = el('button', 'seg-button', mode.label);
      button.type = 'button';
      button.dataset.mode = mode.id;
      button.addEventListener('click', () => this.handlers.onModeChange(mode.id));
      modeSwitch.append(button);
      this.modeButtons.set(mode.id, button);
    }

    // The room chip is the only persistent trace of the online session; it
    // reopens the dialog so the code stays reachable mid-game.
    this.roomChip = el('button', 'chip room-chip');
    this.roomChip.type = 'button';
    this.roomChip.hidden = true;
    this.roomChip.setAttribute('aria-label', '打开房间');
    const dot = el('span', 'room-chip-dot');
    this.roomCodeText = el('span', 'room-code', '');
    this.roomChip.append(dot, this.roomCodeText);
    this.roomChip.addEventListener('click', () => this.handlers.onOpenRoom());

    // Sound is a state, not an action, so it is a toggle button rather than a
    // ghost button: `aria-pressed` carries the on/off for both sighted and
    // screen-reader users.
    const sound = el('button', 'ghost-button sound-toggle');
    sound.type = 'button';
    sound.dataset.role = 'sound-toggle';
    this.soundIcon = el('span', 'sound-icon', '♪');
    this.soundLabel = el('span', 'sound-label', '音效');
    sound.append(this.soundIcon, this.soundLabel);
    sound.addEventListener('click', () => this.setSound(this.handlers.onToggleSound()));
    this.soundButton = sound;

    const flip = el('button', 'ghost-button', '翻转');
    flip.type = 'button';
    flip.addEventListener('click', () => this.handlers.onFlip());

    controls.append(modeSwitch, this.roomChip, sound, flip);
    top.append(brand, controls);
    this.root.append(top);

    // --- Side panel -----------------------------------------------------
    const panel = el('aside', 'hud-panel');
    this.turnPill = el('div', 'turn-pill');
    const pillDot = el('span', 'turn-dot');
    this.turnText = el('span', 'turn-label', '红方行棋');
    this.turnPill.append(pillDot, this.turnText);

    this.connectRow = el('div', 'meta-row connect-row');
    this.connectRow.append(el('span', 'meta-label', '连接'));
    this.netPill = el('span', 'meta-value net-pill', '离线');
    this.connectRow.append(this.netPill);
    this.connectRow.hidden = true;

    const lastMoveRow = el('div', 'meta-row');
    lastMoveRow.append(el('span', 'meta-label', '上一手'));
    this.moveText = el('span', 'meta-value', EMPTY_MOVE_TEXT);
    lastMoveRow.append(this.moveText);

    const movesRow = el('div', 'meta-row');
    movesRow.append(el('span', 'meta-label', '回合'));
    this.movesValue = el('span', 'meta-value', '1');
    movesRow.append(this.movesValue);

    const actions = el('div', 'hud-actions');
    this.undoButton = el('button', 'ghost-button', '悔棋');
    this.undoButton.type = 'button';
    this.undoButton.addEventListener('click', () => this.handlers.onUndo());
    const restart = el('button', 'ghost-button', '重启');
    this.restartButton = restart;
    restart.type = 'button';
    restart.addEventListener('click', () => this.handlers.onRestart());
    actions.append(this.undoButton, restart);

    this.notice = el('p', 'notice');
    this.notice.setAttribute('role', 'status');
    this.notice.hidden = true;

    panel.append(this.turnPill, this.connectRow, lastMoveRow, movesRow, actions, this.notice);
    this.root.append(panel);

    // --- Result banner --------------------------------------------------
    this.resultBanner = el('div', 'result-banner');
    this.resultBanner.hidden = true;
    this.resultTitle = el('h2', 'result-title', '');
    this.resultSub = el('p', 'result-sub', '');
    const resultActions = el('div', 'result-actions');
    const again = el('button', 'primary-button', '再来一局');
    again.type = 'button';
    again.addEventListener('click', () => this.handlers.onRestart());
    resultActions.append(again);
    this.resultBanner.append(this.resultTitle, this.resultSub, resultActions);
    this.root.append(this.resultBanner);
  }

  setMode(mode: 'local' | 'online'): void {
    this.restartButton.textContent = mode === 'online' ? '再来一局' : '重启';
    for (const [id, button] of this.modeButtons) {
      button.classList.toggle('is-active', id === mode);
      button.setAttribute('aria-pressed', String(id === mode));
    }
    this.connectRow.hidden = mode !== 'online';
    this.undoButton.disabled = mode === 'online';
    if (mode === 'local') this.setRoom(null);
  }

  /**
   * Reflect the audio preference on the toggle. The label text itself carries
   * the state ("音效" / "静音"), so the accessible name matches what is on
   * screen without a separate aria-label fighting the visible text.
   */
  setSound(enabled: boolean): void {
    this.soundButton.classList.toggle('is-off', !enabled);
    this.soundButton.setAttribute('aria-pressed', String(enabled));
    this.soundButton.title = enabled ? '关闭音效' : '开启音效';
    this.soundIcon.textContent = enabled ? '♪' : '✕';
    this.soundLabel.textContent = enabled ? '音效' : '静音';
  }

  setConnection(text: string, tone: 'idle' | 'ok' | 'error'): void {
    this.netPill.textContent = text;
    this.netPill.dataset.tone = tone;
  }

  /** Show the room code chip, or hide it with `null`. */
  setRoom(code: string | null): void {
    this.roomChip.hidden = code === null;
    this.roomCodeText.textContent = code ?? '';
    if (code === null) this.roomChip.classList.remove('is-waiting');
  }

  /** Mark the room as waiting on a second seat, which pulses the chip dot. */
  setRoomWaiting(waiting: boolean): void {
    this.roomChip.classList.toggle('is-waiting', waiting);
  }

  /** A short-lived line for in-game events (joins, rematch votes). */
  setNotice(text: string, tone: 'info' | 'error' = 'info'): void {
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.notice.textContent = text;
    this.notice.dataset.tone = tone;
    this.notice.hidden = false;
    this.noticeTimer = window.setTimeout(() => {
      this.notice.hidden = true;
      this.noticeTimer = null;
    }, NOTICE_MS);
  }

  update(snapshot: GameStatusSnapshot): void {
    this.updateTurn(snapshot.sideToMove, snapshot);
    this.movesValue.textContent = String(Math.floor(snapshot.moveCount / 2) + 1);
    this.undoButton.disabled = !snapshot.canUndo || snapshot.mode === 'online';
    // A fresh game has no last move; keep the row from showing whatever the
    // previous game ended on.
    this.moveText.textContent = snapshot.lastMove?.text || EMPTY_MOVE_TEXT;

    const { status } = snapshot;
    this.restartButton.disabled = snapshot.mode === 'online' &&
      (status.kind === 'playing' || snapshot.onlineSide === null || !snapshot.connected);
    this.resultBanner.hidden = status.kind === 'playing';
    if (status.kind === 'checkmate') {
      const winner = status.winner === RED ? '红方' : '黑方';
      this.showResult(`${winner}胜`, '绝杀');
    } else if (status.kind === 'stalemate') {
      const winner = status.winner === RED ? '红方' : '黑方';
      this.showResult(`${winner}胜`, '困毙');
    } else if (status.kind === 'repetition') {
      this.showResult('和棋', '三次重复');
    } else if (status.kind === 'no-capture') {
      this.showResult('和棋', '久无吃子');
    }

    if (snapshot.mode === 'online') {
      this.connectRow.hidden = false;
      if (!snapshot.connected) this.setConnection('重连中', 'error');
      else if (snapshot.onlineSide === null) this.setConnection('观战', 'idle');
      else this.setConnection(snapshot.onlineSide === RED ? '执红' : '执黑', 'ok');
    } else {
      this.connectRow.hidden = true;
    }
  }

  private updateTurn(sideToMove: Color, snapshot: GameStatusSnapshot): void {
    const red = sideToMove === RED;
    this.turnPill.dataset.side = red ? 'red' : 'black';
    let label = red ? '红方行棋' : '黑方行棋';
    if (snapshot.mode === 'online' && snapshot.onlineSide !== null) {
      label += snapshot.onlineSide === sideToMove ? ' · 你' : ' · 对手';
    }
    this.turnText.textContent = label;
  }

  private showResult(title: string, subtitle: string): void {
    this.resultTitle.textContent = title;
    this.resultSub.textContent = subtitle;
  }

  dispose(): void {
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.root.remove();
  }
}

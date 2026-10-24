import type { ArchiveEntry } from '../storage/archive.ts';
import type { ViewPreset } from '../game/game.ts';
import type { GameResult } from '@xiangqi/rules';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; el.textContent = text; return el;
}
function button(text: string, action: () => void, primary = false): HTMLButtonElement {
  const el = node('button', primary ? 'primary-button' : 'ghost-button', text);
  el.type = 'button'; el.addEventListener('click', action); return el;
}
export function resultLabel(result: GameResult | null): string {
  if (!result) return '未完成';
  if (result.winner === null) return '和棋';
  return `${result.winner === 0 ? '红方' : '黑方'}胜`;
}

/** Native dialogs keep focus and background input isolated on phones too. */
export class LibraryDialog {
  private readonly dialog = node('dialog', 'library-dialog');
  private undoOpen = false;
  private cancelAction: (() => void) | null = null;
  constructor(container: HTMLElement) {
    container.append(this.dialog);
    this.dialog.addEventListener('cancel', () => { this.cancelAction?.(); this.cancelAction = null; });
    this.dialog.addEventListener('click', event => {
      if (event.target !== this.dialog) return;
      const rect = this.dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) this.close();
    });
  }
  dismissUndo(): void { if (this.undoOpen) { this.cancelAction = null; this.close(); } }
  close(): void {
    this.undoOpen = false;
    const cancel = this.cancelAction;
    this.cancelAction = null;
    this.dialog.close();
    cancel?.();
  }
  private open(title: string): HTMLElement {
    this.cancelAction = null;
    this.undoOpen = false;
    this.dialog.replaceChildren();
    const head = node('div', 'library-head');
    const heading = node('h2', '', title); heading.id = 'library-title';
    this.dialog.setAttribute('aria-labelledby', heading.id);
    head.append(heading, button('关闭', () => this.close()));
    this.dialog.append(head);
    if (!this.dialog.open) this.dialog.showModal();
    return this.dialog;
  }
  history(entries: ArchiveEntry[], resume: (entry: ArchiveEntry) => void, review: (entry: ArchiveEntry) => void): void {
    const host = this.open('棋局记录');
    if (!entries.length) host.append(node('p', 'library-empty', '还没有棋局'));
    for (const completed of [false, true]) {
      const group = entries.filter(entry => !!entry.record.result === completed);
      if (!group.length) continue;
      host.append(node('h3', 'library-section', completed ? '已结束' : '未完成'));
      for (const entry of group) {
        const card = node('article', 'game-card');
        card.dataset.gameId = entry.record.id;
        const title = node('div', 'game-card-title');
        title.append(node('strong', '', entry.mode === 'online' ? `联机 · ${entry.roomCode ?? '—'}` : '本机双人'),
          node('span', entry.record.result ? 'record-result' : 'record-pending', resultLabel(entry.record.result)));
        const date = new Date(entry.record.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        card.append(title, node('p', 'game-card-meta', `${date} · ${entry.record.moves.length} 手${entry.seat === 'spectator' ? ' · 观战' : entry.seat ? ` · 执${entry.seat === 'red' ? '红' : '黑'}` : ''}`));
        const actions = node('div', 'game-card-actions');
        if (!entry.record.result) actions.append(button(entry.seat === 'spectator' ? '继续观战' : '继续对局', () => { this.close(); resume(entry); }, true));
        actions.append(button('复盘', () => { this.close(); review(entry); }));
        card.append(actions);
        if (entry.record.moves.length) {
          const details = node('details', 'record-moves');
          details.append(node('summary', '', '查看棋谱'));
          const list = node('ol');
          for (const move of entry.record.moves) list.append(node('li', '', move.notation));
          details.append(list); card.append(details);
        }
        host.append(card);
      }
    }
  }
  views(preset: ViewPreset, change: (preset: ViewPreset) => void, flip: () => void): void {
    const host = this.open('棋盘视角');
    const grid = node('div', 'view-presets');
    for (const [id, label, angle] of [
      ['auto', '自适应', '随屏幕调整'], ['overhead', '俯视', '平铺看全局'],
      ['angled', '斜俯', '58°'], ['low', '低角度', '25°'],
    ] as const) {
      const item = button('', () => { change(id); this.close(); });
      item.classList.add('view-preset'); item.dataset.preset = id;
      item.setAttribute('aria-pressed', String(id === preset));
      item.append(node('span', `view-preview view-${id}`), node('strong', '', label), node('small', '', angle));
      grid.append(item);
    }
    host.append(grid, button('翻转红黑视角', () => { flip(); this.close(); }));
  }
  undo(answer: (accept: boolean) => void): void {
    const host = this.open('对手请求悔棋');
    this.undoOpen = true;
    const actions = node('div', 'game-card-actions');
    const respond = (accept: boolean) => { this.cancelAction = null; this.close(); answer(accept); };
    actions.append(button('拒绝', () => respond(false)), button('同意悔棋', () => respond(true), true));
    host.append(actions);
    this.cancelAction = () => answer(false);
  }
}

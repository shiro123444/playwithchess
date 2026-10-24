import './styles/global.css';
import { BLACK, RED, type GameRecord } from '@xiangqi/rules';
import { createGame, type GameCue, type ViewPreset } from './game/game.ts';
import { SoundBoard } from './audio/sound.ts';
import { Hud } from './ui/hud.ts';
import { RoomDialog } from './ui/room-dialog.ts';
import { LibraryDialog } from './ui/library.ts';
import { GameArchive, type ArchiveEntry } from './storage/archive.ts';
import type { OnlineSession, RoomState } from './net/online.ts';

type Mode = 'local' | 'online' | 'review';
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const hudHost = document.querySelector<HTMLElement>('#hud')!;
const overlayHost = document.querySelector<HTMLElement>('#overlay')!;
const game = createGame({ canvas });
const sound = new SoundBoard();
canvas.addEventListener('pointerdown', () => sound.unlock(), { capture: true });
const archive = new GameArchive({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) });
const library = new LibraryDialog(overlayHost);
let mode: Mode = 'local';
let online: OnlineSession | null = null;
let seat: 'red' | 'black' | 'spectator' | null = null;
let identity: { code: string; gameId: string; seat: 'red' | 'black' | 'spectator'; resumeToken: string | null } | null = null;
let lastState: RoomState | null = null;
let onlineRecord: GameRecord | null = null;
let localRecord = game.getRecord();
let reviewEntry: ArchiveEntry | null = null;
let reviewPly = 0;
let closeTimer: number | null = null;
let joinAttempt = 0;
let connecting = false;
let storageWarningShown = false;
let preset: ViewPreset = 'auto';
try {
  const stored = localStorage.getItem('xiangqi.view');
  if (['auto', 'overhead', 'angled', 'low'].includes(stored ?? '')) preset = stored as ViewPreset;
} catch { /* View changes still work when browser storage is blocked. */ }

function save(entry: ArchiveEntry): void {
  if (!archive.save(entry) && !storageWarningShown) {
    storageWarningShown = true;
    hud.setNotice('存档保存失败，浏览器存储已满或不可用', 'error');
  }
}
function saveOnline(): void {
  if (!onlineRecord) return;
  const entry: ArchiveEntry = { record: onlineRecord, mode: 'online', roomCode: lastState?.code ?? identity?.code ?? online?.roomId ?? undefined };
  if (identity?.gameId === onlineRecord.id) {
    entry.seat = identity.seat;
    if (identity.resumeToken) entry.resumeToken = identity.resumeToken;
  }
  save(entry);
}
const hud = new Hud(hudHost, {
  onUndo: () => {
    sound.play('click');
    if (mode === 'review') stepReview(-1);
    else if (mode === 'online') online?.requestUndo();
    else if (game.undo()) hud.setNotice('已撤回上一手');
  },
  onRestart: () => {
    sound.play('click');
    if (mode === 'review') return exitReview();
    if (mode === 'online') { online?.requestRematch(); hud.setNotice('已请求再来一局'); }
    else game.restart();
  },
  onFlip: () => {
    roomDialog.hide();
    library.views(preset, next => {
      preset = next; game.setViewPreset(next);
      try { localStorage.setItem('xiangqi.view', next); } catch { /* optional preference */ }
    }, () => game.flipCamera());
  },
  onHistory: () => { sound.unlock(); roomDialog.hide(); library.history(archive.entries(), resume, review); },
  onReviewNext: () => stepReview(1),
  onModeChange: next => { sound.play('click'); if (next === 'online') openRoom(); else goLocal(); },
  onOpenRoom: () => openRoom(),
  onToggleSound: () => { const enabled = sound.toggle(); if (enabled) sound.play('click'); return enabled; },
});
const roomDialog = new RoomDialog(overlayHost, {
  onEnter: code => void enterRoom(code), onLeave: () => goLocal(), onCancel: () => goLocal(),
  onCopy: async text => {
    try { await navigator.clipboard.writeText(text); hud.setNotice('邀请已复制'); }
    catch { hud.setNotice('复制失败', 'error'); }
  },
});
hud.setSound(sound.isEnabled);
function openRoom(): void {
  if (connecting) return;
  if (online?.isConnected()) roomDialog.showWaiting(online.roomId ?? '', lastState?.waiting ?? true, seatText());
  else roomDialog.showEntry();
}
async function enterRoom(code: string | null, resumeToken?: string): Promise<void> {
  if (connecting) return;
  const previous = online; online = null; previous?.leave();
  connecting = true;
  const attempt = ++joinAttempt;
  seat = null; identity = null; onlineRecord = null; lastState = null;
  try {
    const { OnlineSession } = await import('./net/online.ts');
    if (attempt !== joinAttempt) return;
    const session = new OnlineSession({
      onStatus: (text, tone) => { if (online === session) hud.setConnection(text, tone); },
      onRoom: state => { if (online === session) onRoomState(state); },
      onNotice: text => { if (online === session) hud.setNotice(text); },
      onRecord: record => {
        if (online !== session) return;
        const animate = onlineRecord?.id === record.id;
        onlineRecord = record;
        saveOnline();
        if (mode === 'online') game.loadRecord(record, animate);
      },
      onIdentity: next => {
        if (online === session) {
          identity = next;
          if (onlineRecord?.id === next.gameId) saveOnline();
        }
      },
      onUndo: request => {
        if (online !== session) return;
        if (!request) { library.dismissUndo(); return; }
        if (seat === request.seat) hud.setNotice('已请求悔棋，等待对手确认');
        else if (seat !== 'spectator') library.undo(accept => session.answerUndo(accept));
      },
      onSide: side => {
        if (online !== session) return;
        seat = side === RED ? 'red' : side === BLACK ? 'black' : 'spectator';
        if (mode !== 'review') game.setMode('online', side);
      },
      onConnection: connected => { if (online === session) game.setConnection(connected, !(lastState?.waiting ?? true)); },
      onClosed: () => { if (online === session) { goLocal(); hud.setNotice('棋局已保留，可从棋局记录续局'); } },
    });
    online = session;
    await session.connect(code, resumeToken);
    if (attempt !== joinAttempt || online !== session) { session.leave(); return; }
    connecting = false;
    mode = 'online'; reviewEntry = null;
    seat = session.side === RED ? 'red' : session.side === BLACK ? 'black' : 'spectator';
    hud.setMode(mode); game.setMode(mode, session.side);
    if (onlineRecord) game.loadRecord(onlineRecord);
    const joinedState = lastState as RoomState | null;
    roomDialog.showWaiting(session.roomId ?? '', joinedState?.waiting ?? true, seatText());
    if (joinedState && !joinedState.waiting) scheduleClose();
  } catch (error) {
    if (attempt !== joinAttempt) return;
    const failed = online; online = null; failed?.leave(); connecting = false;
    roomDialog.fail(error instanceof Error && /凭据|座位|房间|存档/.test(error.message) ? error.message : '连接失败，请重试');
  }
}
function scheduleClose(): void {
  if (closeTimer !== null) clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => { closeTimer = null; roomDialog.hide(); }, 800);
}
function onRoomState(state: RoomState): void {
  const wasWaiting = lastState?.waiting ?? true;
  lastState = state;
  game.setConnection(online?.isConnected() ?? false, !state.waiting);
  hud.setRoom(state.code); hud.setRoomWaiting(state.waiting); hud.setConnection(seatText(), 'ok');
  if (roomDialog.isOpen) {
    roomDialog.updateWaiting(state.waiting, state.waiting ? '等待对手回到棋局' : '双方已就位');
    if (wasWaiting && !state.waiting) scheduleClose();
  }
}
function seatText(): string { return seat === 'red' ? '执红' : seat === 'black' ? '执黑' : '观战'; }
function goLocal(): void {
  ++joinAttempt; connecting = false;
  if (closeTimer !== null) { clearTimeout(closeTimer); closeTimer = null; }
  const previous = online; online = null; previous?.leave();
  seat = null; lastState = null; identity = null; onlineRecord = null;
  mode = 'local'; reviewEntry = null;
  roomDialog.hide(); hud.setMode(mode); hud.setConnection('本机双人', 'idle');
  game.setMode(mode, null); game.loadRecord(localRecord);
}
function resume(entry: ArchiveEntry): void {
  if (!archive.valid(entry)) { hud.setNotice('棋谱损坏，无法恢复', 'error'); return; }
  if (entry.mode === 'online') {
    if (online?.isConnected() && online.roomId === entry.roomCode && identity?.seat === entry.seat) { exitReview(); return; }
    roomDialog.showConnecting(entry.roomCode ?? '');
    void enterRoom(entry.roomCode ?? null, entry.resumeToken);
  } else {
    goLocal(); localRecord = entry.record; game.loadRecord(localRecord); save(entry);
    hud.setNotice('已恢复对局');
  }
}
function review(entry: ArchiveEntry): void {
  if (!archive.valid(entry)) { hud.setNotice('棋谱损坏，无法复盘', 'error'); return; }
  mode = 'review'; reviewEntry = entry; reviewPly = entry.record.moves.length;
  hud.setMode(mode); game.setMode(mode, null); game.loadRecord(entry.record, false, reviewPly);
}
function stepReview(delta: number): void {
  if (!reviewEntry) return;
  reviewPly = Math.max(0, Math.min(reviewEntry.record.moves.length, reviewPly + delta));
  game.loadRecord(reviewEntry.record, false, reviewPly);
}
function exitReview(): void {
  reviewEntry = null;
  if (online?.isConnected() && onlineRecord) {
    mode = 'online'; hud.setMode(mode); game.setMode(mode, online.side); game.loadRecord(onlineRecord);
  } else goLocal();
}
game.onStatus = snapshot => hud.update({ ...snapshot, mode });
game.onRecord = record => { localRecord = record; save({ record, mode: 'local' }); };
game.onLocalMove = uci => { if (mode === 'online' && online?.isConnected()) online.sendMove(uci); };
game.onCue = (cue: GameCue) => sound.play(cue);
hud.setMode(mode); game.start(); game.setViewPreset(preset);
const active = archive.activeLocal();
if (active && archive.valid(active)) { localRecord = active.record; game.loadRecord(localRecord); }
else save({ record: localRecord, mode: 'local' });
const invitationCode = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
if (invitationCode && /^[A-Z0-9]{4}$/.test(invitationCode)) roomDialog.showEntry('', invitationCode);
window.addEventListener('beforeunload', () => { online?.leave(); game.dispose(); hud.dispose(); sound.dispose(); });

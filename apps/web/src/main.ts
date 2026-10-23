import './styles/global.css';
import { BLACK, RED } from '@xiangqi/rules';
import { createGame, type GameCue } from './game/game.ts';
import { SoundBoard } from './audio/sound.ts';
import { Hud } from './ui/hud.ts';
import { RoomDialog } from './ui/room-dialog.ts';
import type { OnlineSession, RoomState } from './net/online.ts';

type Mode = 'local' | 'online';

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
const hudHost = document.querySelector<HTMLElement>('#hud');
const overlayHost = document.querySelector<HTMLElement>('#overlay');
if (!canvas || !hudHost || !overlayHost) {
  throw new Error('Missing #scene, #hud or #overlay in the document');
}

const game = createGame({ canvas });
const sound = new SoundBoard();

let mode: Mode = 'local';
let online: OnlineSession | null = null;
/** Seat the server gave us once the room answered; `null` means spectator. */
let seat: 'red' | 'black' | 'spectator' | null = null;
let lastState: RoomState | null = null;
let closeTimer: number | null = null;
let joinAttempt = 0;
let connecting = false;

const hud = new Hud(hudHost, {
  onUndo: () => {
    sound.play('click');
    game.undo();
  },
  onRestart: () => {
    sound.play('click');
    if (mode === 'online') {
      online?.requestRematch();
      hud.setNotice('已请求再来一局');
    } else game.restart();
  },
  onFlip: () => {
    sound.play('click');
    game.flipCamera();
  },
  onModeChange: (next) => {
    sound.play('click');
    if (next === 'online') openRoom();
    else goLocal();
  },
  onOpenRoom: () => {
    sound.play('click');
    openRoom();
  },
  onToggleSound: () => {
    const enabled = sound.toggle();
    // Confirm turning it on with the cue itself; mute needs no confirmation.
    if (enabled) sound.play('click');
    return enabled;
  },
});

const roomDialog = new RoomDialog(overlayHost, {
  onEnter: (code) => void enterRoom(code),
  onLeave: () => goLocal(),
  onCancel: () => goLocal(),
  onCopy: (text) => void copyInvite(text),
});

hud.setSound(sound.isEnabled);

// --- Online --------------------------------------------------------------

function openRoom(): void {
  if (connecting) return;
  if (online?.isConnected()) {
    roomDialog.showWaiting(online.roomId ?? '', lastState?.waiting ?? false, seatText());
    return;
  }
  roomDialog.showEntry();
}

async function enterRoom(code: string | null): Promise<void> {
  if (connecting) return;
  connecting = true;
  const attempt = ++joinAttempt;
  const { OnlineSession } = await import('./net/online.ts');
  if (attempt !== joinAttempt) return;
  const session = new OnlineSession({
    onStatus: (text, tone) => hud.setConnection(text, tone),
    onRoom: (state) => onRoomState(state),
    onNotice: (text) => hud.setNotice(text),
    onPosition: (fen, lastMoveUci, notation) => game.setOnlinePosition(fen, lastMoveUci, notation),
    onSide: (side) => {
      seat = side === RED ? 'red' : side === BLACK ? 'black' : 'spectator';
      game.setMode('online', side);
    },
    onConnection: (connected) => game.setConnection(connected, !(lastState?.waiting ?? true)),
    onClosed: () => {
      if (online === session) goLocal();
    },
  });
  online = session;
  try {
    await session.connect(code);
  } catch {
    if (attempt !== joinAttempt) return;
    // The dialog stays open so the code can be corrected or retried.
    online = null;
    connecting = false;
    roomDialog.fail('连接失败');
    return;
  }
  if (attempt !== joinAttempt || online !== session) {
    session.leave();
    return;
  }
  connecting = false;

  mode = 'online';
  seat = session.side === RED ? 'red' : session.side === BLACK ? 'black' : 'spectator';
  hud.setMode('online');
  game.setMode('online', session.side);
  roomDialog.showWaiting(session.roomId ?? '', lastState?.waiting ?? true, seatText());
}

function onRoomState(state: RoomState): void {
  const wasWaiting = lastState?.waiting ?? true;
  lastState = state;
  game.setConnection(online?.isConnected() ?? false, !state.waiting);
  hud.setRoom(state.code);
  hud.setRoomWaiting(state.waiting);
  hud.setConnection(seatText(), 'ok');
  if (!roomDialog.isOpen) return;
  roomDialog.updateWaiting(state.waiting, waitingText(state));
  // Filling the second seat is the moment to get out of the way.
  if (wasWaiting && !state.waiting) {
    if (closeTimer !== null) window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      closeTimer = null;
      roomDialog.hide();
    }, 900);
  }
}

function seatText(): string {
  if (seat === 'red') return '执红';
  if (seat === 'black') return '执黑';
  return '观战';
}

function waitingText(state: RoomState): string {
  if (state.waiting) return seat === 'spectator' ? '等待两位棋手落座' : '等待对手加入';
  return '对手已就位';
}

async function copyInvite(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    hud.setNotice('邀请已复制');
  } catch {
    hud.setNotice('复制失败', 'error');
  }
}

// --- Mode switching ------------------------------------------------------

function goLocal(): void {
  ++joinAttempt;
  connecting = false;
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
  const previous = online;
  online = null;
  previous?.leave();
  seat = null;
  lastState = null;
  mode = 'local';
  roomDialog.hide();
  hud.setMode('local');
  hud.setConnection('本机双人', 'idle');
  game.setMode('local', null);
  game.restart();
}

// --- Wiring --------------------------------------------------------------

// The game reports its own view mode; keep the HUD honest about the toggle.
game.onStatus = (next) => hud.update({ ...next, mode });

game.onLocalMove = (uci) => {
  if (mode === 'online' && online?.isConnected()) online.sendMove(uci);
};

game.onCue = (cue: GameCue) => sound.play(cue);

hud.setMode('local');
game.start();

const invitationCode = new URLSearchParams(window.location.search).get('room')?.trim().toUpperCase();
if (invitationCode && /^[A-Z0-9]{4}$/.test(invitationCode)) roomDialog.showEntry('', invitationCode);

window.addEventListener('beforeunload', () => {
  online?.leave();
  game.dispose();
  hud.dispose();
  sound.dispose();
});

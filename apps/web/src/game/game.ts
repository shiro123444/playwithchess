import * as THREE from 'three';
import {
  BLACK,
  createRecord,
  replayRecord,
  resultFor,
  PIECE_GLYPHS,
  type GameRecord,
  type GameResult,
  RED,
  Position,
  XIANGQI,
  colorOf,
  getVariant,
  moveFrom,
  moveTo,
  toChineseNotation,
  uciToSquare,
  type Color,
  type Move,
  type GameStatus,
  type VariantConfig,
} from '@xiangqi/rules';
import {
  BOARD_DEPTH,
  BOARD_FILES,
  BOARD_RANKS,
  BOARD_WIDTH,
  CELL,
  GRID_DEPTH,
  GRID_WIDTH,
  PIECE_HEIGHT,
  PALETTE,
  SURFACE_Y,
  squareToWorld,
} from '../engine/config.ts';
import { createBoard, createBoardShadow } from '../engine/board.ts';
import {
  createLastMoveMarker,
  createMoveMarker,
  createPieceVisual,
  createSelectionRing,
  type PieceVisual,
} from '../engine/pieces.ts';
// Type-only: the Rapier bundle is ~1.5 MB of wasm, so it is imported lazily in
// `start()` and never blocks first paint. Capture debris simply waits for it.
import type { PhysicsWorld } from '../engine/physics.ts';
import { cuesFor } from '../audio/cue.ts';
import { SCENE_FOV, createSceneRig } from '../engine/scene.ts';
import { ReactionLayer } from '../engine/reactions.ts';

const ANIMATION_MS = 320;
const CAMERA_LERP = 0.07;

export type GameViewMode = 'local' | 'online' | 'review';
export type ViewPreset = 'auto' | 'overhead' | 'angled' | 'low';

/**
 * Cues the view asks the shell to play. They live here rather than in the
 * audio module so the scene stays free of playback policy (mute, storage).
 */
export type GameCue = 'move' | 'capture' | 'check' | 'end';

export interface GameStatusSnapshot {
  sideToMove: Color;
  status: GameStatus;
  moveCount: number;
  lastMove: { from: number; to: number; text: string } | null;
  canUndo: boolean;
  mode: GameViewMode;
  onlineSide: Color | null;
  connected: boolean;
  ready: boolean;
  result: GameResult | null;
  selection: string | null;
  reviewPly: number;
  totalMoves: number;
}

export interface GameController {
  start(): void;
  dispose(): void;
  undo(): boolean;
  restart(): void;
  setMode(mode: GameViewMode, side: Color | null): void;
  setConnection(connected: boolean, ready: boolean): void;
  loadRecord(record: GameRecord, animate?: boolean, ply?: number): void;
  getRecord(): GameRecord;
  setViewPreset(preset: ViewPreset): void;
  onRecord: ((record: GameRecord) => void) | null;
  onStatus: ((snapshot: GameStatusSnapshot) => void) | null;
  /** Called with the move the player made; the online layer forwards it. */
  onLocalMove: ((uci: string) => void) | null;
  /** Sound hooks: the scene says what happened, the shell decides how loud. */
  onCue: ((cue: GameCue) => void) | null;
  /** Swing the camera to the other end of the board. */
  flipCamera(): void;
  /** Pop a reaction sticker over `side`'s back ranks. Returns false for unknown ids. */
  showReaction(id: string, side: Color | null): boolean;
}

interface Options {
  canvas: HTMLCanvasElement;
  variantId?: string;
}

export function createGame({ canvas, variantId = XIANGQI.id }: Options): GameController {
  const variant: VariantConfig = getVariant(variantId);
  let position = new Position(variant);
  let record = createRecord(crypto.randomUUID(), variant.id);
  let reviewPly = -1;
  let preset: ViewPreset = 'auto';
  let recordListener: ((record: GameRecord) => void) | null = null;
  const rig = createSceneRig(canvas);
  const { renderer, scene, camera } = rig;

  const board = createBoard();
  scene.add(board.group);
  scene.add(createBoardShadow());

  const pieces = new Map<number, PieceVisual>();
  const pieceLayer = new THREE.Group();
  scene.add(pieceLayer);

  const selectionRing = createSelectionRing();
  selectionRing.position.y = SURFACE_Y + 0.012;
  scene.add(selectionRing);

  const moveMarkers: THREE.Mesh[] = [];
  const lastMoveMarkers = [createLastMoveMarker(), createLastMoveMarker()];
  for (const marker of lastMoveMarkers) {
    marker.visible = false;
    marker.position.y = SURFACE_Y + 0.008;
    scene.add(marker);
  }

  const travelArrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xb4463c, 0.3, 0.18);
  travelArrow.visible = false;
  (travelArrow.line.material as THREE.Material).transparent = true;
  (travelArrow.line.material as THREE.Material).opacity = 0.65;
  scene.add(travelArrow);
  const landingRing = createLastMoveMarker(0x3f7aa8);
  landingRing.visible = false;
  scene.add(landingRing);
  const reactions = new ReactionLayer(scene, camera);  let landingAt = 0;
  let selectionVisual: PieceVisual | null = null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  interface HistoryEntry {
    move: Move;
    notation: string;
  }

  const state = {
    selected: -1,
    legalTargets: new Map<number, Move>(),
    // The notation has to be stored per move: undo needs to restore the text
    // of the move before the one being taken back.
    moveHistory: [] as HistoryEntry[],
    lastMove: null as { from: number; to: number } | null,
    lastNotation: '',
    animating: false,
    mode: 'local' as GameViewMode,
    onlineSide: null as Color | null,
    connected: true,
    ready: false,
    pendingMove: false,
    hoverSquare: -1,
  };

  let physics: PhysicsWorld | null = null;
  let statusListener: ((snapshot: GameStatusSnapshot) => void) | null = null;
  let localMoveListener: ((uci: string) => void) | null = null;
  let cueListener: ((cue: GameCue) => void) | null = null;
  let rafId = 0;
  // The first online snapshot describes a board that was already in progress;
  // its "last move" happened before we arrived and must not make a sound.
  let lastFrame = performance.now();
  let cameraTarget = new THREE.Vector3(0, 12.5, 11.5);
  let destroyed = false;

  // --- Pieces -------------------------------------------------------------

  function worldFor(square: number): THREE.Vector3 {
    const { x, z } = squareToWorld(square, BOARD_FILES, BOARD_RANKS);
    return new THREE.Vector3(x, SURFACE_Y, z);
  }

  function syncPieces(): void {
    // Remove visuals for squares that are now empty, and add new ones.
    for (const [square, visual] of pieces) {
      if (position.board[square] === 0) {
        pieceLayer.remove(visual.mesh);
        pieces.delete(square);
      }
    }
    for (let square = 0; square < position.geo.squares; square++) {
      const code = position.board[square];
      if (code === 0) continue;
      const existing = pieces.get(square);
      const type = code & 7;
      const red = (code & 8) === 0;
      if (existing) {
        // A different piece landed here: rebuild it.
        const existingType = (existing.mesh.userData.type as number | undefined) ?? -1;
        const existingRed = (existing.mesh.userData.red as boolean | undefined) ?? false;
        if (existingType === type && existingRed === red) continue;
        pieceLayer.remove(existing.mesh);
        pieces.delete(square);
      }
      const visual = createPieceVisual(type, red);
      const world = worldFor(square);
      visual.mesh.position.copy(world);
      visual.home.copy(world);
      // Pieces that appear after a flip (a restored board, a reloaded record)
      // must start already facing the viewer.
      visual.cap.rotation.y = viewSide === RED ? 0 : Math.PI;
      visual.mesh.userData.square = square;
      visual.mesh.userData.type = type;
      visual.mesh.userData.red = red;
      pieceLayer.add(visual.mesh);
      pieces.set(square, visual);
    }
  }

  // --- Animation ----------------------------------------------------------

  interface Tween {
    mesh: THREE.Object3D;
    from: THREE.Vector3;
    to: THREE.Vector3;
    start: number;
    duration: number;
    lift: number;
    done?: () => void;
  }
  const tweens: Tween[] = [];

  function tweenTo(
    mesh: THREE.Object3D,
    to: THREE.Vector3,
    duration: number,
    lift = 0,
    done?: () => void,
  ): void {
    tweens.push({
      mesh,
      from: mesh.position.clone(),
      to: to.clone(),
      start: performance.now(),
      duration,
      lift,
      done,
    });
  }

  function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function updateTweens(now: number): void {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tween = tweens[i]!;
      const t = Math.min(1, (now - tween.start) / tween.duration);
      const eased = easeInOutCubic(t);
      tween.mesh.position.lerpVectors(tween.from, tween.to, eased);
      tween.mesh.position.y += Math.sin(eased * Math.PI) * tween.lift;
      if (t >= 1) {
        tween.mesh.position.copy(tween.to);
        tweens.splice(i, 1);
        tween.done?.();
      }
    }
  }

  // --- Selection / markers ------------------------------------------------

  function clearMarkers(): void {
    if (selectionVisual) {
      selectionVisual.mesh.scale.setScalar(1);
      if (!state.animating) selectionVisual.mesh.position.y = SURFACE_Y;
      selectionVisual = null;
    }
    for (const marker of moveMarkers) {
      marker.visible = false;
    }
    selectionRing.visible = false;
  }

  function showMarkers(from: number): void {
    clearMarkers();
    const visual = pieces.get(from);
    if (visual) {
      selectionVisual = visual;
      selectionRing.position.set(visual.mesh.position.x, SURFACE_Y + 0.012, visual.mesh.position.z);
      selectionRing.visible = true;
    }
    const moves = position.legalMoves().filter((move) => moveFrom(move) === from);
    state.legalTargets.clear();
    for (const move of moves) state.legalTargets.set(moveTo(move), move);

    let index = 0;
    for (const to of state.legalTargets.keys()) {
      let marker = moveMarkers[index];
      if (!marker) {
        marker = createMoveMarker();
        moveMarkers.push(marker);
        scene.add(marker);
      }
      const world = worldFor(to);
      const occupied = position.board[to] !== 0;
      marker.userData.baseScale = occupied ? 2.5 : 1.4;
      marker.scale.setScalar(marker.userData.baseScale as number);
      marker.position.set(world.x, SURFACE_Y + 0.014, world.z);
      marker.visible = true;
      index++;
    }
  }

  function showLastMove(): void {
    if (!state.lastMove) {
      travelArrow.visible = false;
      for (const marker of lastMoveMarkers) marker.visible = false;
      return;
    }
    const fromWorld = worldFor(state.lastMove.from);
    const toWorld = worldFor(state.lastMove.to);
    lastMoveMarkers[0]!.position.set(fromWorld.x, SURFACE_Y + 0.008, fromWorld.z);
    lastMoveMarkers[1]!.position.set(toWorld.x, SURFACE_Y + 0.008, toWorld.z);
    const direction = toWorld.clone().sub(fromWorld);
    const moverColor = colorOf(position.board[state.lastMove.to]);
    const routeColor = moverColor === RED ? PALETTE.vermilion : PALETTE.cobalt;
    travelArrow.setColor(routeColor);
    for (const marker of lastMoveMarkers) (marker.material as THREE.MeshBasicMaterial).color.setHex(routeColor);
    travelArrow.position.copy(fromWorld).add(new THREE.Vector3(0, 0.025, 0));
    travelArrow.setDirection(direction.clone().normalize());
    travelArrow.setLength(direction.length(), 0.3, 0.18);
    travelArrow.visible = true;
    lastMoveMarkers[0]!.visible = true;
    lastMoveMarkers[1]!.visible = true;
  }

  // --- Move application ---------------------------------------------------

  function inputAllowed(): boolean {
    if (state.animating || state.mode === 'review' || record.result) return false;
    if (position.status().kind !== 'playing') return false;
    if (state.mode === 'online') {
      if (!state.connected || !state.ready || state.pendingMove || state.onlineSide === null) return false;
      if (position.sideToMove !== state.onlineSide) return false;
    }
    return true;
  }

  function applyMove(move: Move, animate: boolean, notify = true): void {
    const from = moveFrom(move);
    const to = moveTo(move);
    // Notation is derived from the position *before* the move.
    const notation = toChineseNotation(position, move);
    const mover = pieces.get(from);
    const captured = position.board[to] !== 0 ? pieces.get(to) : undefined;

    position.makeMove(move);
    record = { ...record, moves: [...record.moves, { uci: position.moveToUci(move), notation, at: Date.now() }],
      updatedAt: Date.now(), result: resultFor(position.status()) };
    if (state.mode === 'local') recordListener?.(structuredClone(record));
    state.moveHistory.push({ move, notation });
    state.lastNotation = notation;
    state.lastMove = { from, to };
    state.selected = -1;
    state.legalTargets.clear();
    clearMarkers();

    const target = worldFor(to);
    if (captured) pieces.delete(to);
    pieces.delete(from);

    if (mover) {
      pieces.set(to, mover);
      mover.mesh.userData.square = to;
      if (animate) {
        state.animating = true;
        mover.mesh.position.y = SURFACE_Y;
        tweenTo(mover.mesh, target, ANIMATION_MS, PIECE_HEIGHT * 1.15, () => {
          if (captured && physics) {
            launchCapture(captured, target);
          } else if (captured) {
            pieceLayer.remove(captured.mesh);
          }
          state.animating = false;
          syncPieces();
          showLastMove();
          // Sound follows the landing, not the click: the piece hitting the
          // board is the event, and the capture's second hit trails it.
          flashLanding(to);
          soundFor(captured !== undefined);
          emitStatus();
        });
      } else {
        mover.mesh.position.copy(target);
        if (captured) pieceLayer.remove(captured.mesh);
      }
    }

    if (!animate) {
      syncPieces();
      showLastMove();
    }

    if (!animate) soundFor(captured !== undefined);

    if (notify) localMoveListener?.(position.moveToUci(move));
    // Disable undo immediately while the piece is in flight, then enable it
    // again in the landing callback. A previous move may already be undoable.
    emitStatus();
  }

  function flashLanding(square: number): void {
    landingAt = performance.now();
    landingRing.position.copy(worldFor(square));
    landingRing.position.y += 0.03;
    landingRing.visible = true;
  }

  /** Cue a move that has just been applied (see `cuesFor` for the mix). */
  function soundFor(captured: boolean): void {
    if (!cueListener) return;
    for (const cue of cuesFor(position.status(), captured)) cueListener(cue);
  }

  function launchCapture(victim: PieceVisual, impact: THREE.Vector3): void {
    if (!physics) {
      pieceLayer.remove(victim.mesh);
      return;
    }
    // Fling the captured piece away from the impact point and off the table.
    const direction = new THREE.Vector3(
      victim.mesh.position.x - impact.x,
      0,
      victim.mesh.position.z - impact.z,
    );
    if (direction.lengthSq() < 0.001) direction.set(Math.random() - 0.5, 0, -1);
    direction.normalize();
    const impulse = new THREE.Vector3(
      direction.x * (2.6 + Math.random() * 1.4),
      2.2 + Math.random() * 1.4,
      direction.z * (2.6 + Math.random() * 1.4),
    );
    const spin = new THREE.Vector3(
      (Math.random() - 0.5) * 0.6,
      (Math.random() - 0.5) * 0.6,
      (Math.random() - 0.5) * 0.6,
    );
    physics.launchDebris(victim.mesh, impulse, spin);
  }

  // --- Pointer interaction ------------------------------------------------

  function squareAtPointer(event: PointerEvent): number {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(board.pickPlane, false);
    const hit = hits[0];
    if (!hit) return -1;
    // Convert into the board group's frame (unrotated), so x is the file and z
    // is the rank. The pick plane itself is rotated flat, so its own local
    // coordinates would put the depth on `y` instead of `z`.
    const local = board.group.worldToLocal(hit.point.clone());
    const file = Math.round(local.x / CELL + (BOARD_FILES - 1) / 2);
    const rank = Math.round(local.z / CELL + (BOARD_RANKS - 1) / 2);
    if (file < 0 || file >= BOARD_FILES || rank < 0 || rank >= BOARD_RANKS) return -1;
    return rank * BOARD_FILES + file;
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    // The whole canvas is clickable; browser tap feedback would tint that
    // entire surface instead of the selected piece.
    event.preventDefault();
    if (!inputAllowed()) return;
    const square = squareAtPointer(event);
    if (square < 0) {
      state.selected = -1;
      state.legalTargets.clear();
      clearMarkers();
      emitStatus();
      return;
    }
    const pending = state.legalTargets.get(square);
    if (state.selected >= 0 && pending !== undefined) {
      if (state.mode === 'online') {
        // Wait for the authority before changing the position or playing audio.
        state.pendingMove = true;
        state.selected = -1;
        state.legalTargets.clear();
        clearMarkers();
        localMoveListener?.(position.moveToUci(pending));
      } else applyMove(pending, true);
      return;
    }
    const piece = position.board[square];
    if (piece !== 0 && colorOf(piece) === position.sideToMove) {
      state.selected = square;
      showMarkers(square);
      emitStatus();
      return;
    }
    state.selected = -1;
    state.legalTargets.clear();
    clearMarkers();
    emitStatus();
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    const square = squareAtPointer(event);
    if (square === state.hoverSquare) return;
    state.hoverSquare = square;
    const isPiece = square >= 0 && position.board[square] !== 0;
    const isTarget = state.legalTargets.has(square);
    canvas.style.cursor = isPiece || isTarget ? 'pointer' : 'default';
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);

  // --- Camera -------------------------------------------------------------

  /**
   * Camera side. Red sits at +z, Black at -z. The view does NOT follow the
   * turn — rotating the board between moves is disorienting — but playing as
   * Black puts you behind your own pieces.
   */
  let viewSide: Color = RED;
  /** User zoom, 1 = the framing the layout asked for. */
  let zoom = 1;

  // A throwaway camera used to solve the fit; it never renders.
  const projectCamera = new THREE.PerspectiveCamera(SCENE_FOV, 1, 0.1, 400);

  // Corners of the volume that must stay on screen: the slab plus a piece's
  // height above it, so the far rank never clips at the top.
  const FIT_POINTS: THREE.Vector3[] = [];
  {
    const halfX = BOARD_WIDTH / 2 + 0.08;
    const halfZ = BOARD_DEPTH / 2 + 0.08;
    for (const x of [-halfX, halfX]) {
      for (const z of [-halfZ, halfZ]) {
        for (const y of [-0.6, 0.45]) FIT_POINTS.push(new THREE.Vector3(x, y, z));
      }
    }
  }
  const FIT_MARGIN = 0.96;
  const FIT_MIN = 12;
  const FIT_MAX = 100;

  /**
   * Distance along the rig's line of sight at which every board corner lands
   * inside the frustum. Pure trigonometry would have to special-case portrait
   * vs landscape; projecting the corners and growing the distance until they
   * fit handles both, and any aspect the browser can produce.
   */
  function fitDistance(dir: THREE.Vector3): number {
    const probe = projectCamera.clone();
    probe.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    probe.updateProjectionMatrix();
    let distance = FIT_MIN;
    for (let pass = 0; pass < 8; pass++) {
      probe.position.copy(dir).multiplyScalar(distance);
      probe.lookAt(0, 0, 0);
      probe.updateMatrixWorld(true);
      let worst = 0;
      for (const point of FIT_POINTS) {
        const ndc = point.clone().project(probe);
        worst = Math.max(worst, Math.abs(ndc.x), Math.abs(ndc.y));
      }
      // Screen extent is very nearly proportional to 1/distance, so the ratio
      // is both the error and the correction. Falling short means coming back
      // in again — growing on overflow only would leave the board marooned.
      const margin = compactPortrait() ? 0.985 : FIT_MARGIN;
      const ratio = worst / margin;
      if (Math.abs(ratio - 1) < 0.01) break;
      distance = THREE.MathUtils.clamp(distance * ratio, FIT_MIN, FIT_MAX);
    }
    return distance;
  }

  /**
   * Camera elevation in degrees. A wide screen can afford the raking view that
   * shows the pieces' bodies; a portrait one cannot, because the board's long
   * axis runs down the screen. So portrait tilts toward top-down instead of
   * merely backing away — backing away alone leaves the board a thin strip
   * marooned in a sea of paper.
   */
  function elevationDegrees(): number {
    if (preset === 'overhead') return 89.5;
    if (preset === 'angled') return 58;
    if (preset === 'low') return 25;
    // Uniform piece sizes matter more than foreshortening on a phone.
    if (window.matchMedia('(max-width: 1000px)').matches) {
      return compactPortrait() ? 88 : 70;
    }
    const aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    const t = THREE.MathUtils.clamp((1.35 - aspect) / 0.9, 0, 1);
    return THREE.MathUtils.lerp(36, 78, t);
  }

  function compactPortrait(): boolean {
    return window.matchMedia('(max-width: 1000px) and (orientation: portrait)').matches;
  }

  function applyViewSide(): void {
    const sign = viewSide === RED ? 1 : -1;
    const elevation = THREE.MathUtils.degToRad(elevationDegrees());
    const direction = new THREE.Vector3(
      0,
      Math.sin(elevation),
      Math.cos(elevation) * sign,
    ).normalize();
    const distance = fitDistance(direction) * zoom;
    cameraTarget.copy(direction).multiplyScalar(distance);
    orientGlyphs();
  }

  /**
   * Turn every piece's inked face toward the viewer.
   *
   * The glyph is painted once, readable from red's side (+z). Sitting at the
   * far end of the board does not mirror the board — it turns the camera
   * around — so without this every character reads upside down to whichever
   * side is not red. The body is a plain cylinder, so spinning only the cap
   * keeps the piece physically identical while the text stays upright.
   */
  function orientGlyphs(): void {
    const angle = viewSide === RED ? 0 : Math.PI;
    for (const visual of pieces.values()) visual.cap.rotation.y = angle;
  }

  function updateCameraForTurn(): void {
    applyViewSide();
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    // Zoom in multiples of the current framing rather than absolute units, so
    // a phone that starts further back can still come all the way in.
    zoom = THREE.MathUtils.clamp(zoom + event.deltaY * 0.0007, 0.55, 1.9);
    applyViewSide();
  }
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // A rotation between portrait and landscape changes the frustum as well as
  // the framing; re-fit and cut rather than sweep.
  const onResize = (): void => {
    applyViewSide();
    camera.position.copy(cameraTarget);
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  const canvasResizeObserver = new ResizeObserver(() => {
    // Mobile browser chrome and CSS layout can resize the canvas without a
    // matching window resize. Update the projection before fitting it.
    rig.resize();
    onResize();
  });
  canvasResizeObserver.observe(canvas);

  // --- Status -------------------------------------------------------------

  function emitStatus(): void {
    if (!statusListener) return;
    statusListener({
      sideToMove: position.sideToMove,
      status: position.status(),
      moveCount: (position.fullmoveNumber - 1) * 2 + (position.sideToMove === BLACK ? 1 : 0),
      lastMove: state.lastMove
        ? {
            from: state.lastMove.from,
            to: state.lastMove.to,
            text: state.lastNotation,
          }
        : null,
      canUndo: state.moveHistory.length > 0 && !state.animating,
      mode: state.mode,
      onlineSide: state.onlineSide,
      connected: state.connected,
      ready: state.ready,
      result: reviewPly >= 0 && reviewPly < record.moves.length ? null : record.result,
      selection: state.selected < 0 ? null : `${position.sideToMove === RED ? '红' : '黑'}${
        PIECE_GLYPHS[(position.board[state.selected] ?? 0) & 7]?.[position.sideToMove === RED ? 'red' : 'black'] ?? '棋'} · ${state.legalTargets.size} 个落点`,
      reviewPly: reviewPly < 0 ? record.moves.length : reviewPly,
      totalMoves: record.moves.length,
    });
  }

  // --- Frame loop ---------------------------------------------------------

  function frame(now: number): void {
    if (destroyed) return;
    rafId = requestAnimationFrame(frame);
    const delta = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    updateTweens(now);
    physics?.step(delta);
    reactions.update(now);

    camera.position.lerp(cameraTarget, CAMERA_LERP);
    camera.lookAt(0, 0, 0);

    // Gentle breathing on the selection ring keeps it from feeling static.
    if (selectionRing.visible) {
      const pulse = 1 + Math.sin(now * 0.004) * 0.045;
      selectionRing.scale.setScalar(pulse * 1.12);
      if (selectionVisual) {
        selectionVisual.mesh.scale.setScalar(1.07 + Math.sin(now * 0.004) * 0.015);
        selectionVisual.mesh.position.y = SURFACE_Y + 0.08 + Math.sin(now * 0.004) * 0.025;
      }
    }

    for (const marker of moveMarkers) if (marker.visible) {
      marker.scale.setScalar((marker.userData.baseScale as number) * (1 + Math.sin(now * 0.005) * 0.13));
    }
    if (landingRing.visible) {
      const t = (now - landingAt) / 800;
      landingRing.scale.setScalar(1.05 + t * 1.1);
      (landingRing.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.95 * (1 - t));
      if (t >= 1) landingRing.visible = false;
    }
    renderer.render(scene, camera);
  }

  // --- Public API ---------------------------------------------------------

  function start(): void {
    syncPieces();
    updateCameraForTurn();
    camera.position.copy(cameraTarget);
    lastFrame = performance.now();
    rafId = requestAnimationFrame(frame);
    emitStatus();

    void import('../engine/physics.ts')
      .then(({ PhysicsWorld }) => PhysicsWorld.create())
      .then((world) => {
        if (destroyed) {
          world.dispose();
          return;
        }
        world.addBoardSurface(BOARD_WIDTH / 2, BOARD_DEPTH / 2);
        world.addFloor(-14);
        physics = world;
      })
      .catch((error: unknown) => {
        // Physics is spectacle only; the game must stay playable without it.
        console.warn('Physics unavailable, captures will not tumble', error);
      });
  }

  function undo(): boolean {
    if (state.animating || !record.moves.length || state.mode !== 'local') return false;
    const next = { ...record, moves: record.moves.slice(0, -1), result: null, updatedAt: Date.now() };
    loadRecord(next, true);
    recordListener?.(structuredClone(record));
    return true;
  }

  function restart(): void {
    loadRecord(createRecord(crypto.randomUUID(), variant.id));
    recordListener?.(structuredClone(record));
  }

  function loadRecord(next: GameRecord, animate = false, ply = next.moves.length): void {
    const restored = replayRecord(next, ply);
    state.pendingMove = false;
    const previous = record;
    // An ordinary server move follows the exact same physical animation as local play.
    if (animate && next.id === previous.id && next.moves.length === previous.moves.length + 1 &&
        previous.moves.every((move, i) => next.moves[i].uci === move.uci) && ply === next.moves.length) {
      const move = position.findUciMove(next.moves.at(-1)!.uci);
      if (move >= 0) {
        applyMove(move, true, false);
        record = structuredClone(next);
        reviewPly = -1;
        return;
      }
    }
    const tail = previous.moves.at(-1);
    const undone = animate && next.id === previous.id && next.moves.length < previous.moves.length && tail;
    const undoFrom = undone ? uciToSquare(tail.uci.slice(2), position.geo.width, position.geo.height) : -1;
    const undoTo = undone ? uciToSquare(tail.uci.slice(0, 2), position.geo.width, position.geo.height) : -1;
    clearMarkers();
    state.selected = -1;
    state.legalTargets.clear();
    state.pendingMove = false;
    state.animating = false;
    tweens.length = 0;
    physics?.removeDebris();
    pieceLayer.clear();
    pieces.clear();
    record = structuredClone(next);
    reviewPly = state.mode === 'review' ? ply : -1;
    position = restored;
    state.moveHistory = [];
    const probe = new Position(variant);
    probe.setFen(next.initialFen);
    for (const item of next.moves.slice(0, ply)) {
      const move = probe.findUciMove(item.uci);
      state.moveHistory.push({ move, notation: toChineseNotation(probe, move) });
      probe.makeMove(move);
    }
    const last = state.moveHistory.at(-1);
    state.lastMove = last ? { from: moveFrom(last.move), to: moveTo(last.move) } : null;
    state.lastNotation = last?.notation ?? '';
    syncPieces();
    showLastMove();
    const mover = pieces.get(undoTo);
    if (undone && mover && undoFrom >= 0) {
      mover.mesh.position.copy(worldFor(undoFrom));
      state.animating = true;
      tweenTo(mover.mesh, worldFor(undoTo), ANIMATION_MS, PIECE_HEIGHT, () => {
        state.animating = false;
        flashLanding(undoTo);
        emitStatus();
      });
    }
    emitStatus();
  }

  function dispose(): void {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(rafId);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('wheel', onWheel);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    canvasResizeObserver.disconnect();
    reactions.dispose();
    physics?.dispose();
    rig.dispose();
  }

  return {
    start,
    dispose,
    undo,
    restart,
    loadRecord,
    getRecord: () => structuredClone(record),
    setViewPreset(next) {
      preset = next;
      zoom = 1;
      applyViewSide();
      camera.position.copy(cameraTarget);
    },
    get onRecord() { return recordListener; },
    set onRecord(listener) { recordListener = listener; },
    setMode(mode, side) {
      state.mode = mode;
      state.onlineSide = side;
      state.selected = -1;
      state.legalTargets.clear();
      clearMarkers();
      // Sit behind your own army online; otherwise keep the red-side view.
      if (mode === 'online' && side !== null) viewSide = side;
      else viewSide = RED;
      applyViewSide();
      camera.position.copy(cameraTarget);
      emitStatus();
    },
    setConnection(connected, ready) {
      state.connected = connected;
      state.ready = ready;
      if (!connected || !ready) {
        state.pendingMove = false;
        state.selected = -1;
        state.legalTargets.clear();
        clearMarkers();
      }
      emitStatus();
    },
    get onStatus() {
      return statusListener;
    },
    set onStatus(listener) {
      statusListener = listener;
    },
    get onLocalMove() {
      return localMoveListener;
    },
    set onLocalMove(listener) {
      localMoveListener = listener;
    },
    get onCue() {
      return cueListener;
    },
    set onCue(listener) {
      cueListener = listener;
    },
    flipCamera: () => {
      viewSide = viewSide === RED ? BLACK : RED;
      applyViewSide();
      // Cut rather than sweep: easing 180° means clicking a piece mid-flight
      // picks a square from the old camera, and the board reads as spinning.
      camera.position.copy(cameraTarget);
    },
    showReaction(id, side) {
      return reactions.show(id, side);
    },
  };
}

/** Board extents, exported for UI framing math. */
export const BOARD_EXTENTS = { width: GRID_WIDTH, depth: GRID_DEPTH, cell: CELL, files: BOARD_FILES };
export const COLORS = { RED, BLACK };

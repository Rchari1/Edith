import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { dockBounds, clampWidth, squareBounds, SQUARE_SIZE, type Point, type Rect, type MiniShape } from '../core/mini/dock.js';

/** What both renderers are told about mini mode. */
export interface MiniState {
  visible: boolean;
  /** Folded to the strip. A peek unfolds the panel without changing this. */
  collapsed: boolean;
  /** The rail, or the small square in the corner. */
  shape: MiniShape;
  autoShow: boolean;
  /** When the current stretch of work began; the panel draws the notes touched since. */
  stretchStartedAt: number | null;
}

export interface MiniPrefs {
  width: number;
  shape: MiniShape;
}

/**
 * Mini mode: a narrow column docked to the left edge of the screen that shows
 * Claude using the brain while the user works beside it.
 *
 * macOS gives an app no way to reserve screen space, so this floats over
 * whatever is underneath rather than pushing it aside. Everything else follows
 * from not getting in the way: it never takes focus, even when clicked; it
 * follows the user across Spaces and over full-screen apps. It can fold to a
 * strip the width of the main window's rail, or shrink to a small square in the
 * corner; both of those show nothing but the live graph.
 */
export class MiniWindow {
  private win: BrowserWindow | null = null;
  private displayId: number | null = null;
  /**
   * Folded to a strip. Deliberately not remembered: whenever the panel opens,
   * the graph is showing - a bare strip is not what minimizing Edith should give you.
   */
  private folded = false;
  /** Unfolded for the moment - on hover, or while Claude is touching the brain. */
  private peeking = false;
  private widthTimer: NodeJS.Timeout | undefined;
  /**
   * Where each shape was dragged to, in screen coordinates: the rail's left
   * edge, and the square's top-left corner. Null is the docked default. Kept
   * for this run only - a fresh start docks them again, which is where they
   * make sense before the user has said otherwise.
   */
  private railLeft: number | null = null;
  private squareOrigin: Point | null = null;
  private readonly redock = (): void => this.applyBounds(false);

  constructor(
    private prefs: MiniPrefs,
    private readonly persist: (patch: Partial<MiniPrefs>) => void,
    private readonly changed: () => void
  ) {
    // Settings are hand-editable JSON; anything unrecognised is the rail.
    this.prefs = { ...prefs, shape: prefs.shape === 'square' ? 'square' : 'rail' };
    screen.on('display-metrics-changed', this.redock);
    screen.on('display-removed', this.redock);
  }

  get visible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  get collapsed(): boolean {
    return this.folded;
  }

  get shape(): MiniShape {
    return this.prefs.shape;
  }

  /** Appear beside the terminal the user is typing in, without taking focus from it. */
  show(): void {
    const win = this.ensure();
    if (win.isVisible()) return;
    // The cursor is the best signal of which display the user is working on.
    this.displayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    this.folded = false;
    this.peeking = false;
    this.applyBounds(false);
    win.showInactive();
    this.changed();
  }

  hide(): void {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return;
    this.peeking = false;
    this.win.hide();
    this.changed();
  }

  setCollapsed(collapsed: boolean): void {
    // Only the rail folds; the square is already as small as it gets.
    if (this.prefs.shape !== 'rail') return;
    this.peeking = false;
    if (this.folded !== collapsed) {
      this.folded = collapsed;
      this.changed();
    }
    this.applyBounds(true);
  }

  /** Switch between the rail and the square. Remembered, so minimizing Edith opens whichever was used last. */
  setShape(shape: MiniShape): void {
    this.folded = false;
    this.peeking = false;
    if (this.prefs.shape !== shape) {
      this.prefs = { ...this.prefs, shape };
      this.persist({ shape });
      this.changed();
    }
    this.applyBounds(true);
  }

  /** Unfold for a moment without touching the saved preference. */
  peek(on: boolean): void {
    if (!this.folded || this.peeking === on) return;
    this.peeking = on;
    this.applyBounds(true);
  }

  /** A drag on the panel's edge. The width is clamped here rather than trusted from the renderer. */
  setWidth(width: number): void {
    if (this.folded || this.prefs.shape !== 'rail') return;
    const next = clampWidth(width, this.workArea());
    if (next === this.prefs.width) return;
    this.prefs = { ...this.prefs, width: next };
    this.applyBounds(false);
    // A drag fires continuously; write settings once it settles.
    clearTimeout(this.widthTimer);
    this.widthTimer = setTimeout(() => this.persist({ width: next }), 400);
  }

  /**
   * A drag from the panel. The renderer asks for a top-left corner in screen
   * coordinates; the panel follows onto whichever display that lands on and is
   * clamped inside its work area, so it can cross screens but never leave them.
   * The rail and the strip stay full height, so only their left edge moves.
   */
  moveTo(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const size = this.bounds();
    const centre = { x: Math.round(x + size.width / 2), y: Math.round(y + size.height / 2) };
    this.displayId = screen.getDisplayNearestPoint(centre).id;
    if (this.prefs.shape === 'square') this.squareOrigin = { x, y };
    else this.railLeft = x;
    this.applyBounds(false);
  }

  destroy(): void {
    screen.removeListener('display-metrics-changed', this.redock);
    screen.removeListener('display-removed', this.redock);
    clearTimeout(this.widthTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const mac = process.platform === 'darwin';
    const win = new BrowserWindow({
      ...this.bounds(),
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      roundedCorners: false,
      // A non-activating panel: clicking it does not pull Edith in front of
      // the terminal, and it floats over full-screen apps on every Space.
      ...(mac ? { type: 'panel' } : {}),
      backgroundColor: '#0a0a0a',
      title: 'Edith mini',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    win.setAlwaysOnTop(true, 'floating');
    if (!mac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('closed', () => {
      this.win = null;
    });

    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/mini.html`);
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/mini.html'));
    }
    this.win = win;
    return win;
  }

  private workArea(): Rect {
    const display =
      screen.getAllDisplays().find((d) => d.id === this.displayId) ?? screen.getPrimaryDisplay();
    return display.workArea;
  }

  private applyBounds(animate: boolean): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.setBounds(this.bounds(), animate);
  }

  private bounds(): Rect {
    const area = this.workArea();
    if (this.prefs.shape === 'square') return squareBounds(area, SQUARE_SIZE, this.squareOrigin);
    return dockBounds(area, this.prefs.width, this.folded && !this.peeking, this.railLeft);
  }
}

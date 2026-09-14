import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { dockBounds, clampWidth, type Rect } from '../core/mini/dock.js';

/** What both renderers are told about mini mode. */
export interface MiniState {
  visible: boolean;
  /** Folded to the strip. A peek unfolds the panel without changing this. */
  collapsed: boolean;
  autoShow: boolean;
  /** When the current stretch of work began; the panel draws the notes touched since. */
  stretchStartedAt: number | null;
}

export interface MiniPrefs {
  width: number;
}

/**
 * Mini mode: a narrow column docked to the left edge of the screen that shows
 * Claude using the brain while the user works beside it.
 *
 * macOS gives an app no way to reserve screen space, so this floats over
 * whatever is underneath rather than pushing it aside. Everything else follows
 * from not getting in the way: it never takes focus, even when clicked; it
 * follows the user across Spaces and over full-screen apps; and it folds to a
 * strip the width of the main window's rail.
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
  private readonly redock = (): void => this.applyBounds(false);

  constructor(
    private prefs: MiniPrefs,
    private readonly persist: (patch: Partial<MiniPrefs>) => void,
    private readonly changed: () => void
  ) {
    screen.on('display-metrics-changed', this.redock);
    screen.on('display-removed', this.redock);
  }

  get visible(): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  get collapsed(): boolean {
    return this.folded;
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
    this.peeking = false;
    if (this.folded !== collapsed) {
      this.folded = collapsed;
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
    if (this.folded) return;
    const next = clampWidth(width, this.workArea());
    if (next === this.prefs.width) return;
    this.prefs = { ...this.prefs, width: next };
    this.applyBounds(false);
    // A drag fires continuously; write settings once it settles.
    clearTimeout(this.widthTimer);
    this.widthTimer = setTimeout(() => this.persist({ width: next }), 400);
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
      ...dockBounds(this.workArea(), this.prefs.width, this.folded),
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
    const folded = this.folded && !this.peeking;
    this.win.setBounds(dockBounds(this.workArea(), this.prefs.width, folded), animate);
  }
}

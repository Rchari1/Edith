import { EventEmitter } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import { classifyTranscript } from '../parser/classify.js';
import { parseSession, parseSubagent } from '../parser/parse-session.js';
import type { Session } from '../types.js';

export function defaultProjectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

export interface WatcherOptions {
  projectsRoot?: string;
  /** Quiet period after the last write before a session counts as settled. */
  settleMs?: number;
}

/**
 * Watches Claude Code's transcript directory.
 *
 * Transcripts are appended to continuously while a session is live, so we do
 * not distill on every write - we wait for a quiet period and treat that as
 * the session having settled. This is also why the parser tolerates malformed
 * trailing lines: we frequently read a file mid-write.
 */
export class SessionWatcher extends EventEmitter {
  readonly projectsRoot: string;
  private readonly settleMs: number;
  private watcher: FSWatcher | null = null;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(opts: WatcherOptions = {}) {
    super();
    this.projectsRoot = opts.projectsRoot ?? defaultProjectsRoot();
    this.settleMs = opts.settleMs ?? 8000;
  }

  /** Every main-session transcript currently on disk. Used for backfill. */
  async scanExisting(): Promise<Array<{ file: string; projectSlug: string; sessionId: string }>> {
    const found: Array<{ file: string; projectSlug: string; sessionId: string }> = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'memory') continue;
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const kind = classifyTranscript(this.projectsRoot, full);
          if (kind.kind === 'session') {
            found.push({ file: full, projectSlug: kind.projectSlug, sessionId: kind.sessionId });
          }
        }
      }
    };
    await walk(this.projectsRoot);
    return found;
  }

  /** Parse one session and attach any subagent transcripts it spawned. */
  async loadSession(file: string, projectSlug: string, sessionId: string): Promise<Session> {
    const session = await parseSession(file, projectSlug, sessionId);
    const subDir = path.join(path.dirname(file), sessionId, 'subagents');
    const subFiles = await collectJsonl(subDir);
    for (const sub of subFiles) {
      const kind = classifyTranscript(this.projectsRoot, sub);
      if (kind.kind !== 'subagent') continue;
      try {
        session.subagents.push(await parseSubagent(sub, kind.agentId));
      } catch {
        // A bad subagent file must not sink the parent session.
      }
    }
    return session;
  }

  async start(): Promise<void> {
    await fs.mkdir(this.projectsRoot, { recursive: true });

    this.watcher = chokidar.watch(this.projectsRoot, {
      ignoreInitial: true,
      persistent: true,
      // Deliberately no awaitWriteFinish. It suppresses events until a file
      // stops changing, which is the opposite of the live "Claude is writing
      // right now" signal, and it can defer indefinitely while a session is
      // actively appending. Settling is debounced by scheduleSettle below, and
      // the parser already tolerates a half-written trailing line, so nothing
      // here needs to wait for the file to go quiet.
      ignored: (p: string) => p.includes(`${path.sep}memory${path.sep}`)
    });

    const onChange = (file: string) => {
      const kind = classifyTranscript(this.projectsRoot, file);
      if (kind.kind !== 'session') return;
      this.emit('activity', { sessionId: kind.sessionId, file });
      this.scheduleSettle(file, kind.projectSlug, kind.sessionId);
    };

    this.watcher.on('add', onChange);
    this.watcher.on('change', onChange);
    this.watcher.on('error', (err) => this.emit('error', err));

    // Resolve only once chokidar has finished its initial scan. Returning
    // earlier leaves a window where a session written right after launch is
    // silently missed. The timeout keeps a slow or huge directory from
    // hanging startup - we would rather watch late than not start at all.
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 10_000);
      timer.unref?.();
      this.watcher?.once('ready', done);
    });
  }

  private scheduleSettle(file: string, projectSlug: string, sessionId: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void (async () => {
        try {
          const session = await this.loadSession(file, projectSlug, sessionId);
          this.emit('session-settled', session);
        } catch (err) {
          this.emit('error', err);
        }
      })();
    }, this.settleMs);

    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    await this.watcher?.close();
    this.watcher = null;
  }
}

async function collectJsonl(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  await walk(dir);
  return out;
}

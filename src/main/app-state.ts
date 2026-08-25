import path from 'node:path';
import { EventEmitter } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';
import { Vault } from '../core/vault/vault.js';
import { SqliteSearchProvider } from '../core/vault/search.js';
import { BrainServer, findFreePort } from '../core/mcp/server.js';
import { SessionWatcher } from '../core/watcher/index.js';
import { Distiller } from '../core/distiller/distiller.js';
import { DistillQueue } from '../core/distiller/queue.js';
import { registerAll, type RegistrationResult } from '../core/onboarding/register.js';
import { loadSettings, saveSettings, resolveApiKey, type Settings } from './settings.js';
import type { BrainEvent, Session } from '../core/types.js';
import type { Graph } from '../core/vault/vault.js';

export interface BrainStatus {
  serverUrl: string | null;
  port: number | null;
  noteCount: number;
  vaultPath: string;
  hasApiKey: boolean;
  registrations: RegistrationResult[];
  queue: { total: number; done: number; failed: number; pending: number };
  watching: string;
}

/**
 * Owns every long-lived piece and wires them together.
 *
 * Deliberately separate from Electron so the whole pipeline can be constructed
 * and exercised without a browser window.
 */
export class AppState extends EventEmitter {
  settings!: Settings;
  vault!: Vault;
  server!: BrainServer;
  watcher!: SessionWatcher;
  queue: DistillQueue | null = null;
  registrations: RegistrationResult[] = [];

  private settingsFile: string;
  private backfilling = false;

  constructor(private readonly userDataDir: string) {
    super();
    this.settingsFile = path.join(userDataDir, 'settings.json');
  }

  async start(): Promise<void> {
    this.settings = await loadSettings(this.settingsFile, this.userDataDir);

    this.vault = new Vault(
      this.settings.vaultPath,
      new SqliteSearchProvider(path.join(this.settings.vaultPath, 'index.db'))
    );
    await this.vault.init();

    const port = await findFreePort(this.settings.port);
    this.server = new BrainServer(this.vault, { port });
    this.server.bus.onEvent((e) => this.emit('event', e));
    await this.server.start();

    // Register with whatever Claude surfaces exist. A port change rewrites them.
    this.registrations = await registerAll(this.server.url!);
    for (const r of this.registrations) {
      if (r.status === 'failed') {
        this.push({
          type: 'status',
          message: `Could not register with ${r.target}: ${r.detail}`,
          level: 'warn',
          at: Date.now()
        });
      }
    }

    this.buildQueue();

    this.watcher = new SessionWatcher({ settleMs: 8000 });
    this.watcher.on('session-settled', (session: Session) => {
      this.push({ type: 'status', message: `Session settled: ${session.title ?? session.id.slice(0, 8)}`, level: 'info', at: Date.now() });
      if (this.settings.autoDistill) this.queue?.enqueue(session);
    });
    this.watcher.on('error', (err: unknown) => {
      this.push({
        type: 'status',
        message: `Watcher error: ${err instanceof Error ? err.message : String(err)}`,
        level: 'error',
        at: Date.now()
      });
    });
    await this.watcher.start();

    this.push({ type: 'status', message: 'SecondBrain ready', level: 'info', at: Date.now() });
  }

  /** Rebuild the distill queue, e.g. after the API key or model changes. */
  private buildQueue(): void {
    this.queue?.stop();
    this.queue = null;

    const apiKey = resolveApiKey(this.settings);
    if (!apiKey) {
      this.push({
        type: 'status',
        message: 'No API key set - ingest is paused. Notes can still be saved by Claude.',
        level: 'warn',
        at: Date.now()
      });
      return;
    }

    const client = new Anthropic({ apiKey });
    const distiller = new Distiller(client, this.vault, {
      model: this.settings.model,
      minTurns: this.settings.minTurns
    });
    const queue = new DistillQueue(distiller);

    queue.on('done', (result: { noteIds: string[]; skipped: boolean }) => {
      if (!result.skipped && result.noteIds.length) {
        this.push({ type: 'saved', noteIds: result.noteIds, at: Date.now() });
      }
      this.emit('vault-changed');
    });
    queue.on('failed', (info: { sessionId: string; error: string }) => {
      this.push({
        type: 'status',
        message: `Distill failed for ${info.sessionId.slice(0, 8)}: ${info.error}`,
        level: 'error',
        at: Date.now()
      });
    });
    queue.on('progress', (stats: { done: number; total: number }) => {
      this.push({
        type: 'ingest-progress',
        done: stats.done,
        total: stats.total,
        label: 'distilling',
        at: Date.now()
      });
    });

    this.queue = queue;
  }

  /** Ingest every session already on disk. One-time, resumable, safe to re-run. */
  async backfill(): Promise<{ queued: number; skipped: number }> {
    if (this.backfilling) return { queued: 0, skipped: 0 };
    this.backfilling = true;
    try {
      const found = await this.watcher.scanExisting();
      let queued = 0;
      let skipped = 0;

      for (const entry of found) {
        if (this.vault.hasSession(entry.sessionId)) {
          skipped++;
          continue;
        }
        try {
          const session = await this.watcher.loadSession(entry.file, entry.projectSlug, entry.sessionId);
          if (session.turns.length < this.settings.minTurns) {
            skipped++;
            continue;
          }
          this.queue?.enqueue(session);
          queued++;
        } catch {
          skipped++;
        }
      }

      this.push({
        type: 'status',
        message: `Backfill: ${queued} session(s) queued, ${skipped} skipped`,
        level: 'info',
        at: Date.now()
      });
      return { queued, skipped };
    } finally {
      this.backfilling = false;
    }
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const needsQueueRebuild =
      ('apiKey' in patch && patch.apiKey !== this.settings.apiKey) ||
      ('model' in patch && patch.model !== this.settings.model) ||
      ('minTurns' in patch && patch.minTurns !== this.settings.minTurns);

    this.settings = { ...this.settings, ...patch };
    await saveSettings(this.settingsFile, this.settings);
    if (needsQueueRebuild) this.buildQueue();
    return this.settings;
  }

  graph(): Graph {
    return this.vault.graph();
  }

  status(): BrainStatus {
    return {
      serverUrl: this.server?.url ?? null,
      port: this.server?.port ?? null,
      noteCount: this.vault?.size() ?? 0,
      vaultPath: this.settings.vaultPath,
      hasApiKey: Boolean(resolveApiKey(this.settings)),
      registrations: this.registrations,
      queue: this.queue?.stats() ?? { total: 0, done: 0, failed: 0, pending: 0 },
      watching: this.watcher?.projectsRoot ?? ''
    };
  }

  private push(event: BrainEvent): void {
    this.server?.bus.emitEvent(event) ?? this.emit('event', event);
  }

  async stop(): Promise<void> {
    this.queue?.stop();
    await this.watcher?.stop();
    await this.server?.stop();
    this.vault?.close();
  }
}

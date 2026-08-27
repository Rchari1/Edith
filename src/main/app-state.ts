import path from 'node:path';
import { EventEmitter } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';
import { Vault } from '../core/vault/vault.js';
import { SqliteSearchProvider } from '../core/vault/search.js';
import { BrainServer, findFreePort } from '../core/mcp/server.js';
import { SessionWatcher } from '../core/watcher/index.js';
import { WatcherSessionSource } from '../core/sessions/source.js';
import { Forge } from '../core/forge/forge.js';
import { installProposal, uninstallProposal } from '../core/forge/install.js';
import { seedStarterSkills } from '../core/forge/starter.js';
import type { SkillProposal } from '../core/forge/types.js';
import { createThrottle } from '../core/util/throttle.js';
import chokidar, { type FSWatcher } from 'chokidar';
import { Distiller } from '../core/distiller/distiller.js';
import { DistillQueue } from '../core/distiller/queue.js';
import { registerAll, type RegistrationResult } from '../core/onboarding/register.js';
import { registerSessionHook, type HookResult } from '../core/onboarding/hooks.js';
import { installSkill } from '../core/onboarding/skill.js';
import { importFiles, importText, type ImportSummary } from '../core/importer/index.js';
import fs from 'node:fs/promises';
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
  /** Whether the SessionStart primer hook is installed, and where. */
  hook: { status: string; configPath: string; detail?: string } | null;
  /** When a Claude session last wrote to a transcript, so the UI can say "seen 2m ago". */
  lastSessionAt: number | null;
}

/**
 * Owns every long-lived piece and wires them together.
 *
 * Deliberately separate from Electron so the whole pipeline can be constructed
 * and exercised without a browser window.
 */
/**
 * assets/ sits beside the built output in dev and inside the bundle when
 * packaged. __dirname, not import.meta.url: the main process builds as
 * CommonJS, where import.meta does not exist - and tsc cannot catch that
 * because it does not know the output format.
 */
function assetsRoot(): string {
  return path.resolve(__dirname, '../../assets');
}

export class AppState extends EventEmitter {
  settings!: Settings;
  vault!: Vault;
  forge!: Forge;
  private forgeWatcher: FSWatcher | null = null;
  /** Editors write in bursts; one reload per burst is enough. */
  private readonly forgeReloadThrottle = createThrottle(400);
  server!: BrainServer;
  watcher!: SessionWatcher;
  queue: DistillQueue | null = null;
  distiller: Distiller | null = null;
  registrations: RegistrationResult[] = [];
  hookRegistration: HookResult | null = null;

  private settingsFile: string;
  private backfilling = false;
  /** A busy transcript writes constantly; surface at most one heartbeat per session per 1.5s. */
  private readonly activityThrottle = createThrottle(1500);
  private lastSessionAt: number | null = null;

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

    this.forge = new Forge(this.settings.vaultPath);
    await this.forge.init();

    // Offer the bundled starter kit. Once each, as proposals rather than
    // installed skills - an empty forge explains nothing, but putting files on
    // someone's machine unasked is not the answer either.
    try {
      const seeded = await seedStarterSkills(
        this.forge,
        path.join(assetsRoot(), 'starter-skills'),
        this.settings.vaultPath
      );
      if (seeded.seeded.length) {
        this.push({
          type: 'status',
          message: `${seeded.seeded.length} starter skill(s) waiting in the forge`,
          level: 'info',
          at: Date.now()
        });
      }
    } catch {
      // A missing or unreadable bundle must never block startup.
    }

    // Proposals are plain markdown and are advertised as editable in any
    // editor, so the forge has to notice edits made outside the app - the same
    // courtesy the vault already extends to notes.
    this.forgeWatcher = chokidar.watch(this.forge.dir, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p: string) => p.endsWith('~') || p.includes('.tmp-')
    });
    const reloadForge = () => {
      if (!this.forgeReloadThrottle('forge')) return;
      void this.forge.reload().then(() => this.emit('forge-changed'));
    };
    this.forgeWatcher.on('add', reloadForge);
    this.forgeWatcher.on('change', reloadForge);
    this.forgeWatcher.on('unlink', reloadForge);

    // Constructed before the server so its sessions can be exposed as tools;
    // watching itself does not begin until start() below.
    this.watcher = new SessionWatcher({ settleMs: 8000 });

    const port = await findFreePort(this.settings.port);
    this.server = new BrainServer(
      this.vault,
      { port },
      new WatcherSessionSource(this.watcher, this.vault),
      this.forge
    );
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

    // A SessionStart hook injects a primer describing the brain. Without it,
    // Claude only learns Edith exists once it is already considering a tool -
    // which is the moment it needs prompting, not after.
    this.hookRegistration = await registerSessionHook(
      `http://127.0.0.1:${this.server.port}/context`
    );
    if (this.hookRegistration.status === 'failed') {
      this.push({
        type: 'status',
        message: `Could not install the session hook: ${this.hookRegistration.detail}`,
        level: 'warn',
        at: Date.now()
      });
    }

    // The /edith skill lives entirely in its own directory under
    // ~/.claude/skills, so unlike the config writes there is nothing to merge.
    try {
      const skillSource = path.join(assetsRoot(), 'skill', 'edith');
      const skill = await installSkill(skillSource);
      if (skill.status === 'failed') {
        this.push({
          type: 'status',
          message: `Could not install the /edith command: ${skill.detail}`,
          level: 'warn',
          at: Date.now()
        });
      }
    } catch {
      // Never let an optional convenience block startup.
    }

    this.buildQueue();

    // A live session writes to its transcript constantly. Surface that as a
    // heartbeat so the app visibly reacts while Claude is working, even when
    // the brain itself is not being queried - but throttle it hard.
    this.watcher.on('activity', ({ sessionId, file }: { sessionId: string; file: string }) => {
      this.lastSessionAt = Date.now();
      if (!this.activityThrottle(sessionId)) return;
      const project = path.basename(path.dirname(file));
      this.push({ type: 'session-active', sessionId, project, at: Date.now() });
    });

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

    this.push({ type: 'status', message: 'Edith ready', level: 'info', at: Date.now() });
  }

  /** Rebuild the distill queue, e.g. after the API key or model changes. */
  private buildQueue(): void {
    this.queue?.stop();
    this.queue = null;
    this.distiller = null;

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
    this.distiller = distiller;
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

  /**
   * Bring outside content into the brain.
   *
   * 'verbatim' keeps the user's own writing exactly as-is - importing an
   * Obsidian vault should not rewrite it. 'distill' runs the same extraction
   * used on sessions, for raw material like meeting notes or docs.
   */
  async importPaths(files: string[], mode: 'verbatim' | 'distill'): Promise<ImportSummary> {
    if (mode === 'verbatim' || !this.distiller) {
      if (mode === 'distill' && !this.distiller) {
        this.push({
          type: 'status',
          message: 'No API key - imported files as-is instead of distilling.',
          level: 'warn',
          at: Date.now()
        });
      }
      const summary = await importFiles(this.vault, files);
      this.reportImport(summary.imported, summary.failed);
      return summary;
    }

    const results: ImportSummary['results'] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(file, 'utf8');
        const label = file.split('/').pop() ?? file;
        const result = await this.distiller.distillText(label, raw);
        if (result.skipped) {
          results.push({ file, status: 'skipped', detail: result.reason });
        } else {
          for (const id of result.noteIds) results.push({ file, id, status: 'imported' });
        }
      } catch (err) {
        results.push({ file, status: 'failed', detail: err instanceof Error ? err.message : String(err) });
      }
    }

    const summary: ImportSummary = {
      imported: results.filter((r) => r.status === 'imported').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
      results
    };
    this.reportImport(summary.imported, summary.failed);
    return summary;
  }

  async importPastedText(
    title: string,
    body: string,
    mode: 'verbatim' | 'distill'
  ): Promise<{ ids: string[] }> {
    if (mode === 'distill' && this.distiller) {
      const result = await this.distiller.distillText(title || 'Pasted text', body);
      this.reportImport(result.noteIds.length, 0);
      if (result.skipped && result.noteIds.length === 0) {
        throw new Error(result.reason ?? 'Nothing durable found in that text.');
      }
      return { ids: result.noteIds };
    }
    const { id } = await importText(this.vault, title, body);
    this.reportImport(1, 0);
    return { ids: [id] };
  }

  private reportImport(imported: number, failed: number): void {
    this.push({
      type: 'status',
      message: failed
        ? `Imported ${imported} note(s), ${failed} failed`
        : `Imported ${imported} note(s)`,
      level: failed ? 'warn' : 'info',
      at: Date.now()
    });
    this.emit('vault-changed');
  }

  /**
   * Accept a proposal: install it as a real skill, then record the decision.
   *
   * Install first. If the write fails or collides with a skill Edith did not
   * create, the proposal stays in the queue rather than being marked accepted
   * for something that never landed on disk.
   */
  async acceptSkill(id: string): Promise<{ ok: boolean; detail?: string; proposal?: SkillProposal }> {
    const proposal = this.forge.get(id);
    if (!proposal) return { ok: false, detail: 'no such proposal' };

    const result = await installProposal(proposal);
    if (result.status !== 'installed') {
      return { ok: false, detail: result.detail ?? result.status };
    }

    const updated = await this.forge.setStatus(id, 'accepted', result.dir);
    this.push({
      type: 'status',
      message: `Forged skill: ${proposal.title} - available in a new Claude session`,
      level: 'info',
      at: Date.now()
    });
    this.emit('forge-changed');
    return { ok: true, ...(updated ? { proposal: updated } : {}) };
  }

  async rejectSkill(id: string): Promise<{ ok: boolean }> {
    const updated = await this.forge.setStatus(id, 'rejected');
    this.emit('forge-changed');
    return { ok: Boolean(updated) };
  }

  /** Undo an acceptance: remove the installed skill and requeue the proposal. */
  async undoSkill(id: string): Promise<{ ok: boolean; detail?: string }> {
    const proposal = this.forge.get(id);
    if (!proposal) return { ok: false, detail: 'no such proposal' };
    if (proposal.status === 'accepted') {
      const result = await uninstallProposal(id);
      if (result.status === 'conflict') return { ok: false, detail: result.detail ?? 'conflict' };
    }
    await this.forge.restore(id);
    this.emit('forge-changed');
    return { ok: true };
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
      watching: this.watcher?.projectsRoot ?? '',
      hook: this.hookRegistration
        ? {
            status: this.hookRegistration.status,
            configPath: this.hookRegistration.configPath,
            ...(this.hookRegistration.detail ? { detail: this.hookRegistration.detail } : {})
          }
        : null,
      lastSessionAt: this.lastSessionAt
    };
  }

  private push(event: BrainEvent): void {
    // emitEvent returns void, so `??` here always fired the fallback too and
    // every status event reached the renderer twice.
    if (this.server) this.server.bus.emitEvent(event);
    else this.emit('event', event);
  }

  async stop(): Promise<void> {
    this.queue?.stop();
    await this.forgeWatcher?.close();
    this.forgeWatcher = null;
    await this.watcher?.stop();
    await this.server?.stop();
    this.vault?.close();
  }
}

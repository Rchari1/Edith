import express from 'express';
import type { Server as HttpServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Vault } from '../vault/vault.js';
import { BrainEventBus } from './events.js';
import { registerBrainTools } from './tools.js';
import type { SessionSource } from '../sessions/source.js';
import type { Forge } from '../forge/forge.js';
import { buildPrimer, buildHookPayload } from '../context/primer.js';
import { RetrievalStats } from './stats.js';

export const DEFAULT_PORT = 4319;

export interface BrainServerOptions {
  port?: number;
  host?: string;
}

/** Is this TCP port free to bind? */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, host);
  });
}

/** First free port at or after `start`. Onboarding rewrites configs to whatever we land on. */
export async function findFreePort(start = DEFAULT_PORT, attempts = 50): Promise<number> {
  for (let i = 0; i < attempts; i++) {
    const port = start + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${start}-${start + attempts}`);
}

/**
 * Edith's MCP endpoint, hosted inside the desktop app.
 *
 * Runs in stateless mode: each POST gets a fresh McpServer and transport.
 * That keeps concurrent Claude sessions from colliding on request ids, and
 * costs nothing because all real state lives in the Vault, not the server.
 */
export class BrainServer {
  readonly bus = new BrainEventBus();
  /** Is Claude reaching for the brain on its own? The number that matters. */
  readonly stats = new RetrievalStats();
  private http: HttpServer | null = null;
  private boundPort: number | null = null;
  private readonly callLog: Array<{ method: string; tool?: string; at: number }> = [];

  constructor(
    private readonly vault: Vault,
    private readonly opts: BrainServerOptions = {},
    private readonly sessions?: SessionSource,
    private readonly forge?: Forge
  ) {}

  get port(): number | null {
    return this.boundPort;
  }

  get url(): string | null {
    return this.boundPort ? `http://127.0.0.1:${this.boundPort}/mcp` : null;
  }

  async start(): Promise<number> {
    this.stats.attach(this.bus);
    // Beside the vault, not inside notes/: derived machine state, never synced.
    this.stats.persistTo(path.join(this.vault.root, '.edith', 'retrieval.json'));
    const host = this.opts.host ?? '127.0.0.1';
    const port = this.opts.port ?? (await findFreePort());

    const app = express();
    app.use(express.json({ limit: '8mb' }));

    app.get('/health', (_req, res) => {
      res.json({ ok: true, notes: this.vault.size(), port: this.boundPort });
    });

    // Recent activity, for diagnosing "Claude is connected but nothing lit up".
    // Distinguishes "no tool call arrived" from "a call arrived and matched nothing".
    /*
     * Emits a Claude Code SessionStart hook payload directly, so the hook
     * itself is a bare curl with no script file to go stale or lose its
     * executable bit. If Edith is not running the curl fails, the hook
     * produces nothing, and the session starts normally.
     */
    app.get('/context', (_req, res) => {
      res.type('application/json').send(buildHookPayload(buildPrimer(this.vault)));
    });

    /** The same primer as plain text, for CLAUDE.md and for debugging. */
    app.get('/context.txt', (_req, res) => {
      res.type('text/plain').send(buildPrimer(this.vault));
    });

    /** Everything a status line needs, in one cheap call. */
    app.get('/session/:id', (req, res) => {
      const id = String(req.params.id ?? '');
      // Polling is itself proof this session is live; it makes tool-call
      // attribution work without waiting on a transcript write.
      if (id && id !== 'unknown') this.stats.markLive(id);
      res.json({
        ok: true,
        notes: this.vault.size(),
        session: this.stats.forSession(id)
      });
    });

    app.get('/stats', (_req, res) => {
      res.json(this.stats.report());
    });

    app.get('/events', (_req, res) => {
      res.json({ calls: this.callLog.slice(-50), events: this.bus.recent(50) });
    });

    app.post('/mcp', async (req, res) => {
      this.recordCall(req.body);
      const server = new McpServer({ name: 'edith', version: '0.1.0' });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

      res.on('close', () => {
        void transport.close();
        void server.close();
      });

      try {
        registerBrainTools(server, this.vault, this.bus, this.sessions, this.forge);
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        this.bus.emitEvent({
          type: 'status',
          message: `MCP request failed: ${err instanceof Error ? err.message : String(err)}`,
          level: 'error',
          at: Date.now()
        });
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null
          });
        }
      }
    });

    // Stateless mode has no server-initiated stream to resume.
    const methodNotAllowed = (_req: express.Request, res: express.Response) => {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' },
        id: null
      });
    };
    app.get('/mcp', methodNotAllowed);
    app.delete('/mcp', methodNotAllowed);

    await new Promise<void>((resolve, reject) => {
      const server = app.listen(port, host, () => {
        this.http = server;
        this.boundPort = port;
        resolve();
      });
      server.once('error', reject);
    });

    this.bus.emitEvent({
      type: 'status',
      message: `Brain listening on ${this.url}`,
      level: 'info',
      at: Date.now()
    });
    return port;
  }

  /** Record every inbound JSON-RPC call so we can tell silence from a miss. */
  private recordCall(body: unknown): void {
    const msgs = Array.isArray(body) ? body : [body];
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue;
      const rpc = m as { method?: string; params?: { name?: string } };
      if (!rpc.method) continue;
      const entry = {
        method: rpc.method,
        ...(rpc.params?.name ? { tool: rpc.params.name } : {}),
        at: Date.now()
      };
      this.callLog.push(entry);
      if (this.callLog.length > 200) this.callLog.shift();
      // eslint-disable-next-line no-console
      console.log(`[mcp] ${entry.method}${entry.tool ? ` ${entry.tool}` : ''}`);
    }
  }

  async stop(): Promise<void> {
    this.stats.flush();
    const server = this.http;
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    // close() waits for every open connection to end, so a client holding one
    // open - an MCP client's keep-alive, say - would stall shutdown indefinitely.
    server.closeAllConnections();
    await closed;
    this.http = null;
    this.boundPort = null;
  }
}

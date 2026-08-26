# SecondBrain Development Plan

**Date:** 2026-08-25
**Status:** Draft — pending Kate's review
**Supersedes:** the implicit plan in `docs/superpowers/specs/2026-08-25-secondbrain-design.md` (that doc remains the accurate v1 record; this plan reorients development around the new product model)

## Product model

Obsidian's model, adapted for Claude.

- **Free local core.** SecondBrain is a local MCP server. All user data lives on the user's machine as inspectable, portable files — Markdown notes as the source of truth, SQLite strictly as a rebuildable derived index. No data leaves the machine by default. If the company disappears, the user keeps a usable folder of files. Packaged as an MCPB desktop extension for one-click install in Claude Desktop; addable to Claude Code via `claude mcp add`. Transports: stdio for local clients, plus a Streamable HTTP mode so advanced users can self-host and add it as a claude.ai custom connector.
- **Paid: end-to-end-encrypted sync.** A hosted relay that syncs a brain across a user's devices. The server stores and relays ciphertext only; keys never leave the client. We must be able to say truthfully that we cannot read user data. Licensing is a signed token the local server caches, valid offline for weeks; the license check transmits nothing but a license ID.
- **The Claude-specific differentiator.** Opinionated memory capture and retrieval that works for people who don't know how to prompt for it, and stays out of the way of developers who do: a small set of well-defined tools with load-bearing descriptions, bundled skills/prompts for common workflows, and sensible defaults for what gets remembered automatically vs. on request.

**Explicit non-goal for now:** a hosted-plaintext tier for mobile/browser access. Recorded here as a possible future *opt-out* from E2E; nothing in the sync design may depend on the server ever seeing plaintext, and nothing needs to be designed for it now.

## Milestones

| # | Milestone | Delivers |
|---|---|---|
| A | Local core hardened + file format finalized | Headless server, portable vault, format v1 frozen |
| B | MCPB packaging + install path | One-click Claude Desktop install; clean `claude mcp add` |
| C | Claude-specific tool surface + defaults | The differentiator: capture/recall done right |
| D | Licensing | Signed offline-tolerant license tokens |
| E | E2E sync service | The monetized layer |

Decision points marked **[K*n*]** require Kate's sign-off before they are locked (collected in the Decision Log at the end).

---

## Milestone A — Local core hardened, file format finalized

The core becomes a standalone thing that outlives any UI, and the on-disk format becomes something we can promise stability for.

**Scope**

- **Extract a headless server.** A `secondbrain serve` entry point that runs vault + index + watcher + distiller + MCP surface with no Electron. Transports: `--stdio` and `--http [--port]`. The Electron app becomes a *client* of this server (graph UI subscribes to the event stream) rather than its host. This is the seam every later milestone depends on: MCPB spawns the headless server; sync runs inside it; the app visualizes it.
- **Single-writer architecture [K4].** Claude Desktop and Claude Code may each spawn a server. Proposed: a singleton daemon owns the vault (watcher, distill queue, index); stdio spawns are thin shims that proxy to the daemon over a local socket, and the first shim to start becomes/starts the daemon. Alternative: fully multi-instance with SQLite WAL + advisory locks and an idempotent distill queue. The shim/daemon split is recommended — it also keeps the app's live "lights up" events working from a single event source.
- **Portable vault location [K1].** Move the vault out of Electron `userData` to a visible, user-configurable folder (proposed default: `~/SecondBrain`). One-time migration of existing vaults.
- **File format v1 freeze [K2] [K3].** Schema-version the frontmatter (`format: 1`), move `created`/`updated` to full RFC3339 UTC timestamps (day-granularity cannot drive sync), confirm the storage split: Markdown = source of truth and the only thing that ever syncs; `index.db` = derived, rebuildable, never syncs; per-vault machine state lives in `.secondbrain/` inside the vault, excluded from sync. Publish the format as a short spec (`docs/FORMAT.md`) — this is the "you keep a usable folder" promise in writing.
- **Event stream interface.** The in-process `BrainEventBus` gets an out-of-process form (SSE on the local HTTP endpoint) so the UI's highlighting survives the server extraction.
- **Registration hygiene.** Stop rewriting Claude configs on every boot with a moving port. Stable configuration; config writes become explicit onboarding actions.
- **Dev environment hardening.** `engines` field + `.nvmrc` (Node ≥ 22.12 — system Node 18 breaks Vite 7), dev script guards against inherited `ELECTRON_RUN_AS_NODE` (both bit us on 2026-08-25).

**Open questions**

- Daemon lifecycle: who stops it? (proposal: idle timeout when no clients and queue empty; the app pins it while open)
- Does the slug remain the note's identity across devices, or do we add a UUID? (part of [K2] — recommendation: slug stays the identity; sync treats same-slug as same-note and merges, which matches the existing "deepen, don't clobber" semantics)
- Windows/Linux support level for the daemon socket (named pipe vs unix socket).

**Done means**

- `secondbrain serve --stdio` passes the existing MCP test suite with Electron not installed.
- `claude mcp add` against the built server works on a clean machine.
- Vault lives in the portable location; migration verified on a real pre-existing vault.
- `docs/FORMAT.md` exists; all format decisions in it are marked resolved, none pending.
- Two concurrent clients (Desktop + Code) produce no duplicate distills, no index corruption.
- All tests green, including new transport + concurrency tests.

---

## Milestone B — MCPB packaging + install path

**Scope**

- Package the headless server as an MCPB extension: manifest, node entry point, user-config surface (vault path; Anthropic API key for distillation, stored via the OS keychain mechanism MCPB provides — not in plaintext settings).
- One-click install in Claude Desktop; the extension spawns the stdio shim.
- Keep `claude mcp add secondbrain -- <command>` as the documented Claude Code path; publish the server so that command exists (npm package or bundled binary — decide within the milestone).
- Documented self-host path: `secondbrain serve --http` behind the user's own TLS, added as a claude.ai custom connector. (Streamable HTTP already exists in `core/mcp/server.ts`; this mode needs auth — at minimum a bearer token — before it is documented for network exposure.)
- The desktop app remains a separate optional install that connects to whichever server instance is running.

**Open questions**

- Signing/notarization requirements for MCPB distribution.
- Does the MCPB build bundle `better-sqlite3` prebuilds per-platform, or do we swap to a pure-JS/WASM SQLite to remove the native dependency from the install path entirely?
- Auto-update story for the extension.

**Done means**

- A fresh machine with only Claude Desktop: install the `.mcpb`, restart, and the brain tools appear and work — zero terminal use.
- A fresh machine with Claude Code: one documented command adds the server.
- Self-host doc validated end-to-end with a claude.ai custom connector.

---

## Milestone C — Claude-specific tool surface + defaults

This is the differentiator: better than "point Claude at a folder" because the tool surface is opinionated about *memory*, not generic CRUD.

**Scope**

- **Proposed tool set [K7]** (details in `docs/ARCHITECTURE.md`):
  - `remember` — capture an insight (successor of `save_note`; same deepen-not-clobber semantics)
  - `recall` — search; with no query, orient on recent notes (absorbs `search_brain` + `list_notes`)
  - `read_note` — full note by id (unchanged; the recall→read two-step is what makes "considered vs used" visible, keep it)
  - `link` — assert a connection between two notes, with an optional reason appended to both
  - `summarize` ships as a bundled MCP prompt/skill, **not** a tool — synthesis belongs to the calling model; a tool would need a server-side API call and adds latency for something Claude does better in-context.
- Rewrite every description against a rubric: when to reach for it, when *not* to, with trigger phrases. Evaluate empirically (a small harness that replays realistic prompts against Claude with the tools attached and scores tool-selection).
- Bundled skills/prompts for common workflows: "start of session — check the brain", "end of session — capture decisions", "weekly digest".
- **Sensible defaults for capture:** auto-distillation stays default-on with the min-turns threshold; explicit `remember` always available; a visible, simple policy setting (off / conservative / standard) for what gets remembered automatically. Developers who want manual-only get it in one switch.

**Open questions**

- Tool-name migration: aliases for the old names during a deprecation window, or clean break while the user base is tiny? (recommendation: clean break now, before MCPB distribution)
- Should `recall` results include an explicit "confidence / staleness" hint so Claude weighs old notes appropriately?

**Done means**

- The tool-selection harness shows Claude choosing the right tool on the scenario suite without prompt coaching.
- A first-run user with zero configuration gets useful capture and recall in their first session.
- The bundled prompts ship in the MCPB and are visible in Claude Desktop.

---

## Milestone D — Licensing

**Scope**

- Signed license token (Ed25519, public key embedded in the client): `{ licenseId, plan, issuedAt, expiresAt }` with a multi-week offline grace window (proposed: 45 days).
- Local server caches the token; verification is offline against the embedded key.
- Renewal ping sends **only** the license ID — no machine identifiers, no vault metadata, nothing else. This is a stated privacy property, tested for (assert on the outbound request body).
- License gates sync features only; the local core never checks a license.
- Account/payment service itself is out of scope here beyond the token-issuing endpoint contract.

**Open questions**

- Device count enforcement: none, honor-system soft cap, or token-embedded cap? (privacy tension: counting devices means identifying devices)
- Grace-window length and the UX of expiry (sync pauses; local core must be visibly unaffected).

**Done means**

- Sync refuses without a valid token; local core provably never phones home (network-layer test).
- A machine offline for the full grace window keeps syncing to its local queue and recovers cleanly.
- The renewal request contains the license ID and nothing else, verified by test.

---

## Milestone E — E2E-encrypted sync service

Design first, then build. **Do not start implementation until the encryption scheme [K5] and conflict model [K6] are signed off.** Interface-level design is in `docs/ARCHITECTURE.md`; the threat model lives there too.

**Scope**

- Client `SyncEngine` inside the headless server: vault changes → per-note encrypted envelopes → relay; pull → decrypt → merge.
- Relay service: stores opaque blobs keyed by opaque ids; `push`, `pull-since-cursor`, per-account storage; knows account id, license id, blob sizes/counts/timestamps — and nothing else.
- Key management: client-generated root key, encoded as a recovery phrase; per-vault key wrapped by the root key; keys never transmitted. New-device enrollment via recovery phrase (v1).
- Conflict resolution: proposed version-vector LWW per note with conflict copies for concurrent body edits (`<id>.sync-conflict-<date>.md`) — inspectable, Obsidian-familiar, no black-box merges.
- Threat model documented and published: what a fully compromised server can and cannot learn.
- Note the future hosted-plaintext opt-out here only as a pointer; no design work.

**Open questions**

- Metadata minimization depth: pad blob sizes? batch pushes to blunt timing analysis? (cost vs. benefit — decide after threat-model review)
- Attachment/large-file story, or notes-only in v1 (recommendation: notes-only).
- Relay hosting/stack — deliberately unconstrained until the client-side design is signed off.

**Done means**

- Two devices converge from arbitrary divergence; concurrent edits never lose data (property-based test on the merge).
- The relay's stored bytes are demonstrably ciphertext; a red-team read of the database yields sizes and timestamps only.
- Threat model reviewed and published.
- Sync survives weeks offline and a mid-transfer crash (resumable, idempotent push/pull).

---

## What in the current code conflicts with this model

| # | Conflict | Where | Resolution (milestone) |
|---|---|---|---|
| 1 | MCP server lives inside the Electron app; if the GUI isn't running, Claude gets connection-refused (exactly the 2026-08-25 outage) | `src/main/app-state.ts` hosting `BrainServer` | Headless daemon; app becomes a client (A) |
| 2 | HTTP-only transport on a dynamic port, with configs rewritten every boot to chase the port | `core/mcp/server.ts` `findFreePort`; `main/app-state.ts:57-63` | stdio-first + stable config; HTTP kept for self-host (A, B) |
| 3 | Auto-registration writes `{type:"http",url}` directly into `~/.claude.json` / Desktop config on startup | `core/onboarding/register.ts`, called from `app-state.start()` | MCPB owns Desktop install; `claude mcp add` owns Code; config writes become explicit onboarding (B) |
| 4 | Vault buried in Electron `userData` — not the "portable folder you keep" | `main/settings.ts` `defaultSettings.vaultPath` | Portable location + migration (A) [K1] |
| 5 | `updated`/`created` are day-granularity strings — cannot order edits for sync | `core/vault/vault.ts` upsert (`toISOString().slice(0,10)`) | RFC3339 timestamps in format v1 (A) [K2] |
| 6 | No schema version in frontmatter — format cannot evolve safely once promised stable | `core/types.ts` `NoteFrontmatter` | `format: 1` field (A) [K2] |
| 7 | Naive append-merge of note bodies — fine for one machine, silently interleaves on two | `core/vault/vault.ts` `mergeBodies` | Version-vector merge + conflict copies (E) [K6] |
| 8 | Nothing prevents two server instances double-watching and double-distilling (two spawns = two watchers, two Anthropic-billed queues, racing SQLite writers) | `main/app-state.ts` (implicit singleton assumption) | Daemon + shim single-writer (A) [K4] |
| 9 | Tool surface is storage-shaped (`save_note`, `list_notes`) rather than memory-shaped, and lives-or-dies on 4 descriptions written without an eval | `core/mcp/tools.ts` | Opinionated surface + eval harness (C) [K7] |
| 10 | Event bus is in-process only — the graph's live highlighting breaks the moment the server leaves the app process | `core/mcp/events.ts` | SSE event stream (A) |
| 11 | API key stored in plaintext `settings.json` | `main/settings.ts` | MCPB keychain-backed user config (B) |
| 12 | Dev environment assumes system Node works — Node 18 + inherited `ELECTRON_RUN_AS_NODE` both break launch | `package.json` (no `engines`), dev scripts | engines + `.nvmrc` + script guard (A) |

Not conflicts, worth stating: the Markdown-as-truth / SQLite-as-cache split already matches the model (confirm as [K3]); `StreamableHTTPServerTransport` already exists for the self-host mode; provenance (`sources[]`) recorded from day one is exactly what a paid tier's session-layer features will want; the transcript watcher stays local-only and transcripts never sync.

## Decision log — needs Kate's sign-off

| ID | Decision | Recommendation | Locks in at |
|---|---|---|---|
| K1 | Default vault location + name | `~/SecondBrain` | Milestone A |
| K2 | Format v1: RFC3339 timestamps, `format: 1` version field, slug remains note identity (no UUID) | as stated | Milestone A |
| K3 | Storage split: `notes/*.md` synced source of truth; `index.db` derived, never synced; `.secondbrain/` in-vault machine state, excluded from sync | confirm | Milestone A |
| K4 | Single-writer: daemon + thin stdio shims vs. multi-instance + locks | daemon + shims | Milestone A |
| K5 | Encryption scheme: libsodium XChaCha20-Poly1305 envelopes, client-generated root key encoded as recovery phrase (alternatives: `age`; passphrase-derived KDF) | libsodium + recovery phrase | before Milestone E design |
| K6 | Conflict model: version-vector LWW + conflict copies vs. CRDT bodies | LWW + conflict copies | before Milestone E design |
| K7 | Tool surface: `remember` / `recall` / `read_note` / `link`; `summarize` as bundled prompt, not tool | as stated | Milestone C |

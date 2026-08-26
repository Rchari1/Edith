# Edith Architecture Note

**Date:** 2026-08-25
**Status:** Draft — pending Kate's review. Interfaces, not implementation.
**Companion to:** `docs/PLAN.md` (milestones and decision log; [K*n*] tags refer to its Decision Log)

## Processes

```
Claude Desktop ──MCPB/stdio──▶ shim ─┐
Claude Code    ──stdio─────────▶ shim ─┼─local socket─▶ ┌────────────────────────┐
claude.ai      ──Streamable HTTP (self-host)──────────▶ │  secondbrain daemon     │
                                                        │  vault · index · watcher│
Desktop app (optional UI) ◀──SSE events + local HTTP──▶ │  distiller · MCP tools  │
                                                        │  sync engine (paid)     │
                                                        └────────────────────────┘
```

One daemon owns the vault [K4]. stdio entries are thin shims that proxy MCP traffic to the daemon and start it if absent. The Electron app is a client: it renders the graph and subscribes to the event stream; it hosts nothing. The daemon idles out when no clients are connected and the queues are empty.

## On-disk layout

```
~/SecondBrain/                     # [K1] the brain — portable, user-visible, syncable
  notes/<slug>.md                  # source of truth; YAML frontmatter + Markdown body
  .secondbrain/                    # [K3] per-vault machine state — NEVER syncs
    index.db                       # SQLite FTS5 cache; delete → rebuilt from notes/
    sync.db                        # sync cursors, version vectors, outbound queue (Milestone E)

<platform config dir>/secondbrain/ # per-machine, not per-vault
  settings.json                    # vault path, model, capture policy
  license.token                    # cached signed license (Milestone D)
```

The promise, in one sentence: **everything the user would grieve losing is plain Markdown in `notes/`; everything else is rebuildable or machine-local.**

### Note format v1 [K2]

```markdown
---
format: 1
id: dynamic-port-binding          # slug; the identity, also the filename
title: Dynamic Port Binding
type: concept
created: 2026-08-25T10:00:00Z     # RFC3339 UTC (v0 used day-granularity)
updated: 2026-08-25T14:12:30Z
origin: distilled                 # distilled | claude | human
sources:
  - session: <uuid>
    project: -Users-u-myapp
    at: 2026-08-25T10:00:00Z
links: [mcp-registration]
tags: [infra]
---
Body: self-contained Markdown explaining WHY, not just what.
```

Unknown frontmatter keys are preserved on rewrite (hand-edited notes are first-class). `format` gates migrations. The slug is the cross-device identity: two devices independently creating `sqlite-fts-ranking` are talking about the same concept, and sync merges rather than duplicates — consistent with the local "deepen, don't clobber" upsert semantics.

## MCP tool surface [K7]

Four tools, memory-shaped, each with a description that says when to use it *and when not to*:

| Tool | Contract | UI event |
|---|---|---|
| `remember(title, body, id?, links?, tags?)` | Capture a durable insight: decisions + reasoning, gotchas, conventions. Existing id ⇒ deepen, never clobber. Not for narration or anything reconstructible from code. | `saved` |
| `recall(query?, limit?)` | Search the brain; empty query ⇒ recent notes for orientation. Returns ids + snippets, never full bodies. | `considered` |
| `read_note(id)` | Full note by id. The deliberate second step after `recall` — this distinction is what lets the UI show *considered* vs *used*. | `opened` |
| `link(from, to, reason?)` | Assert a connection between two notes; reason appended to both. Creating structure is a first-class act, not a `save` side-effect. | `saved` |

`summarize` is deliberately **not** a tool: synthesis belongs to the calling model. It ships as a bundled MCP prompt ("digest what the brain knows about X") so the workflow exists without a server-side API dependency.

Capture defaults: auto-distillation of settled sessions stays default-on (min-turns threshold), `remember` is always explicit, and one visible setting (off / conservative / standard) governs automatic capture. Experts flip one switch to manual-only and the tools stay out of their way.

## Transports

- **stdio** — default for Claude Desktop (via MCPB) and Claude Code. No ports, no config chasing.
- **Streamable HTTP** — `secondbrain serve --http` for self-hosters adding a claude.ai custom connector. Already implemented (`StreamableHTTPServerTransport`, stateless per-request); gains bearer-token auth before being documented for anything beyond loopback.
- **SSE event stream** — local-only channel the desktop app subscribes to for live highlighting (`considered` / `opened` / `saved`), replacing the in-process bus.

## Sync & encryption (Milestone E — interfaces only)

Design principle: the relay is a dumb, blind mailbox. Every property below must survive a fully compromised server.

### Key hierarchy [K5 — needs sign-off before any implementation]

```
Root Key (256-bit, generated client-side, never transmitted)
  └── encoded for the human as a recovery phrase (word list)
  └── wraps → Vault Key (per vault)
                └── encrypts → per-note envelopes
                └── keys → HMAC for opaque object ids
```

- Proposed primitives: libsodium — XChaCha20-Poly1305 for envelopes, Argon2id if a passphrase variant is added later. Alternative considered: the `age` format (nice tooling, less natural for per-object streams).
- Note ids and titles are content: they are inside the ciphertext. The relay sees only opaque object ids (`HMAC(VaultKey, slug)`) — stable per note, meaningless to the server.
- New-device enrollment v1: type the recovery phrase. Device-to-device approval (short auth string) is a later addition, not a dependency.
- Key rotation: envelopes carry a key-generation number; rotation re-wraps the Vault Key and lazily re-encrypts.

### Envelope (the only thing the relay stores)

```
{ objectId, ciphertext, nonce, keyGen, versionVector, deviceId(opaque), size, pushedAt }
```

`versionVector` and opaque `deviceId` are visible to the relay — they are sync-protocol necessities, counted as metadata leakage in the threat model.

### Relay API (shape, not spec)

```
POST /v1/push      { envelopes[] }          → { cursor }        # idempotent
GET  /v1/changes   ?since=cursor            → { envelopes[], cursor }
auth: account token; entitlement: license ID only (see Licensing)
```

### Conflict resolution [K6 — needs sign-off]

Version vector per note. Ordered histories fast-forward. Concurrent edits: frontmatter merges field-wise deterministically (links/tags/sources union; latest-timestamp title), bodies produce a visible conflict copy (`<slug>.sync-conflict-<date>.md`) rather than a silent merge. Inspectable, Obsidian-familiar, no black boxes. CRDT bodies were considered and rejected for v1: complexity and opaque merges versus a format whose whole point is inspectability.

### Threat model (to be published with Milestone E)

| Adversary | Can learn | Cannot learn |
|---|---|---|
| Honest-but-curious relay operator (us) | account id, license id, device count, note count, envelope sizes, push timing | note content, titles, ids, tags, the link graph |
| Full relay database compromise | the above, historically | same — ciphertext only |
| Network observer | traffic timing/volume to the relay | content, and (TLS) the API shapes |
| Compromised user device | everything — out of scope | — |

Metadata minimization (size padding, push batching) is an open question in the plan, decided after threat-model review. **The future hosted-plaintext mobile tier is an explicit opt-out from this model, not a weakening of it** — noted, not designed.

### Licensing (Milestone D)

Ed25519-signed token, public key embedded in the client: `{ licenseId, plan, issuedAt, expiresAt }`. Verified offline; cached; ~45-day grace. The renewal request body is the license ID and nothing else — enforced by test. The free local core contains no license checks and no network calls.

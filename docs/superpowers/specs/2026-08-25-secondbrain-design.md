# SecondBrain - v1 Design

**Date:** 2026-08-25
**Status:** Approved, implemented

## Problem

Every Claude session produces knowledge - decisions, gotchas, conventions, reasoning - and then loses it. The transcript survives on disk, but nothing reads it back. The next session starts cold.

SecondBrain is a desktop app that ingests those sessions, distills them into linked Markdown notes, and serves them back to Claude over MCP. When Claude consults the brain, the app's graph lights up to show which parts of your knowledge were used.

## Premise correction

An Anthropic API key does **not** grant access to claude.ai conversation history. The Messages API is stateless and there is no endpoint that lists past conversations. Session data comes from two places:

| Source | Access | Status in v1 |
|---|---|---|
| Claude Code transcripts (`~/.claude/projects`) | Local JSONL, complete, retroactive | Supported |
| claude.ai / Desktop history | Manual data export only | Out of scope |

The API key's role is **distillation**, not retrieval.

## Architecture

One process serves both faces. The desktop app hosts the MCP server in-process, so a tool call and the resulting highlight happen on the same tick - no IPC, no polling, no sync layer.

```
Claude session ──MCP/HTTP──▶ ┌──────────────────────────┐
                             │      SecondBrain.app     │
                             │  ┌────────┐  ┌────────┐  │
                             │  │  MCP   │─▶│  graph │  │ node glows
                             │  │ server │  │   UI   │  │
                             │  └────────┘  └────────┘  │
                             │       ▲          ▲       │
                             │  ┌────┴──────────┴────┐  │
                             │  │  vault: .md + FTS  │  │
                             │  └─────────▲──────────┘  │
                             │  ┌─────────┴──────────┐  │
                             │  │ distiller (Opus 5) │  │
                             │  └─────────▲──────────┘  │
                             │  ┌─────────┴──────────┐  │
                             │  │ watcher: *.jsonl   │  │
                             │  └────────────────────┘  │
                             └──────────────────────────┘
```

### Why HTTP and not stdio

A stdio MCP server is spawned as a fresh subprocess per client - a different process from the running app, which would have to phone home over a socket just to light anything up. Local HTTP makes the app itself the server. A stdio shim forwarding to the HTTP endpoint remains available for any surface that requires it.

### Modules

| Module | Responsibility |
|---|---|
| `core/parser` | Classify transcript paths; parse JSONL into a canonical `Session` |
| `core/watcher` | Watch `~/.claude/projects`; emit settled sessions; scan for backfill |
| `core/vault` | Markdown notes on disk + SQLite FTS5 index; graph construction |
| `core/distiller` | Session -> concept notes via the Messages API; retrying queue |
| `core/mcp` | MCP server, tool definitions, event bus |
| `core/onboarding` | Merge MCP config into each installed Claude surface |
| `main` | Electron lifecycle, orchestration, IPC |
| `renderer` | Force-directed graph, note panels, live highlighting |

## Key findings that shaped the design

These came out of reading real transcripts, and each one would have caused a rebuild.

**1. Most `.jsonl` files are not sessions.** On a representative machine, 151 transcript files contained only 15 real sessions; the remaining 136 were subagent and workflow transcripts nested under session directories. A naive `**/*.jsonl` glob fills the vault with context-free fragments. `classifyTranscript` sorts them by path shape:

```
<project>/<uuid>.jsonl                       -> session
<project>/<uuid>/subagents/**/agent-*.jsonl  -> subagent of that session
<project>/<uuid>/subagents/**/journal.jsonl  -> ignored
<project>/memory/**                          -> ignored
```

**2. Transcripts are trees, not lists.** Interrupting Claude or editing a prompt forks the history and leaves the abandoned branch in the file. Claude Code records the live tip as `last-prompt.leafUuid`; the parser walks `parentUuid` back from that tip and keeps only what is reachable. Without this, abandoned branches get distilled as though they happened.

**3. Only a fraction of lines are conversation.** Transcripts carry nine line types. Of 22 `user` lines in a sample session, 9 were real user turns - the rest were tool-result carriers and `isMeta` injections. `thinking` and `tool_result` blocks are dropped; `<system-reminder>` blocks are stripped.

**4. Claude titles its own sessions.** The `ai-title` line gives a free, high-quality session title.

**5. Partial reads are normal.** Transcripts are appended to live, so the last line is frequently half-written. Malformed lines are skipped and counted, never fatal.

## Data model

```markdown
---
id: dynamic-port-binding
title: Dynamic Port Binding
type: concept
created: 2026-08-25
updated: 2026-08-25
origin: distilled          # distilled | claude | human
sources:
  - session: 11111111-2222-3333-4444-555555555555
    project: -Users-u-myapp
    at: 2026-08-25T10:00:00Z
links: [mcp-registration]
---
Bind the next free port and rewrite the MCP config to match.
```

`sources[]` is recorded from the very first note. The session layer (concept nodes over session nodes with provenance edges) is therefore a **view**, not a migration - it can be added later without touching stored data.

Markdown files are the source of truth. The SQLite index is a derived cache that can be deleted and rebuilt.

## MCP surface

| Tool | Purpose | Event emitted |
|---|---|---|
| `search_brain` | Search notes by query | `considered` (dim glow) |
| `read_note` | Read one note in full | `opened` (bright glow) |
| `list_notes` | Recent notes, for orientation | - |
| `save_note` | Claude saves an insight mid-session | `saved` (green flash) |

Retrieval and usage are distinct, and the protocol exposes both: a search shows what was *considered*, a read shows what was *used*. Highlights decay over 30 seconds so the graph shows the shape of attention rather than a permanent smear.

Tool descriptions are load-bearing - they are the only thing Claude reads when deciding whether the brain is worth consulting.

## Registration

One user-scope entry in `~/.claude.json` covers the Claude Code CLI, the VS Code extension, and every project directory - they are the same Claude Code and share transcript storage and configuration. Claude Desktop gets its own config file.

The app writes these files directly rather than shelling out to `claude mcp add`, because the CLI is not reliably on `PATH` for a GUI app launched from Finder. Writes are atomic (temp + rename), merge-only, and back the file up once before first modification.

## Error handling

| Failure | Behavior |
|---|---|
| Distill API error | Queued with exponential backoff, parked after 4 attempts. Transcript is still on disk and re-distillable. |
| Malformed JSONL line | Skipped and counted. Expected during live sessions. |
| Port already bound | Bind the next free port; rewrite configs to match. |
| Note edited by hand | Vault re-reads and re-indexes. |
| Corrupt note frontmatter | That note degrades to defaults; the vault still loads. |
| Claude surface absent | Skipped, reported in the UI, never fatal. |
| No API key | Ingest pauses; `save_note` and search keep working. |

## Testing

65 tests across 7 files. Notable coverage:

- Path classification, including the 136-vs-15 case
- Fork resolution via `leafUuid`; meta/tool-result filtering; malformed-line tolerance
- Note round-trip; hand-edited frontmatter with wrong types
- Vault merge-not-clobber; provenance dedupe; ghost nodes; index rebuild from disk; FTS-hostile queries
- Config merge preserving unrelated user state; corrupt-config recovery; unregister isolation
- Live MCP client over HTTP: tools, events, concurrent clients
- Full pipeline: transcript on disk -> classify -> parse -> distill (mocked API) -> vault -> MCP search -> highlight

## Deliberately excluded from v1

claude.ai export import - session-layer rendering - sync across machines - vector/semantic search.

Search sits behind a `SearchProvider` interface so hybrid semantic search later touches one file.

## Stack

Electron 44, TypeScript 7, Vite 7, better-sqlite3 13 (N-API prebuilds, no per-ABI rebuild), MCP SDK 1.30, Anthropic SDK 0.120, model `claude-opus-5` with adaptive thinking and structured outputs.

Main and preload build as CommonJS. Electron's ESM entry exposes its API through lazy non-enumerable getters, so both named imports and default-import destructuring yield `undefined`; CJS is the reliable path.

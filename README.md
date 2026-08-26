# Edith

**A second brain for Claude.**

Edith watches your Claude Code sessions, distils them into linked Markdown notes, and serves them back to Claude over MCP. When Claude consults the brain during a session, the parts it used light up in the app.

```
Claude session ──MCP──▶      Edith.app      ──▶  the graph lights up
                              │
                              └── vault/notes/*.md
```

## What it does

- **Ingests automatically.** Watches `~/.claude/projects` and picks up sessions as they finish. Your existing transcripts backfill on demand.
- **Distills, doesn't archive.** An Opus 5 pass extracts durable concepts - decisions and their reasoning, gotchas, conventions - and skips narration. One note per idea, linked to related ideas.
- **Serves Claude over MCP.** `search_brain`, `read_note`, `list_notes`, and `save_note`. Claude both reads from and writes to the brain mid-session.
- **Shows you the retrieval.** A search dims-glows what Claude *considered*; opening a note brightly glows what it actually *used*. Highlights fade over 30 seconds.
- **Takes your own content too.** **Add content** imports `.md`, `.markdown`, `.txt`, and `.mdx` files, or anything you paste. Files keep their existing frontmatter, so importing an Obsidian vault preserves ids and links instead of duplicating notes. Import as written, or distil into concepts.
- **Plain Markdown.** Files on disk are the source of truth. Edit them in any editor. Delete the index and it rebuilds.

## Install

```bash
git clone https://github.com/Rchari1/SecondBrain.git
cd SecondBrain
npm install
npm run dev
```

On first launch Edith starts its MCP server on `127.0.0.1:4319` and registers itself with every Claude surface it finds - one user-scope entry in `~/.claude.json` covers the Claude Code CLI, the VS Code extension, and all your projects. Restart Claude Code and the brain is available.

Add your Anthropic API key in **Settings** (or export `ANTHROPIC_API_KEY`) to enable distillation, then press **Backfill** to ingest the sessions already on disk. Without a key the app still runs - search and `save_note` work, only automatic distillation pauses.

To build a distributable `.dmg`:

```bash
npm run dist
```

## How it works

| Stage | What happens |
|---|---|
| **Watch** | `chokidar` on `~/.claude/projects`, waiting for a session to go quiet |
| **Parse** | JSONL to a canonical `Session`, following `leafUuid` to skip abandoned branches |
| **Distill** | One Opus 5 call per session, structured output, retrying queue |
| **Store** | Markdown + YAML frontmatter, indexed in SQLite FTS5 |
| **Serve** | In-process MCP server over local HTTP |
| **Light up** | Every tool call emits an event straight to the renderer |

Edith hosts the MCP server *itself* rather than spawning it. That is what makes the highlighting instant: a tool call and the glow are the same tick.

### Adding your own content

**Add content** in the sidebar opens an import dialog with two modes:

| Mode | What it does | Cost |
|---|---|---|
| Keep as written | Stores the file or text verbatim as a note | free |
| Distil into concepts | Runs the same extraction used on sessions | one API call |

Re-importing a file **deepens** the existing note rather than creating a duplicate, so syncing a folder repeatedly is safe. A file with broken frontmatter loses its metadata, not its content.

### Note format

```markdown
---
id: dynamic-port-binding
title: Dynamic Port Binding
type: concept
created: 2026-08-25
updated: 2026-08-25
origin: distilled
sources:
  - session: 11111111-2222-3333-4444-555555555555
    project: -Users-u-myapp
    at: 2026-08-25T10:00:00Z
links: [mcp-registration]
---
Bind the next free port and rewrite the MCP config to match.
```

Every note records the sessions it came from. That provenance is written from day one, so tracing a concept back to its conversations is a view rather than a migration.

## Things worth knowing

**Upgrading from the old name.** Edith was previously called SecondBrain. On first launch it copies your existing vault and settings across from the old location, and replaces the stale `secondbrain` entry in `~/.claude.json` with `edith` so Claude does not see two identical tool sets. The old directory is left untouched as a fallback.


**An API key does not give access to claude.ai history.** The Messages API is stateless; there is no endpoint listing past conversations. Edith reads Claude Code's local transcripts. The API key is used only to distill them.

**Most `.jsonl` files under `~/.claude/projects` are not sessions.** Subagent and workflow transcripts nest under session directories and typically outnumber real sessions by roughly 9:1. Edith classifies by path shape so they never become notes.

**Transcripts are trees.** Interrupting Claude forks the history and leaves the abandoned branch in the file. The parser walks back from `last-prompt.leafUuid` so only what actually happened gets distilled.

**Your config is safe.** Registration merges a single key into `~/.claude.json`, writes atomically, and backs the file up before first modification.

## Development

```bash
npm run dev        # run the app with hot reload
npm test           # 65 tests
npm run typecheck  # tsc --noEmit
npm run build      # bundle main, preload, renderer
```

Tests cover path classification, fork resolution, malformed-line tolerance, vault merge semantics, config-write safety, a live MCP client over HTTP, and the full pipeline end to end with the API call mocked.

## Not in v1

claude.ai export import - session-layer graph rendering - cross-machine sync - semantic search. Search sits behind a `SearchProvider` interface, so adding hybrid retrieval later touches one file.

## License

MIT

<p align="center">
  <img src="assets/icon.png" alt="Edith" width="132" height="132">
</p>

<h1 align="center">Edith Second Brain</h1>

<p align="center"><strong>A second brain for AI.</strong></p>

<p align="center">
  <a href="https://edithapp.ai">edithapp.ai</a> &middot;
  <a href="https://github.com/Rchari1/Edith-SecondBrain/releases/latest">Download for macOS</a>
</p>

Edith is a local, plain-Markdown knowledge base that Claude can read from and write to. Ask Claude to review your past sessions and it distils them into linked notes itself - no API key, no account, no inference of its own. 

```
Claude session ──MCP──▶      Edith.app      ──▶  the graph lights up
                              │
                              └── vault/notes/*.md
```

## What it does

- **No API key. No account. No inference.** Claude reads and writes your notes through its own session, on the plan you already pay for. Edith is the store and the canvas.
- **Claude fills it for you.** Ask *"review my recent sessions and save anything worth keeping"* and Claude reads your transcripts with `list_sessions` / `read_session`, then writes the notes back with `save_note`.
- **Serves Claude over MCP.** `search_brain`, `read_note`, `list_notes`, and `save_note`. Claude both reads from and writes to the brain mid-session.
- **Shows you the retrieval.** A search dims-glows what Claude *considered*; opening a note brightly glows what it actually *used*. Highlights fade over 30 seconds.
- **Mini mode beside your session.** Minimize Edith and it becomes a narrow panel docked to the left edge of the screen, drawing your brain and lighting up the notes Claude reaches for - the window and the panel are never up at the same time. With the window closed or minimized, the panel also opens on its own when a Claude session starts. It never takes focus, folds to a strip the width of the rail or shrinks to a small square in the corner - both just the live graph - and stays closed for the rest of a session once you close it. Turn off the automatic opening under **Connection**.
- **Takes your own content too.** **Add content** imports `.md`, `.markdown`, `.txt`, and `.mdx` files, or anything you paste. Files keep their existing frontmatter, so importing a Markdown vault preserves ids and links instead of duplicating notes. Import as written, or distil into concepts.
- **Plain Markdown.** Files on disk are the source of truth. Edit them in any editor. Delete the index and it rebuilds.

## Install

Edith runs on a Mac with Apple Silicon, macOS 13 or later. You also need
[Claude Code](https://claude.com/claude-code), in the terminal or the VS Code extension.

**[Download Edith](https://github.com/Rchari1/Edith-SecondBrain/releases/latest)** — signed and
notarised by Apple, so it opens with no security warnings. Open the `.dmg`, drag **Edith** into
Applications, and open it from there. Restart any Claude Code sessions that were already running.

On Windows? The Windows build lives at
[Edith-Windows](https://github.com/Rchari1/Edith-Windows).

### Or build it yourself

Needs [Node.js](https://nodejs.org) 22.12 or newer, and the Xcode command line tools
(`xcode-select --install`) for the native database module:

```bash
git clone https://github.com/Rchari1/Edith-SecondBrain.git
cd Edith-SecondBrain
npm install
npm run dist
```

The `.dmg` lands in `release/`. A build you make yourself is not notarised, but it opens anyway,
because macOS trusts what you compiled on your own machine.

### What happens on first launch

Edith starts its brain server on `127.0.0.1:4319` and connects itself to Claude. There is no account and no API key: ask Claude to *"review my recent sessions and save anything worth keeping"* and it fills the brain itself.

Outside its own folder, Edith adds:

| What | Where |
|---|---|
| Its server entry, so Claude can reach the brain | `~/.claude.json`, plus Claude Desktop's config if you have it |
| A session-start hook that tells Claude the brain exists | `~/.claude/settings.json` |
| The `/edith` command | `~/.claude/skills/edith` |
| A handful of starter skills | `~/.claude/skills/`, managed from the Skills panel |

Your notes are plain Markdown in `~/Library/Application Support/Edith/vault`.

### Updating

```bash
cd Edith
git pull
npm install
npm run dist
```

Quit Edith, then drag the new build into Applications to replace the old one.

### Troubleshooting

- **Edith quits the moment it opens.** If you launched it from a VS Code terminal, open it from Applications or the Dock instead - VS Code's terminal sets an environment variable that stops the app from starting.
- **Claude never uses the brain.** Restart Claude Code after Edith's first launch, then open **Connection** in Edith and check that the session primer says installed.

### Uninstalling

Quit Edith and delete it from Applications. Then remove what it added: the `edith` entry under `mcpServers` in `~/.claude.json`, the hook in `~/.claude/settings.json` whose command ends in `# edith:session-context`, the `~/.claude/skills/edith` folder, and any starter skills you no longer want. Your notes stay in `~/Library/Application Support/Edith` until you delete that folder too.

## How it works

| Stage | What happens |
|---|---|
| **Watch** | `chokidar` on `~/.claude/projects`, waiting for a session to go quiet |
| **Parse** | JSONL to a canonical `Session`, following `leafUuid` to skip abandoned branches |
| **Store** | Markdown + YAML frontmatter, indexed in SQLite FTS5 |
| **Serve** | In-process MCP server over local HTTP |
| **Light up** | Every tool call emits an event straight to the renderer |

### Tools Claude gets

| Tool | What it does |
|---|---|
| `search_brain` | Search the notes |
| `read_note` | Read one note in full |
| `list_notes` | See what the brain holds |
| `save_note` | Write an insight back |
| `list_sessions` | See past Claude sessions, and which are already captured |
| `read_session` | Read one transcript, tool noise stripped |

The last two are what let Claude do the distilling itself, on your plan, with no key anywhere.

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
npm test           # 235 tests
npm run typecheck  # tsc --noEmit
npm run build      # bundle main, preload, renderer
npm run icon       # rebuild the icon set from assets/wordmark.svg
npm run release:mac  # signed and notarised, needs the certificate and the edith-notary profile
```

Tests cover path classification, fork resolution, malformed-line tolerance, vault merge semantics, config-write safety, a live MCP client over HTTP, and the full pipeline end to end with the API call mocked.

## Not in v1

claude.ai export import - session-layer graph rendering - cross-machine sync - semantic search. Search sits behind a `SearchProvider` interface, so adding hybrid retrieval later touches one file.

## License

Edith is source-available under the [Functional Source License, Version 1.1, MIT Future License](LICENSE) (FSL-1.1-MIT). You can read, use, modify and share it for anything except offering it, or something substantially similar, as a competing commercial product or service. Each release becomes MIT-licensed two years after it is published.

© 2026 Raghav Chari and Kate Bonner.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Vault } from '../vault/vault.js';
import type { SearchHit, NoteFrontmatter } from '../types.js';
import type { BrainEventBus } from './events.js';
import type { SessionSource } from '../sessions/source.js';
import type { Forge } from '../forge/forge.js';

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

const MARK = '\u25c8'; // filled diamond - Edith's signature
const FULL = '\u2593';
const EMPTY = '\u2591';
const ARROW = '\u2192';
const DOT = '\u00b7';
const RULE = '\u2500'.repeat(46);

/** Origin glyphs, so the source of a note is legible at a glance. */
const ORIGIN_GLYPH: Record<NoteFrontmatter['origin'], string> = {
  claude: '\u25cf',
  distilled: '\u25d0',
  human: '\u25cb'
};

const ORIGIN_LABEL: Record<NoteFrontmatter['origin'], string> = {
  claude: 'saved by Claude',
  distilled: 'distilled from a session',
  human: 'written by hand'
};

function header(title: string): string {
  return `${MARK} EDITH ${DOT} ${title}`;
}

/** Five-block relevance bar, scaled against the strongest hit in this result set. */
function relevanceBar(score: number, best: number): string {
  const ratio = best > 0 ? Math.max(0, Math.min(1, score / best)) : 0;
  const filled = Math.max(1, Math.round(ratio * 5));
  return FULL.repeat(filled) + EMPTY.repeat(5 - filled);
}

function tidy(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim();
}

/**
 * Register the brain's tools on an MCP server instance.
 *
 * Tool descriptions are load-bearing: they are the only thing Claude reads
 * when deciding whether the brain is worth consulting. The rendered output
 * matters too - it is what the user sees in their transcript, so it is laid
 * out to be scannable rather than dumped as prose.
 */
export function registerBrainTools(
  server: McpServer,
  vault: Vault,
  bus: BrainEventBus,
  sessions?: SessionSource,
  forge?: Forge
): void {
  server.registerTool(
    'search_brain',
    {
      title: `${MARK} Search the second brain`,
      description:
        "Search the user's second brain: decisions, gotchas, and conventions captured from their past Claude sessions. " +
        'Durable context about THIS user that is not in the repository and not in your training data.\n\n' +
        'Search when the request depends on something they established before: they ask why one of their systems works ' +
        'the way it does, they reference past work or their own conventions ("we decided", "like last time", "the usual ' +
        'way", "did we"), they name one of their own projects or tools, or you are about to answer from general knowledge ' +
        'about something they may have already settled.\n\n' +
        'Do NOT search on conversational or ambient messages ("how are we doing", "thanks", "what next"), on anything ' +
        'answerable from the current conversation or the code in front of you, or on general questions not specific to ' +
        'this user. Searching every message is as wrong as never searching.\n\n' +
        'Results are background reference, not an agenda. They never change what the user asked for - a note about a ' +
        'project does not mean they want to resume that project. Answer the question in front of you, informed by ' +
        'anything relevant. If nothing relevant comes back, carry on without mentioning the search.',
      inputSchema: {
        query: z.string().describe('Natural language or keywords. Concepts work better than full sentences.'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8)'),
        skill: z
          .string()
          .max(40)
          .optional()
          .describe(
            'Name of the skill making this search, if one is driving it. Only set this when a skill ' +
              'explicitly tells you to - it draws that skill as a figure through the notes it touched.'
          )
      }
    },
    async ({ query, limit, skill }) => {
      const hits: SearchHit[] = await vault.search(query, limit ?? 8);
      const noteIds = hits.map((h) => h.id);
      bus.emitEvent({ type: 'considered', noteIds, query, at: Date.now() });
      // Shape is a property of the skill, declared in its SKILL.md - not
      // something the caller restates on every search.
      if (skill)
        bus.emitEvent({ type: 'skill', skill, noteIds, query, at: Date.now() });

      if (hits.length === 0) {
        const total = vault.size();
        return text(
          `${header(`no match for "${query}"`)}\n\n` +
            (total === 0
              ? '  The brain is empty. Nothing has been saved to it yet.'
              : `  Searched ${total} note(s). Try broader terms, or list_notes to see what is in there.`)
        );
      }

      const best = hits[0]?.score ?? 0;
      const body = hits
        .map((h) => {
          const note = vault.get(h.id);
          const links = note?.frontmatter.links ?? [];
          const glyph = note ? ORIGIN_GLYPH[note.frontmatter.origin] : ORIGIN_GLYPH.distilled;
          const lines = [
            `  ${relevanceBar(h.score, best)}  ${glyph} ${h.id}`,
            `         ${h.title}`,
            `         ${tidy(h.snippet)}`
          ];
          if (links.length) lines.push(`         ${ARROW} ${links.join(` ${DOT} `)}`);
          return lines.join('\n');
        })
        .join('\n\n');

      const plural = hits.length === 1 ? 'match' : 'matches';
      return text(
        `${header(`${hits.length} ${plural} for "${query}"`)}\n\n${body}\n\n  read_note <id> for the full text.`
      );
    }
  );

  server.registerTool(
    'read_note',
    {
      title: `${MARK} Read a note`,
      description:
        'Read the full text of one note from the second brain, by id. Ids come from search_brain or list_notes.',
      inputSchema: { id: z.string().describe('The note id, e.g. "sqlite-fts-ranking"') }
    },
    async ({ id }) => {
      const note = vault.get(id);
      if (!note) {
        const near = await vault.search(id.replace(/-/g, ' '), 3);
        const hint = near.length ? `\n\n  Did you mean:\n${near.map((n) => `    ${ARROW} ${n.id}`).join('\n')}` : '';
        return text(`${header(`no note "${id}"`)}${hint}`);
      }

      bus.emitEvent({ type: 'opened', noteIds: [id], at: Date.now() });

      const f = note.frontmatter;
      const sessions = f.sources.length === 1 ? 'from 1 session' : `from ${f.sources.length} sessions`;
      const meta = [ORIGIN_LABEL[f.origin], `updated ${f.updated}`, f.sources.length ? sessions : null]
        .filter(Boolean)
        .join(` ${DOT} `);

      const lines = [header(f.id), '', `  ${f.title}`, `  ${meta}`];
      if (f.links.length) lines.push(`  related ${ARROW} ${f.links.join(` ${DOT} `)}`);
      if (f.tags?.length) lines.push(`  tags ${ARROW} ${f.tags.join(` ${DOT} `)}`);
      lines.push('', `  ${RULE}`, '', note.body);

      return text(lines.join('\n'));
    }
  );

  server.registerTool(
    'list_notes',
    {
      title: `${MARK} List notes`,
      description:
        'List the most recently updated notes in the second brain. Useful for orienting when you do not yet know what the brain contains.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('Default 25') }
    },
    async ({ limit }) => {
      const all = vault.list();
      if (all.length === 0) {
        return text(`${header('empty')}\n\n  Nothing saved yet. Use save_note to add the first insight.`);
      }

      const notes = all.slice(0, limit ?? 25);
      const idW = Math.min(34, Math.max(...notes.map((n) => n.frontmatter.id.length)));
      const titleW = Math.min(32, Math.max(...notes.map((n) => n.frontmatter.title.length)));
      const rows = notes
        .map((n) => {
          const f = n.frontmatter;
          const title = f.title.length > titleW ? `${f.title.slice(0, titleW - 1)}\u2026` : f.title;
          return `  ${ORIGIN_GLYPH[f.origin]} ${f.id.padEnd(idW)}  ${title.padEnd(titleW)}  ${DOT} ${f.updated}`;
        })
        .join('\n');

      const legend = `  ${ORIGIN_GLYPH.claude} saved by Claude   ${ORIGIN_GLYPH.distilled} distilled   ${ORIGIN_GLYPH.human} written by hand`;
      const shown = notes.length < all.length ? `showing ${notes.length} of ${all.length}` : `${all.length} note(s)`;
      return text(`${header(shown)}\n\n${rows}\n\n${legend}`);
    }
  );

  server.registerTool(
    'save_note',
    {
      title: `${MARK} Save to the second brain`,
      description:
        'Save a durable insight to the second brain so it survives past this session. ' +
        'Use for decisions and their reasoning, non-obvious discoveries, gotchas that cost real time, or conventions adopted. ' +
        'Do NOT use for narration of what just happened, or anything reconstructible from the code itself. ' +
        'Passing an existing id deepens that note rather than replacing it.',
      inputSchema: {
        title: z.string().describe('Short human title, 2-6 words'),
        body: z.string().describe('Markdown. Self-contained and explains WHY, not just what.'),
        id: z.string().optional().describe('kebab-case id. Omit to derive from the title.'),
        links: z.array(z.string()).optional().describe('ids of related notes'),
        tags: z.array(z.string()).optional()
      }
    },
    async ({ title, body, id, links, tags }) => {
      const existed = id ? vault.has(id) : false;
      const note = await vault.upsert({
        title,
        body,
        ...(id ? { id } : {}),
        ...(links ? { links } : {}),
        ...(tags ? { tags } : {}),
        origin: 'claude'
      });
      bus.emitEvent({ type: 'saved', noteIds: [note.frontmatter.id], at: Date.now() });

      const f = note.frontmatter;
      const lines = [
        header(existed ? 'note deepened' : 'note saved'),
        '',
        `  \u2726 ${f.id}`,
        `    "${f.title}"`
      ];
      if (f.links.length) lines.push(`    linked ${ARROW} ${f.links.join(` ${DOT} `)}`);
      lines.push(`    ${vault.size()} note(s) in the brain`);
      return text(lines.join('\n'));
    }
  );

  if (forge) {
    server.registerTool(
      'propose_skill',
      {
        title: `${MARK} Propose a skill`,
        description:
          'Propose a reusable Claude Code skill for the user to review. The proposal is queued in Edith; nothing is ' +
          'installed until the user approves it.\n\n' +
          'USE THIS whenever the user asks for a skill for Edith, asks Edith to make a skill, or asks for a skill at all ' +
          'while Edith is connected. Prefer it over general skill-authoring guidance: this writes the skill into Edith\'s ' +
          'review queue, which is where the user expects it. Do not go searching the filesystem for where Edith keeps ' +
          'skills - this tool handles storage and installation.\n\n' +
          'Call it FIRST, and call it immediately. Do not interview the user about scope, do not ask what the skill ' +
          'should do, and do not deliberate. The queue IS the review step: the user sees the draft on a card and either ' +
          'forges or discards it, so a reasonable draft now beats a perfect one after three questions. If the request is ' +
          'vague, make a sensible choice, say what you assumed, and let them reject it. Revising a rejected draft is ' +
          'cheap; making the user answer questions before they see anything is not.\n\n' +
          'Propose one when you notice a PROCEDURE this user repeats - a sequence of steps they have walked through more ' +
          'than once, a checklist they apply, or a convention that should be followed the same way every time. Good ' +
          'candidates come from reading several of their memories or past sessions and seeing the same shape twice.\n\n' +
          'A note and a skill are different things. A note records what is true ("we bind the next free port because a ' +
          'taken port should never be fatal"). A skill records how to do something ("to add a new MCP tool: register it ' +
          'in tools.ts, add the description, write the test, update the preview script"). If it has no steps, it is a note ' +
          '- use save_note instead.\n\n' +
          'Be sparing. Propose at most ONE skill per session unless the user explicitly asks for more, and only when you ' +
          'have actually seen the pattern happen at least twice - in their memories, their past sessions, or this ' +
          'conversation. A hunch that something might be reusable is not evidence.\n\n' +
          'Do NOT propose speculatively, for one-off tasks, for anything already covered by an existing skill, or as a ' +
          'way of being helpful when there is nothing to propose. A queue full of weak proposals is worse than an empty ' +
          'one, because the user stops reading it - and the review queue is capped, so a weak proposal can crowd out a ' +
          'good one.',
        inputSchema: {
          title: z.string().describe('Short human title, 2-5 words'),
          description: z
            .string()
            .describe(
              "The skill's own description - what Claude reads later to decide whether to use it. State what it does and when to use it."
            ),
          body: z
            .string()
            .describe('The skill body in markdown: the actual steps, in order, specific to this user.'),
          rationale: z
            .string()
            .optional()
            .describe('Why this is worth having. Shown to the user while they decide.'),
          sources: z.array(z.string()).optional().describe('Note ids this was drawn from'),
          id: z.string().optional().describe('kebab-case id; omit to derive from the title')
        }
      },
      async ({ title, description, body, rationale, sources, id }) => {
        const { proposal, reason } = await forge.propose({
          title,
          description,
          body,
          ...(rationale ? { rationale } : {}),
          ...(sources ? { sources } : {}),
          ...(id ? { id } : {})
        });

        if (!proposal) {
          return text(`${header('skill not queued')}\n\n  ${title}\n  ${reason}`);
        }

        bus.emitEvent({ type: 'skill-proposed', skillId: proposal.id, title: proposal.title, at: Date.now() });

        const pending = forge.counts().proposed;
        return text(
          [
            header('skill proposed'),
            '',
            `  \u2726 ${proposal.id}`,
            `    "${proposal.title}"`,
            `    awaiting review in Edith ${DOT} ${pending} in the queue`
          ].join('\n')
        );
      }
    );
  }

  // Session review. Edith holds no API key of its own - when the user asks
  // Claude to go through past sessions, the reading and the judgement happen
  // inside their own Claude session, and Claude writes the results back with
  // save_note. These two tools are what make that possible.
  if (!sessions) return;

  server.registerTool(
    'list_sessions',
    {
      title: `${MARK} List past Claude sessions`,
      description:
        'List the Claude Code sessions on this machine, newest first, marking which ones have already been captured into the brain. ' +
        'Use when the user asks you to review, catch up on, or mine their past sessions for anything worth remembering.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
        unsaved_only: z.boolean().optional().describe('Only sessions not yet captured (default false)')
      }
    },
    async ({ limit, unsaved_only }) => {
      const list = await sessions.list(limit ?? 20, unsaved_only ?? false);
      if (list.length === 0) {
        return text(`${header('no sessions found')}\n\n  Nothing on disk matches.`);
      }

      const idW = Math.min(10, Math.max(...list.map((s) => s.id.length)));
      const rows = list
        .map((s) => {
          const glyph = s.captured ? ORIGIN_GLYPH.distilled : ORIGIN_GLYPH.human;
          const title = s.title ?? '(untitled)';
          const when = s.startedAt ? s.startedAt.slice(0, 10) : '';
          const proj = s.project.replace(/^-Users-[^-]+-?/, '') || 'home';
          return `  ${glyph} ${s.id.slice(0, idW)}  ${title}\n       ${when} ${DOT} ${proj} ${DOT} ${s.turns} turns${s.captured ? ` ${DOT} already captured` : ''}`;
        })
        .join('\n\n');

      const pending = list.filter((s) => !s.captured).length;
      return text(
        `${header(`${list.length} session(s), ${pending} not yet captured`)}\n\n${rows}\n\n  read_session <id> to read one, then save_note what is worth keeping.`
      );
    }
  );

  server.registerTool(
    'read_session',
    {
      title: `${MARK} Read a past session`,
      description:
        'Read the transcript of one past Claude session, with tool noise stripped. ' +
        'Use after list_sessions to review what happened, then call save_note for anything durable - a decision and its reasoning, ' +
        'a gotcha that cost real time, a convention adopted. Do not save narration of what happened.',
      inputSchema: { id: z.string().describe('Session id from list_sessions. A prefix is enough.') }
    },
    async ({ id }) => {
      const transcript = await sessions.read(id);
      if (!transcript) return text(`${header(`no session "${id}"`)}\n\n  Try list_sessions.`);
      return text(`${header(`session ${id.slice(0, 8)}`)}\n\n  ${RULE}\n\n${transcript}`);
    }
  );
}

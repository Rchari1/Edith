import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Vault } from '../vault/vault.js';
import type { SearchHit, NoteFrontmatter } from '../types.js';
import type { BrainEventBus } from './events.js';

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
export function registerBrainTools(server: McpServer, vault: Vault, bus: BrainEventBus): void {
  server.registerTool(
    'search_brain',
    {
      title: `${MARK} Search the second brain`,
      description:
        "Search the user's personal knowledge base of decisions, gotchas, and architectural notes distilled from their past Claude sessions. " +
        'Use this BEFORE answering questions about the user\'s own projects, conventions, or past decisions - it often contains context that is not in the current repository. ' +
        'Worth checking whenever the user says "we decided", "like last time", "the usual way", or refers to prior work.',
      inputSchema: {
        query: z.string().describe('Natural language or keywords. Concepts work better than full sentences.'),
        limit: z.number().int().min(1).max(25).optional().describe('Max results (default 8)')
      }
    },
    async ({ query, limit }) => {
      const hits: SearchHit[] = await vault.search(query, limit ?? 8);
      bus.emitEvent({ type: 'considered', noteIds: hits.map((h) => h.id), query, at: Date.now() });

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
}

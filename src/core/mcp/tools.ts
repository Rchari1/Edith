import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Vault } from '../vault/vault.js';
import type { BrainEventBus } from './events.js';

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

/**
 * Register the brain's tools on an MCP server instance.
 *
 * Tool descriptions are load-bearing: they are the only thing Claude reads
 * when deciding whether the brain is worth consulting. They are written to
 * encourage checking before answering, and saving before forgetting.
 */
export function registerBrainTools(server: McpServer, vault: Vault, bus: BrainEventBus): void {
  server.registerTool(
    'search_brain',
    {
      title: 'Search the second brain',
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
      const hits = await vault.search(query, limit ?? 8);
      bus.emitEvent({ type: 'considered', noteIds: hits.map((h) => h.id), query, at: Date.now() });

      if (hits.length === 0) return text(`No notes matched "${query}".`);
      const body = hits
        .map((h, i) => `${i + 1}. [${h.id}] ${h.title}\n   ${h.snippet.replace(/\s+/g, ' ').trim()}`)
        .join('\n\n');
      return text(`${hits.length} match(es) for "${query}":\n\n${body}\n\nUse read_note with an id for the full note.`);
    }
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read a note',
      description:
        'Read the full text of one note from the second brain, by id. Ids come from search_brain or list_notes.',
      inputSchema: { id: z.string().describe('The note id, e.g. "sqlite-fts-ranking"') }
    },
    async ({ id }) => {
      const note = vault.get(id);
      if (!note) return text(`No note with id "${id}".`);
      bus.emitEvent({ type: 'opened', noteIds: [id], at: Date.now() });

      const f = note.frontmatter;
      const meta = [
        `# ${f.title}`,
        `id: ${f.id} | updated: ${f.updated} | origin: ${f.origin}`,
        f.links.length ? `related: ${f.links.join(', ')}` : null,
        f.sources.length ? `from ${f.sources.length} session(s)` : null
      ]
        .filter(Boolean)
        .join('\n');
      return text(`${meta}\n\n${note.body}`);
    }
  );

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description:
        'List the most recently updated notes in the second brain. Useful for orienting when you do not yet know what the brain contains.',
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe('Default 25') }
    },
    async ({ limit }) => {
      const notes = vault.list().slice(0, limit ?? 25);
      if (notes.length === 0) return text('The brain is empty.');
      const body = notes
        .map((n) => `- [${n.frontmatter.id}] ${n.frontmatter.title} (updated ${n.frontmatter.updated})`)
        .join('\n');
      return text(`${vault.size()} note(s) total. Most recent:\n\n${body}`);
    }
  );

  server.registerTool(
    'save_note',
    {
      title: 'Save to the second brain',
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
      const note = await vault.upsert({
        title,
        body,
        ...(id ? { id } : {}),
        ...(links ? { links } : {}),
        ...(tags ? { tags } : {}),
        origin: 'claude'
      });
      bus.emitEvent({ type: 'saved', noteIds: [note.frontmatter.id], at: Date.now() });
      return text(`Saved as [${note.frontmatter.id}] "${note.frontmatter.title}".`);
    }
  );
}

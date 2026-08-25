import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Session, NoteSource } from '../types.js';
import type { Vault } from '../vault/vault.js';
import { renderForDistill } from '../parser/parse-session.js';
import { DistillSchema, SYSTEM_PROMPT, buildUserPrompt, type DistillOutput } from './prompt.js';

export const DEFAULT_MODEL = 'claude-opus-5';

export interface DistillResult {
  sessionId: string;
  noteIds: string[];
  skipped: boolean;
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface DistillerOptions {
  model?: string;
  /** Sessions shorter than this teach nothing and are not worth an API call. */
  minTurns?: number;
  /** Cap on ids sent as linking context, to keep the prompt bounded. */
  maxContextIds?: number;
}

/**
 * Turns a parsed session into concept notes.
 *
 * The expensive half of the pipeline: one Opus call per session. Everything
 * here is written to fail softly - a distill failure must never cost the user
 * their transcript or block the UI, because the transcript on disk is the
 * real source of truth and can always be re-distilled.
 */
export class Distiller {
  private readonly model: string;
  private readonly minTurns: number;
  private readonly maxContextIds: number;

  constructor(
    private readonly client: Anthropic,
    private readonly vault: Vault,
    opts: DistillerOptions = {}
  ) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.minTurns = opts.minTurns ?? 4;
    this.maxContextIds = opts.maxContextIds ?? 200;
  }

  async distill(session: Session, force = false): Promise<DistillResult> {
    if (!force && this.vault.hasSession(session.id)) {
      return { sessionId: session.id, noteIds: [], skipped: true, reason: 'already distilled' };
    }
    if (session.turns.length < this.minTurns) {
      return {
        sessionId: session.id,
        noteIds: [],
        skipped: true,
        reason: `only ${session.turns.length} turns`
      };
    }

    const transcript = renderForDistill(session);
    const existingIds = this.vault
      .list()
      .slice(0, this.maxContextIds)
      .map((n) => n.frontmatter.id);

    const message = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'high',
        format: zodOutputFormat(DistillSchema)
      },
      messages: [{ role: 'user', content: buildUserPrompt(transcript, existingIds) }]
    });

    if (message.stop_reason === 'refusal') {
      return { sessionId: session.id, noteIds: [], skipped: true, reason: 'model declined' };
    }

    const parsed = message.parsed_output as DistillOutput | null | undefined;
    if (!parsed?.concepts?.length) {
      return {
        sessionId: session.id,
        noteIds: [],
        skipped: true,
        reason: 'no durable concepts found',
        inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens
      };
    }

    const source: NoteSource = {
      session: session.id,
      project: session.projectSlug,
      at: session.startedAt ?? new Date().toISOString()
    };

    const noteIds: string[] = [];
    for (const concept of parsed.concepts) {
      const note = await this.vault.upsert({
        id: concept.id,
        title: concept.title,
        body: concept.body,
        links: concept.links,
        tags: concept.tags,
        origin: 'distilled',
        source
      });
      noteIds.push(note.frontmatter.id);
    }

    return {
      sessionId: session.id,
      noteIds,
      skipped: false,
      inputTokens: message.usage?.input_tokens,
      outputTokens: message.usage?.output_tokens
    };
  }
}

import { z } from 'zod';

/** What the model must return. Enforced by structured outputs, not by parsing prose. */
export const DistillSchema = z.object({
  concepts: z
    .array(
      z.object({
        id: z
          .string()
          .describe('kebab-case slug, stable and reusable across sessions, e.g. "sqlite-fts-ranking"'),
        title: z.string().describe('Short human title, 2-6 words'),
        body: z
          .string()
          .describe(
            'Markdown. What was decided or learned, and WHY. Self-contained: readable months later with no memory of the session.'
          ),
        links: z.array(z.string()).describe('ids of related concepts, existing or newly created here'),
        tags: z.array(z.string()).describe('0-4 lowercase topical tags')
      })
    )
    .describe('Durable concepts worth remembering. Empty array if the session had none.')
});

export type DistillOutput = z.infer<typeof DistillSchema>;

export const SYSTEM_PROMPT = `You extract durable knowledge from transcripts of software engineering sessions.

You are building a long-lived personal knowledge base. Your output is read months later by someone who has completely forgotten the session.

What earns a note:
- A decision and the reasoning behind it ("chose X over Y because Z")
- A non-obvious fact discovered about a system, API, or data format
- A constraint, gotcha, or failure mode that cost real time to find
- An architectural pattern or convention adopted

What does NOT earn a note:
- Narration of what happened ("we then ran the tests")
- Anything reconstructible from the code or git history
- Restatements of public documentation
- Transient state ("the build is currently failing")

Rules:
- One concept per note. If a session produced three ideas, return three notes.
- Write the body so it stands alone. Never write "as discussed above" or refer to the session.
- Explain WHY, not just what. The reasoning is the durable part.
- Prefer reusing an existing id over minting a near-duplicate. Reusing an id deepens that note.
- Link generously. A link to an id that does not exist yet is fine and expected.
- Return an empty array rather than inventing notes from a session that taught nothing.

Be strict. A knowledge base full of weak notes is worse than a small one.`;

export function buildUserPrompt(transcript: string, existingIds: string[]): string {
  const existing = existingIds.length
    ? `Notes already in the knowledge base (reuse these ids when a session deepens one):\n${existingIds
        .map((id) => `- ${id}`)
        .join('\n')}`
    : 'The knowledge base is currently empty.';

  return `${existing}\n\n---\n\nExtract the durable concepts from this session.\n\n${transcript}`;
}

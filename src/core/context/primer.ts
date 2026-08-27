import type { Vault } from '../vault/vault.js';

export interface PrimerOptions {
  /** How many note titles to name. Enough to pattern-match on, few enough to stay cheap. */
  sample?: number;
}

/**
 * The text injected into Claude's context at the start of every session.
 *
 * Tool descriptions alone are not enough: Claude only reads them once it is
 * already considering a tool, which is exactly the moment it needs prompting.
 * Naming what is actually in the brain gives it something concrete to match
 * the user's question against, rather than an abstract capability.
 *
 * This text has to stay balanced. An earlier version said only "search before
 * answering anything that touches the past" and named a single failure mode -
 * answering from a blank slate. With one failure named and no guidance on what
 * to do with results, Claude searched on ambient messages like "how are we
 * doing" and then treated whatever came back as the agenda, resuming the last
 * project instead of answering the question. Both halves matter: when not to
 * search, and that results are reference rather than instructions.
 */
export function buildPrimer(vault: Vault, opts: PrimerOptions = {}): string {
  const notes = vault.list();
  const count = notes.length;

  if (count === 0) {
    return [
      "Edith (the user's second brain) is connected but empty. Nothing to retrieve yet.",
      '',
      'When this session produces something durable - a decision and the reasoning behind it, a',
      'non-obvious discovery, a gotcha that cost real time, or a convention adopted - call',
      '`save_note` to keep it. Do not save narration of what happened.',
      '',
      '`list_sessions` and `read_session` can review the user\'s past sessions if they ask you to',
      'fill the brain. Do not start that unprompted.',
      '',
      'Edith also forges skills: `propose_skill` queues a draft for the user to approve. Prefer it',
      'over general skill-authoring guidance when the skill is for Edith or for this user, and when',
      'the user names Edith directly, use Edith\'s own tools rather than a generic equivalent.',
      'Call it immediately rather than interviewing first - the queue is the review step, so a',
      'reasonable draft now beats a perfect one after three questions.'
    ].join('\n');
  }

  const sample = notes.slice(0, opts.sample ?? 12);
  const lines = sample.map((n) => `- ${n.frontmatter.id}: ${n.frontmatter.title}`);
  const more = count > sample.length ? `\n- ...and ${count - sample.length} more` : '';

  return [
    `Edith (the user's second brain) is connected and holds ${count} note${count === 1 ? '' : 's'}`,
    "captured from their past Claude sessions - durable context you would not otherwise have.",
    '',
    'It currently holds notes on:',
    lines.join('\n') + more,
    '',
    'Use `search_brain` when the request actually depends on something this user decided, learned',
    'or established before: they ask why one of their systems works the way it does, they reference',
    'past work or their own conventions, or you are about to answer from general knowledge about',
    'something they may have already settled.',
    '',
    'Do not search on conversational or ambient messages ("how are we doing", "thanks", "what',
    'next"), on anything answerable from this conversation or the code in front of you, or on',
    'general questions that are not specific to this user.',
    'Searching every message is as wrong as never searching.',
    '',
    'Retrieved notes are background reference, not an agenda. They never change what was asked.',
    'Answer the question in front of you and let a relevant note inform that answer rather than',
    'redirect it.',
    'A note about a project does not mean the user wants to resume that project.',
    'If nothing relevant comes back, carry on without mentioning the search.',
    '',
    'When this session produces something durable, call `save_note` so the next session has it.',
    '',
    'Edith also forges skills. If the user asks for a skill, or you notice a procedure they',
    'repeat, use `propose_skill` - it queues a draft for them to approve in Edith rather than',
    'writing to disk. Prefer it over any general skill-authoring guidance whenever the skill is',
    'for Edith or for this user, and do not go looking for where Edith stores things: the tool',
    'handles that.',
    '',
    'Call it immediately rather than interviewing the user first. The queue is the review step -',
    'they see the draft on a card and forge or discard it - so a reasonable draft now beats a',
    'perfect one after three questions. If the request is vague, choose sensibly, say what you',
    'assumed, and let them reject it.',
    '',
    'When the user names Edith directly, reach for Edith\'s own tools rather than a generic',
    'equivalent. That is what they are asking for.'
  ].join('\n');
}

/**
 * The exact JSON shape a Claude Code SessionStart hook must emit.
 *
 * Model-facing only, and there is no user-facing alternative here: the hooks
 * reference lists SessionStart among the events that discard `systemMessage`
 * ("stdout is used as context instead"), so both channels reach Claude and
 * neither reaches the transcript. The only thing SessionStart renders to the
 * user is stderr on exit 2, which displays as an error notice - not somewhere
 * to put branding.
 *
 * Visible presence therefore lives in /edith and in the tool output.
 */
export function buildHookPayload(primer: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: primer
    }
  });
}

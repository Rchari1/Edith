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
 */
export function buildPrimer(vault: Vault, opts: PrimerOptions = {}): string {
  const notes = vault.list();
  const count = notes.length;

  if (count === 0) {
    return [
      "Edith (the user's second brain) is connected but empty.",
      '',
      'When this session produces something durable - a decision and the reasoning behind it, a',
      'non-obvious discovery, a gotcha that cost real time, or a convention adopted - call',
      '`save_note` to keep it. Do not save narration of what happened.',
      '',
      'You can also offer to fill it: `list_sessions` and `read_session` let you review the',
      "user's past Claude sessions and save what mattered."
    ].join('\n');
  }

  const sample = notes.slice(0, opts.sample ?? 12);
  const lines = sample.map((n) => `- ${n.frontmatter.id}: ${n.frontmatter.title}`);
  const more = count > sample.length ? `\n- ...and ${count - sample.length} more` : '';

  return [
    `Edith (the user's second brain) is connected and holds ${count} note${count === 1 ? '' : 's'}`,
    'distilled from their past Claude sessions. It is durable context you do not otherwise have.',
    '',
    'Most recently updated:',
    lines.join('\n') + more,
    '',
    '**Call `search_brain` before answering anything that touches the past.** In particular when',
    'the user refers to a previous decision, asks why something is the way it is, mentions their',
    'own conventions, says "we decided" / "like last time" / "the usual way", or asks about a',
    'project or system named above. Searching costs almost nothing; answering from a blank slate',
    'when the answer was already written down is the failure mode to avoid.',
    '',
    'When this session produces something durable, call `save_note` so the next session has it.'
  ].join('\n');
}

/** The exact JSON shape a Claude Code SessionStart hook must emit. */
export function buildHookPayload(primer: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: primer
    }
  });
}

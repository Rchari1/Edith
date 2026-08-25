import path from 'node:path';
import type { TranscriptKind } from '../types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Classify a .jsonl path found under ~/.claude/projects.
 *
 * The directory holds several kinds of file and only one of them is a session:
 *
 *   <project>/<uuid>.jsonl                          -> a real session
 *   <project>/<uuid>/subagents/**\/agent-*.jsonl    -> a subagent OF that session
 *   <project>/<uuid>/subagents/**\/journal.jsonl    -> workflow journal, not conversation
 *   <project>/memory/**                             -> Claude's own memory store
 *
 * Globbing `**\/*.jsonl` and treating every hit as a session is wrong: on a
 * typical machine the subagent transcripts outnumber real sessions ~9:1, and
 * ingesting them produces a vault full of context-free fragments.
 */
export function classifyTranscript(projectsRoot: string, absPath: string): TranscriptKind {
  const rel = path.relative(projectsRoot, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { kind: 'ignored', reason: 'outside projects root' };
  }

  const parts = rel.split(path.sep);
  const projectSlug = parts[0];
  if (!projectSlug || parts.length < 2) {
    return { kind: 'ignored', reason: 'not inside a project directory' };
  }
  if (parts.includes('memory')) {
    return { kind: 'ignored', reason: "Claude's own memory store" };
  }
  if (!absPath.endsWith('.jsonl')) {
    return { kind: 'ignored', reason: 'not a .jsonl file' };
  }

  // <project>/<uuid>.jsonl
  if (parts.length === 2) {
    const base = path.basename(parts[1]!, '.jsonl');
    return UUID_RE.test(base)
      ? { kind: 'session', projectSlug, sessionId: base }
      : { kind: 'ignored', reason: `top-level file is not a session uuid: ${base}` };
  }

  // <project>/<uuid>/subagents/...
  const sessionId = parts[1]!;
  if (!UUID_RE.test(sessionId)) {
    return { kind: 'ignored', reason: `nested under non-session dir: ${sessionId}` };
  }
  if (parts[2] !== 'subagents') {
    return { kind: 'ignored', reason: `unknown nested dir: ${parts[2]}` };
  }

  const base = path.basename(rel, '.jsonl');
  if (base === 'journal') {
    return { kind: 'ignored', reason: 'workflow journal, not a conversation' };
  }
  const agentId = base.startsWith('agent-') ? base.slice('agent-'.length) : base;
  return { kind: 'subagent', projectSlug, sessionId, agentId };
}

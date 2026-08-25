import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import type { Session, Turn, SubagentTranscript } from '../types.js';

/** A raw transcript line. Claude Code writes ~9 different shapes; we only care about a few. */
interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  toolUseResult?: unknown;
  aiTitle?: string;
  leafUuid?: string;
  message?: { role?: string; content?: unknown };
}

interface ContentExtract {
  text: string;
  tools: string[];
}

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/**
 * Pull visible text and tool names out of a message body.
 * Drops `thinking` (huge, and not what the user said) and `tool_result` (noise).
 */
export function extractContent(content: unknown): ContentExtract {
  if (typeof content === 'string') {
    return { text: cleanText(content), tools: [] };
  }
  if (!Array.isArray(content)) return { text: '', tools: [] };

  const texts: string[] = [];
  const tools: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; text?: string; name?: string };
    if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b.type === 'tool_use' && typeof b.name === 'string') tools.push(b.name);
    // 'thinking' and 'tool_result' deliberately ignored.
  }
  return { text: cleanText(texts.join('\n\n')), tools };
}

function cleanText(s: string): string {
  return s.replace(SYSTEM_REMINDER_RE, '').trim();
}

/** True for lines that carry a tool result rather than something a human typed. */
function isToolResultCarrier(line: RawLine): boolean {
  if (line.toolUseResult != null) return true;
  const content = line.message?.content;
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result'
  );
}

/**
 * Read a transcript into an ordered list of records, tolerating partial writes.
 * These files are appended to live, so the final line is regularly half-written.
 */
async function readLines(file: string): Promise<{ lines: RawLine[]; malformed: number }> {
  const lines: RawLine[] = [];
  let malformed = 0;

  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const raw of rl) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RawLine);
    } catch {
      malformed++;
    }
  }
  return { lines, malformed };
}

/**
 * Reconstruct the canonical conversation thread.
 *
 * Transcripts are a tree, not a list: interrupting Claude or editing a prompt
 * forks the history and leaves the abandoned branch in the file. Claude Code
 * records the tip of the live thread as `last-prompt.leafUuid`, so we walk
 * parentUuid back from that tip and keep only what is actually reachable.
 * Without this, abandoned branches get distilled as if they were real.
 */
export function canonicalThread(lines: RawLine[]): RawLine[] {
  const conversational = lines.filter((l) => l.type === 'user' || l.type === 'assistant');
  const byUuid = new Map<string, RawLine>();
  for (const l of conversational) if (l.uuid) byUuid.set(l.uuid, l);

  let leaf: string | undefined;
  for (const l of lines) if (l.type === 'last-prompt' && l.leafUuid) leaf = l.leafUuid;

  if (!leaf || !byUuid.has(leaf)) {
    // No usable tip (very short or still-open session): fall back to file order.
    return conversational;
  }

  const chain: RawLine[] = [];
  const seen = new Set<string>();
  let cursor: string | null | undefined = leaf;
  while (cursor && byUuid.has(cursor) && !seen.has(cursor)) {
    seen.add(cursor);
    const node: RawLine = byUuid.get(cursor)!;
    chain.push(node);
    cursor = node.parentUuid ?? null;
  }
  return chain.reverse();
}

/** Convert surviving records into Turns, dropping anything with no human-visible content. */
function toTurns(records: RawLine[]): Turn[] {
  const turns: Turn[] = [];
  for (const line of records) {
    const role = line.message?.role ?? line.type;
    if (role !== 'user' && role !== 'assistant') continue;
    if (role === 'user' && (line.isMeta === true || isToolResultCarrier(line))) continue;

    const { text, tools } = extractContent(line.message?.content);
    if (!text && tools.length === 0) continue;

    turns.push({
      uuid: line.uuid ?? '',
      parentUuid: line.parentUuid ?? null,
      role,
      text,
      toolsUsed: tools,
      timestamp: line.timestamp ?? ''
    });
  }
  return turns;
}

/** Parse a main session transcript. */
export async function parseSession(
  file: string,
  projectSlug: string,
  sessionId: string
): Promise<Session> {
  const { lines, malformed } = await readLines(file);

  let title: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  for (const l of lines) {
    if (l.type === 'ai-title' && l.aiTitle) title = l.aiTitle;
    if (!cwd && l.cwd) cwd = l.cwd;
    if (!gitBranch && l.gitBranch) gitBranch = l.gitBranch;
  }

  const turns = toTurns(canonicalThread(lines));
  const stamps = lines.map((l) => l.timestamp).filter((t): t is string => Boolean(t)).sort();

  return {
    id: sessionId,
    projectSlug,
    cwd,
    gitBranch,
    title,
    startedAt: stamps[0] ?? null,
    endedAt: stamps[stamps.length - 1] ?? null,
    turns,
    subagents: [],
    sourcePath: file,
    malformedLines: malformed
  };
}

/** Parse a subagent transcript. These attach to a parent session, never stand alone. */
export async function parseSubagent(file: string, agentId: string): Promise<SubagentTranscript> {
  const { lines } = await readLines(file);
  return { path: file, agentId, turns: toTurns(canonicalThread(lines)) };
}

/** Render a session as the plain transcript the distiller reads. */
export function renderForDistill(session: Session, maxChars = 240_000): string {
  const header = [
    `# Session ${session.id}`,
    session.title ? `Title: ${session.title}` : null,
    session.cwd ? `Directory: ${path.basename(session.cwd)}` : null,
    session.startedAt ? `Date: ${session.startedAt}` : null
  ]
    .filter(Boolean)
    .join('\n');

  const body = session.turns
    .map((t) => {
      const tools = t.toolsUsed.length ? ` [used: ${[...new Set(t.toolsUsed)].join(', ')}]` : '';
      const speaker = t.role === 'user' ? 'User' : 'Claude';
      return `## ${speaker}${tools}\n${t.text}`.trim();
    })
    .join('\n\n');

  const full = `${header}\n\n${body}`;
  if (full.length <= maxChars) return full;
  // Keep the head and tail: openings state intent, endings state conclusions.
  const half = Math.floor(maxChars / 2);
  return `${full.slice(0, half)}\n\n[... middle of session truncated ...]\n\n${full.slice(-half)}`;
}

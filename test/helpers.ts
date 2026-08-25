import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'sb-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

interface LineOpts {
  uuid: string;
  parent?: string | null;
  role?: 'user' | 'assistant';
  text?: string;
  tools?: string[];
  isMeta?: boolean;
  toolResult?: boolean;
  ts?: string;
}

/** Build a transcript line in the real Claude Code shape. */
export function line(o: LineOpts): string {
  const role = o.role ?? 'user';
  const content: unknown[] = [];
  if (o.toolResult) {
    content.push({ type: 'tool_result', tool_use_id: 'tu_1', content: 'result body' });
  } else {
    if (o.text) content.push({ type: 'text', text: o.text });
    for (const t of o.tools ?? []) content.push({ type: 'tool_use', id: `tu_${t}`, name: t, input: {} });
  }
  return JSON.stringify({
    type: role,
    uuid: o.uuid,
    parentUuid: o.parent ?? null,
    sessionId: '11111111-2222-3333-4444-555555555555',
    timestamp: o.ts ?? '2026-08-25T10:00:00.000Z',
    cwd: '/Users/someone/proj',
    gitBranch: 'main',
    isSidechain: false,
    ...(o.isMeta ? { isMeta: true } : {}),
    ...(o.toolResult ? { toolUseResult: { ok: true } } : {}),
    message: { role, content }
  });
}

export function meta(type: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ type, sessionId: '11111111-2222-3333-4444-555555555555', ...extra });
}

/**
 * A transcript with a fork: the user interrupted, so uuid 'b' has two children.
 * Only the branch reachable from leafUuid is real.
 */
export function forkedTranscript(): string {
  return [
    line({ uuid: 'a', parent: null, role: 'user', text: 'first question' }),
    line({ uuid: 'b', parent: 'a', role: 'assistant', text: 'first answer', tools: ['Bash'] }),
    line({ uuid: 'abandoned', parent: 'b', role: 'user', text: 'ABANDONED BRANCH' }),
    line({ uuid: 'c', parent: 'b', role: 'user', text: 'second question' }),
    line({ uuid: 'tr', parent: 'c', role: 'user', text: '', toolResult: true }),
    line({ uuid: 'm', parent: 'c', role: 'user', text: 'injected', isMeta: true }),
    line({ uuid: 'd', parent: 'c', role: 'assistant', text: 'second answer' }),
    meta('ai-title', { aiTitle: 'A Test Session' }),
    meta('last-prompt', { leafUuid: 'd' }),
    meta('file-history-snapshot', { snapshot: { big: 'x'.repeat(50) } }),
    '{ this line is not valid json',
    ''
  ].join('\n');
}

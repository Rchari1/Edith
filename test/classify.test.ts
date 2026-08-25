import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { classifyTranscript } from '@core/parser/classify.js';

const ROOT = '/home/u/.claude/projects';
const S = '547bcf8e-77bc-4a3c-9c9c-078bc4c600b5';
const p = (...parts: string[]) => path.join(ROOT, ...parts);

describe('classifyTranscript', () => {
  it('treats a top-level uuid.jsonl as a session', () => {
    expect(classifyTranscript(ROOT, p('-Users-u-proj', `${S}.jsonl`))).toEqual({
      kind: 'session',
      projectSlug: '-Users-u-proj',
      sessionId: S
    });
  });

  it('treats subagent transcripts as subagents, not sessions', () => {
    const r = classifyTranscript(ROOT, p('-Users-u-proj', S, 'subagents', 'workflows', 'wf_x', 'agent-abc123.jsonl'));
    expect(r).toEqual({ kind: 'subagent', projectSlug: '-Users-u-proj', sessionId: S, agentId: 'abc123' });
  });

  it('ignores workflow journals', () => {
    const r = classifyTranscript(ROOT, p('-Users-u-proj', S, 'subagents', 'workflows', 'wf_x', 'journal.jsonl'));
    expect(r.kind).toBe('ignored');
  });

  it("ignores Claude's own memory store", () => {
    expect(classifyTranscript(ROOT, p('-Users-u-proj', 'memory', 'MEMORY.md')).kind).toBe('ignored');
    expect(classifyTranscript(ROOT, p('-Users-u-proj', 'memory', 'x.jsonl')).kind).toBe('ignored');
  });

  it('ignores non-uuid top-level files', () => {
    expect(classifyTranscript(ROOT, p('-Users-u-proj', 'notes.jsonl')).kind).toBe('ignored');
  });

  it('ignores paths outside the projects root', () => {
    expect(classifyTranscript(ROOT, '/etc/passwd.jsonl').kind).toBe('ignored');
  });

  it('does not mistake 136 subagent files for sessions', () => {
    // The bug this whole function exists to prevent.
    const files = [
      p('-Users-u-proj', `${S}.jsonl`),
      ...Array.from({ length: 10 }, (_, i) =>
        p('-Users-u-proj', S, 'subagents', 'workflows', 'wf_a', `agent-${i}.jsonl`)
      )
    ];
    const sessions = files.map((f) => classifyTranscript(ROOT, f)).filter((k) => k.kind === 'session');
    expect(sessions).toHaveLength(1);
  });
});

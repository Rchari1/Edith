import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseSession, extractContent, renderForDistill } from '@core/parser/parse-session.js';
import { tmpDir, rm, forkedTranscript } from './helpers.js';

describe('extractContent', () => {
  it('reads a plain string body', () => {
    expect(extractContent('hello')).toEqual({ text: 'hello', tools: [] });
  });

  it('keeps text and tool names, drops thinking and tool_result', () => {
    const r = extractContent([
      { type: 'thinking', thinking: 'secret reasoning' },
      { type: 'text', text: 'visible' },
      { type: 'tool_use', name: 'Bash', input: {} },
      { type: 'tool_result', content: 'noise' }
    ]);
    expect(r.text).toBe('visible');
    expect(r.tools).toEqual(['Bash']);
    expect(r.text).not.toContain('secret');
  });

  it('strips system-reminder blocks', () => {
    const r = extractContent('real text <system-reminder>injected junk</system-reminder> more');
    expect(r.text).not.toContain('injected');
    expect(r.text).toContain('real text');
  });
});

describe('parseSession', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'x.jsonl');
  fs.writeFileSync(file, forkedTranscript());

  it('follows leafUuid and drops the abandoned branch', async () => {
    const s = await parseSession(file, '-Users-u-proj', 'sid');
    const texts = s.turns.map((t) => t.text).join(' ');
    expect(texts).toContain('first question');
    expect(texts).toContain('second answer');
    expect(texts).not.toContain('ABANDONED BRANCH');
  });

  it('drops tool-result carriers and isMeta lines', async () => {
    const s = await parseSession(file, '-Users-u-proj', 'sid');
    const texts = s.turns.map((t) => t.text).join(' ');
    expect(texts).not.toContain('injected');
    expect(s.turns.every((t) => !t.text.includes('result body'))).toBe(true);
  });

  it('survives a malformed trailing line and counts it', async () => {
    const s = await parseSession(file, '-Users-u-proj', 'sid');
    expect(s.malformedLines).toBe(1);
    expect(s.turns.length).toBeGreaterThan(0);
  });

  it("picks up Claude's own session title and metadata", async () => {
    const s = await parseSession(file, '-Users-u-proj', 'sid');
    expect(s.title).toBe('A Test Session');
    expect(s.cwd).toBe('/Users/someone/proj');
    expect(s.gitBranch).toBe('main');
  });

  it('records tool usage on the turn', async () => {
    const s = await parseSession(file, '-Users-u-proj', 'sid');
    expect(s.turns.some((t) => t.toolsUsed.includes('Bash'))).toBe(true);
  });

  it('falls back to file order when there is no leafUuid', async () => {
    const f2 = path.join(dir, 'y.jsonl');
    fs.writeFileSync(
      f2,
      [
        JSON.stringify({ type: 'user', uuid: 'a', message: { role: 'user', content: 'only turn' } })
      ].join('\n')
    );
    const s = await parseSession(f2, 'p', 'sid2');
    expect(s.turns).toHaveLength(1);
  });
});

describe('renderForDistill', () => {
  it('truncates from the middle, keeping head and tail', async () => {
    const dir2 = tmpDir();
    const f = path.join(dir2, 'big.jsonl');
    const lines = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        uuid: `u${i}`,
        parentUuid: i === 0 ? null : `u${i - 1}`,
        timestamp: `2026-08-25T10:00:${String(i).padStart(2, '0')}.000Z`,
        message: { role: 'user', content: `TURN${i} ${'x'.repeat(500)}` }
      })
    );
    fs.writeFileSync(f, lines.join('\n'));
    const s = await parseSession(f, 'p', 'sid');
    const out = renderForDistill(s, 4000);
    expect(out).toContain('TURN0');
    expect(out).toContain('TURN39');
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(4600);
    rm(dir2);
  });
});

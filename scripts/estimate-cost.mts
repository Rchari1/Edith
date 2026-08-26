/** Estimate distillation cost over the real transcript corpus. */
import path from 'node:path';
import os from 'node:os';
import { SessionWatcher } from '../src/core/watcher/index.js';
import { renderForDistill } from '../src/core/parser/parse-session.js';

const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 }
};

const OUT_TOKENS = 900; // a few concept notes per session

const watcher = new SessionWatcher({ projectsRoot: path.join(os.homedir(), '.claude', 'projects') });
const found = await watcher.scanExisting();

let rawBytes = 0;
let sentChars = 0;
let distillable = 0;
const rows: Array<{ id: string; turns: number; chars: number }> = [];

for (const e of found) {
  const session = await watcher.loadSession(e.file, e.projectSlug, e.sessionId);
  const { size } = await import('node:fs').then((fs) => fs.promises.stat(e.file));
  rawBytes += size;
  if (session.turns.length < 4) continue;
  distillable++;
  const rendered = renderForDistill(session);
  sentChars += rendered.length;
  rows.push({ id: session.title ?? session.id.slice(0, 8), turns: session.turns.length, chars: rendered.length });
}

const inTokens = Math.round(sentChars / 4);
const fmt = (n: number) => n.toLocaleString('en-US');

console.log(`sessions found:        ${found.length}`);
console.log(`distillable (>=4 turns): ${distillable}`);
console.log(`raw transcript bytes:  ${fmt(Math.round(rawBytes / 1024 / 1024))} MB`);
console.log(`text actually sent:    ${fmt(Math.round(sentChars / 1024))} KB  (~${fmt(inTokens)} input tokens)`);
console.log(`compression:           ${(rawBytes / Math.max(1, sentChars)).toFixed(1)}x smaller than raw\n`);

console.log('BACKFILL (one-time, all sessions):');
for (const [model, p] of Object.entries(PRICES)) {
  const cost = (inTokens / 1e6) * p.in + ((OUT_TOKENS * distillable) / 1e6) * p.out;
  console.log(`  ${model.padEnd(18)} $${cost.toFixed(3)}`);
}

const avgIn = distillable ? inTokens / distillable : 0;
console.log(`\nPER SESSION (avg ${fmt(Math.round(avgIn))} input tokens):`);
for (const [model, p] of Object.entries(PRICES)) {
  const cost = (avgIn / 1e6) * p.in + (OUT_TOKENS / 1e6) * p.out;
  console.log(`  ${model.padEnd(18)} $${cost.toFixed(4)}   -> 100 sessions/mo = $${(cost * 100).toFixed(2)}`);
}

console.log('\nlargest sessions:');
for (const r of rows.sort((a, b) => b.chars - a.chars).slice(0, 5)) {
  console.log(`  ${String(Math.round(r.chars / 1024)).padStart(5)} KB  ${String(r.turns).padStart(3)} turns  ${r.id}`);
}

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createThrottle } from '@core/util/throttle.js';
import { SessionWatcher } from '@core/watcher/index.js';
import { tmpDir, rm, line, meta } from './helpers.js';

describe('createThrottle', () => {
  it('allows the first call and suppresses rapid follow-ups', () => {
    const allow = createThrottle(1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('a', 300)).toBe(false);
    expect(allow('a', 999)).toBe(false);
    expect(allow('a', 1000)).toBe(true);
  });

  it('tracks keys independently', () => {
    const allow = createThrottle(1000);
    expect(allow('a', 0)).toBe(true);
    expect(allow('b', 0)).toBe(true);
    expect(allow('a', 100)).toBe(false);
    expect(allow('b', 100)).toBe(false);
  });
});

describe('live session detection', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rm(d);
    dirs.length = 0;
  });

  it('emits activity while a transcript is being written, before it settles', async () => {
    const root = tmpDir('sb-live-');
    dirs.push(root);
    const project = path.join(root, '-Users-u-app');
    fs.mkdirSync(project, { recursive: true });

    const id = 'cccccccc-1111-2222-3333-444444444444';
    const file = path.join(project, `${id}.jsonl`);
    fs.writeFileSync(file, line({ uuid: 'x1', parent: null, role: 'user', text: 'starting' }));

    // settleMs is long so this can only pass via the live activity signal,
    // not by the session having finished.
    const watcher = new SessionWatcher({ projectsRoot: root, settleMs: 60_000 });
    await watcher.start();

    const activity = new Promise<{ sessionId: string }>((resolve) =>
      watcher.once('activity', resolve)
    );

    fs.appendFileSync(file, '\n' + line({ uuid: 'x2', parent: 'x1', role: 'assistant', text: 'mid-conversation' }));

    const event = await activity;
    expect(event.sessionId).toBe(id);
    await watcher.stop();
  }, 20000);

  it('does not report activity for subagent transcripts', async () => {
    const root = tmpDir('sb-live2-');
    dirs.push(root);
    const id = 'dddddddd-1111-2222-3333-444444444444';
    const sub = path.join(root, '-Users-u-app', id, 'subagents', 'workflows', 'wf_a');
    fs.mkdirSync(sub, { recursive: true });

    const watcher = new SessionWatcher({ projectsRoot: root, settleMs: 60_000 });
    await watcher.start();

    let fired = false;
    watcher.on('activity', () => { fired = true; });
    fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), line({ uuid: 's1', role: 'user', text: 'subagent noise' }));

    await new Promise((r) => setTimeout(r, 2000));
    expect(fired).toBe(false);
    await watcher.stop();
  }, 20000);
});

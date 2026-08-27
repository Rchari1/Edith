import { describe, it, expect } from 'vitest';
import { clusterNotes, type Galaxy } from '@core/cluster/index.js';
import type { Note } from '@core/types.js';

function note(id: string, title: string, body: string, tags: string[] = []): Note {
  return {
    frontmatter: {
      id,
      title,
      type: 'concept',
      created: '2026-08-01',
      updated: '2026-08-01',
      sources: [],
      links: [],
      origin: 'distilled',
      tags
    },
    body,
    path: `/vault/${id}.md`
  };
}

/**
 * Three subjects that share almost no vocabulary, which is the situation
 * galaxies are for. Each note repeats its domain's terms the way a real note
 * about one subject does.
 */
const QUANTUM = [
  note('q1', 'Distillation trades two pairs for one', 'Entanglement distillation consumes two noisy pairs to yield one pair of higher fidelity. The protocol discards failures.'),
  note('q2', 'Fidelity levels are half-open intervals', 'A pair sits at a fidelity level when its fidelity falls in the interval. Distillation moves a pair up a level.'),
  note('q3', 'The BBPSSW ladder', 'BBPSSW distillation applied repeatedly forms a ladder of fidelity levels, each pair climbing as the protocol consumes entanglement.'),
  note('q4', 'Decoherence bounds the ladder', 'Stored entanglement decoheres, so fidelity decays and the distillation ladder cannot climb indefinitely.')
];

const INFRA = [
  note('i1', 'The watcher debounces file events', 'The filesystem watcher coalesces rapid file writes into one event so the indexer does not run per keystroke.'),
  note('i2', 'SQLite holds the search index', 'The search index lives in a SQLite table rebuilt when a file changes on disk. Queries hit the index rather than the filesystem.'),
  note('i3', 'Indexing runs off the main thread', 'File indexing is queued so a large directory does not block. The queue drains in the background.'),
  note('i4', 'Watch the vault directory', 'The vault directory is watched recursively; a new file triggers an index write.')
];

const DESIGN = [
  note('d1', 'One radius everywhere', 'Every square corner in the interface uses the same four pixel radius. A softer corner is not offered by the system.'),
  note('d2', 'Colour only means state', 'Nothing in the interface is coloured for emphasis. Colour is reserved for state, so a coloured element carries information.'),
  note('d3', 'The opacity scale', 'Every surface is white at one of a fixed set of opacities. Adding an opacity is a design decision.'),
  note('d4', 'Motion uses one curve', 'All interface motion shares a single easing curve. Nothing snaps; panels ease rather than vanish.')
];

describe('clusterNotes', () => {
  it('finds one galaxy per subject, without being told how many', () => {
    const { galaxies, field } = clusterNotes([...QUANTUM, ...INFRA, ...DESIGN]);
    expect(galaxies).toHaveLength(3);
    expect(field).toEqual([]);
    for (const g of galaxies) {
      expect(new Set(g.noteIds.map((id) => id[0])).size).toBe(1);
    }
  });

  it('splits a varied vault more than a narrow one of the same size', () => {
    // The property that matters is relative. Asserting an exact count on one
    // subject is brittle: eight notes on entanglement still divide into
    // sub-themes if the prose does, and that is the algorithm working, not
    // failing. What must hold is that three subjects fragment more than one.
    const narrow = [
      ...QUANTUM,
      note('q5', 'Distillation raises pair fidelity', 'Entanglement distillation consumes noisy pairs and yields a pair of higher fidelity; the protocol discards failures.'),
      note('q6', 'Fidelity decays for a stored pair', 'A stored entanglement pair loses fidelity, so the distillation ladder of fidelity levels cannot be climbed slowly.'),
      note('q7', 'The distillation protocol discards pairs', 'Distillation consumes two entanglement pairs and keeps the pair whose fidelity passes; failures are discarded.'),
      note('q8', 'Fidelity levels partition the ladder', 'Each fidelity level is an interval on the distillation ladder, and a pair sits at the level holding its fidelity.')
    ];
    const varied = [...QUANTUM, ...INFRA, ...DESIGN];

    const n = clusterNotes(narrow).galaxies.length;
    const v = clusterNotes(varied).galaxies.length;
    expect(v).toBeGreaterThan(n);
  });

  it('names a galaxy after its own vocabulary', () => {
    const { galaxies } = clusterNotes([...QUANTUM, ...INFRA, ...DESIGN]);
    const quantum = galaxies.find((g) => g.noteIds.includes('q1'));
    expect(quantum).toBeDefined();
    expect(quantum!.terms.join(' ')).toMatch(/fidelity|distillation|pair|entanglement|ladder/);
  });

  it('leaves a note in the field when nothing is like it', () => {
    const odd = note('x1', 'A sourdough starter needs feeding', 'Flour and water, discarded and refreshed daily until the culture rises predictably.');
    const { galaxies, field } = clusterNotes([...QUANTUM, ...INFRA, odd]);
    expect(field).toContain('x1');
    for (const g of galaxies) expect(g.noteIds).not.toContain('x1');
  });

  it('dissolves groups too small to be a galaxy', () => {
    // Each subject has four notes, so a floor of five leaves nothing standing.
    const { galaxies, field } = clusterNotes([...QUANTUM, ...INFRA, ...DESIGN], { minSize: 5 });
    expect(galaxies).toEqual([]);
    expect(field).toHaveLength(12);
  });

  it('returns everything to the field when there is barely a vault', () => {
    const { galaxies, field } = clusterNotes(QUANTUM.slice(0, 2));
    expect(galaxies).toEqual([]);
    expect(field).toEqual(['q1', 'q2']);
  });

  it('accounts for every note exactly once', () => {
    const all = [...QUANTUM, ...INFRA, ...DESIGN];
    const { galaxies, field } = clusterNotes(all);
    const seen = [...galaxies.flatMap((g) => g.noteIds), ...field].sort();
    expect(seen).toEqual(all.map((n) => n.frontmatter.id).sort());
  });

  it('is deterministic', () => {
    const all = [...QUANTUM, ...INFRA, ...DESIGN];
    const a = clusterNotes(all);
    const b = clusterNotes(all);
    expect(b).toEqual(a);
  });

  it('keeps a galaxy id when a note is added to it', () => {
    const first = clusterNotes([...QUANTUM, ...INFRA, ...DESIGN]);
    const quantumBefore = first.galaxies.find((g) => g.noteIds.includes('q1')) as Galaxy;

    const grown = note('q5', 'Purification raises fidelity', 'Each purification round consumes pairs and raises the fidelity of what survives.');
    const second = clusterNotes([...QUANTUM, grown, ...INFRA, ...DESIGN], {
      previous: first.galaxies
    });
    const quantumAfter = second.galaxies.find((g) => g.noteIds.includes('q1')) as Galaxy;

    expect(quantumAfter).toBeDefined();
    expect(quantumAfter.id).toBe(quantumBefore.id);
    expect(quantumAfter.noteIds).toContain('q5');
  });

  it('does not hand one previous id to two galaxies', () => {
    const first = clusterNotes([...QUANTUM, ...INFRA, ...DESIGN]);
    const second = clusterNotes([...QUANTUM, ...INFRA, ...DESIGN], { previous: first.galaxies });
    const ids = second.galaxies.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('honours a forced threshold, overriding the natural cut', () => {
    const all = [...QUANTUM, ...INFRA, ...DESIGN];
    const loose = clusterNotes(all, { threshold: 0.02, minSize: 2 });
    const tight = clusterNotes(all, { threshold: 0.2, minSize: 2 });
    const meanSize = (r: { galaxies: Galaxy[] }) =>
      r.galaxies.reduce((n, g) => n + g.noteIds.length, 0) / Math.max(r.galaxies.length, 1);
    expect(meanSize(tight)).toBeLessThanOrEqual(meanSize(loose));
  });

  it('never reports more galaxies than asked for', () => {
    const { galaxies } = clusterNotes([...QUANTUM, ...INFRA, ...DESIGN], { maxGalaxies: 2 });
    expect(galaxies.length).toBeLessThanOrEqual(2);
  });

  it('labels a galaxy with terms particular to it', () => {
    const { galaxies } = clusterNotes([...QUANTUM, ...INFRA, ...DESIGN]);
    for (const g of galaxies) {
      expect(g.terms.length).toBeGreaterThan(0);
      // A label built from function words would name nothing.
      for (const filler of ['every', 'one', 'uses', 'same', 'rather']) {
        expect(g.terms).not.toContain(filler);
      }
    }
  });
});

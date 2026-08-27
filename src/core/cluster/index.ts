import type { Note } from '../types.js';

/**
 * Grouping notes into galaxies.
 *
 * The graph seeds each note into a strange attractor by hashing its id, so
 * position carries no meaning today. To make position mean something, notes
 * need to be grouped by what they are about - and the grouping has to come
 * from the notes themselves, because Edith holds no API key and cannot reach
 * an embedding model.
 *
 * So: TF-IDF over the note text, cosine similarity, average-link agglomerative
 * merging. Measured on a real vault, that separates genuinely different
 * subject matter about 4x (within-topic cosine 0.085 against 0.021 between)
 * while barely separating two facets of the same project at 1.8x. That
 * coarseness is deliberate. Galaxies should fall along project lines - a
 * handful of legible basins - rather than fragmenting every topic into
 * subtopics nobody asked for.
 *
 * What this is not: tags are no good here because the distiller writes facets
 * (`draft`, `todo`, `result`) rather than subjects, and the authored `links`
 * graph is one dense component with no natural cut.
 */

/** A group of notes that belong together, and the terms that make it one. */
export interface Galaxy {
  /**
   * Stable across recomputes. Galaxies are matched to their previous selves by
   * centroid, so the renderer can keep a basin in place while its membership
   * shifts underneath.
   */
  id: string;
  /** The terms most distinctive to this galaxy, strongest first. */
  terms: string[];
  /** Note ids, in the order they were merged in. */
  noteIds: string[];
}

export interface ClusterOptions {
  /**
   * Force a fixed cut instead of finding the natural one.
   *
   * Left unset, the number of galaxies is discovered from the merge heights
   * (see `agglomerate`). Setting this pins the cut at an absolute cosine,
   * which is mostly useful for tests that need a known answer.
   */
  threshold?: number;
  /**
   * Never report more than this many galaxies. A screen full of basins is not
   * more informative than a handful.
   */
  maxGalaxies?: number;
  /**
   * Galaxies smaller than this are dissolved and their notes returned to the
   * field. A basin holding two notes reads as debris, not a galaxy.
   */
  minSize?: number;
  /** Galaxies from the previous run, so identity can survive a recompute. */
  previous?: Galaxy[];
}

export interface ClusterResult {
  galaxies: Galaxy[];
  /** Notes that landed in no galaxy - too few neighbours, or too unlike anything. */
  field: string[];
}

const DEFAULTS = { minSize: 3, maxGalaxies: 8 };

/**
 * How much sharper a drop has to be than the merges around it to count as the
 * boundary between galaxies rather than ordinary variation.
 *
 * Measured: a vault covering several subjects shows within-topic similarity
 * near 0.08 against 0.02 between them, so the real boundary stands out by
 * roughly 4x. A vault covering one subject declines smoothly with no such
 * step, and should stay a single galaxy. 2x sits between those cases.
 */
const SPLIT_FACTOR = 2;

/** Below this, a merge is noise rather than a similarity worth acting on. */
const NOISE_FLOOR = 0.01;

/**
 * Words carrying no topical signal.
 *
 * Deliberately short. An aggressive list would strip the domain vocabulary
 * that makes two notes look alike in the first place.
 */
const STOP = new Set(
  `the a an and or of to in is are be been was were that this these those it its
   for on as with by from at not no if then than so we you i they their there
   here what which who when where how all any both each few more most other some
   such only own same too very can will just should now do does did doing have
   has had having would could may might must into over under again further once
   about against between through during before after above below up down out off
   because while until also but nor yet than them he she him her his hers`
    .split(/\s+/)
    .filter(Boolean)
);

/** Words worth keeping: alphabetic, three or more characters, not a stopword. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z][a-z_-]{2,}/g) ?? []) {
    const w = raw.replace(/^[-_]+|[-_]+$/g, '');
    if (w.length >= 3 && !STOP.has(w)) out.push(w);
  }
  return out;
}

/**
 * A note's text, with its title counted several times.
 *
 * A title is a human summary of the whole note in a handful of words, so its
 * terms are worth more per occurrence than body prose.
 */
const TITLE_WEIGHT = 3;

function noteText(note: Note): string[] {
  const title = tokenize(note.frontmatter.title);
  const body = tokenize(note.body);
  const tags = note.frontmatter.tags?.flatMap((t) => tokenize(t)) ?? [];
  const out: string[] = [...body, ...tags];
  for (let i = 0; i < TITLE_WEIGHT; i++) out.push(...title);
  return out;
}

/** A unit-length sparse TF-IDF vector, term index -> weight. */
type Vector = Map<number, number>;

/** A note reduced to what clustering needs: its id and its vector. */
interface Doc {
  id: string;
  vec: Vector;
}

function cosine(a: Vector, b: Vector): number {
  // Walk the shorter vector; both are unit length, so the dot product is the
  // cosine directly.
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) {
    const w = big.get(k);
    if (w !== undefined) dot += v * w;
  }
  return dot;
}

/** Sublinear TF, smoothed IDF, L2 normalised. Terms appearing once are dropped. */
function vectorise(notes: Note[]): { docs: Doc[]; vocab: string[]; docFreq: number[] } {
  const tokenised = notes.map(noteText);

  const df = new Map<string, number>();
  for (const d of tokenised) {
    for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  }

  // A term in exactly one document cannot make two documents alike, and there
  // is a long tail of them - dropping them shrinks the vectors substantially.
  const vocab: string[] = [];
  const idf: number[] = [];
  const docFreq: number[] = [];
  const index = new Map<string, number>();
  const N = notes.length;
  for (const [w, n] of df) {
    if (n >= 2) {
      index.set(w, vocab.length);
      vocab.push(w);
      idf.push(Math.log(N / n));
      docFreq.push(n);
    }
  }

  const docs = tokenised.map((tokens, i) => {
    const counts = new Map<number, number>();
    for (const w of tokens) {
      const at = index.get(w);
      if (at !== undefined) counts.set(at, (counts.get(at) ?? 0) + 1);
    }
    const vec: Vector = new Map();
    let sum = 0;
    for (const [at, count] of counts) {
      const weight = (1 + Math.log(count)) * (idf[at] ?? 0);
      if (weight > 0) {
        vec.set(at, weight);
        sum += weight * weight;
      }
    }
    const norm = Math.sqrt(sum);
    if (norm > 0) for (const [at, w] of vec) vec.set(at, w / norm);
    const note = notes[i];
    return { id: note ? note.frontmatter.id : String(i), vec };
  });

  return { docs, vocab, docFreq };
}

/** Mean of a set of unit vectors, renormalised. */
function centroid(docs: Doc[]): Vector {
  const acc = new Map<number, number>();
  for (const d of docs) {
    for (const [k, v] of d.vec) acc.set(k, (acc.get(k) ?? 0) + v);
  }
  let sum = 0;
  for (const v of acc.values()) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (const [k, v] of acc) acc.set(k, v / norm);
  return acc;
}

/**
 * Function words that are useless in a name but useful in a vector.
 *
 * Kept apart from STOP deliberately. Stripping these before clustering would
 * remove the shared phrasing that makes two notes on a subject look alike -
 * an earlier attempt to fold them into STOP broke a cluster outright. They
 * only need to be absent from the four words that label a galaxy.
 */
const LABEL_STOP = new Set(
  `one two three four five six seven eight nine ten every each either neither
   another other others rather via per thus hence still even much many made
   make makes making use uses used using way ways thing things get gets first
   second last next new old same own since upon toward towards let lets need
   needs want wants take takes give gives put puts run runs`
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * Terms in more than this share of the whole vault name nothing in particular.
 *
 * IDF already discounts them, but on a vault about one subject its common
 * words survive into every centroid, so a galaxy ends up labelled with the
 * vocabulary of the vault rather than of itself.
 */
const LABEL_MAX_DF = 0.4;

/** The terms that set this galaxy apart - what it is about, in four words. */
function describe(c: Vector, vocab: string[], docFreq: number[], total: number, n = 4): string[] {
  const out: string[] = [];
  for (const [at] of [...c.entries()].sort((a, b) => b[1] - a[1])) {
    const term = vocab[at];
    const df = docFreq[at];
    if (term === undefined || df === undefined) continue;
    if (df / total > LABEL_MAX_DF) continue;
    if (LABEL_STOP.has(term)) continue;
    out.push(term);
    if (out.length === n) break;
  }
  return out;
}

/**
 * Average-link agglomerative clustering, cut where the corpus says to cut.
 *
 * Average link rather than single link because single link chains: one note
 * that is vaguely like everything drags separate galaxies into one.
 *
 * The interesting part is where to stop. An absolute cosine cut cannot work,
 * because the right value depends on the vault: 0.045 correctly leaves a
 * single-subject vault as one galaxy, but the same number fails to separate
 * three subjects, and 0.08 shatters the single-subject vault into five
 * arbitrary pieces. The threshold is a property of the corpus, not a constant.
 *
 * So merge all the way down to one cluster, recording how alike each pair was
 * when it merged. Those heights fall smoothly while genuinely related things
 * are joining, then drop sharply at the moment unrelated subjects are forced
 * together. Cutting at the sharpest drop finds the number of galaxies the
 * vault actually has - and when there is no sharp drop, as in a vault about
 * one subject, it correctly declines to split at all.
 */
function agglomerate(docs: Doc[], forced: number | undefined, maxGalaxies: number): Doc[][] {
  const groups = new Map<number, Doc[]>();
  docs.forEach((d, i) => groups.set(i, [d]));

  const sim = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const ids = [...groups.keys()];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      if (a === undefined || b === undefined) continue;
      const da = docs[a];
      const db = docs[b];
      if (!da || !db) continue;
      sim.set(key(a, b), cosine(da.vec, db.vec));
    }
  }

  /** Each merge, in order: how alike the pair was, and the state it produced. */
  const history: Array<{ height: number; snapshot: Doc[][] }> = [];

  for (;;) {
    let best = forced ?? NOISE_FLOOR;
    let bi = -1;
    let bj = -1;
    for (const a of groups.keys()) {
      for (const b of groups.keys()) {
        if (b <= a) continue;
        const v = sim.get(key(a, b)) ?? 0;
        if (v > best) {
          best = v;
          bi = a;
          bj = b;
        }
      }
    }
    if (bi < 0 || bj < 0) break;

    const gi = groups.get(bi);
    const gj = groups.get(bj);
    if (!gi || !gj) break;

    // Recompute bi's links as the size-weighted mean of the two - that is what
    // makes this average-link rather than centroid.
    for (const other of groups.keys()) {
      if (other === bi || other === bj) continue;
      const si = sim.get(key(bi, other)) ?? 0;
      const sj = sim.get(key(bj, other)) ?? 0;
      sim.set(key(bi, other), (si * gi.length + sj * gj.length) / (gi.length + gj.length));
    }
    groups.set(bi, gi.concat(gj));
    groups.delete(bj);
    history.push({ height: best, snapshot: [...groups.values()].map((g) => [...g]) });
  }

  // A forced threshold means the caller wanted a specific cut, not the
  // natural one.
  if (forced !== undefined) return [...groups.values()];

  // Walk the merge heights looking for the sharpest fall, among cuts that
  // leave a plausible number of galaxies. Merging the last few clusters always
  // looks dramatic and never means anything.
  let cut: Doc[][] | undefined;
  let sharpest = SPLIT_FACTOR;
  for (let i = 1; i < history.length; i++) {
    const before = history[i - 1];
    const after = history[i];
    if (!before || !after) continue;
    const count = before.snapshot.length;
    if (count < 2 || count > maxGalaxies) continue;
    const ratio = before.height / Math.max(after.height, 1e-9);
    if (ratio > sharpest) {
      sharpest = ratio;
      cut = before.snapshot;
    }
  }
  if (cut) return cut;

  // No natural boundary. Merging stops once pairs are merely noise-similar, so
  // the end state can still hold more clusters than a screen should show -
  // in that case fall back to the last cut that was within budget.
  const final = [...groups.values()];
  if (final.length <= maxGalaxies) return final;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h && h.snapshot.length <= maxGalaxies) return h.snapshot;
  }
  return final;
}

/**
 * Carry galaxy identity across a recompute.
 *
 * Position is about to become a function of the whole corpus rather than a
 * hash of one id, so adding a note can reshuffle membership. If galaxy ids
 * were regenerated each time, a basin would jump on screen whenever the vault
 * grew. Matching new galaxies to their nearest previous centroid keeps a basin
 * still while its membership changes underneath.
 */
const IDENTITY_FLOOR = 0.3;

function carryIdentity(
  fresh: Array<{ members: Doc[]; centroid: Vector; terms: string[] }>,
  previous: Galaxy[] | undefined,
  byId: Map<string, Doc>
): Galaxy[] {
  const prevCentroids = new Map<string, Vector>();
  for (const g of previous ?? []) {
    const members = g.noteIds.map((id) => byId.get(id)).filter((d): d is Doc => d !== undefined);
    if (members.length) prevCentroids.set(g.id, centroid(members));
  }

  const taken = new Set<string>();
  return fresh.map((f) => {
    let bestId: string | null = null;
    let bestSim = IDENTITY_FLOOR; // below this it is a different galaxy, not a moved one
    for (const [id, c] of prevCentroids) {
      if (taken.has(id)) continue;
      const s = cosine(f.centroid, c);
      if (s > bestSim) {
        bestSim = s;
        bestId = id;
      }
    }
    if (bestId) taken.add(bestId);
    return {
      id: bestId ?? `galaxy-${f.terms[0] ?? 'field'}-${f.members.length}`,
      terms: f.terms,
      noteIds: f.members.map((d) => d.id)
    };
  });
}

/**
 * Group notes into galaxies by what they are about.
 *
 * Returns galaxies plus the field: notes that belong to no galaxy, either
 * because nothing was like them or because their group was too small to be
 * one. The field is not a failure - a brand new note genuinely has no home
 * yet, and drawing it adrift is more honest than forcing it into a basin.
 */
export function clusterNotes(notes: Note[], options: ClusterOptions = {}): ClusterResult {
  const minSize = options.minSize ?? DEFAULTS.minSize;
  const maxGalaxies = options.maxGalaxies ?? DEFAULTS.maxGalaxies;

  if (notes.length < minSize) {
    return { galaxies: [], field: notes.map((n) => n.frontmatter.id) };
  }

  const { docs, vocab, docFreq } = vectorise(notes);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const groups = agglomerate(docs, options.threshold, maxGalaxies);

  const fresh: Array<{ members: Doc[]; centroid: Vector; terms: string[] }> = [];
  const field: string[] = [];

  for (const members of groups) {
    if (members.length < minSize) {
      for (const d of members) field.push(d.id);
      continue;
    }
    const c = centroid(members);
    fresh.push({ members, centroid: c, terms: describe(c, vocab, docFreq, notes.length) });
  }

  // Biggest first, so the renderer lays out the dominant basin first and the
  // ordering does not churn between runs.
  fresh.sort((a, b) => b.members.length - a.members.length);

  return { galaxies: carryIdentity(fresh, options.previous, byId), field };
}

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
 * How well separated a split has to be before it is worth making.
 *
 * This is a mean silhouette: for each note, how much closer it sits to its own
 * galaxy than to the nearest other one, from -1 to 1. Zero means the split
 * tells you nothing.
 *
 * An earlier version looked for a sharp fall in merge heights instead, and it
 * did not survive contact with a real vault. Five plainly distinct subjects
 * separate at a height ratio of only about 1.4x - the cliff a synthetic
 * corpus shows simply is not there - so a factor test either missed real
 * boundaries or invented them, depending on where the constant was put.
 * Scoring the partition asks the question directly.
 */
const MIN_SILHOUETTE = 0.035;

/**
 * How much better a coarser split has to score before it is preferred.
 *
 * TF-IDF vectors are sparse enough that unrelated notes score almost exactly
 * zero against each other. That makes the silhouette saturate: with the
 * nearest other galaxy at ~0, nearly any partition scores near 1, and picking
 * the maximum is picking noise. It showed up as two unrelated subjects merging
 * into one galaxy that scored a hair above keeping them apart.
 *
 * So finer partitions are preferred, and a coarser one has to win by a margin
 * rather than by a rounding error. Merging is the claim that needs evidence.
 */
const MERGE_MARGIN = 0.02;

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
 * Every pairwise similarity, once, as a flat matrix.
 *
 * Both the merging and the scoring need the same numbers, and computing them
 * from sparse vectors on demand was the whole cost of clustering: an earlier
 * version keyed similarities by a `${a}:${b}` template string, so every pair
 * comparison allocated a string, and the merge loop compares every pair on
 * every merge. At 800 notes that took nineteen seconds.
 */
function similarityMatrix(docs: Doc[]): Float64Array {
  const n = docs.length;
  const m = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    const di = docs[i];
    if (!di) continue;
    for (let j = i + 1; j < n; j++) {
      const dj = docs[j];
      if (!dj) continue;
      const v = cosine(di.vec, dj.vec);
      m[i * n + j] = v;
      m[j * n + i] = v;
    }
  }
  return m;
}

/**
 * Mean silhouette of a partition: is a note more like its own galaxy than the
 * nearest other one?
 *
 * For each note, `a` is its mean similarity to the rest of its own group and
 * `b` its best mean similarity to any other group. Averaged over every note
 * this says whether the split describes the corpus or merely divides it.
 *
 * Notes alone in a group score zero rather than one - a singleton is not
 * well-clustered, and rewarding it would push the answer toward dust.
 */
function silhouette(owner: Int32Array, groupCount: number, sim: Float64Array, n: number): number {
  if (groupCount < 2) return 0;

  const sums = new Float64Array(groupCount);
  const sizes = new Float64Array(groupCount);
  let total = 0;
  let counted = 0;

  for (let i = 0; i < n; i++) {
    const mine = owner[i];
    if (mine === undefined || mine < 0) continue;
    sums.fill(0);
    sizes.fill(0);
    const row = i * n;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const theirs = owner[j];
      if (theirs === undefined || theirs < 0) continue;
      sums[theirs] = (sums[theirs] ?? 0) + (sim[row + j] ?? 0);
      sizes[theirs] = (sizes[theirs] ?? 0) + 1;
    }
    const own = sizes[mine] ?? 0;
    if (own === 0) {
      counted++; // a singleton contributes zero, but still counts
      continue;
    }
    const a = (sums[mine] ?? 0) / own;
    let b = -Infinity;
    for (let g = 0; g < groupCount; g++) {
      if (g === mine) continue;
      const size = sizes[g] ?? 0;
      if (size === 0) continue;
      const mean = (sums[g] ?? 0) / size;
      if (mean > b) b = mean;
    }
    if (b === -Infinity) continue;
    const denom = Math.max(a, b);
    total += denom > 0 ? (a - b) / denom : 0;
    counted++;
  }
  return counted ? total / counted : 0;
}

/**
 * Average-link agglomerative clustering, cut where the corpus says to cut.
 *
 * Average link rather than single link because single link chains: one note
 * that is vaguely like everything drags separate galaxies into one.
 *
 * The interesting part is where to stop. An absolute cosine cut cannot work,
 * because the right value depends on the vault: 0.045 correctly leaves a
 * single-subject vault as one galaxy, the same number fails to separate three
 * subjects, and 0.08 shatters that single-subject vault into five arbitrary
 * pieces. The threshold is a property of the corpus, not a constant. So merge
 * all the way down, score every partition passed through, and keep the best.
 *
 * Two things keep it affordable. Similarities live in a flat matrix rather
 * than a map keyed by a built string, and each group remembers its own best
 * partner, so choosing the next merge scans groups rather than pairs. Only
 * partitions small enough to be worth scoring are recorded.
 */
function agglomerate(docs: Doc[], forced: number | undefined, maxGalaxies: number): Doc[][] {
  const n = docs.length;
  if (n === 0) return [];
  const sim = similarityMatrix(docs);

  // Group-level average similarity, updated in place as groups merge. A
  // group's id is the index of the doc it started from.
  const gsim = Float64Array.from(sim);
  const members: Doc[][] = docs.map((d) => [d]);
  const size = new Int32Array(n).fill(1);
  const alive = new Set<number>();
  for (let i = 0; i < n; i++) alive.add(i);

  const bestJ = new Int32Array(n).fill(-1);
  const bestS = new Float64Array(n).fill(-Infinity);
  const refreshBest = (i: number): void => {
    let bj = -1;
    let bs = -Infinity;
    const row = i * n;
    for (const j of alive) {
      if (j === i) continue;
      const v = gsim[row + j] ?? 0;
      if (v > bs) {
        bs = v;
        bj = j;
      }
    }
    bestJ[i] = bj;
    bestS[i] = bj >= 0 ? bs : -Infinity;
  };
  for (const i of alive) refreshBest(i);

  const floor = forced ?? NOISE_FLOOR;
  /** Partitions small enough to be worth scoring, finest first. */
  const history: Doc[][][] = [];

  while (alive.size > 1) {
    let a = -1;
    let b = -1;
    let best = floor;
    for (const i of alive) {
      const s = bestS[i] ?? -Infinity;
      if (s > best) {
        best = s;
        a = i;
        b = bestJ[i] ?? -1;
      }
    }
    if (a < 0 || b < 0) break;

    // Lance-Williams for average link: the merged group's similarity to every
    // other is the size-weighted mean of its parents'.
    const sa = size[a] ?? 1;
    const sb = size[b] ?? 1;
    const rowA = a * n;
    const rowB = b * n;
    for (const k of alive) {
      if (k === a || k === b) continue;
      const v = ((gsim[rowA + k] ?? 0) * sa + (gsim[rowB + k] ?? 0) * sb) / (sa + sb);
      gsim[rowA + k] = v;
      gsim[k * n + a] = v;
    }
    members[a] = (members[a] ?? []).concat(members[b] ?? []);
    members[b] = [];
    size[a] = sa + sb;
    alive.delete(b);

    refreshBest(a);
    for (const i of alive) {
      if (i === a) continue;
      const bj = bestJ[i];
      if (bj === a || bj === b) refreshBest(i);
    }

    if (alive.size <= maxGalaxies) {
      history.push([...alive].map((i) => members[i] ?? []));
    }
  }

  const current = (): Doc[][] => [...alive].map((i) => members[i] ?? []);
  if (forced !== undefined) return current();

  // Score each recorded partition. History runs from many clusters to few, so
  // the finest are considered first and a coarser one must clear the margin.
  const index = new Map(docs.map((d, i) => [d.id, i]));
  let cut: Doc[][] | undefined;
  let bestScore = MIN_SILHOUETTE;
  for (const snapshot of history) {
    if (snapshot.length < 2) continue;
    const owner = new Int32Array(n).fill(-1);
    snapshot.forEach((g, gi) => {
      for (const d of g) {
        const at = index.get(d.id);
        if (at !== undefined) owner[at] = gi;
      }
    });
    const score = silhouette(owner, snapshot.length, sim, n);
    const bar = cut ? bestScore + MERGE_MARGIN : bestScore;
    if (score > bar) {
      bestScore = score;
      cut = snapshot;
    }
  }
  if (cut) return cut;

  // Nothing scored well enough to be worth splitting: one galaxy. Merging
  // stops once pairs are merely noise-similar, so the end state can still hold
  // more clusters than a screen should show - fall back to the coarsest
  // partition recorded.
  const final = current();
  if (final.length <= maxGalaxies) return final;
  const last = history[history.length - 1];
  return last ?? final;
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

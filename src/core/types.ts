/** Shared domain types for SecondBrain. */

/** A single meaningful exchange in a Claude session. Tool noise is already stripped. */
export interface Turn {
  uuid: string;
  parentUuid: string | null;
  role: 'user' | 'assistant';
  /** Concatenated visible text. Never includes tool results or thinking bodies. */
  text: string;
  /** Names of tools invoked in this turn, e.g. ['Bash', 'Read']. */
  toolsUsed: string[];
  timestamp: string;
}

/** A parsed Claude Code session: the canonical thread, with abandoned branches removed. */
export interface Session {
  /** Claude Code sessionId (a UUID). Stable across appends. */
  id: string;
  /** Encoded project directory name, e.g. '-Users-someone-myrepo'. */
  projectSlug: string;
  /** Real working directory the session ran in, recovered from the transcript. */
  cwd: string | null;
  gitBranch: string | null;
  /** Claude's own generated title for the session, when it produced one. */
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  turns: Turn[];
  /** Transcripts of subagents spawned by this session. */
  subagents: SubagentTranscript[];
  /** Absolute path to the source .jsonl. */
  sourcePath: string;
  /** Lines that failed to parse. Non-zero is normal for a live session. */
  malformedLines: number;
}

export interface SubagentTranscript {
  path: string;
  agentId: string;
  turns: Turn[];
}

/** How a .jsonl path under ~/.claude/projects is classified. */
export type TranscriptKind =
  | { kind: 'session'; projectSlug: string; sessionId: string }
  | { kind: 'subagent'; projectSlug: string; sessionId: string; agentId: string }
  | { kind: 'ignored'; reason: string };

/** Frontmatter on every note in the vault. */
export interface NoteFrontmatter {
  id: string;
  title: string;
  type: 'concept';
  created: string;
  updated: string;
  /** Provenance. Recorded from day one so the session layer is additive, not a migration. */
  sources: NoteSource[];
  links: string[];
  /** 'distilled' = written by the pipeline; 'claude' = saved deliberately mid-session; 'human' = hand-edited. */
  origin: 'distilled' | 'claude' | 'human';
  tags?: string[];
}

export interface NoteSource {
  session: string;
  project: string;
  at: string;
}

export interface Note {
  frontmatter: NoteFrontmatter;
  body: string;
  /** Absolute path on disk. */
  path: string;
}

export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  score: number;
}

/** Emitted on every MCP tool call so the UI can light up. */
export type BrainEvent =
  | { type: 'considered'; noteIds: string[]; query: string; at: number }
  | { type: 'opened'; noteIds: string[]; at: number }
  | { type: 'saved'; noteIds: string[]; at: number }
  | { type: 'vault-changed'; at: number }
  | { type: 'ingest-progress'; done: number; total: number; label: string; at: number }
  | { type: 'status'; message: string; level: 'info' | 'warn' | 'error'; at: number };

export interface SearchProvider {
  search(query: string, limit: number): Promise<SearchHit[]>;
  reindex(notes: Note[]): Promise<void>;
  upsert(note: Note): Promise<void>;
  remove(id: string): Promise<void>;
  close(): void;
}

/**
 * Collects the change feed's search work and hands it to Meilisearch in batches.
 *
 * The follower used to index every `_changes` batch as it arrived, and a live session
 * produces one of those per hook event: about 95 single-document updates an hour from
 * one session. Meilisearch's cost is per update, not per document — each one rewrites
 * a large share of the index on disk, ~17 MB per document on a 1 GB index (#231). The
 * same turns indexed a few minutes later as one update cost a fraction of that.
 *
 * So the buffer keys everything by what it will become in the index and keeps only the
 * latest: a chunk that lands twice is one write, and a session that moved forty times
 * since the last flush is one row. Running sessions are buffered as *ids*, not rows,
 * and projected at flush time from the then-current rollup — that is what lets forty
 * events collapse to one row, and it means a session that ended inside the window is
 * written once, from its summary, rather than as a partial row then a full one.
 */

export interface SearchBatch {
  /** Session rows projected from `summary` docs, keyed by session id. */
  summaries: Map<string, Record<string, unknown>>;
  /** Turn rows, keyed by their search doc id. */
  turns: Map<string, Record<string, unknown>>;
  /** Sessions whose events moved and that have no summary in this batch. */
  running: string[];
  /** The `_changes` seq this batch covers up to — safe to checkpoint once it is indexed. */
  seq: string | null;
}

export class SearchBuffer {
  private summaries = new Map<string, Record<string, unknown>>();
  private turns = new Map<string, Record<string, unknown>>();
  private touched = new Set<string>();
  private seq: string | null = null;

  /** Rows held, counting each running session as one. What an early flush is sized on. */
  get size(): number {
    return this.summaries.size + this.turns.size + this.touched.size;
  }

  addSummary(sessionId: string, row: Record<string, unknown>): void {
    this.summaries.set(sessionId, row);
    this.touched.delete(sessionId);
  }

  addTurns(rows: Record<string, unknown>[]): void {
    for (const row of rows) this.turns.set(String(row.id), row);
  }

  /** A session whose events moved. Ignored once its summary is buffered — that wins. */
  touch(sessionId: string): void {
    if (!this.summaries.has(sessionId)) this.touched.add(sessionId);
  }

  /** Record how far the feed has been read; checkpointed only after the next flush. */
  advance(seq: string): void {
    this.seq = seq;
  }

  /**
   * Hand over everything buffered and start empty. Synchronous on purpose: the feed
   * keeps adding while a flush is awaiting Meilisearch, and those adds belong to the
   * *next* batch, so the swap can't straddle an `await`.
   */
  take(): SearchBatch {
    const batch: SearchBatch = {
      summaries: this.summaries,
      turns: this.turns,
      running: [...this.touched],
      seq: this.seq,
    };
    this.summaries = new Map();
    this.turns = new Map();
    this.touched = new Set();
    this.seq = null;
    return batch;
  }
}

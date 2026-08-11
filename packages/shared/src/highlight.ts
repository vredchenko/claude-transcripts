/**
 * Marking which part of a string matched a search, and reading those marks back.
 *
 * A search result that doesn't show you *what* matched makes you open it to find out,
 * which is most of the work the search was supposed to save. Two different places need
 * to answer that question, and they can't answer it the same way:
 *
 * - **Snippets from the search index.** Meilisearch already knows precisely which
 *   tokens matched — including prefixes and typo-corrections that no client-side
 *   matcher would find — so it marks them and the webapi passes the marks through.
 *   {@link splitMarkedText} reads them back.
 * - **Everything else** (a transcript you arrived at from a result, a turn in the
 *   speaker view). These never went through the index, so the terms are re-found
 *   locally by {@link splitByTerms}. Cruder than Meilisearch, and honest about it: it
 *   matches substrings, case-insensitively, and nothing else.
 *
 * Both return the same segment list, so one component renders either.
 *
 * ## Why not just send HTML
 *
 * Meilisearch's default marks are `<em>`/`</em>`, which invites the obvious shortcut of
 * rendering the snippet as HTML. That shortcut turns every transcript in the corpus
 * into stored XSS: transcripts contain arbitrary text, including markup, and this app
 * exists to display other people's raw session logs. The marks below are private-use
 * codepoints instead — no meaning to any renderer, effectively absent from real text —
 * and the split functions hand back plain strings for the UI to render as text.
 */

/**
 * Delimiters wrapped around a matched span. U+E000/U+E001 sit in the Unicode
 * Private Use Area: they have no rendering, no semantics, and don't occur in text that
 * came from a keyboard or a language model. Meilisearch is configured to emit these
 * (`highlightPreTag`/`highlightPostTag`) instead of its `<em>` default.
 */
export const HIGHLIGHT_PRE = "\u{E000}";
export const HIGHLIGHT_POST = "\u{E001}";

/** One run of text, flagged with whether it matched the query. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Merge adjacent segments of the same kind and drop empty ones, so a renderer emits
 * one node per visible run rather than a node per token.
 */
function compact(segments: HighlightSegment[]): HighlightSegment[] {
  const out: HighlightSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = out[out.length - 1];
    if (last && last.match === segment.match) last.text += segment.text;
    else out.push({ ...segment });
  }
  return out;
}

/**
 * Read a snippet marked by the search index back into segments.
 *
 * Defensive about malformed input, because the marks arrive over the wire and a
 * cropped snippet can genuinely be cut mid-span: an unmatched opener runs to the end
 * of the string, and a stray closer is dropped. Text with no marks at all comes back
 * as a single unmatched segment, which is the right answer for an index that isn't
 * configured to highlight.
 */
export function splitMarkedText(marked: string): HighlightSegment[] {
  if (!marked) return [];
  // No opener: all plain text. Still strip closers, so a snippet cropped after its
  // opening mark doesn't leak a delimiter into the rendered string.
  if (!marked.includes(HIGHLIGHT_PRE)) {
    return compact([{ text: marked.replaceAll(HIGHLIGHT_POST, ""), match: false }]);
  }

  const segments: HighlightSegment[] = [];
  let rest = marked;
  while (rest.length > 0) {
    const open = rest.indexOf(HIGHLIGHT_PRE);
    if (open === -1) {
      // No further openers; anything left is ordinary text (minus stray closers).
      segments.push({ text: rest.replaceAll(HIGHLIGHT_POST, ""), match: false });
      break;
    }
    segments.push({ text: rest.slice(0, open).replaceAll(HIGHLIGHT_POST, ""), match: false });
    rest = rest.slice(open + HIGHLIGHT_PRE.length);

    const close = rest.indexOf(HIGHLIGHT_POST);
    if (close === -1) {
      // Truncated mid-span — treat the remainder as matched rather than losing it.
      segments.push({ text: rest, match: true });
      break;
    }
    segments.push({ text: rest.slice(0, close), match: true });
    rest = rest.slice(close + HIGHLIGHT_POST.length);
  }
  return compact(segments);
}

/** Strip the marks entirely — for a plain-text context (a title attribute, the CLI). */
export function stripHighlightMarks(marked: string): string {
  return marked.replaceAll(HIGHLIGHT_PRE, "").replaceAll(HIGHLIGHT_POST, "");
}

/** Escape a term for literal use inside a RegExp. */
function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The distinct terms of a query, longest first.
 *
 * Longest-first matters: for `retry policy`, matching `policy` before `retry` would be
 * fine, but for overlapping terms like `retry retrying` the shorter one would eat the
 * start of the longer and leave a ragged tail highlighted separately. Sorting by
 * length makes the greedy alternation prefer the fuller match.
 */
function queryTerms(query: string): string[] {
  const terms = [...new Set(query.trim().toLowerCase().split(/\s+/).filter(Boolean))];
  return terms.sort((a, b) => b.length - a.length);
}

/**
 * Find a query's terms in arbitrary text — for content that never passed through the
 * search index, like the transcript you land on after clicking a result.
 *
 * Substring matching, case-insensitive, each term independently. It will miss what
 * Meilisearch's tokenizer catches (prefixes, typo tolerance, stemming) and will match
 * inside words where Meilisearch wouldn't. That's the honest trade for highlighting
 * text the index never saw; the alternative is highlighting nothing.
 */
export function splitByTerms(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const terms = queryTerms(query);
  if (terms.length === 0) return [{ text, match: false }];

  const pattern = new RegExp(terms.map(escapeRegExp).join("|"), "gi");
  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const found of text.matchAll(pattern)) {
    const at = found.index;
    if (at === undefined) continue;
    segments.push({ text: text.slice(cursor, at), match: false });
    segments.push({ text: found[0], match: true });
    cursor = at + found[0].length;
  }
  segments.push({ text: text.slice(cursor), match: false });
  return compact(segments);
}

/** Whether a query's terms appear in the text at all — used to find the first hit. */
export function matchesQuery(text: string, query: string): boolean {
  if (!text) return false;
  const terms = queryTerms(query);
  if (terms.length === 0) return false;
  const haystack = text.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

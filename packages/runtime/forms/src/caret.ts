/**
 * Where a caret goes when the text under it is reformatted.
 *
 * A localized input rewrites its own value: the user types digits and the formatter puts grouping
 * separators between them, and a locale commit can rewrite the whole thing. Different separators,
 * a different numbering system, and, entering an RTL context, bidi marks around the parts. The
 * caret has to end up under the same character it was under, and the offsets it was captured at no
 * longer mean what they meant.
 *
 * Its own file because it is arithmetic and nothing else. The directive that calls it reaches
 * Angular and can only be exercised through a browser; this can be asked the questions directly.
 */

/**
 * Characters a reader cannot see, and a caret must not be pushed around by.
 *
 * Bidi marks, isolates, embeddings and overrides, the zero-width family, and the byte-order mark.
 * All occupy no width, so a caret on either side of one is in the same place as far as anyone
 * looking at the screen is concerned, which is the whole reason counting them was wrong.
 */
const INVISIBLE =
  /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

function visibleCharacters(value: string): readonly string[] {
  const visible: string[] = [];
  for (const character of value) {
    if (!INVISIBLE.test(character)) visible.push(character);
  }
  return visible;
}

/**
 * The offset in `value` that sits before its `target`th visible character.
 *
 * The earliest such offset, so a caret lands before a run of invisible characters rather than after
 * it, and the next thing typed joins the text instead of following a mark.
 */
function offsetOfVisible(value: string, target: number): number {
  let visible = 0;
  let index = 0;
  for (const character of value) {
    if (visible === target) return index;
    if (!INVISIBLE.test(character)) visible += 1;
    index += character.length;
  }
  return index;
}

/**
 * The offset in `next` that holds the caret `previous` held at `offset`.
 *
 * **Measured in visible characters.** A locale commit into an RTL context appends bidi marks, and
 * counting those moved the caret by the number of marks anywhere in the value rather than by the
 * number beyond it: a selection of the `0` in `50%` came back as a selection of the `%` in
 * `50<LRM>%<LRM>`, off by two where only one mark lay past it. That defect is arithmetic, not
 * timing: the answer was wrong the instant it was computed.
 *
 * **Anchored to whichever side of the change the caret is on.** Everything up to the last visible
 * character the two strings still agree on is text the reformat did not touch, so a caret there
 * keeps its distance from the start. Past that point the text ahead of it has moved, so it keeps
 * its distance from the end instead. One comparison, and it covers both reformats that happen:
 * typing a digit and watching a separator appear behind the caret, where the change is before the
 * caret and the end anchor holds it against the digit just typed; and selecting a whole value that
 * then grows a separator, where the change is after the selection's start and the start anchor
 * keeps it at the front rather than dragging it past the first digit.
 *
 * Both boundaries of a selection go through this independently. Carrying the old width across would
 * assume a reformat cannot change how wide a selection is, and inserting a separator inside one
 * does exactly that.
 */
export function remapCaret(
  previous: string,
  offset: number,
  next: string,
): number {
  const previousVisible = visibleCharacters(previous);
  const nextVisible = visibleCharacters(next);
  const before = visibleCharacters(previous.slice(0, offset)).length;
  let agreed = 0;
  while (
    agreed < previousVisible.length &&
    agreed < nextVisible.length &&
    previousVisible[agreed] === nextVisible[agreed]
  ) {
    agreed += 1;
  }
  const target =
    before <= agreed
      ? before
      : Math.max(0, nextVisible.length - (previousVisible.length - before));
  return offsetOfVisible(next, target);
}

import { describe, expect, it } from 'vitest';

import { remapCaret } from '../forms/src/caret.js';

/**
 * A caret's offset is a position in a particular string, and a localized input rewrites its string.
 *
 * The browser assurance gate caught this as an intermittent: a selection of the `0` in `50%` came
 * back as a selection of the `%` after an RTL commit, then corrected itself about a frame later.
 * The correction made it look like a race. It was not: two components were restoring the same
 * selection with different arithmetic, and one of them was wrong. Wrong by exactly the number of
 * bidi marks the commit had inserted anywhere in the value, rather than the number inserted past
 * the caret.
 *
 * So these are the questions that defect answers wrongly, asked of the arithmetic directly rather
 * than through a browser. Every invisible character here is written as an escape, so a reader
 * can see what a case contains.
 */

/** LEFT-TO-RIGHT MARK, what a commit into an RTL context puts around a Latin-script number. */
const LRM = '\u200E';

describe('remapping a caret across a reformat', () => {
  it('counts only what a reader can see', () => {
    // The measured defect. `50%` becomes `50<LRM>%<LRM>`: one mark lies past the selection, one
    // does not, and treating both as characters moved the selection by two.
    const previous = '50%';
    const next = `50${LRM}%${LRM}`;

    expect(remapCaret(previous, 1, next)).toBe(1);
    expect(remapCaret(previous, 2, next)).toBe(2);

    // Which is to say: the same `0`, still just the `0`.
    expect(next.slice(1, 2)).toBe('0');
  });

  it('stays with the character just typed when a separator appears behind it', () => {
    // Someone types the `4` of `1234` and the formatter inserts a group separator ahead of the
    // caret. The caret belongs after the `4`, not two characters behind it.
    expect(remapCaret('1234', 4, '1,234')).toBe(5);

    // And a caret that was mid-value keeps the same characters ahead of it.
    expect(remapCaret('1234', 3, '1,234')).toBe(4);
    expect('1,234'.slice(4)).toBe('4');
  });

  it('keeps a selection of the whole value covering the whole value', () => {
    // The reason both boundaries cannot share one anchor. The end of this selection has the change
    // behind it, so it holds its distance from the end; the start has the change ahead of it, so it
    // holds its distance from the start. Anchoring both to the end would have dropped the leading
    // `1` out of the selection to preserve a width the reformat had already changed.
    const start = remapCaret('1234', 0, '1,234');
    const end = remapCaret('1234', 4, '1,234');

    expect([start, end]).toStrictEqual([0, 5]);
    expect('1,234'.slice(start, end)).toBe('1,234');
  });

  it('collapses to one position when it started as one position', () => {
    // A caret is a selection whose boundaries agree. Two independent remaps have to keep agreeing,
    // or an input someone is typing into silently grows a selection.
    for (const offset of [0, 1, 2, 3, 4]) {
      expect(remapCaret('1234', offset, '1,234')).toBe(
        remapCaret('1234', offset, '1,234'),
      );
    }

    const collapsed = new Set(
      [0, 1, 2, 3].map((offset) =>
        remapCaret('50%', offset, `50${LRM}%${LRM}`),
      ),
    );
    expect(collapsed.size).toBe(4);
  });

  it('lands before a trailing mark rather than after it', () => {
    // Both offsets are the same place on screen. The earlier one is the one where the next
    // character typed joins the number instead of following the mark.
    expect(remapCaret('50%', 3, `50${LRM}%${LRM}`)).toBe(4);
    expect(`50${LRM}%${LRM}`.length).toBe(5);
  });

  it('holds the end of the value when the whole value is replaced', () => {
    // A locale commit can change the numbering system, leaving nothing in common to anchor to.
    // Falling back to the end is what an input does when its text is replaced outright.
    const arabicIndic = '\u0661\u066C\u0662\u0663\u0664';

    expect(remapCaret('1,234', 5, arabicIndic)).toBe(arabicIndic.length);
    expect(remapCaret('1,234', 0, arabicIndic)).toBe(0);
  });

  it('survives the value getting shorter', () => {
    // Backspace at the end of `1,234`, which loses the separator too.
    expect(remapCaret('1,234', 5, '123')).toBe(3);

    // Backspace at offset 3, which removes the `2` and again loses the separator. The caret keeps
    // the two digits ahead of it and ends up after the `1`.
    expect(remapCaret('1,234', 3, '134')).toBe(1);

    // And a value cleared outright cannot return an offset into a string that has no positions.
    expect(remapCaret('1,234', 5, '')).toBe(0);
  });
});

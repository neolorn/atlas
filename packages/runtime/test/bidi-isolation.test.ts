import { describe, expect, it } from 'vitest';

import { parseAtlasMessage } from '../../toolkit/src/message-format.js';
import type { AtlasMessageSemanticModel } from '../../toolkit/src/message-format.js';
import {
  FormatterCache,
  evaluateCandidate,
  findEvaluationCandidate,
  mayReorder,
} from '../src/evaluator.js';
import { RuntimeExtensions } from '../src/extensions.js';
import type {
  CompiledCatalog,
  CompiledInputContract,
} from '../src/catalog-runtime.js';
import {
  RTL_SCRIPTS,
  type FormattingContext,
  type LocalizedParts,
  type MessageHandle,
} from '@neolorn/atlas/core';

/**
 * Bidirectional isolation of interpolated values, and MessageFormat 2's `u:` options.
 *
 * `specs/09-safe-content-and-ux.spec.md` section 8 is the rule both halves serve: a value is
 * isolated in the formatter rather than at each call site, and the string surface and the
 * element surface cannot differ in what they guarantee.
 *
 * Two halves of one change. Atlas decided isolation by sniffing the formatted string against a
 * hand-written list of Unicode blocks, and it parsed `u:dir` and `u:id` and threw them away. The
 * sniff is now generated from the Unicode Character Database (`Bidi_Class` in {R, AL}, which is
 * the property that says whether a character reorders the text around it) and `u:dir` is what an
 * author writes when the derivation is wrong for their value, so reverting either one on its own
 * leaves the other without the thing that makes it safe.
 *
 * Every assertion here is on the emitted control characters, never on rendered output. A check that
 * a name "appears correctly" passes under every implementation, including the one being replaced.
 */

/** The three directional isolates, and the terminator all three share. */
const LRI = '\u2066';
const RLI = '\u2067';
const FSI = '\u2068';
const PDI = '\u2069';

const NAME: readonly CompiledInputContract[] = Object.freeze([
  { name: 'name', type: 'string', optional: false, nullable: false },
]);
const COUNT: readonly CompiledInputContract[] = Object.freeze([
  { name: 'count', type: 'number', optional: false, nullable: false },
]);

function compiledCatalogFor(
  semantics: AtlasMessageSemanticModel,
  inputs: readonly CompiledInputContract[],
  locale: string,
): CompiledCatalog {
  const body =
    semantics.kind === 'pattern'
      ? {
          kind: 'pattern',
          declarations: semantics.declarations,
          pattern: semantics.pattern,
        }
      : {
          kind: 'select',
          declarations: semantics.declarations,
          selectors: semantics.selectors,
          variants: semantics.variants,
        };
  const outputParts = 64;
  const resources = {
    irNodes: 1,
    depth: 1,
    selectors: 1,
    variants: 8,
    inputs: inputs.length,
    slots: 0,
    outputParts,
  };
  return {
    profile: 'atlas-compiled-ir/1',
    generatedAbi: 'atlas-generated/1',
    standardsProfile: 'atlas-1',
    key: { providerId: 'bidi', scopeId: 'bidi', catalogLocale: locale },
    applicationContractFingerprint: 'test',
    semanticRegistryFingerprint: 'test',
    requiredExtensions: Object.freeze([]),
    messages: Object.freeze([
      {
        messageId: 'subject',
        kind: 'message' as const,
        resultKind: 'structured' as const,
        sourceFingerprint: 'test',
        inputs: Object.freeze(inputs),
        slots: Object.freeze([]),
        body,
      },
    ]),
    resources: { ...resources, maximumMessage: resources },
  } as unknown as CompiledCatalog;
}

function parse(source: string): AtlasMessageSemanticModel {
  const parsed = parseAtlasMessage(source);
  if (!parsed.ok) {
    throw new Error(
      `The message under test did not parse: ${parsed.diagnostics
        .map((diagnostic) => diagnostic.summary)
        .join('; ')}`,
    );
  }
  return parsed.value;
}

/**
 * Evaluate to parts, which is where the direction decision is visible before projection.
 *
 * `resultKind: 'structured'` so both the parts and the projected string come back from one
 * evaluation: the point of several of these checks is that the two agree.
 */
function evaluateParts(
  source: string,
  inputs: readonly CompiledInputContract[],
  values: Readonly<Record<string, unknown>>,
  locale = 'en-US',
): LocalizedParts {
  const catalog = compiledCatalogFor(parse(source), inputs, locale);
  const handle: MessageHandle = {
    generatedAbi: 'atlas-generated/1',
    providerId: 'bidi',
    scopeId: 'bidi',
    messageId: 'subject',
    identity: 'bidi:bidi:subject',
    resultKind: 'structured',
    inputNames: Object.freeze(inputs.map(({ name }) => name)),
    slotNames: Object.freeze([]),
  } as MessageHandle;
  const context: FormattingContext = Object.freeze({ locale });
  const result = evaluateCandidate(
    handle,
    findEvaluationCandidate(handle, locale, [catalog]),
    values,
    context,
    new FormatterCache(8),
    new RuntimeExtensions(),
  );
  if (result.kind !== 'parts') throw new Error('Expected a structured result.');
  return result;
}

function render(
  source: string,
  inputs: readonly CompiledInputContract[],
  values: Readonly<Record<string, unknown>>,
  locale = 'en-US',
): string {
  return evaluateParts(source, inputs, values, locale).text;
}

describe('the sniff agrees with the script table over the whole of Unicode', () => {
  /**
   * What this asserts is a property, and deliberately not a count.
   *
   * "Forty-four code points are added" is satisfied by adding two ranges, and the next Unicode
   * release reopens the gap with nothing to notice.
   *
   * What replaces the count is a cross-check between two files that are maintained separately:
   * CLDR says which scripts run right to left, and the Unicode Character Database says which
   * characters do. The runtime's class is generated from the second. Over every letter in Unicode
   * the two agree exactly, and that is a much stronger statement than either file makes alone:
   * it fails the moment either moves, including when this runs on an ICU newer than the vendored
   * UCD file, which is the signal to update both together.
   *
   * Restricted to letters, script membership by `Script_Extensions` is the right comparison: a
   * letter whose `Script` is one of the right-to-left scripts necessarily carries that script in
   * its extensions too, and U+0640 ARABIC TATWEEL is reachable only through the extensions.
   */
  it('matches a letter exactly when its script extensions include a right-to-left script', () => {
    const usedWithRtlScript = new RegExp(
      `[${RTL_SCRIPTS.map((script) => `\\p{Script_Extensions=${script}}`).join(
        '',
      )}]`,
      'u',
    );
    const letter = /\p{L}/u;

    const disagreements: string[] = [];
    let letters = 0;
    for (let code = 0; code <= 0x10ffff; code += 1) {
      // Surrogates are not characters and belong to no script.
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const character = String.fromCodePoint(code);
      if (!letter.test(character)) continue;
      letters += 1;
      if (mayReorder(character) === usedWithRtlScript.test(character)) continue;
      if (disagreements.length < 16) {
        disagreements.push(
          `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
        );
      }
    }

    // The enumeration has to have run. Without this a broken loop passes by checking nothing, which
    // is the same failure mode as sampling.
    expect(letters).toBeGreaterThan(100_000);
    expect(disagreements).toEqual([]);
  });

  /**
   * The pair that no script derivation separates, and `Bidi_Class` separates immediately.
   *
   * Both are `Script=Common` carrying a right-to-left script in their extensions. U+0640 ARABIC
   * TATWEEL is `AL` and U+00B7 MIDDLE DOT is `ON`, so one reorders text and the other does not.
   * Reading the script data, the two look identical and have to be told apart by a rule about
   * letters that has nothing to do with direction; reading `Bidi_Class`, the question does not
   * arise.
   */
  it('keeps U+0640 TATWEEL and does not take U+00B7 MIDDLE DOT with it', () => {
    expect(mayReorder('\u0640')).toBe(true);
    expect(mayReorder('\u00B7')).toBe(false);
    // A decomposed diaeresis is used with Syriac and is not right-to-left. Taking the script
    // extensions without the letter restriction would isolate every Latin value carrying one.
    expect(mayReorder('\u0308')).toBe(false);
  });

  /**
   * The Siyaq numerals, which are the reason the derivation moved off script data entirely.
   *
   * Indic Siyaq (U+1EC71..U+1ECB4) and Ottoman Siyaq (U+1ED01..U+1ED3D) are accounting numerals
   * written with Arabic script. Their `Script` and `Script_Extensions` are both `Common`, so no
   * derivation from script membership can reach them however it is built, and their `Bidi_Class`
   * is `AL`. The whole-block class Atlas started with covered them by accident, and both script
   * derivations lost them.
   */
  it('covers the Siyaq numerals, which no script derivation can reach', () => {
    expect(mayReorder('\u{1EC71}')).toBe(true);
    expect(mayReorder('\u{1ED01}')).toBe(true);
  });

  /**
   * The deliberate half of the narrowing, asserted so it cannot become accidental.
   *
   * Moving to `Bidi_Class` drops 447 code points the script derivation covered, and every one is
   * a character the bidi algorithm resolves from its context rather than from itself: a Hebrew
   * point is `NSM` and takes the direction of the letter before it, an Arabic-Indic digit is `AN`
   * and sits at an even embedding level inside a left-to-right paragraph. Neither can reposition
   * the text around it, which is the only question this asks. The generator asserts that no
   * *strong* character was dropped; these two are the cases a reader is most likely to doubt.
   */
  /**
   * The UCD keeps this answer outside its data lines, and a reader that misses it is wrong later.
   *
   * Unassigned code points in blocks reserved for right-to-left scripts take `R` or `AL`, and the
   * file says so on `@missing:` lines rather than by listing them. Parsing only the data lines
   * produces a class that is correct for every character that exists today and wrong for the next
   * one added to the Arabic block: a defect that cannot be seen until a Unicode release lands.
   *
   * U+05FF is the last code point of the Hebrew block, unassigned, and `Right_To_Left` by that
   * default. Whatever is eventually assigned there will run right to left, which is the point.
   */
  it('covers unassigned code points that the UCD defaults to a right-to-left class', () => {
    expect(mayReorder('\u05FF')).toBe(true);
  });

  it('does not isolate marks and digits that take their direction from context', () => {
    // U+05B0 HEBREW POINT SHEVA, alone. Attached to a Hebrew letter the value matches anyway.
    expect(mayReorder('\u05B0')).toBe(false);
    // U+0660 ARABIC-INDIC DIGIT ZERO. Bidi_Class AN, not AL.
    expect(mayReorder('\u0660')).toBe(false);
  });
});

describe('MF2 Default Bidi Strategy', () => {
  it('leaves a left-to-right value in a left-to-right message bare', () => {
    const text = render('Hello {$name :string}.', NAME, { name: 'Ada' });
    expect(text).toBe('Hello Ada.');
  });

  it('isolates a value whose content could reorder the message around it', () => {
    const text = render('Hello {$name :string}.', NAME, { name: 'שרה' });
    expect(text).toBe(`Hello ${FSI}שרה${PDI}.`);
  });

  /**
   * U+0870 was one of the code points the hand-written class missed.
   *
   * The Arabic Extended-B block was added in Unicode 14, after the block list was written, and
   * nothing compared the two. It is asserted by name rather than by count because a count is
   * satisfied by adding the two ranges and losing the next release.
   */
  it('isolates a value using a block added after the old list was written', () => {
    const text = render('Hello {$name :string}.', NAME, { name: 'x\u0870y' });
    expect(text).toBe(`Hello ${FSI}x\u0870y${PDI}.`);
  });

  /**
   * U+200F RIGHT-TO-LEFT MARK was named in this defect's own evidence as a miss.
   *
   * It is not a strong character and it is not in any right-to-left script, so neither half of the
   * script derivation sees it. `\p{Bidi_Control}` does, and covers U+061C and U+200E with it,
   * without a table to maintain.
   */
  it('isolates a value carrying a bidi control the old range list did not cover', () => {
    const text = render('Hello {$name :string}.', NAME, { name: 'a\u200Fb' });
    expect(text).toBe(`Hello ${FSI}a\u200Fb${PDI}.`);
  });

  it('isolates a value of Siyaq numerals, which the shipped script class missed', () => {
    const text = render('Total {$name :string}.', NAME, {
      name: '\u{1EC71}\u{1EC72}',
    });
    expect(text).toBe(`Total ${FSI}\u{1EC71}\u{1EC72}${PDI}.`);
  });

  it('uses RLI, not FSI, for a value that runs right to left', () => {
    // A Latin name in an Arabic message. The value's direction is the locale's (Atlas formatted
    // nothing here, but nothing in it could reorder either) and the strategy isolates every
    // right-to-left value regardless of the message around it.
    const text = render(
      'مرحبا {$name :string}.',
      NAME,
      { name: 'Ada' },
      'ar-EG',
    );
    expect(text).toBe(`مرحبا ${RLI}Ada${PDI}.`);
  });

  it('isolates a number Atlas formatted in a right-to-left message', () => {
    const text = render('لديك {$count :number}.', COUNT, { count: 3 }, 'ar-EG');
    expect(text).toContain(RLI);
    expect(text).toContain(PDI);
    expect(text.startsWith('لديك ' + RLI)).toBe(true);
  });

  it('leaves an empty value bare rather than isolating nothing', () => {
    const text = render('Hello {$name :string}.', NAME, { name: '' });
    expect(text).toBe('Hello .');
  });
});

describe('MF2 u:dir and u:id', () => {
  it('isolates with RLI when the author declares a right-to-left value', () => {
    const text = render('Hello {$name :string u:dir=rtl}.', NAME, {
      name: 'Ada',
    });
    expect(text).toBe(`Hello ${RLI}Ada${PDI}.`);
  });

  /**
   * `u:dir=ltr` in a left-to-right message is the case that shows `isolate` is a separate fact.
   *
   * The value's direction and the message's agree, so nothing needs isolating; the strategy
   * isolates anyway, because writing `u:dir` at all sets `isolate`. Deriving isolation from the two
   * directions alone would leave this bare.
   */
  it('isolates with LRI when the author declares a left-to-right value', () => {
    const text = render('Hello {$name :string u:dir=ltr}.', NAME, {
      name: 'Ada',
    });
    expect(text).toBe(`Hello ${LRI}Ada${PDI}.`);
  });

  it('isolates with FSI when the author defers to the content', () => {
    const text = render('Hello {$name :string u:dir=auto}.', NAME, {
      name: 'Ada',
    });
    expect(text).toBe(`Hello ${FSI}Ada${PDI}.`);
  });

  /**
   * The one line that ties the two halves of this change together.
   *
   * Atlas isolates a value whose content could reorder the message, which is a decision made about
   * a consumer's string without being told anything about it. `u:dir=inherit` is how an author
   * overrides that, and it is the reason implementing `u:dir` and correcting the sniff had to land
   * together: without it the sniff has no escape hatch, and the value below would be isolated with
   * nothing an author could do about it.
   */
  it('leaves a value bare when the author writes u:dir=inherit over the content check', () => {
    const text = render('Hello {$name :string u:dir=inherit}.', NAME, {
      name: 'שרה',
    });
    expect(text).toBe('Hello שרה.');
  });

  it('carries u:id on the part and keeps it out of the string', () => {
    const result = evaluateParts('Hello {$name :string u:id=who}.', NAME, {
      name: 'Ada',
    });
    const value = result.value.find((part) => part.kind === 'value');
    expect(value).toBeDefined();
    expect(value).toMatchObject({ id: 'who', value: 'Ada' });
    expect(result.text).toBe('Hello Ada.');
  });

  it('records the resolved direction on the part, not only in the projection', () => {
    const declared = evaluateParts('Hello {$name :string u:dir=rtl}.', NAME, {
      name: 'Ada',
    }).value.find((part) => part.kind === 'value');
    expect(declared).toMatchObject({ contentDirection: 'rtl', isolate: true });

    // Without `u:dir`, a consumer's string that could reorder is `auto`: Atlas defers rather than
    // claiming to know the language, which is the same answer `<bdi>` gives in the DOM.
    const sniffed = evaluateParts('Hello {$name :string}.', NAME, {
      name: 'שרה',
    }).value.find((part) => part.kind === 'value');
    expect(sniffed).toMatchObject({ contentDirection: 'auto', isolate: false });
  });
});

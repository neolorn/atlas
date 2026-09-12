import {
  localeProfile,
  type ContentDirection,
  type IconDirectionClass,
  type LocaleDirection,
  type LocaleTypographyRegistry,
  type TypographyProfile,
} from '@neolorn/atlas/core';

/** A language tag with the direction it is written in, for marking up a run of text. */
export interface LanguagePresentation {
  /** The tag in its canonical spelling, for the `lang` attribute. */
  readonly language: string;
  /** Which way it runs, for the `dir` attribute. */
  readonly direction: LocaleDirection;
}

/** Whether an icon should be flipped in the current direction, and what it was judged on. */
export interface IconPresentation {
  /** What kind of icon this is: one that points, one that does not, one that never flips. */
  readonly classification: IconDirectionClass;
  /** The direction the judgement was made against. */
  readonly direction: LocaleDirection;
  /** The answer: whether to mirror it. Only a pointing icon in a right-to-left locale is flipped. */
  readonly mirror: boolean;
}

/**
 * How to mark up a piece of content whose language the application may not know.
 *
 * The direction is `auto` rather than a guess wherever the language is unknown or the content has
 * no language, which is what lets the browser decide from the text instead of Atlas deciding from
 * nothing.
 */
export interface ContentPresentation {
  /** The declared tag, absent when the consumer supplied none. */
  readonly language?: string;
  /** What to put in `dir`, which is `auto` for anything not known to be in a language. */
  readonly direction: ContentDirection;
  /** Why that direction: the language resolved, it did not, or the content has no language. */
  readonly classification: 'known' | 'unknown' | 'language-independent';
}

/** BCP 47: no linguistic content, such as an order reference, a SKU, or a serial number. */
const LANGUAGE_INDEPENDENT = 'zxx';

/** BCP 47: undetermined language. */
const UNDETERMINED = 'und';

/**
 * How to present a piece of consumer content whose language may not be known.
 *
 * `specs/03-locale-identity-and-resolution.spec.md` section 10 says user-authored, multilingual and
 * language-independent values keep their own known language and direction, or an explicit unknown
 * state. The unknown state had no
 * representation: `languagePresentation('und')` answered `ltr`, so content explicitly marked
 * undetermined was assigned a direction Atlas had no basis for. A customer name typed in Arabic
 * and stored without a tag rendered left-to-right.
 *
 * Now:
 *
 * - a tag that resolves to a script keeps its direction, including `und-Arab`, where the language
 *   is undetermined but the script is not;
 * - `und` with no script, and an absent tag, are unknown and defer;
 * - `zxx` is language-independent and defers, because a reference or a code has no language to
 *   take a direction from;
 * - a malformed tag still throws, because a tag that cannot be parsed is a programming error
 *   rather than an undetermined language.
 */
export function contentPresentation(language?: string): ContentPresentation {
  if (language === undefined) {
    return Object.freeze({ direction: 'auto', classification: 'unknown' });
  }

  const primary = language.split('-')[0]?.toLowerCase() ?? '';

  if (primary === LANGUAGE_INDEPENDENT) {
    return Object.freeze({
      language,
      direction: 'auto',
      classification: 'language-independent',
    });
  }

  if (primary === UNDETERMINED && !hasScriptSubtag(language)) {
    // Undetermined with nothing to resolve a script from. Answering 'ltr' here is the defect this
    // exists to remove: it is a guess wearing the shape of a fact.
    return Object.freeze({
      language,
      direction: 'auto',
      classification: 'unknown',
    });
  }

  const profile = localeProfile(language);
  return Object.freeze({
    language: profile.locale,
    direction: profile.direction,
    classification: 'known',
  });
}

function hasScriptSubtag(language: string): boolean {
  // A script subtag is exactly four alphabetic characters in the second position.
  const parts = language.split('-');
  return parts.length > 1 && /^[A-Za-z]{4}$/u.test(parts[1] ?? '');
}

/**
 * The tag and direction for content known to be in a particular language.
 *
 * For a language name in a switcher, a quotation, a sample. Throws for a tag that cannot be
 * parsed; use `contentPresentation` for content whose language is not known.
 */
export function languagePresentation(language: string): LanguagePresentation {
  const profile = localeProfile(language);
  return Object.freeze({
    language: profile.locale,
    direction: profile.direction,
  });
}

/**
 * Picks the typography a locale should be set in, from the registry an application declared.
 *
 * Looks for the locale's script first, then its language, then the registry's default, and returns
 * `undefined` when the registry has none of the three. Script before language, because line height
 * and font stack follow the writing system rather than the tongue.
 */
export function resolveTypography(
  locale: string,
  registry: LocaleTypographyRegistry,
): TypographyProfile | undefined {
  const profile = localeProfile(locale);
  return (
    registry.scripts?.[profile.script] ??
    registry.languages?.[profile.language] ??
    registry.default
  );
}

/**
 * Decides whether an icon is mirrored, from what kind of icon it is and which way the page runs.
 *
 * Only an icon that points at something is flipped, and only in a right-to-left locale. A clock, a
 * logo or a checkmark keeps its orientation, because mirroring those makes them wrong rather than
 * localized.
 */
export function iconPresentation(
  classification: IconDirectionClass,
  direction: LocaleDirection,
): IconPresentation {
  return Object.freeze({
    classification,
    direction,
    mirror: classification === 'relative' && direction === 'rtl',
  });
}

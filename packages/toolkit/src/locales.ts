import {
  atlasDiagnostic,
  atlasFailure,
  atlasSuccess,
  type AtlasResult,
} from './diagnostics.js';
import { ATLAS_LOCALE_ENDONYMS } from './endonyms.generated.js';
import { ATLAS_PARENT_LOCALES } from './parent-locales.generated.js';
import { atlasUntrustedText } from './untrusted-text.js';

declare const localeBrand: unique symbol;
declare const localeAliasBrand: unique symbol;

/**
 * A locale tag in its canonical spelling.
 *
 * Branded, so a bare string cannot stand in for one and a tag that was never canonicalized cannot
 * reach a place expecting one. `canonicalizeAtlasLocale` is what produces one; two spellings of the
 * same locale become the same value, which is what lets them be compared and used as keys.
 */
export type AtlasLocale = string & {
  readonly [localeBrand]: 'AtlasLocale';
};

export type AtlasLocaleAlias = string & {
  readonly [localeAliasBrand]: 'AtlasLocaleAlias';
};

/**
 * The alias grammar, which is narrower than a locale identity on purpose.
 *
 * `specs/03-locale-identity-and-resolution.spec.md` section 5 says what an alias is for: a
 * consumer's own spelling of a locale, such as one its storage held before Atlas. It is not a place
 * to restate a relation the pinned data already gives, so nothing here consults that data, and
 * section 3 of `specs/03-locale-identity-and-resolution.spec.md` is what the canonical side is
 * held to instead.
 */
const aliasPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export function canonicalizeAtlasLocale(
  value: unknown,
): AtlasResult<AtlasLocale> {
  const text = atlasUntrustedText(value, 'ATL1003', 'Locale identity');
  if (!text.ok) return text;
  const locale = text.value;
  if (
    locale.length === 0 ||
    locale.length > 255 ||
    locale.includes('_') ||
    locale.trim() !== locale
  ) {
    return atlasFailure([
      atlasDiagnostic('ATL1003', 'Locale identity is malformed.'),
    ]);
  }

  let canonical: string;
  try {
    const locales = Intl.getCanonicalLocales(locale);
    if (locales.length !== 1 || locales[0] === undefined) {
      return atlasFailure([
        atlasDiagnostic('ATL1003', 'Locale identity is malformed.'),
      ]);
    }
    canonical = locales[0];
  } catch {
    return atlasFailure([
      atlasDiagnostic('ATL1003', 'Locale identity is malformed.'),
    ]);
  }

  const parts = canonical.split('-');
  if (parts.slice(1).some((part) => part.length === 1)) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1003',
        'Catalog locale identities cannot contain extensions or private-use subtags.',
      ),
    ]);
  }

  return atlasSuccess(canonical as AtlasLocale);
}

export function parseAtlasLocaleAlias(
  value: unknown,
): AtlasResult<AtlasLocaleAlias> {
  const text = atlasUntrustedText(value, 'ATL1005', 'Locale alias');
  if (!text.ok) return text;
  if (!aliasPattern.test(text.value)) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1005',
        'Locale alias must be a lowercase ASCII identifier containing only letters, digits, and hyphens.',
      ),
    ]);
  }

  return atlasSuccess(text.value as AtlasLocaleAlias);
}

/**
 * The name a locale has for itself, from Atlas's pinned CLDR release.
 *
 * `undefined` means Atlas has no name for this locale and the caller should say so rather than
 * invent one: either CLDR names none of it, there are locales in the standard with no display
 * names at all, or the tag is outside CLDR's coverage entirely, as a private-use tag is.
 *
 * A tag CLDR does not list is answered by its parent, by truncation: `de-CH-1901` is `de-CH`, which
 * is "Deutsch (Schweiz)". That is a real name for a broader locale rather than a guess at a
 * narrower one, and it is the same fallback CLDR itself performs to find data. What is not done is
 * composing a new name out of subtags Atlas has no words for: that is how `catala (Espanya,
 * VALENCIA)` happens, and it is the defect this table exists to remove.
 */
export function atlasLocaleEndonym(locale: string): string | undefined {
  let candidate = locale;
  for (;;) {
    const endonym = Object.hasOwn(ATLAS_LOCALE_ENDONYMS, candidate)
      ? ATLAS_LOCALE_ENDONYMS[candidate]
      : undefined;
    if (endonym !== undefined) return endonym;
    const cut = candidate.lastIndexOf('-');
    if (cut <= 0) return undefined;
    candidate = candidate.slice(0, cut);
  }
}

/**
 * The identity CLDR gives the locale every chain ends at.
 *
 * It is written in the pinned parent table as the parent of a locale that inherits from root, so
 * it is a value Atlas reads rather than one it chose, and a project writing it in its own
 * `parentLocales` is saying the same thing CLDR says: this locale has no parent.
 */
export const ATLAS_ROOT_LOCALE = 'und';

const NO_PARENT_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The parent of one locale, from Atlas's pinned CLDR release and the project's own declarations.
 *
 * `undefined` means the locale inherits from root, which is where a chain ends.
 *
 * Three rules in the order UTS 35 section 4.1.3 gives them. A parent the project declared wins,
 * because its configuration is where a consumer says CLDR's answer is wrong for this product.
 * Otherwise the pinned table answers, `und` included: `und` there means root, so it ends the chain
 * rather than naming a locale. Otherwise the parent is the tag with its last subtag removed, and a
 * tag with one subtag left has none.
 *
 * Declarations are consulted at every hop rather than only at the first, which is what makes one
 * entry enough to move a family: a project that gives `en-001` a different parent has moved every
 * locale that inherits through it.
 */
export function atlasLocaleParent(
  locale: string,
  overrides: Readonly<Record<string, string>> = NO_PARENT_OVERRIDES,
): string | undefined {
  const declared = Object.hasOwn(overrides, locale)
    ? overrides[locale]
    : Object.hasOwn(ATLAS_PARENT_LOCALES, locale)
      ? ATLAS_PARENT_LOCALES[locale]
      : undefined;
  if (declared !== undefined) {
    return declared === ATLAS_ROOT_LOCALE ? undefined : declared;
  }
  const cut = locale.lastIndexOf('-');
  return cut <= 0 ? undefined : locale.slice(0, cut);
}

/**
 * Every locale a locale inherits from, nearest first, ending before root.
 *
 * The chain is walked to its end rather than stopped at one hop, because one hop is not what a
 * reader of "falls back to its parent" expects and not what CLDR means. `en-AU` gives `en-001`
 * and then `en`; stopping at `en-001` would serve the source locale for a string `en` has.
 *
 * The locale itself is not in the result. It is the caller's first choice by definition, and
 * putting it here would make every caller drop it again.
 *
 * A cycle can only come from a project's own declarations, since the pinned table has none and
 * truncation always shortens. The walk stops at the first locale it has already seen so that a
 * mistake costs a short chain rather than a hang, and `ATL1007` reports the mistake itself when
 * the configuration is read.
 */
export function atlasLocaleFallbackChain(
  locale: string,
  overrides: Readonly<Record<string, string>> = NO_PARENT_OVERRIDES,
): readonly string[] {
  const chain: string[] = [];
  const seen = new Set<string>([locale]);
  for (
    let parent = atlasLocaleParent(locale, overrides);
    parent !== undefined && !seen.has(parent);
    parent = atlasLocaleParent(parent, overrides)
  ) {
    seen.add(parent);
    chain.push(parent);
  }
  return Object.freeze(chain);
}

/**
 * The same chain, restricted to the locales a project actually ships.
 *
 * This is what reaches the runtime. A chain runs through locales nobody serves, `en-001` among
 * them, and a member with no catalog costs a lookup and answers nothing; the links still matter
 * while the chain is being walked, which is why they are dropped here and not while walking.
 *
 * `shipped` is the project's own locale set, so the answer changes when the set does. That is why
 * the resolved chain is a build output rather than something the runtime derives: only the build
 * knows which locales this application ships.
 */
export function atlasShippedFallbackChain(
  locale: string,
  shipped: readonly string[],
  overrides: Readonly<Record<string, string>> = NO_PARENT_OVERRIDES,
): readonly string[] {
  const available = new Set(shipped);
  return Object.freeze(
    atlasLocaleFallbackChain(locale, overrides).filter((parent) =>
      available.has(parent),
    ),
  );
}

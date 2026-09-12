import type { LocaleDirection } from './contracts';
import { RTL_SCRIPTS } from './locale-profile.generated';

const rtlScripts = new Set<string>(RTL_SCRIPTS);

/**
 * What a locale tag resolves to once the parts it left implicit are filled in.
 *
 * A tag names as little as it needs to, so `ar` carries neither a script nor a region while still
 * naming a right-to-left locale written in Egypt. The script and region here come from the tag
 * where it stated them and from the standard's likely-subtags data where it did not.
 */
export interface LocaleProfile {
  /** The tag, canonically spelled. */
  readonly locale: string;
  /** Its language subtag, which is what `lang` on a single element wants. */
  readonly language: string;
  /** Its script, filled in from likely subtags when the tag did not state one. */
  readonly script: string;
  /** Its region, filled in the same way. Absent when even maximizing does not produce one. */
  readonly region?: string;
  /** Which way it is written, which follows from the script. */
  readonly direction: LocaleDirection;
}

/**
 * A tag's language subtag, as ECMA-402 defines it rather than as the engine reports it.
 *
 * `get Intl.Locale.prototype.language` is `GetLocaleLanguage(loc.[[Locale]])`, which is
 * `GetLocaleBaseName`, *"Return the longest prefix of locale matched by the `unicode_language_id`
 * nonterminal"*, and then *"Return the first subtag of baseName"*, having first asserted that the
 * subtag matches `unicode_language_subtag`. No step in that chain produces `undefined`.
 *
 * V8 produces one anyway. `new Intl.Locale('und').baseName` is `'und'` and `.language` is
 * `undefined`, so the engine contradicts its own two answers: the accessor is defined as the first
 * subtag of exactly the base name it just returned. It holds for every tag built on `und`,
 * `und-Arab-EG` included, where the profile then reported an undetermined language beside an Arabic
 * script and a right-to-left direction.
 *
 * Neither standard the accessor rests on excludes `und`. The pinned IANA registry records it as
 * *"Type: language, Subtag: und, Description: Undetermined, Scope: special"*, and UTS 35 48.2 gives
 * `unicode_language_subtag = alpha{2,3} | alpha{5,8}`, which three letters match.
 *
 * So reading the base name is not a special case for one tag; it is the accessor's own definition,
 * applied to every tag, which is what `specs/01-standards-profile.spec.md` section 5 asks for when
 * a host capability is materially inconsistent with the standard it implements. `root` and a bare script subtag are refused by the
 * constructor before they reach here, so the first subtag of an accepted tag's base name is a
 * language subtag every time.
 */
function localeLanguageSubtag(parsed: Intl.Locale): string {
  const [first] = parsed.baseName.split('-');
  return first ?? parsed.baseName;
}

/**
 * Resolves a locale tag into its language, script, region and direction.
 *
 * Throws a `RangeError` on a tag the engine will not parse, and on one whose script cannot be
 * determined even after maximizing, since there is then nothing to decide a direction from. Use
 * `directionForLocale` where only the direction is wanted and a bad tag should not throw.
 */
export function localeProfile(locale: string): LocaleProfile {
  const parsed = new Intl.Locale(locale);
  const maximized = parsed.maximize();
  const language = localeLanguageSubtag(parsed);
  const script = parsed.script ?? maximized.script;
  const region = parsed.region ?? maximized.region;
  if (script === undefined) {
    throw new RangeError('Atlas locale profile has no likely script.');
  }
  return Object.freeze({
    locale: parsed.toString(),
    language,
    script,
    ...(region === undefined ? {} : { region }),
    direction: rtlScripts.has(script) ? 'rtl' : 'ltr',
  });
}

/**
 * A locale in Open Graph's spelling, or nothing when it has no spelling there.
 *
 * [ogp.me](https://ogp.me/) says only this: "`og:locale` -- The locale these tags are marked up in.
 * Of the format `language_TERRITORY`. Default is `en_US`." It is BCP 47 with an underscore and no
 * script subtag, and the spec says nothing at all about the two cases a real locale set runs into:
 * a tag carrying a script (`zh-Hans-CN`) and a tag carrying no territory (`ar`). What follows is
 * therefore Atlas's answer where the specification is silent, not a requirement read out of it.
 *
 * *The territory is taken from the maximized profile*, so `ar` answers `ar_EG` rather than nothing.
 * A tag without a territory still names one locale, and CLDR's likely-subtags is the standard way to
 * say which; refusing to answer would be pedantry that costs a correct tag. *The script is dropped*,
 * because `language_TERRITORY` has no place to put one.
 *
 * *And a locale with no territory even after maximization gets no tag at all.* Emitting `zh` or
 * `zh_` in a field specified as two parts is worse than emitting nothing: a consumer of the markup
 * cannot tell a malformed value from a territory it does not recognise.
 *
 * This exists because it is the thing a hand-written implementation gets wrong. Writing the runtime
 * locale straight into the tag yields `ar-EG`, which is valid BCP 47, looks right, and is not what
 * the field is specified to hold.
 */
export function openGraphLocale(locale: string): string | undefined {
  let profile: LocaleProfile;
  try {
    profile = localeProfile(locale);
  } catch {
    return undefined;
  }
  return profile.region === undefined
    ? undefined
    : `${profile.language}_${profile.region}`;
}

/**
 * The social alternates of a page, from the same eligible-variant set the `hreflang` cluster is
 * built from: minus the page's own locale.
 *
 * The two formats want opposite things from that one set. An `hreflang` cluster is reciprocal: each
 * representation lists itself along with every sibling, because the set answers "which addresses
 * serve this page". `og:locale:alternate` answers "which *other* languages this page is also
 * available in", so the page's own locale appearing there says it is also available in the language
 * it is written in.
 *
 * This is a function rather than four lines inside the head effect because the divergence is the
 * whole point. Written inline it is a `continue` in a loop, correct the day it is written, and
 * invisible the day someone changes how the cluster is assembled, and a self-listing alternate
 * does not fail, warn, or render differently. It is simply a false claim in the markup.
 *
 * `x-default` is skipped: it is a routing answer about where an unmatched visitor lands, not a
 * language the page exists in. An alternate whose tag cannot be spelled in the Open Graph form is
 * dropped rather than guessed at, for the reason `openGraphLocale` gives.
 */
export function openGraphAlternates(
  locale: string | undefined,
  alternates: readonly { readonly hreflang: string }[],
): readonly string[] {
  const own = locale === undefined ? undefined : openGraphLocale(locale);
  const spelled = new Set<string>();
  for (const alternate of alternates) {
    if (alternate.hreflang === 'x-default') continue;
    const value = openGraphLocale(alternate.hreflang);
    if (value === undefined || value === own) continue;
    spelled.add(value);
  }
  return [...spelled];
}

/**
 * A locale's writing direction, or `ltr` when the locale is not one Atlas can profile.
 *
 * This lives beside `localeProfile` rather than in the evaluator because direction is a property of
 * the profile and nothing else: it reads one field and swallows the one error that field can
 * raise. Its home in the evaluator was the single runtime edge from `routing` into the message
 * pipeline, and through it into the catalog runtime, which is 110KB of machinery that answering
 * "which way does this locale read" has never needed.
 */
export function directionForLocale(locale: string): LocaleDirection {
  try {
    return localeProfile(locale).direction;
  } catch {
    return 'ltr';
  }
}

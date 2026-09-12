/**
 * Matching what a request asks for against what an application actually has.
 *
 * A browser sends `ar-SA,ar;q=0.9,en;q=0.8`. An application supports `en-US` and `ar-EG`. Nobody
 * asked for either of those exact tags, and yet the right answer is obviously Arabic. Producing
 * that answer is RFC 4647 lookup with one addition, and it is the part every consumer would
 * otherwise reimplement slightly differently.
 *
 * The addition is the encompassed-language relation. Where it comes from is decided by
 * section 3 of `specs/01-standards-profile.spec.md`: membership from the pinned registry snapshot,
 * ordering from the pinned release's language matching data, never from what a consumer happened to
 * declare, so a consumer does not restate `ar-SA` as an alias of `ar`. That refusal is
 * `specs/03-locale-identity-and-resolution.spec.md` section 6.
 *
 * The four steps below are `specs/03-locale-identity-and-resolution.spec.md` section 7, in order,
 * and each range is exhausted before the next one is looked at.
 */

import { ENCOMPASSED_LANGUAGE_DISTANCES } from './encompassed-languages.generated';

/** Ranges beyond this are ignored: a real Accept-Language header carries a handful. */
const MAXIMUM_RANGES = 32;

/** A language range longer than this is not a language range. */
const MAXIMUM_RANGE_LENGTH = 64;

/**
 * A `q` parameter and its value, or no match when the parameter is something else.
 *
 * RFC 9110 12.4.2 introduces the parameter as *"q" (case-insensitive)*, so a header spelling it `Q`
 * is stating a weight. Reading it as an unknown parameter leaves the default of 1, and
 * `de;Q=0.1, en` then answers German to a client whose first preference was English.
 *
 * The value is any decimal number rather than the qvalue grammar exactly, because the grammar's
 * three-digit limit binds a *sender*, "A sender of qvalue MUST NOT generate more than three digits
 * after the decimal point", and places no requirement on a recipient. Reading `q=1.0000` as 1 is
 * conformant; discarding the range would lose a language a client asked for over a digit that harms
 * nothing. The range is what 12.4.2 normalizes, and the caller does that.
 */
const WEIGHT_PARAMETER = /^\s*[Qq]\s*=\s*(\d+(?:\.\d+)?)\s*$/u;

/**
 * The language ranges an `Accept-Language` header asks for, best first.
 *
 * `*` is dropped rather than treated as a wildcard match: it means "anything else is acceptable",
 * which is what the configured default already expresses, and honouring it here would let a header
 * that expresses no real preference outrank the source the consumer put after it.
 */
export function parseAcceptLanguage(header: string): readonly string[] {
  const entries: { readonly range: string; readonly quality: number }[] = [];
  for (const part of header.split(',', MAXIMUM_RANGES)) {
    const [rangeText, ...parameters] = part.split(';');
    const range = rangeText?.trim() ?? '';
    if (
      range.length === 0 ||
      range.length > MAXIMUM_RANGE_LENGTH ||
      range === '*' ||
      !/^[A-Za-z0-9-]+$/u.test(range)
    ) {
      continue;
    }
    let quality = 1;
    for (const parameter of parameters) {
      const match = WEIGHT_PARAMETER.exec(parameter);
      if (match?.[1] === undefined) continue;
      // "The weight is normalized to a real number in the range 0 through 1": RFC 9110 12.4.2.
      // A value outside it is not a preference this header can express, and reading `q=1.999` as
      // 1.999 would let a client that wrote something the grammar forbids outrank one that wrote
      // `q=1`.
      quality = Math.min(1, Math.max(0, Number(match[1])));
    }
    if (quality <= 0) continue;
    entries.push({ range, quality });
  }
  // Stable sort by descending quality: equal qualities keep header order, which is the order the
  // client wrote them in and the only tie-break information available.
  return Object.freeze(
    entries
      .map((entry, index) => ({ ...entry, index }))
      .sort((left, right) =>
        left.quality === right.quality
          ? left.index - right.index
          : right.quality - left.quality,
      )
      .map(({ range }) => range),
  );
}

function languageSubtag(tag: string): string {
  return (tag.split('-')[0] ?? '').toLowerCase();
}

/**
 * The next candidate in RFC 4647 lookup, or `undefined` once the language subtag is all that is
 * left.
 *
 * Section 3.4: *"Single letter or digit subtags (including both the letter 'x', which introduces
 * private-use sequences, and the subtags that introduce extensions) are removed at the same time as
 * their closest trailing subtag."* So `zh-Hant-CN-x-private1` truncates to `zh-Hant-CN`, and the
 * RFC's own worked example never asks about `zh-Hant-CN-x`, which is not a language tag.
 *
 * Truncating one subtag at a time produced that extra candidate, and it matched nothing only
 * because `Intl.getCanonicalLocales` rejects it and every supported locale is canonical. That is an
 * invariant of another file, and the algorithm this loop claims to implement does not need it.
 */
function truncateSubtag(candidate: string): string | undefined {
  const separator = candidate.lastIndexOf('-');
  if (separator < 0) return undefined;
  let next = candidate.slice(0, separator);
  // A trailing singleton goes with the subtag just removed, and so does the one before it: an
  // extension sequence is a singleton followed by its subtags, and removing them one at a time
  // would leave a tag no registry has ever defined.
  for (
    let boundary = next.lastIndexOf('-');
    boundary >= 0 && next.length - boundary === 2;
    boundary = next.lastIndexOf('-')
  ) {
    next = next.slice(0, boundary);
  }
  return next;
}

/**
 * The script a tag is written in, after CLDR's likely-subtags maximization.
 *
 * Maximization is what makes the comparison work on the tags people actually send, which mostly
 * name no script at all: `zh-TW` gives `Hant` and `zh-CN` gives `Hans`, `sr` gives `Cyrl` and
 * `sr-Latn` gives `Latn`. Comparing written scripts would answer nothing for any of them.
 *
 * `undefined` for a tag that cannot be maximized, which then compares equal only to another tag
 * that cannot either.
 */
function maximizedScript(tag: string): string | undefined {
  try {
    return new Intl.Locale(tag).maximize().script;
  } catch {
    return undefined;
  }
}

/**
 * The best supported locale for a list of requested ranges, or `undefined`.
 *
 * Each range is tried in order and fully resolved before the next is considered: a client that
 * prefers Arabic and accepts English must not be given English because its Arabic tag needed one
 * more step to match. For a single range:
 *
 * 1. the range itself, after canonicalization and consumer aliases;
 * 2. the range truncated from the end, which is RFC 4647 lookup: `ar-SA-u-nu-arab` becomes
 *    `ar-SA-u-nu`, then `ar-SA`, then `ar`. `u` goes with `nu` because a singleton is removed
 *    together with the subtag that follows it;
 * 3. any supported locale sharing the range's language *and its script*. This is the addition.
 *    Lookup alone leaves `ar-SA` unmatched against a supported `ar-EG`, and answering English to an
 *    Arabic speaker because the region differs is the wrong answer by a wide margin.
 * 4. any supported locale written in the same script whose language is the *same language* as the
 *    range's under another subtag, nearest first. `no` is the everyday case: a browser sends it,
 *    BCP 47 3.1.10 says `nb` and `nn` are both encompassed by it, and a site shipping `nb-NO`
 *    matched nothing at step 3 because `no` and `nb` are different subtags.
 *
 * Step 3 prefers the earliest supported locale, so the consumer's declared order decides which
 * regional variant represents a language. Step 4 prefers the nearest language and falls back to
 * that same rule for a tie, so a consumer never has to break one CLDR does not break.
 *
 * The script is compared because a language is not a script. `zh-Hant` against a supported
 * `zh-Hans-CN` shares a language and nothing else: it would serve Simplified to a Traditional
 * reader, which is not the regional difference this step was written to absorb. Both sides are
 * maximized first, so a range and a locale that name no script are still compared by the script
 * they are actually written in.
 */
export function negotiateLocale(
  ranges: readonly string[],
  supportedLocales: readonly string[],
  canonicalize: (value: string) => string | undefined,
): string | undefined {
  const supported = new Set(supportedLocales);
  // Maximized once per call rather than once per range: the supported list cannot change while one
  // header is being resolved, and step 3 is reached for every range that step 2 does not answer.
  let profiles:
    | readonly {
        readonly locale: string;
        readonly language: string;
        readonly script: string | undefined;
      }[]
    | undefined;
  for (const range of ranges) {
    let candidate: string | undefined = range;
    while (candidate !== undefined && candidate.length > 0) {
      const canonical = canonicalize(candidate);
      if (canonical !== undefined && supported.has(canonical)) return canonical;
      candidate = truncateSubtag(candidate);
    }
    const language = languageSubtag(range);
    if (language.length === 0) continue;
    profiles ??= supportedLocales.map((locale) => ({
      locale,
      language: languageSubtag(locale),
      script: maximizedScript(locale),
    }));
    const script = maximizedScript(range);
    const related = profiles.find(
      (profile) => profile.language === language && profile.script === script,
    );
    if (related !== undefined) return related.locale;
    // Step 4. The table holds only subtags that are one language written twice, so this cannot
    // reach across languages; the script comparison is repeated unchanged, so it cannot reach
    // across scripts either. A request for `zh-Hant` against a supported `zh-Hans-CN` is still
    // refused here, because `zh` is not in the table against itself and the scripts differ anyway.
    const distances = ENCOMPASSED_LANGUAGE_DISTANCES[language];
    if (distances === undefined) continue;
    let nearest: string | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const profile of profiles) {
      const distance = distances[profile.language];
      // `>=` and not `>`: an equal distance leaves the earlier supported locale in place, which is
      // the consumer's declared order deciding a tie CLDR does not decide.
      if (distance === undefined || distance >= nearestDistance) continue;
      if (profile.script !== script) continue;
      nearest = profile.locale;
      nearestDistance = distance;
    }
    if (nearest !== undefined) return nearest;
  }
  return undefined;
}

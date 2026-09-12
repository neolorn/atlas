/**
 * A locale nobody translated, so a developer can see what translation is going to do.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 16 configures the direction, the length factor
 * and the boundary markers independently rather than as a set of modes, and keeps the transform
 * at build time: a production build does not generate the catalog, so there is no transform in
 * the bundle for anything to enable by accident.
 */

import { parseMessage, stringifyMessage, type Model } from 'messageformat';

import type {
  AtlasCatalog,
  AtlasCatalogMessage,
  AtlasTextCatalogMessage,
} from './catalog.js';
import {
  atlasDiagnostic,
  atlasFailure,
  atlasSuccess,
  type AtlasResult,
} from './diagnostics.js';
import { canonicalizeAtlasLocale } from './locales.js';
import {
  parseAtlasMessage,
  type AtlasMessageCustomFunction,
} from './message-format.js';

/**
 * The expanded pseudo-locale: Latin script, left-to-right, modelling a language longer than English.
 *
 * `XA` is a user-assigned ISO 3166-1 region code, permanently unassigned to any country, so it
 * cannot collide with a real locale now or later. It is also the established pseudo-locale
 * convention, Chrome and Android use `en-XA` for exactly this, so a developer who sees it in a
 * locale switcher recognises what it is.
 *
 * The script subtag is written out rather than left to be inferred, because the script is what
 * carries direction and this file's whole design rests on direction being a property of the tag.
 * `en-XA` maximizes to `en-Latn-XA` and resolves the same way; stating `Latn` means the reader does
 * not have to know that.
 */
export const ATLAS_PSEUDO_LOCALE_EXPANDED = 'en-Latn-XA';

/**
 * The contracted pseudo-locale: Arabic script, right-to-left, modelling a language shorter than
 * English, which Arabic is, and which is the case that finds containers sized to English copy.
 *
 * **The base language is `en`, deliberately, and this is the part worth not changing.** A developer
 * reading their own screens must still be able to read them; the point is to see *their* layout
 * mirrored and their own physical CSS become visible. `ar-XB` would be an Arabic-language
 * pseudo-locale, which tests translation coverage instead and leaves the developer unable to
 * evaluate what they are looking at.
 *
 * `Arab` is in the generated `RTL_SCRIPTS` table, so this tag resolves `direction: 'rtl'` through
 * the lookup every locale uses. There is no pseudo-locale branch anywhere in the runtime, and
 * nothing to exclude from a production build beyond not generating the catalog.
 *
 * **Why not `en-x-psexpand` and `en-Arab-x-pscontr`, which say what they are?** Because
 * `canonicalizeAtlasLocale` refuses any single-character subtag, and `x` is one, so a private-use
 * tag is rejected as a catalog identity. This is recorded here because the private-use form looks
 * correct from outside: it passes `Intl.getCanonicalLocales`, it survives `Intl.Locale.maximize()`,
 * and the runtime's direction lookup returns `rtl` for it. Three external authorities accept it and
 * the one validator that belongs to Atlas does not.
 * `specs/03-locale-identity-and-resolution.spec.md` section 3 is the reason the validator is right:
 * a private-use subtag carries no application semantics, so admitting one into a catalog identity
 * would let two catalogs differ only in a part that no lookup reads.
 */
export const ATLAS_PSEUDO_LOCALE_CONTRACTED = 'en-Arab-XB';

/**
 * How a pseudo-locale differs from its source, as settings that combine freely.
 *
 * This was `AtlasPseudoLocaleMode`, two values naming fixed *combinations*, `expansion-accent`
 * and `bidi-rtl`, which made the behaviours mutually exclusive and welded the boundary markers
 * into one of them. A reader wanting expansion *and* markers, or contraction *without* them, could
 * not ask for it. Nothing about the behaviours requires them to be bundled, so they are not.
 *
 * **Direction is deliberately absent from this interface.** It is carried by the locale tag, not by
 * the transform: direction is derived from the script subtag through the generated `RTL_SCRIPTS`
 * table, so `ATLAS_PSEUDO_LOCALE_CONTRACTED` resolves RTL because `Arab` is an RTL script, through
 * machinery that already exists and needs no pseudo-locale special case. A direction flag here
 * would mean a runtime branch that reads it, which is a shipped code path the build-time design
 * exists to avoid.
 *
 * **Accenting is not a setting either, because it is what makes the locale a pseudo-locale.** The
 * substituted alphabet is how a reader tells transformed text from text that never reached Atlas,
 * and a pseudo-locale with it switched off is just the source language under a different tag.
 */
export interface AtlasPseudoLocaleTransform {
  /**
   * Signed. Positive expands, negative contracts, absent leaves length alone.
   *
   * **No default, deliberately.** The value this replaces defaulted to `0.35`, a German expansion
   * figure, which every caller silently inherited whether or not anyone had measured their content.
   * Omitting the key now means the length behaviour is off rather than that an unmeasured number is
   * applied. A ratio worth using is derived from real translations of the strings that have no room
   * to shorten.
   *
   * Contraction is not padding with a negative count. It elides vowels in proportion to the factor,
   * because that is what makes one language shorter than another rather than what truncation looks
   * like, and truncation is the symptom the expanded locale exists to *find*, so producing it
   * here would make the two pseudo-locales indistinguishable in the one place they must differ.
   */
  readonly lengthFactor?: number;
  /**
   * Wrap each message in visible delimiters. Off unless asked for.
   *
   * One pair around the whole message rather than around each literal run, so a message containing
   * a placeholder reads as one bounded string instead of several. That is what makes a hardcoded
   * string visible: everything Atlas rendered has boundaries and it does not.
   */
  readonly markers?: boolean;
}

/**
 * How to derive one pseudo-locale from a source catalog.
 *
 * A pseudo-locale is a translation nobody wrote: the source text put through a transform that makes
 * untranslated strings, cramped layouts and direction mistakes visible before a translator is
 * involved. The transform's own options are inherited; what this adds is the tag it publishes under
 * and the extension functions the derived catalog has to parse with.
 */
export interface AtlasPseudoLocaleOptions extends AtlasPseudoLocaleTransform {
  /**
   * Message-function names the application has registered, so a derived catalog parses like an
   * authored one.
   *
   * The transform re-parses each message to find its literal runs, and a parse that does not know
   * an application's registered functions rejects the message its own source catalog accepted. So
   * this is not a refinement: without it, deriving a pseudo-locale fails outright for any
   * application that registers a message extension.
   */
  readonly customFunctions?: readonly AtlasMessageCustomFunction[];
  /**
   * The tag the pseudo-locale is published under. Required.
   *
   * It cannot be optional with a per-mode default, because the tag is what decides direction, so a
   * default picks one silently, which is the single most consequential thing about a pseudo-locale
   * and the least visible if it is chosen by omission.
   */
  readonly locale: string;
}

const accentCharacters: Readonly<Record<string, string>> = Object.freeze({
  A: 'Å',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Đ',
  E: 'Ë',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Ï',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ø',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ř',
  S: 'Š',
  T: 'Ţ',
  U: 'Ü',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẍ',
  Y: 'Ÿ',
  Z: 'Ž',
  a: 'å',
  b: 'ƀ',
  c: 'ç',
  d: 'đ',
  e: 'ë',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'ï',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ṁ',
  n: 'ñ',
  o: 'ø',
  p: 'þ',
  q: 'ǫ',
  r: 'ř',
  s: 'š',
  t: 'ţ',
  u: 'ü',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẍ',
  y: 'ÿ',
  z: 'ž',
});

const protectedText = /(?:https?:\/\/|mailto:)[^\s]+/giu;

function transformUnprotected(
  value: string,
  transform: (part: string) => string,
): string {
  let result = '';
  let start = 0;
  for (const match of value.matchAll(protectedText)) {
    const index = match.index;
    result += transform(value.slice(start, index));
    result += match[0];
    start = index + match[0].length;
  }
  return result + transform(value.slice(start));
}

const vowels = /[AEIOUaeiouÅËÏØÜåëïøü]/u;

/**
 * Remove vowels in proportion to `factor`, spread across the run rather than taken from one end.
 *
 * Spread, because removing a tail is truncation and truncation is precisely the defect the expanded
 * pseudo-locale is built to surface. Two pseudo-locales that produce the same symptom cannot tell a
 * reader which one they are looking at.
 *
 * A run with no vowels does not contract, and that is honest rather than a gap: shortening it would
 * mean cutting consonants, which stops reading as the same word.
 */
function elide(value: string, factor: number): string {
  const characters = [...value];
  const positions = characters.flatMap((character, index) =>
    vowels.test(character) ? [index] : [],
  );
  const removeCount = Math.min(
    positions.length,
    Math.round(positions.length * factor),
  );
  if (removeCount === 0) return value;
  // Evenly spaced picks, so a long word loses vowels along its length instead of losing its middle.
  const step = positions.length / removeCount;
  const removed = new Set(
    Array.from(
      { length: removeCount },
      (_unused, index) => positions[Math.floor(index * step)],
    ),
  );
  return characters.filter((_unused, index) => !removed.has(index)).join('');
}

/**
 * Substitute the accented alphabet, then apply the length factor if there is one.
 *
 * A single `expansionRatio` doing both at once, and only in one direction, is what stops expansion
 * and accenting being asked for separately. The substitution never changes length; the factor never
 * changes which letters are used.
 */
function accent(value: string, lengthFactor: number | undefined): string {
  const substituted = [...value]
    .map((character) => accentCharacters[character] ?? character)
    .join('');
  if (lengthFactor === undefined || lengthFactor === 0) return substituted;
  if (lengthFactor < 0) return elide(substituted, -lengthFactor);
  const expansionRatio = lengthFactor;
  const letters = [...substituted].filter((character) =>
    /\p{L}/u.test(character),
  );
  const expansion = Math.ceil(letters.length * expansionRatio);
  if (expansion === 0) return substituted;
  const paddingSource = letters.filter((character) =>
    /[AEIOUaeiouÅËÏØÜåëïøü]/u.test(character),
  );
  const padding = (paddingSource.length === 0 ? letters : paddingSource)
    .slice(0, Math.max(1, expansion))
    .join('');
  return `${substituted}${padding.repeat(Math.ceil(expansion / Math.max(1, padding.length))).slice(0, expansion)}`;
}

function transformLiteral(
  value: string,
  lengthFactor: number | undefined,
): string {
  if (value.length === 0) return value;
  return transformUnprotected(value, (part) => {
    if (part.length === 0 || !/\S/u.test(part)) return part;
    return accent(part, lengthFactor);
  });
}

/**
 * Transform the literal runs, and optionally bound the whole pattern.
 *
 * Only `typeof part === 'string'` is touched, which is the property the whole design rests on: a
 * placeholder is a structured node, so it is never accented, padded or elided. A blind string
 * transform turns `Welcome, {$name}!` into a message whose placeholder no longer resolves, which is
 * the defect that removed the previous runtime helper.
 *
 * Markers go on the pattern rather than on each run, so a message reads as one bounded string
 * however many placeholders it contains.
 */
function transformPattern(
  pattern: Model.Pattern,
  transform: AtlasPseudoLocaleTransform,
): void {
  for (let index = 0; index < pattern.length; index += 1) {
    const part = pattern[index];
    if (typeof part === 'string') {
      pattern[index] = transformLiteral(part, transform.lengthFactor);
    }
  }
  if (transform.markers === true) {
    pattern.unshift('⟦');
    pattern.push('⟧');
  }
}

export function pseudoLocalizeAtlasMessage(
  source: string,
  transform: AtlasPseudoLocaleTransform = {},
  customFunctions: readonly AtlasMessageCustomFunction[] = [],
): AtlasResult<string> {
  const { lengthFactor } = transform;
  if (
    lengthFactor !== undefined &&
    (!Number.isFinite(lengthFactor) || lengthFactor < -1 || lengthFactor > 2)
  ) {
    // The lower bound is -1 because that already elides every vowel; there is nothing further to
    // remove without cutting consonants, which stops reading as the same word.
    return atlasFailure([
      atlasDiagnostic(
        'ATL1804',
        'Pseudo-localization length factor must be between minus one and two. Positive expands, negative contracts, and omitting it leaves length unchanged.',
      ),
    ]);
  }
  let message: Model.Message;
  try {
    message = JSON.parse(JSON.stringify(parseMessage(source))) as Model.Message;
  } catch {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1804',
        'Pseudo-localization requires a valid MessageFormat message.',
      ),
    ]);
  }
  if (message.type === 'message') {
    transformPattern(message.pattern, transform);
  } else {
    for (const variant of message.variants) {
      transformPattern(variant.value, transform);
    }
  }
  const transformed = stringifyMessage(message);
  const validated = parseAtlasMessage(transformed, { customFunctions });
  return validated.ok
    ? atlasSuccess(transformed, validated.diagnostics)
    : atlasFailure(validated.diagnostics);
}

function pseudoMessage(
  message: AtlasCatalogMessage,
  transform: AtlasPseudoLocaleTransform,
  customFunctions: readonly AtlasMessageCustomFunction[],
): AtlasResult<AtlasCatalogMessage> {
  if (message.kind === 'empty') {
    return atlasSuccess(
      Object.freeze({
        kind: 'empty',
        inputs: Object.freeze({}),
        slots: Object.freeze({}),
      }),
    );
  }
  const transformed = pseudoLocalizeAtlasMessage(
    message.message,
    transform,
    customFunctions,
  );
  if (!transformed.ok) return transformed;
  const semantics = parseAtlasMessage(transformed.value, {
    customFunctions,
  });
  if (!semantics.ok) return semantics;
  return atlasSuccess(
    Object.freeze({
      kind: 'message',
      message: transformed.value,
      semantics: semantics.value,
      inputs: Object.freeze({}),
      slots: Object.freeze({}),
    }) satisfies AtlasTextCatalogMessage,
  );
}

/**
 * An ordinary target catalog, derived from a source catalog with no authored translation.
 *
 * Ordinary is the point. What comes back is an `AtlasCatalog` like any other, so it compiles,
 * loads and renders through the same path a real translation does, and nothing downstream, least
 * of all the runtime, can tell the difference or needs to. That is what keeps the transform at
 * build time, and what makes a production build's exclusion an absence rather than a guard: this
 * function lives in the toolkit, which is a development dependency and reaches no bundle.
 */
export function createAtlasPseudoCatalog(
  source: AtlasCatalog,
  options: AtlasPseudoLocaleOptions,
): AtlasResult<AtlasCatalog> {
  if (source.role !== 'source') {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1804',
        'Pseudo-locales can be generated only from a source catalog.',
      ),
    ]);
  }
  const locale = canonicalizeAtlasLocale(options.locale);
  if (!locale.ok) return locale;
  const messages: Record<string, AtlasCatalogMessage> = Object.create(
    null,
  ) as Record<string, AtlasCatalogMessage>;
  const diagnostics = [];
  for (const [messageId, message] of Object.entries(source.messages)) {
    const transformed = pseudoMessage(
      message,
      options,
      options.customFunctions ?? [],
    );
    diagnostics.push(...transformed.diagnostics);
    if (!transformed.ok) return atlasFailure(diagnostics);
    messages[messageId] = transformed.value;
  }
  return atlasSuccess(
    Object.freeze({
      role: 'target',
      providerId: source.providerId,
      scopeId: source.scopeId,
      locale: locale.value,
      messages: Object.freeze(messages),
      families: Object.freeze({}),
    }),
    diagnostics,
  );
}

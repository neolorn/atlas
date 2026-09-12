/**
 * The locale tables Atlas carries, derived from the pinned CLDR release rather than transcribed.
 *
 * `specs/01-standards-profile.spec.md` section 2 requires every such table to come from a source
 * the lock records, and to agree with that source. `--check` is what makes the second half true: it
 * regenerates and compares, so a data release cannot be raised while the tables derived from it
 * stay where they were, and a table cannot be edited by hand into disagreeing with the release its
 * own header names.
 */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cldrRoot = resolve(workspaceRoot, 'node_modules/cldr-core');
const manifest = JSON.parse(
  await readFile(resolve(cldrRoot, 'package.json'), 'utf8'),
);
assert.equal(manifest.name, 'cldr-core');
assert.equal(manifest.version, '48.2.0');
const cldrProfile = `cldr-${manifest.version.split('.').slice(0, 2).join('.')}`;

const likelyDocument = JSON.parse(
  await readFile(resolve(cldrRoot, 'supplemental/likelySubtags.json'), 'utf8'),
);
const scriptDocument = JSON.parse(
  await readFile(resolve(cldrRoot, 'scriptMetadata.json'), 'utf8'),
);
assert.equal(likelyDocument.supplemental.version._cldrVersion, '48');

const compareCodePoint = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
const rtlScripts = Object.entries(scriptDocument.scriptMetadata)
  .filter(([, metadata]) => metadata.rtl === 'YES')
  .map(([script]) => script)
  .sort(compareCodePoint);

// The strong right-to-left character class.
//
// The property this answers is "can this text reposition the text around it". `Bidi_Class` answers
// that directly; script membership only stands in for it, and the substitution was visible in both
// directions. Two earlier derivations were measured over every code point on Unicode 17.0 before
// this one:
//
// - `Script=` over the table above loses exactly one letter, U+0640 ARABIC TATWEEL, which is
//   `Script=Common` with Arabic among its script extensions.
// - `Script_Extensions=` keeps U+0640 and gains 106 code points that reorder nothing: U+00B7 MIDDLE
//   DOT, used with Avestan; 24 combining marks including U+0303 and U+0308, used with Syriac;
//   U+204F REVERSED SEMICOLON, used with Adlam; the Aegean and Coptic Epact number signs. What
//   separates U+0640 from U+00B7 is not their script data, which has the same shape, but that one
//   is a letter, so the union of `Script=` with the letters of `Script_Extensions=` was correct,
//   and correct by a rule that has nothing to do with direction.
//
// Both missed the 126 Siyaq numerals (U+1EC71..U+1ECB4, U+1ED01..U+1ED3D). They are `Script=Common`
// and `Script_Extensions=Common`, so no script derivation can reach them, and the UCD gives them
// `Bidi_Class=AL`. Reading the property directly finds them and needs no rule about letters.
//
// The script derivation is kept below as a cross-check rather than as the source, because the two
// files are independent: CLDR says which scripts run right to left, the UCD says which characters
// do. They agree on every letter in Unicode, and an assertion that they still do is worth more than
// either one alone.
//
// Generated rather than read at runtime: the runtime would have to ship and parse a 173 KB text
// file to answer a question a character class answers, and the vendored file is a build input.
const bidiClassPath = resolve(
  workspaceRoot,
  'standards/data/DerivedBidiClass-17.0.0.txt',
);
const bidiClassSource = await readFile(bidiClassPath, 'utf8');
assert.ok(
  bidiClassSource.startsWith('# DerivedBidiClass-17.0.0.txt'),
  `${bidiClassPath} is not the pinned Unicode 17.0.0 file; standards/sources.lock.json names what belongs there.`,
);

const BIDI_RANGE =
  /^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*;\s*([A-Za-z_]+)/u;
const BIDI_MISSING =
  /^#\s*@missing:\s*([0-9A-F]{4,6})\.\.([0-9A-F]{4,6})\s*;\s*([A-Za-z_]+)/u;
const BIDI_LONG_NAMES = new Map([
  ['Right_To_Left', 'R'],
  ['Arabic_Letter', 'AL'],
  ['Left_To_Right', 'L'],
]);

// ---------------------------------------------------------------------------------------------
// READ THIS BEFORE CHANGING THE PARSE BELOW.
//
// The UCD does not put all of this file's answers on its data lines. Unassigned code points in
// blocks reserved for right-to-left scripts take `R` or `AL`, and the file says so on `@missing:`
// lines, which are comments, rather than by listing the code points. `0860..086A` is listed;
// `086B..086E`, unassigned, is not, and those four are `AL` all the same. 2,314 code points in
// this file are reachable only that way.
//
// A parser that reads only the data lines therefore produces a class that is correct for every
// character that exists today and wrong for the next one added to the Arabic block. That is the
// worst shape a generated table can have. It passes every test, ships, and stays right until some
// Unicode release years from now assigns a character in one of those blocks: at which point a
// value containing it silently stops being isolated, in a released version of Atlas, with nothing
// in the repository having changed. Nothing would connect the two events.
//
// So the defaults go down first and every explicit line overrides them, and the class includes
// unassigned code points on purpose. `no-missing-defaults` is a mutation in the verification set
// and `bidi-isolation.test.ts` asserts U+05FF (unassigned, `Right_To_Left` by default) for
// exactly this reason. The same trap is waiting in every other UCD file: `@missing:` is a
// normative part of the format (UAX #44 §4.2.10), not a comment about it.
// ---------------------------------------------------------------------------------------------
const bidiClasses = new Array(0x110000).fill('L');
const applyBidiLines = (pattern, onlyComments) => {
  let applied = 0;
  for (const line of bidiClassSource.split('\n')) {
    if (line.startsWith('#') !== onlyComments) continue;
    const match = pattern.exec(line);
    if (match === null) continue;
    applied += 1;
    const value = BIDI_LONG_NAMES.get(match[3]) ?? match[3];
    const first = Number.parseInt(match[1], 16);
    const last = match[2] === undefined ? first : Number.parseInt(match[2], 16);
    for (let code = first; code <= last; code += 1) bidiClasses[code] = value;
  }
  return applied;
};
const missingRanges = applyBidiLines(BIDI_MISSING, true);
const explicitRanges = applyBidiLines(BIDI_RANGE, false);
assert.ok(
  missingRanges > 1 && explicitRanges > 1000,
  `Parsed ${missingRanges} default ranges and ${explicitRanges} explicit ranges from ${bidiClassPath}; the file did not read as the UCD format.`,
);

const isStrongRtl = (code) =>
  bidiClasses[code] === 'R' || bidiClasses[code] === 'AL';

// The cross-check: what the script data says, which is what shipped before this file was vendored.
const scriptClass = (property) =>
  new RegExp(
    `[${rtlScripts.map((script) => String.raw`\p{${property}=${script}}`).join('')}]`,
    'u',
  );
assert.equal(
  process.versions.unicode,
  '17.0',
  'The cross-check below compares the vendored Unicode 17.0.0 file against the running ICU. Under a different Unicode version the two disagree for reasons that have nothing to do with Atlas, so this runs on the pinned toolchain or not at all.',
);
const inRtlScript = scriptClass('Script');
const usedWithRtlScript = scriptClass('Script_Extensions');
const isLetter = /\p{L}/u;

const rtlRanges = [];
const droppedByBidiClass = [];
let letterDisagreements = 0;
for (let code = 0; code <= 0x10ffff; code += 1) {
  // Surrogate code points are not characters and belong to no script; skipping them also keeps
  // `String.fromCodePoint` from producing a lone surrogate.
  if (code >= 0xd800 && code <= 0xdfff) continue;
  const character = String.fromCodePoint(code);
  const strong = isStrongRtl(code);
  if (
    isLetter.test(character) &&
    usedWithRtlScript.test(character) !== strong
  ) {
    letterDisagreements += 1;
  }
  if (
    !strong &&
    (inRtlScript.test(character) ||
      (usedWithRtlScript.test(character) && isLetter.test(character)))
  ) {
    droppedByBidiClass.push(code);
  }
  if (!strong) continue;
  const last = rtlRanges.at(-1);
  if (last !== undefined && code === last[1] + 1) {
    last[1] = code;
    continue;
  }
  rtlRanges.push([code, code]);
}

assert.ok(
  rtlRanges.length > 0,
  'No code point resolved to Bidi_Class R or AL; the derivation produced an empty class.',
);

// CLDR and the UCD are separate files maintained by separate processes. That they agree on every
// letter in Unicode is the strongest single statement available about either, and it is the reason
// the script derivation stays here after ceasing to be the source.
assert.equal(
  letterDisagreements,
  0,
  `${letterDisagreements} letters are in a CLDR right-to-left script but are not Bidi_Class R or AL, or the reverse. The two sources have diverged and the divergence has to be understood before either is trusted.`,
);

// The guard against a silent narrowing. `Bidi_Class` drops code points a script derivation covers,
// and every one of them must be a character the bidi algorithm resolves from its context rather
// than from itself: a mark, a neutral, or a number. A strong character appearing here means this
// source covers less than the script derivation does, which is the one outcome it must not have.
const CONTEXTUAL_CLASSES = new Set([
  'NSM',
  'ON',
  'AN',
  'EN',
  'ET',
  'ES',
  'CS',
  'BN',
  'WS',
  'B',
  'S',
  'L',
]);
const strongDropped = droppedByBidiClass.filter(
  (code) => !CONTEXTUAL_CLASSES.has(bidiClasses[code]),
);
assert.deepEqual(
  strongDropped.map((code) => `U+${code.toString(16).toUpperCase()}`),
  [],
  'Moving the strong right-to-left class to Bidi_Class dropped a character that is not resolved from its context. That is a narrowing, not a correction.',
);

const escapeCodePoint = (value) => `\\u{${value.toString(16).toUpperCase()}}`;
const rtlPattern = `[${rtlRanges
  .map(([start, end]) =>
    start === end
      ? escapeCodePoint(start)
      : `${escapeCodePoint(start)}-${escapeCodePoint(end)}`,
  )
  .join('')}]`;

const output = [
  '/** Generated from cldr-core 48.2.0 and Unicode 17.0.0 by tools/generate-locale-profile.mjs. */',
  "export const LOCALE_DATA_PROFILE =\n  'cldr-48.2+unicode-17.0/atlas-rtl-bidi-1' as const;",
  '',
  '/**',
  ' * Every script code written right to left, from the CLDR release named above.',
  ' *',
  " * What a locale's direction is decided by: the script, rather than the language, because a language",
  ' * written in two scripts reads in two directions.',
  ' */',
  '// prettier-ignore',
  `export const RTL_SCRIPTS = Object.freeze(${JSON.stringify(rtlScripts)} as const);`,
  '',
  '/**',
  ' * Every code point whose Unicode `Bidi_Class` is `R` or `AL`.',
  ' *',
  ' * The source of a character class rather than a compiled expression, so the runtime picks its',
  ' * own flags. Derived from the vendored UCD file that `standards/sources.lock.json` names. `Bidi_Class`',
  ' * is the property that says whether a character reorders the text around it; script membership only',
  ' * stood in for it, and missed the Siyaq numerals in both of the forms that were tried.',
  ' *',
  ' * Unassigned code points in blocks reserved for right-to-left scripts are included, because that is',
  ' * what the standard says they are: the next character added to the Arabic block is `AL` before',
  ' * anyone regenerates this file.',
  ' */',
  '// prettier-ignore',
  `export const RTL_STRONG_CHARACTERS = ${JSON.stringify(rtlPattern)} as const;`,
  '',
].join('\n');

// Plural categories, from the same pinned CLDR release as the script data. The toolkit needs these
// to tell a translator that a target locale is missing a category its grammar requires; deriving
// them from the host Intl instead would make the check vary by Node version, which is exactly what
// pinning a CLDR release is for.
//
// Both sets are emitted because MessageFormat 2's `:number`/`:integer` `select` option chooses
// between them, and they are not variations of one another: Arabic requires all six cardinal
// categories and exactly one ordinal category, while English requires two cardinal and four
// ordinal. Checking an ordinal message against the cardinal table is wrong in both directions.
const CATEGORY_ORDER = ['zero', 'one', 'two', 'few', 'many', 'other'];

function categoriesFrom(document, file, key) {
  const rules = document.supplemental[key];
  assert.ok(
    rules !== undefined && typeof rules === 'object',
    `cldr-core is missing supplemental/${file} ${key} rules.`,
  );
  return Object.fromEntries(
    Object.entries(rules)
      .map(([language, entries]) => {
        const categories = Object.keys(entries)
          .map((entry) => entry.replace('pluralRule-count-', ''))
          .filter((category) => CATEGORY_ORDER.includes(category))
          .sort(
            (left, right) =>
              CATEGORY_ORDER.indexOf(left) - CATEGORY_ORDER.indexOf(right),
          );
        return [language, categories];
      })
      .filter(([, categories]) => categories.length > 0)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

const pluralCategories = categoriesFrom(
  JSON.parse(
    await readFile(resolve(cldrRoot, 'supplemental/plurals.json'), 'utf8'),
  ),
  'plurals.json',
  'plurals-type-cardinal',
);
const ordinalCategories = categoriesFrom(
  JSON.parse(
    await readFile(resolve(cldrRoot, 'supplemental/ordinals.json'), 'utf8'),
  ),
  'ordinals.json',
  'plurals-type-ordinal',
);

const pluralOutput = [
  '/** Generated from cldr-core 48.2.0 by tools/generate-locale-profile.mjs. */',
  "export const ATLAS_PLURAL_DATA_PROFILE = 'cldr-48.2/atlas-plurals-2' as const;",
  '',
  '/**',
  ' * Cardinal plural categories each language requires, keyed by CLDR language subtag.',
  ' *',
  ' * A language absent from this table has only `other`, which is how CLDR expresses it.',
  ' */',
  '// prettier-ignore',
  `export const ATLAS_CARDINAL_PLURAL_CATEGORIES: Readonly<Record<string, readonly string[]>> = Object.freeze(${JSON.stringify(pluralCategories)});`,
  '',
  '/**',
  ' * Ordinal plural categories each language requires, keyed by CLDR language subtag.',
  ' *',
  ' * A language absent from this table has only `other`, which is how CLDR expresses it. This is a',
  ' * different table, not a variant of the cardinal one: Arabic requires all six cardinal categories',
  ' * and exactly one ordinal category, while English requires two cardinal and four ordinal.',
  ' */',
  '// prettier-ignore',
  `export const ATLAS_ORDINAL_PLURAL_CATEGORIES: Readonly<Record<string, readonly string[]>> = Object.freeze(${JSON.stringify(ordinalCategories)});`,
  '',
].join('\n');

// Encompassed languages, from the same pinned CLDR release and the vendored IANA registry.
//
// A browser that sends `no` to a site shipping `nb-NO` is answered with nothing today: step 3 of
// `negotiateLocale` compares language subtags, `no` and `nb` are different subtags, and the only
// repair available to a consumer is writing `"no": "nb-NO"` into `aliases` by hand. That is a
// standards question with a standards answer, and a consumer should not be the one answering it.
//
// Two sources, because neither answers alone. **Membership** is BCP 47 3.1.10, the `Macrolanguage`
// field, "a language that encompasses this subtag's language according to assignments made by
// ISO 639-3", whose own worked example is this case: `nb` and `nn` both declare `Macrolanguage:
// no`. It gives the set and stops there, so on its own a request for `no` picks between Bokmal and
// Nynorsk by whichever the consumer happened to declare first. **Ordering** is CLDR's language
// matching data, which is the standard's own answer to how close one locale is to another:
// `nb`/`no` is distance 1 and `nn`/`no` is distance 20, so a site shipping both answers `no` with
// Bokmal, and does so for a published reason rather than a declaration accident.
//
// **The use is deliberately narrow, and it is not an oversight.** Only the language dimension of
// that data is read, and within it only pairs that share an encompassing macrolanguage. Two things
// are being refused. The script and region dimensions: for `zh-Hant` against a supported
// `zh-Hans-CN` the script dimension alone contributes 50, which is exactly the specification's
// default threshold, so under the whole distance model the refusal would rest on how the
// dimensions combine and on where the threshold sits. Atlas decides that pair categorically today,
// by comparing maximized scripts, and with a test. And the rest of the language dimension: it
// holds 114 pairs that share no macrolanguage (`af`/`en` at 20, `be`/`ru` at 30, `da`/`no` at 8)
// which are judgments about what a reader will accept instead, not about what their language is.
// Serving Russian to a request for Belarusian is a policy, and a localization framework should not
// adopt one silently on a consumer's behalf. Widening this later is a deliberate decision with its
// own argument, not a correction of something left half-done.
const sourcesLock = JSON.parse(
  await readFile(resolve(workspaceRoot, 'standards/sources.lock.json'), 'utf8'),
);
const registrySource = sourcesLock.dataSources?.ianaLanguageSubtagRegistry;
assert.ok(
  typeof registrySource?.projectSnapshot === 'string' &&
    typeof registrySource?.fileDate === 'string',
  'standards/sources.lock.json does not pin the IANA Language Subtag Registry.',
);
const registry = await readFile(
  resolve(workspaceRoot, 'standards', registrySource.projectSnapshot),
  'utf8',
);
// The registry states its own date in its first record, so the lock's claim about which snapshot
// this is gets checked against the snapshot rather than trusted.
assert.equal(
  /^File-Date: (.+)$/mu.exec(registry)?.[1],
  registrySource.fileDate,
  'The vendored IANA registry states a different File-Date than standards/sources.lock.json pins.',
);

const matchingDocument = JSON.parse(
  await readFile(
    resolve(cldrRoot, 'supplemental/languageMatching.json'),
    'utf8',
  ),
);
assert.equal(matchingDocument.supplemental.version._cldrVersion, '48');
const languageMatch =
  matchingDocument.supplemental.languageMatching['written-new']?.languageMatch;
assert.ok(
  Array.isArray(languageMatch) && languageMatch.length > 0,
  'cldr-core is missing supplemental/languageMatching.json written-new rules.',
);

// A language subtag, and nothing wider. A rule whose either side carries a script, a region, a
// wildcard or a `$variable` belongs to a dimension this table does not read.
const LANGUAGE_SUBTAG = /^[a-z]{2,3}$/u;
const languageRules = languageMatch.filter(
  (rule) =>
    LANGUAGE_SUBTAG.test(rule._desired) &&
    LANGUAGE_SUBTAG.test(rule._supported),
);
const languageDistance = new Map();
for (const rule of languageRules) {
  const distance = Number(rule._distance);
  languageDistance.set(`${rule._desired}|${rule._supported}`, distance);
  // A rule is bidirectional unless it says otherwise, and none of the language-dimension rules in
  // this release do. Reading `_oneway` anyway means a release that adds one is honoured rather than
  // silently reversed.
  if (rule._oneway !== 'true') {
    languageDistance.set(`${rule._supported}|${rule._desired}`, distance);
  }
}

const macrolanguageOf = new Map();
for (const record of registry.split(/\r?\n%%\r?\n/u)) {
  if (/^Type: language$/mu.test(record) === false) continue;
  // A deprecated subtag carries a `Preferred-Value` that canonicalization already applies, so
  // matching it here would answer a tag nobody should still be sending, in a second way.
  if (/^Deprecated:/mu.test(record)) continue;
  const subtag = /^Subtag: (.+)$/mu.exec(record)?.[1];
  const macrolanguage = /^Macrolanguage: (.+)$/mu.exec(record)?.[1];
  if (subtag === undefined || macrolanguage === undefined) continue;
  macrolanguageOf.set(subtag, macrolanguage);
}
assert.ok(
  macrolanguageOf.size > 0,
  'No Macrolanguage relations were read from the vendored IANA registry; the record format changed.',
);

// Two subtags belong together when one encompasses the other, or when both are encompassed by the
// same macrolanguage. `nn`/`nb` is the second shape and CLDR ranks it; `arz`/`ary` is the second
// shape and CLDR does not, so it is not in the table.
const sameGroup = (left, right) =>
  macrolanguageOf.get(left) === right ||
  macrolanguageOf.get(right) === left ||
  (macrolanguageOf.has(left) &&
    macrolanguageOf.get(left) === macrolanguageOf.get(right));

// UTS #35 Part 1, Language Matching: "the default threshold distance is 50", read from the tr35-73
// snapshot because the current tr35.html truncates before that section. Nothing here rests on the
// exact number: the assertions below establish that every encompassed pair CLDR ranks is far under
// it and every pair it does not rank is far over, so any threshold between them yields this table.
const DEFAULT_THRESHOLD = 50;
const unrelatedDistance = languageMatch.find(
  (rule) => rule._desired === '*' && rule._supported === '*',
);
assert.ok(
  unrelatedDistance !== undefined &&
    Number(unrelatedDistance._distance) > DEFAULT_THRESHOLD,
  'CLDR no longer places two unrelated languages beyond the default matching threshold.',
);

const encompassed = {};
let encompassedPairs = 0;
let widestKept = 0;
for (const [key, distance] of [...languageDistance].sort(([left], [right]) =>
  left < right ? -1 : left > right ? 1 : 0,
)) {
  const [desired, supported] = key.split('|');
  if (!sameGroup(desired, supported)) continue;
  assert.ok(
    distance < DEFAULT_THRESHOLD,
    `CLDR now rates ${desired} and ${supported} at ${distance}, at or beyond the default matching threshold, though one encompasses the other. Whether Atlas should still treat them as the same language is a decision, not a regeneration.`,
  );
  widestKept = Math.max(widestKept, distance);
  encompassed[desired] ??= {};
  encompassed[desired][supported] = distance;
  encompassedPairs += 1;
}
assert.ok(
  encompassedPairs > 0,
  'The encompassed-language table came out empty; one of its two sources changed shape.',
);

const encompassedOutput = [
  `/** Generated from cldr-core ${manifest.version} and the IANA registry of ${registrySource.fileDate} by tools/generate-locale-profile.mjs. */`,
  // Built rather than written out: this string exists to change when the data under it changes,
  // and a literal is a thing somebody has to remember to edit.
  `export const ATLAS_ENCOMPASSED_LANGUAGE_PROFILE =\n  '${cldrProfile}+iana-${registrySource.fileDate}/atlas-encompassed-1' as const;`,
  '',
  '/**',
  ' * How far apart two language subtags are, for subtags that are the same language written twice.',
  ' *',
  ' * Keyed by the requested language subtag, then by the supported one, in CLDR distances where a',
  ' * smaller number is a closer match. A pair is present only when the IANA registry says one subtag',
  ' * encompasses the other or that both are encompassed by one macrolanguage, BCP 47 3.1.10, and',
  ' * CLDR ranks the pair at the language dimension. Absent means Atlas has nothing to say about the',
  ' * pair, not that the two are unrelated.',
  ' *',
  ' * This is not the whole of CLDR language matching and is not meant to become it. The dimensions it',
  ' * leaves out are the ones Atlas already decides categorically, and the language-dimension pairs it',
  " * leaves out are CLDR's judgments about what a reader will accept instead of their own language,",
  ' * which is a policy rather than an identity.',
  ' */',
  '// prettier-ignore',
  `export const ENCOMPASSED_LANGUAGE_DISTANCES: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze(${JSON.stringify(encompassed)});`,
  '',
].join('\n');

// ---------------------------------------------------------------------------------------------
// Endonyms: the name each locale has for itself, decided here rather than by the visitor's engine.
//
// `selfName` on a locale choice is decided here rather than by
// `new Intl.DisplayNames([locale], { type: 'language' })` read in the browser, which is the
// engine's own CLDR snapshot. Over sixteen locales on the four engines Atlas gates on, three of
// sixteen disagree in two distinct ways: WebKit 26.5
// title-cases the language name (`Portugues (Brasil)`, `Espanol latinoamericano`) where CLDR's own
// casing is lowercase, and Chromium 149 does not translate the `valencia` variant subtag and prints
// `catala (Espanya, VALENCIA)`. A name no reader of any language has seen. The sharper half is
// not the browsers disagreeing with each other: Atlas server-renders the switcher on Node, so a
// WebKit visitor was sent one label and recomputed a different one on hydration.
//
// So the name is derived here from a pinned release and shipped, and the engine no longer votes.
//
// THE ALGORITHM IS TR35'S, AND THE RULE THAT MATTERS IS THE SECOND LINE OF IT: look the whole
// locale id up in `languages`, and if it is not there, take the name of the *bare language subtag*
// and put every remaining subtag in the qualifier list. Not the longest matching prefix. Writing
// the ladder the other way (lang-script-region, then lang-region, then lang-script, then lang)
// is the obvious reading and it is wrong, and the measurement says so rather than the spec: over
// the 910 locales ICU has real data for, the ladder disagreed with ICU on 14 and this rule
// disagrees on 3. `zh-Hans-CN` is the clearest case. The ladder finds `zh-Hans` and produces
// "简体中文（中国）"; every engine in the world renders "中文（简体，中国）", which is what the
// bare-language rule produces.
//
// The three that remain are all one thing, CLDR ships a display-names bundle that ICU does not,
// and in each the pinned answer is CLDR's own:
//
//   - `el-polyton`: the `el-polyton` bundle spells Greek polytonically, "Ἑλληνικά". ICU has no such
//     bundle and answers "Ελληνικά" out of `el`.
//   - `zh-Latn` and `zh-Latn-CN`: the `zh-Latn` bundle's `localeDisplayPattern` uses ASCII
//     parentheses, which is right for a Latin-script rendering. ICU falls back to `zh`'s fullwidth
//     ones.
//
// The cross-check compares only where ICU has data for the locale: `Intl.DisplayNames` answers
// every request, so an unfiltered comparison reports 144 differences of which 141 are ICU replying
// in English about a locale it never shipped. `resolvedOptions().locale` says which locale ICU
// actually answered from, and a locale outside the requested one's inheritance chain is not a
// disagreement about a name: it is ICU not having one.
const localeNamesRoot = resolve(
  workspaceRoot,
  'node_modules/cldr-localenames-full',
);
const localeNamesManifest = JSON.parse(
  await readFile(resolve(localeNamesRoot, 'package.json'), 'utf8'),
);
assert.equal(localeNamesManifest.name, 'cldr-localenames-full');
assert.equal(localeNamesManifest.version, manifest.version);

const displayNamesBundles = new Set(
  (await readdir(resolve(localeNamesRoot, 'main'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);
const availableLocales = JSON.parse(
  await readFile(resolve(cldrRoot, 'availableLocales.json'), 'utf8'),
).availableLocales.full;
const defaultContentLocales = JSON.parse(
  await readFile(resolve(cldrRoot, 'defaultContent.json'), 'utf8'),
).defaultContent;
const parentLocales = JSON.parse(
  await readFile(resolve(cldrRoot, 'supplemental/parentLocales.json'), 'utf8'),
).supplemental.parentLocales.parentLocale;

const orderedParentLocales = Object.fromEntries(
  Object.entries(parentLocales).sort(([left], [right]) =>
    compareCodePoint(left, right),
  ),
);
const undParents = Object.values(parentLocales).filter(
  (parent) => parent === 'und',
).length;

// Atlas's two pseudo-locales are named here for the same reason every other locale is: they appear
// in a switcher during development, and CLDR does have names for XA and XB.
const ATLAS_PSEUDO_LOCALES = ['en-Latn-XA', 'en-Arab-XB'];

const endonymUniverse = [
  ...new Set([
    ...availableLocales,
    ...defaultContentLocales,
    ...ATLAS_PSEUDO_LOCALES,
  ]),
].sort(compareCodePoint);

// CLDR inheritance, which is not truncation: `en-CC`'s parent is `en-001`, not `en`.
const inheritanceChain = (locale) => {
  const chain = [];
  let current = locale;
  while (current !== undefined && current !== 'root') {
    chain.push(current);
    const declared = parentLocales[current];
    if (declared !== undefined) {
      current = declared;
      continue;
    }
    const parts = current.split('-');
    parts.pop();
    current = parts.length > 0 ? parts.join('-') : undefined;
  }
  return chain;
};

const displayNamesCache = new Map();
const readDisplayNames = async (bundle) => {
  const cached = displayNamesCache.get(bundle);
  if (cached !== undefined) return cached;
  const read = async (file, key) => {
    try {
      const document = JSON.parse(
        await readFile(resolve(localeNamesRoot, 'main', bundle, file), 'utf8'),
      );
      return document.main[bundle].localeDisplayNames[key];
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const data = {
    languages: await read('languages.json', 'languages'),
    scripts: await read('scripts.json', 'scripts'),
    territories: await read('territories.json', 'territories'),
    variants: await read('variants.json', 'variants'),
    patterns: await read('localeDisplayNames.json', 'localeDisplayPattern'),
  };
  displayNamesCache.set(bundle, data);
  return data;
};

const resolveDisplayNames = async (locale) => {
  const merged = {
    languages: {},
    scripts: {},
    territories: {},
    variants: {},
    patterns: undefined,
  };
  for (const bundle of inheritanceChain(locale).reverse()) {
    if (!displayNamesBundles.has(bundle)) continue;
    const data = await readDisplayNames(bundle);
    Object.assign(merged.languages, data.languages ?? {});
    Object.assign(merged.scripts, data.scripts ?? {});
    Object.assign(merged.territories, data.territories ?? {});
    Object.assign(merged.variants, data.variants ?? {});
    if (data.patterns !== undefined) merged.patterns = data.patterns;
  }
  return merged;
};

const SUBTAG_SCRIPT = /^[A-Z][a-z]{3}$/u;
const SUBTAG_REGION = /^(?:[A-Z]{2}|\d{3})$/u;

const splitLocale = (locale) => {
  const parts = locale.split('-');
  const language = parts.shift();
  const script =
    parts[0] !== undefined && SUBTAG_SCRIPT.test(parts[0])
      ? parts.shift()
      : undefined;
  const region =
    parts[0] !== undefined && SUBTAG_REGION.test(parts[0])
      ? parts.shift()
      : undefined;
  return { language, script, region, variants: parts };
};

// TR35: a name going into a pattern that already carries parentheses takes brackets instead, so
// "English (Cocos (Keeling) Islands)" is written "English (Cocos [Keeling] Islands)".
const bracketed = (value) => value.replaceAll('(', '[').replaceAll(')', ']');

const deriveEndonym = (locale, data) => {
  const whole = data.languages[locale];
  if (whole !== undefined) return whole;

  const { language, script, region, variants } = splitLocale(locale);
  const base = data.languages[language];
  if (base === undefined) return undefined;

  const qualifiers = [];
  if (script !== undefined) qualifiers.push(data.scripts[script] ?? script);
  if (region !== undefined) qualifiers.push(data.territories[region] ?? region);
  for (const variant of variants) {
    const key = variant.toUpperCase();
    qualifiers.push(data.variants[key] ?? key);
  }
  if (qualifiers.length === 0) return base;

  const separator = data.patterns?.localeSeparator ?? '{0}, {1}';
  let joined = bracketed(qualifiers[0]);
  for (const qualifier of qualifiers.slice(1)) {
    joined = separator
      .replace('{0}', joined)
      .replace('{1}', bracketed(qualifier));
  }
  return (data.patterns?.localePattern ?? '{0} ({1})')
    .replace('{0}', base)
    .replace('{1}', joined);
};

const endonyms = {};
const endonymsWithoutName = [];
const endonymsComparedToIcu = [];
const endonymsDisagreeingWithIcu = [];

for (const locale of endonymUniverse) {
  const derived = deriveEndonym(locale, await resolveDisplayNames(locale));
  if (derived === undefined) {
    endonymsWithoutName.push(locale);
    continue;
  }
  endonyms[locale] = derived;

  let icu;
  let answeredFrom;
  try {
    const display = new Intl.DisplayNames([locale], {
      type: 'language',
      localeMatcher: 'lookup',
    });
    answeredFrom = display.resolvedOptions().locale;
    icu = display.of(locale);
  } catch {
    continue;
  }
  if (!inheritanceChain(locale).includes(answeredFrom)) continue;
  endonymsComparedToIcu.push(locale);
  if (icu !== derived)
    endonymsDisagreeingWithIcu.push(`${locale} (${derived} / ${icu})`);
}

// The cross-check has to be shown to work before its agreement means anything: a filter that
// excluded every locale would report perfect agreement over nothing.
assert.ok(
  endonymsComparedToIcu.length > 800,
  `The ICU cross-check compared only ${endonymsComparedToIcu.length} locales; it is meant to compare every locale ICU has display names for.`,
);
assert.deepEqual(
  endonymsDisagreeingWithIcu,
  [
    'el-polyton (Ἑλληνικά (Πολυτονικό) / Ελληνικά (Πολυτονικό))',
    'zh-Latn (中文 (拉丁文) / 中文（拉丁文）)',
    'zh-Latn-CN (中文 (拉丁文, 中国) / 中文（拉丁文，中国）)',
  ],
  'The derivation disagrees with ICU somewhere new. The three known differences are all CLDR shipping a display-names bundle ICU does not; a fourth is a defect in the derivation until it is shown to be one of those.',
);
assert.equal(endonyms['pt-BR'], 'português (Brasil)');
assert.equal(endonyms['es-419'], 'español latinoamericano');
assert.equal(endonyms['ca-ES-valencia'], 'català (Espanya, valencià)');

const endonymOutput = [
  `/** Generated from cldr-localenames-full ${localeNamesManifest.version} by tools/generate-locale-profile.mjs. */`,
  `export const ATLAS_ENDONYM_PROFILE = 'cldr-${cldrProfile.slice('cldr-'.length)}/atlas-endonyms-1' as const;`,
  '',
  '/**',
  ' * The name each locale has for itself, in itself, keyed by CLDR locale identifier.',
  ' *',
  ' * Derived by TR35 locale display name from the same CLDR release the rest of the profile comes',
  ' * from, so a switcher renders one label for a locale on every engine and on both sides of',
  " * hydration. The engine's own answer is not wrong, it is merely the engine's: measured over the",
  ' * four engines Atlas gates on, three of sixteen locales disagreed, and a server-rendered label',
  ' * that changes on hydration is a defect no consumer can fix.',
  ' *',
  ' * A locale absent from this table is one CLDR has no name for. There are',
  ` * ${endonymsWithoutName.length} of them and \`aa\` is one; the caller falls back rather than inventing a name.`,
  ' *',
  ' * This lives in the toolkit and not in the runtime on purpose. It is a build input: the generated',
  ' * configuration carries one string per configured locale, so an application shipping three',
  ' * locales sends three names to the browser rather than a table of every locale CLDR names.',
  ' */',
  '// prettier-ignore',
  `export const ATLAS_LOCALE_ENDONYMS: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(endonyms)});`,
  '',
].join('\n');

// Every tag in the table canonicalizes to itself, so a key here matches what
// `canonicalizeAtlasLocale` produces from a project's own configuration. A release that changed
// that would silently stop matching, and the chain would quietly become truncation again.
const nonCanonicalParentTags = [
  ...new Set(Object.entries(parentLocales).flat()),
].filter((tag) => {
  try {
    const canonical = Intl.getCanonicalLocales(tag);
    return canonical.length !== 1 || canonical[0] !== tag;
  } catch {
    return true;
  }
});
assert.deepEqual(
  nonCanonicalParentTags,
  [],
  'A CLDR parent-locale tag is not its own canonical form, so the toolkit would look it up under a name this table does not carry.',
);

const parentLocaleOutput = [
  `/** Generated from cldr-core ${manifest.version} by tools/generate-locale-profile.mjs. */`,
  // Wrapped as prettier wraps it: the name and the value together pass the print width, and a
  // generated file that the formatter would rewrite fails the gate on a difference nobody made.
  'export const ATLAS_PARENT_LOCALE_PROFILE =',
  `  '${cldrProfile}/atlas-parent-locales-1' as const;`,
  '',
  '/**',
  ' * The parent CLDR declares for a locale, where that parent is not the tag with its last subtag',
  ' * removed.',
  ' *',
  ' * Inheritance in UTS 35 section 4.1.3 is not truncation. A locale takes the parent this table',
  ' * names; a locale absent from it takes the tag with its last subtag removed; a locale with one',
  ' * subtag left has no parent. So `en-AU` inherits from `en-001` rather than from `en` directly,',
  ' * and `de-CH` inherits from `de` because nothing here says otherwise.',
  ' *',
  ' * `und` is a value here rather than an absence, and it means the locale has no parent below',
  ' * root. `parentLocales.json` carries `_localeRules`',
  ' * `{"parentLocale":{"nonlikelyScript":"root"}}`: a locale written in a script its language does',
  ` * not usually take inherits from root, and ${undParents} entries say \`und\` for that reason. Dropping`,
  ' * them would put truncation back in force and send `az-Arab` to `az`, which is the Latin-script',
  ' * locale it was separated from, so they are kept and a reader stops when it reaches one.',
  ' *',
  ' * Four parents change the language: `hi-Latn` takes `en-IN`, `ht` takes `fr-HT`, and `nb` and',
  ' * `nn` take `no`. That is CLDR data rather than a choice Atlas made, and a project that',
  ' * disagrees says so under `parentLocales` in its own configuration.',
  ' *',
  ' * This lives in the toolkit and not in the runtime for the reason the endonyms do: it is a build',
  ' * input. The generated configuration carries the resolved chain for each configured locale, so',
  ' * an application shipping three locales sends three short lists to the browser rather than a',
  ' * table of every parent CLDR declares.',
  ' */',
  '// prettier-ignore',
  `export const ATLAS_PARENT_LOCALES: Readonly<Record<string, string>> = Object.freeze(${JSON.stringify(orderedParentLocales)});`,
  '',
].join('\n');

const encompassedOutputPath = resolve(
  workspaceRoot,
  'packages/runtime/src/encompassed-languages.generated.ts',
);

const pluralOutputPath = resolve(
  workspaceRoot,
  'packages/toolkit/src/plural-categories.generated.ts',
);

const endonymOutputPath = resolve(
  workspaceRoot,
  'packages/toolkit/src/endonyms.generated.ts',
);

const parentLocaleOutputPath = resolve(
  workspaceRoot,
  'packages/toolkit/src/parent-locales.generated.ts',
);

const outputPath = resolve(
  workspaceRoot,
  'packages/runtime/core/src/locale-profile.generated.ts',
);
if (process.argv.includes('--check')) {
  assert.equal(
    await readFile(outputPath, 'utf8'),
    output,
    'The checked-in Atlas locale profile is stale; run pnpm run generate:locale-profile.',
  );
  assert.equal(
    await readFile(pluralOutputPath, 'utf8'),
    pluralOutput,
    'The checked-in Atlas plural-category table is stale; run pnpm run generate:locale-profile.',
  );
  assert.equal(
    await readFile(encompassedOutputPath, 'utf8'),
    encompassedOutput,
    'The checked-in Atlas encompassed-language table is stale; run pnpm run generate:locale-profile.',
  );
  assert.equal(
    await readFile(endonymOutputPath, 'utf8'),
    endonymOutput,
    'The checked-in Atlas endonym table is stale; run pnpm run generate:locale-profile.',
  );
  assert.equal(
    await readFile(parentLocaleOutputPath, 'utf8'),
    parentLocaleOutput,
    'The checked-in Atlas parent-locale table is stale; run pnpm run generate:locale-profile.',
  );
  console.log(
    `Verified ${rtlScripts.length} RTL scripts, ${rtlRanges.length} strong right-to-left code point ranges derived from Unicode 17.0.0 Bidi_Class, agreeing with the CLDR script data on every letter in Unicode and dropping ${droppedByBidiClass.length} context-resolved code points and no strong one, and cardinal plural categories for ${Object.keys(pluralCategories).length} languages and ordinal plural categories for ${Object.keys(ordinalCategories).length} languages from cldr-core 48.2.0, and ${encompassedPairs} encompassed-language pairs over ${Object.keys(encompassed).length} language subtags, every one ranked by CLDR at ${widestKept} or closer where two languages it does not relate stand at ${unrelatedDistance._distance} and its default matching threshold is ${DEFAULT_THRESHOLD}; likely-script resolution remains native Intl under the tested platform matrix; and ${Object.keys(endonyms).length} endonyms from cldr-localenames-full ${localeNamesManifest.version}, agreeing with this platform's ICU on ${endonymsComparedToIcu.length - endonymsDisagreeingWithIcu.length} of the ${endonymsComparedToIcu.length} locales it has display names for; and ${Object.keys(orderedParentLocales).length} declared parent locales from cldr-core ${manifest.version}, ${undParents} of which name root.`,
  );
} else {
  let current;
  try {
    current = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current !== output) await writeFile(outputPath, output, 'utf8');

  let currentPlural;
  try {
    currentPlural = await readFile(pluralOutputPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (currentPlural !== pluralOutput) {
    await writeFile(pluralOutputPath, pluralOutput, 'utf8');
  }

  let currentEncompassed;
  try {
    currentEncompassed = await readFile(encompassedOutputPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (currentEncompassed !== encompassedOutput) {
    await writeFile(encompassedOutputPath, encompassedOutput, 'utf8');
  }

  let currentEndonyms;
  try {
    currentEndonyms = await readFile(endonymOutputPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (currentEndonyms !== endonymOutput) {
    await writeFile(endonymOutputPath, endonymOutput, 'utf8');
  }

  let currentParentLocales;
  try {
    currentParentLocales = await readFile(parentLocaleOutputPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (currentParentLocales !== parentLocaleOutput) {
    await writeFile(parentLocaleOutputPath, parentLocaleOutput, 'utf8');
  }
}

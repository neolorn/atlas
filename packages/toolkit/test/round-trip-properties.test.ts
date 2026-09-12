import { describe, expect, it } from 'vitest';

import {
  formatAtlasCatalog,
  parseAtlasCatalog,
  parseAtlasConfiguration,
  type AtlasCatalogParseOptions,
} from '../src/index.js';
import { formatAtlasCatalogSource } from '../src/catalog.js';
import { formatAtlasConfiguration } from '../src/configuration.js';
import { canonicalizeAtlasLocale } from '../src/locales.js';
import { parseAtlasMessage } from '../src/message-format.js';

/**
 * Round-trip, idempotence and differential properties over generated input.
 *
 * These exist because of `atlas format`. Building a plain object from the semantic model and
 * stringifying it drops every comment, because comments are not in that model, so a command whose
 * name promises presentation changes deletes them all from a consumer's catalogs: twelve across
 * four files on one real catalog set, two of them load-bearing. `lossless-format.test.ts` pins that
 * exact defect with a hand-written case. What it cannot pin is the shape of the defect, which is a
 * text-to-text transform silently discarding input it cannot reproduce. That is a property, and a
 * property is checked over inputs nobody chose.
 *
 * **Generated, not random bytes, and the distinction is the whole design.** Random bytes reach a
 * parser's front door and stop: they are rejected, the reject path is already the best-covered path
 * in the toolkit (`untrusted-input.test.ts`, and thirty-four enforced ceilings in
 * `ATLAS_RESOURCE_LIMITS`), and nothing past the door is ever exercised. Every generator here emits
 * input that is *valid*, because the properties worth checking are the ones that only apply once
 * parsing has succeeded.
 *
 * **Seeded, and the seed is a constant in this file.** A failing property that cannot be reproduced
 * is a rumour. Every run of every machine draws the same inputs in the same order; changing the seed
 * is an edit with a diff, not a coin toss on CI.
 *
 * **No shrinking, deliberately.** Shrinking is what a property library is really for, and writing
 * one is a project. The generators here are small enough that a failing case is legible as it
 * stands, a catalog of at most eight messages, and the assertion prints it. If a failure ever
 * arrives that is not legible, that is the argument for the dependency, and it should be made then.
 *
 * **What is deliberately not here.** Grammar-directed generation of MessageFormat 2 bodies against
 * the pinned 48.2 profile. Writing a generator that emits arbitrary valid MF2 is comparable in size
 * to writing a second parser, and a second parser is a thing that can disagree with the first for
 * reasons that are its own fault. Message bodies are treated here as opaque text that must survive
 * transport, which is the property the format path can actually break.
 *
 * `specs/12-verification.spec.md` section 3 asks for a release to name the checks it does not
 * run, and for generated valid input checked against a property rather than random bytes:
 * bytes are refused at a parser's front door and never reach a transform behind it. The
 * generators here are seeded from a constant in this file, so a failure is reproducible.
 */

/**
 * xorshift32. Chosen because it is four lines, has no state anyone has to reason about, and its
 * quality as a random number generator is irrelevant here: what is wanted is a reproducible walk
 * through an input space, not statistical uniformity.
 */
function createRandom(seed: number) {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    next(): number {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x1_0000_0000;
    },
    integer(maximumExclusive: number): number {
      return Math.floor(this.next() * maximumExclusive);
    },
    pick<T>(values: readonly T[]): T {
      return values[this.integer(values.length)] as T;
    },
    chance(probability: number): boolean {
      return this.next() < probability;
    },
  };
}

/** One constant, so every run draws the same inputs. */
const SEED = 0x0a71a5;

/** Enough to walk the space; small enough that `test:toolkit` stays a routine-tier command. */
const CASES = 200;

const OPTIONS: AtlasCatalogParseOptions = Object.freeze({
  role: 'source',
  providerId: 'atlas-properties',
  scopeId: 'shell',
  locale: 'en-US',
});

/**
 * Text that must survive transport unchanged. Every entry is a real hazard for a YAML writer rather
 * than a random string: quotes it has to escape, a leading character that changes the node type, a
 * colon that looks like a mapping, an RTL run, a combining mark, an astral pair, and MessageFormat
 * syntax that must not be interpreted on the way through.
 */
const BODY_FRAGMENTS: readonly string[] = Object.freeze([
  'Save',
  'Welcome, {$name}!',
  'Read the {#strong}guide{/strong}.',
  "It's a quote",
  'He said "stop"',
  '  leading and trailing  ',
  '- looks like a sequence',
  'key: looks like a mapping',
  '#not a comment',
  '@reserved',
  '`backtick`',
  'multi\nline',
  'tab\there',
  'مرحبا بالعالم',
  'e\u0301 combining',
  '𝄞 astral',
  '{$count :number} items',
  'null',
  'true',
  '0755',
  '1.0',
]);

/**
 * Rejected by the catalog schema, and kept out of the generator for that reason rather than
 * quietly. Recorded here because a generator that silently stopped producing a shape is how a
 * property test turns into a test of its own generator.
 */
const REJECTED_BODY = '';

const ID_WORDS: readonly string[] = Object.freeze([
  'app',
  'title',
  'welcome',
  'route',
  'home',
  'issue',
  'required',
  'notification',
  'saved',
  'control',
  'retry',
]);

/**
 * A message id the catalog schema accepts:
 * `^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*(?:\.[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*)*$`. Every hyphen and
 * dot segment must start with a letter, which is why uniqueness below is spelled with letters
 * rather than an index.
 */
function messageId(random: ReturnType<typeof createRandom>): string {
  const segments = 1 + random.integer(3);
  return Array.from({ length: segments }, () => random.pick(ID_WORDS)).join(
    random.chance(0.5) ? '.' : '-',
  );
}

/** `-a`, `-b`, ... `-aa`: a suffix the id pattern accepts, unlike `-1`. */
function uniqueSuffix(index: number): string {
  let value = index + 1;
  let suffix = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    suffix = String.fromCharCode(97 + remainder) + suffix;
    value = Math.floor((value - 1) / 26);
  }
  return `-${suffix}`;
}

/** A YAML scalar for `body`, quoted the way an author would have written it. */
function scalar(body: string, random: ReturnType<typeof createRandom>): string {
  if (body.includes('\n')) {
    const indented = body
      .split('\n')
      .map((line) => `      ${line}`)
      .join('\n');
    return `|-\n${indented}`;
  }
  return random.chance(0.5)
    ? `'${body.split("'").join("''")}'`
    : JSON.stringify(body);
}

interface GeneratedCatalog {
  readonly source: string;
  readonly comments: readonly string[];
}

/**
 * An Atlas catalog as an author would have written one, comments included.
 *
 * Comments are the point. They exist only in the file, never in the semantic model, so any
 * transform that goes through the model loses them, which is exactly what happened.
 */
function generateCatalog(
  random: ReturnType<typeof createRandom>,
): GeneratedCatalog {
  const comments: string[] = [];
  const lines: string[] = [];

  if (random.chance(0.6)) {
    const comment = `# ${random.pick(['Owned by the shell team.', 'Do not translate the product name.', 'This English entry is deliberately Arabic.', 'Kept for the legacy route.'])}`;
    comments.push(comment);
    lines.push(comment);
  }

  lines.push('messages:');
  const used = new Set<string>();
  const count = 1 + random.integer(8);
  for (let index = 0; index < count; index += 1) {
    let id = messageId(random);
    let attempt = 0;
    const base = id;
    while (used.has(id)) {
      id = `${base}${uniqueSuffix(attempt)}`;
      attempt += 1;
    }
    used.add(id);

    if (random.chance(0.35)) {
      const comment = `  # note on ${id}`;
      comments.push(comment.trim());
      lines.push(comment);
    }

    const body = random.pick(BODY_FRAGMENTS);
    if (random.chance(0.7)) {
      lines.push(`  ${id}: ${scalar(body, random)}`);
    } else {
      lines.push(`  ${id}:`);
      lines.push(`    message: ${scalar(body, random)}`);
    }
  }

  return { source: `${lines.join('\n')}\n`, comments };
}

describe('formatting a catalog source is lossless and idempotent', () => {
  it('never discards a comment, whatever the catalog looks like', () => {
    const random = createRandom(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const { source, comments } = generateCatalog(random);
      const parsed = parseAtlasCatalog(source, OPTIONS);
      // A generator that stopped producing valid catalogs would make every property below pass
      // vacuously, so the generated input is asserted to be input.
      expect(parsed.ok, source).toBe(true);

      const formatted = formatAtlasCatalogSource(source, OPTIONS);
      expect(formatted.ok, source).toBe(true);
      if (!formatted.ok) continue;

      // The defect, as a property: a tool never destroys input it cannot reproduce.
      for (const comment of comments) {
        expect(formatted.value, source).toContain(comment.trim());
      }
    }
  });

  it('reaches a fixed point, so formatting twice says what formatting once said', () => {
    const random = createRandom(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const { source } = generateCatalog(random);
      const once = formatAtlasCatalogSource(source, OPTIONS);
      expect(once.ok, source).toBe(true);
      if (!once.ok) continue;

      const twice = formatAtlasCatalogSource(once.value, OPTIONS);
      expect(twice.ok, once.value).toBe(true);
      if (!twice.ok) continue;

      // Without this, `atlas format` in a pre-commit hook can loop, and a `check --fix` can report
      // work remaining on a file it just wrote.
      expect(twice.value, source).toBe(once.value);
    }
  });

  it('changes presentation and never meaning', () => {
    const random = createRandom(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const { source } = generateCatalog(random);
      const before = parseAtlasCatalog(source, OPTIONS);
      const formatted = formatAtlasCatalogSource(source, OPTIONS);
      expect(formatted.ok, source).toBe(true);
      if (!formatted.ok || !before.ok) continue;

      const after = parseAtlasCatalog(formatted.value, OPTIONS);
      expect(after.ok, formatted.value).toBe(true);
      if (!after.ok) continue;

      // Every hazard in BODY_FRAGMENTS is a way a YAML writer can change what a scalar means while
      // leaving it looking similar: a quote style that stops escaping, a leading `-` that becomes a
      // sequence, `0755` that becomes a number.
      expect(after.value.messages, source).toEqual(before.value.messages);
      expect(after.value.families, source).toEqual(before.value.families);
    }
  });
});

describe('a catalog survives the model round trip', () => {
  it('parses back to the model it was written from', () => {
    const random = createRandom(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const { source } = generateCatalog(random);
      const parsed = parseAtlasCatalog(source, OPTIONS);
      expect(parsed.ok, source).toBe(true);
      if (!parsed.ok) continue;

      const written = formatAtlasCatalog(parsed.value);
      const reparsed = parseAtlasCatalog(written, OPTIONS);
      expect(reparsed.ok, written).toBe(true);
      if (!reparsed.ok) continue;

      // `formatAtlasCatalog` goes through the semantic model by design, it is how Atlas writes a
      // catalog it composed rather than one an author wrote, so comments are legitimately absent
      // here. What must not be absent is anything the model holds.
      expect(reparsed.value.messages, written).toEqual(parsed.value.messages);
      expect(reparsed.value.families, written).toEqual(parsed.value.families);
    }
  });
});

describe('locale canonicalization is a fixed point and agrees with the platform', () => {
  const LANGUAGES = Object.freeze([
    'en',
    'ar',
    'de',
    'pt',
    'zh',
    'sr',
    'fil',
    'EN',
    'Ar',
    'ZH',
  ]);
  const SCRIPTS = Object.freeze([
    'Latn',
    'Arab',
    'Hans',
    'Hant',
    'cyrl',
    'LATN',
  ]);
  const REGIONS = Object.freeze([
    'US',
    'EG',
    'BR',
    'CN',
    'RS',
    '419',
    'us',
    'eg',
  ]);

  function generateTag(random: ReturnType<typeof createRandom>): string {
    const parts = [random.pick(LANGUAGES)];
    if (random.chance(0.45)) parts.push(random.pick(SCRIPTS));
    if (random.chance(0.7)) parts.push(random.pick(REGIONS));
    return parts.join('-');
  }

  it('canonicalizes to a fixed point', () => {
    const random = createRandom(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const tag = generateTag(random);
      const once = canonicalizeAtlasLocale(tag);
      expect(once.ok, tag).toBe(true);
      if (!once.ok) continue;

      const twice = canonicalizeAtlasLocale(once.value);
      expect(twice.ok, once.value).toBe(true);
      if (!twice.ok) continue;

      // Casing, script capitalisation and region capitalisation are all normalised on the first
      // pass. A second pass that moved anything would mean two catalogs for one locale.
      expect(twice.value, tag).toBe(once.value);
    }
  });

  it('produces a tag the platform also considers canonical', () => {
    const random = createRandom(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const tag = generateTag(random);
      const result = canonicalizeAtlasLocale(tag);
      if (!result.ok) continue;

      // A differential rather than a pinned string, and against a *different* ECMA-402 entry point
      // than the one Atlas calls: `canonicalizeAtlasLocale` goes through
      // `Intl.getCanonicalLocales`, and this checks the answer against `Intl.Locale`, which is a
      // separate algorithm over the same standard. Pinning `en-US` here would pin one ICU edition
      // and turn every platform bump into a failure nobody could tell from a regression.
      expect(new Intl.Locale(result.value).toString(), tag).toBe(result.value);
    }
  });

  it('refuses every tag that carries an extension, however it is spelled', () => {
    const random = createRandom(SEED);
    const singletons = ['u-ca-islamic', 't-en', 'x-private', 'a-value'];
    for (let index = 0; index < CASES; index += 1) {
      const tag = `${generateTag(random)}-${random.pick(singletons)}`;
      // A catalog locale that carried `-u-ca-islamic` would be a second catalog for a locale whose
      // identity is the same, differing only in a preference the runtime resolves separately.
      expect(canonicalizeAtlasLocale(tag).ok, tag).toBe(false);
    }
  });

  it('refuses an underscore, whitespace, and anything that is not text', () => {
    const random = createRandom(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const tag = generateTag(random);
      // Only when there is a separator to replace. `de` has none, and asserting that `de` is
      // refused would assert the opposite of what this file is for.
      if (tag.includes('-')) {
        expect(canonicalizeAtlasLocale(tag.split('-').join('_')).ok, tag).toBe(
          false,
        );
      }
      expect(canonicalizeAtlasLocale(` ${tag}`).ok, tag).toBe(false);
      expect(canonicalizeAtlasLocale(`${tag} `).ok, tag).toBe(false);
    }
    for (const value of [42, undefined, null, true, [], {}]) {
      expect(canonicalizeAtlasLocale(value).ok).toBe(false);
    }
  });
});

describe('the generators produce input, and the shapes they exclude are excluded for a reason', () => {
  it('refuses an empty message body', () => {
    const source = `messages:\n  app-title: ${JSON.stringify(REJECTED_BODY)}\n`;
    // A message that says nothing is not a message, and a catalog carrying one would generate a
    // handle whose rendering is the empty string in every locale: a missing translation that
    // looks like a deliberate one.
    expect(parseAtlasCatalog(source, OPTIONS).ok).toBe(false);
  });

  it('refuses a message id whose segment starts with a digit', () => {
    // Found by the generator rather than written from the schema: a de-duplicating suffix of `-5`
    // produced `title-5`, which the id pattern refuses because every segment must start with a
    // letter. Pinned so the pattern cannot loosen without someone saying so.
    expect(parseAtlasCatalog(`messages:\n  title-5: 'x'\n`, OPTIONS).ok).toBe(
      false,
    );
    expect(parseAtlasCatalog(`messages:\n  title-e: 'x'\n`, OPTIONS).ok).toBe(
      true,
    );
  });
});

describe('parsing is total', () => {
  it('answers with a result for any text, rather than throwing', () => {
    const random = createRandom(SEED);
    // Written as escapes wherever the character has no glyph. An override, an isolate and a
    // combining mark are invisible in an editor and in a diff, so a raw one is a line nobody
    // can read, review or search for.
    const ALPHABET = [
      ...'{}[]()$#:|/\\"\'`.,-_ \n\tabzAZ09',
      '\u0000',
      '\u202E',
      '\u2066',
      '\u0301',
      '𝄞',
      'م',
    ];
    for (let index = 0; index < CASES * 4; index += 1) {
      const length = random.integer(64);
      const source = Array.from({ length }, () => random.pick(ALPHABET)).join(
        '',
      );
      // Not "it parses": most of these do not. The property is that a parser handed untrusted
      // text returns a typed answer either way, because a throw at this boundary escapes into
      // whatever called it: a CLI, a build script, an editor.
      expect(() => parseAtlasMessage(source)).not.toThrow();
      expect(typeof parseAtlasMessage(source).ok, source).toBe('boolean');
    }
  });

  it('answers with a result for any configuration text', () => {
    const random = createRandom(SEED);
    // The override is written as an escape for the reason above.
    const ALPHABET = [...'{}[]",:0123456789abc \n\t', '\u0000', '\u202E'];
    for (let index = 0; index < CASES; index += 1) {
      const length = random.integer(48);
      const source = Array.from({ length }, () => random.pick(ALPHABET)).join(
        '',
      );
      expect(() => parseAtlasConfiguration(source)).not.toThrow();
      expect(typeof parseAtlasConfiguration(source).ok, source).toBe('boolean');
    }
  });
});

describe('a configuration survives the round trip', () => {
  it('parses back to the configuration it was written from', () => {
    const random = createRandom(SEED);
    const LOCALES = ['en-US', 'ar-EG', 'pt-BR', 'de-DE'];
    for (let index = 0; index < CASES; index += 1) {
      const locales = [
        ...new Set(
          Array.from({ length: 1 + random.integer(4) }, () =>
            random.pick(LOCALES),
          ),
        ),
      ];
      const source = JSON.stringify({
        schemaVersion: 1,
        sourceLocale: locales[0],
        defaultLocale: locales[0],
        locales,
        ...(random.chance(0.5)
          ? {
              aliases: Object.fromEntries(
                locales.map((locale) => [
                  locale.slice(0, 2).toLowerCase(),
                  locale,
                ]),
              ),
            }
          : {}),
      });
      const parsed = parseAtlasConfiguration(source);
      expect(parsed.ok, source).toBe(true);
      if (!parsed.ok) continue;

      const written = formatAtlasConfiguration(parsed.value);
      const reparsed = parseAtlasConfiguration(written);
      expect(reparsed.ok, written).toBe(true);
      if (!reparsed.ok) continue;

      // `formatAtlasConfiguration` sorts aliases, so the text is not expected to match. The model
      // is, and a formatter that reordered anything meaning-bearing would show up here.
      expect(reparsed.value, written).toEqual(parsed.value);
    }
  });
});

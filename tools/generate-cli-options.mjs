/**
 * The options `atlas init` accepts, written from the schema that decides what the file accepts.
 *
 * `AtlasInitProjectOptions` offered four of the six settable configuration keys, and the
 * two it omitted, `personNameLocales` and `pseudoLocales`, were unreachable from the install
 * line in a way nothing could notice: the initialized project was valid, so the only symptom was a
 * consumer discovering the field by reading Atlas's source or by failing at runtime.
 *
 * A hand-written option list would have closed those two and gone stale on the seventh key, which
 * is the failure the item names rather than the one it reports. So the option set is not a list
 * that agrees with `ATLAS_CONFIGURATION_SCHEMA`; it *is* that schema, read at build time and
 * written here. A key added to the parser produces a flag the day it lands, and a checked-in table
 * that no longer matches fails `--check` in the gate. Same mechanism as
 * `locale-profile.generated.ts` from `cldr-core`, for the same reason.
 *
 * ## What this reads, and what it cannot
 *
 * Everything about a key's *shape* comes from the schema: whether it is a scalar, a list, or a map,
 * how deep its values go, and what type sits at the end. Its prose comes from the schema too:
 * `description` is a standard JSON Schema annotation, so it lives with the field it describes and
 * ships inside `schemas/configuration.v1.schema.json` as well as printing in `--help`.
 *
 * What JSON Schema has no keyword for is the *flag spelling*. Ajv runs `strict: true`, so inventing
 * one would throw at schema-compile time: breaking validation to save a table. SPELLINGS below is
 * therefore hand-written, and it is the only hand-written thing here. Its key set is asserted equal
 * to the schema's settable key set in both directions, so a new key with no spelling fails this
 * build with its name in the message, and a spelling for a key that no longer exists fails the same
 * way. That assertion is what separates this from the list the item warns about: there is nothing
 * to keep in step by remembering.
 *
 * ## The spelling conventions
 *
 * One rule covers both object-valued shapes: `--flag <path>=<value>`, where the path is a dotted
 * path beneath the key.
 *
 *   scalar         --source-locale en-US            once
 *   list           --locale ar-EG                   repeatable, one value each
 *   map, depth 1   --alias eg=ar-EG                 repeatable, path is the entry key
 *   map, depth 2   --pseudo-locale en-XA.markers=true
 *                  --pseudo-locale en-XA            the entry with no options set
 *
 * `--alias` is unchanged: it is this convention at depth 1 and always was. Depth 2 adds one dot and
 * no new rule, which is why a third level would need no new rule either.
 *
 * A key whose shape fits none of these fails the build rather than reaching a parser that guesses.
 * That is deliberate: the wrong outcome here is a flag that silently accepts the wrong syntax, and
 * a build error names the key and says what shape it found.
 *
 * ## Running it
 *
 * Reads `dist/toolkit/schemas.js`, so it needs `build`. The apparent circularity is not one: the
 * generated file is data derived from the schema and nothing in the schema derives from it, so a
 * stale copy still compiles and the loop is `build`, generate, `build`.
 */

import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtSchemas = resolve(workspaceRoot, 'dist/toolkit/schemas.js');

let schemas;
try {
  schemas = await import(pathToFileURL(builtSchemas).href);
} catch (error) {
  throw new Error(
    `Could not read ${builtSchemas}. This generator reads the built schema rather than the source, so run pnpm run build first. (${error?.message ?? error})`,
  );
}

const schema = schemas.ATLAS_CONFIGURATION_SCHEMA;
assert.equal(
  schema?.title,
  'Atlas project configuration',
  'dist/toolkit/schemas.js does not export the configuration schema this generator is written against.',
);

/**
 * The flag each configuration key is spelled as, and the value placeholder `--help` prints.
 *
 * The only hand-written thing in this file, because JSON Schema has no keyword for either and Ajv's
 * strict mode refuses an invented one. Checked against the schema in both directions below, so this
 * cannot drift without the build saying so.
 *
 * The four that existed before 10.5 keep their spellings exactly. Renaming a shipped flag to satisfy
 * a naming rule would break every install line in the wild to make this table prettier, and the
 * `--alias eg=ar-EG` spelling is already the depth-1 form of the convention the new keys use.
 */
const SPELLINGS = Object.freeze({
  sourceLocale: { flag: '--source-locale', value: '<locale>' },
  defaultLocale: { flag: '--default-locale', value: '<locale>' },
  locales: { flag: '--locale', value: '<locale>' },
  personNameLocales: { flag: '--person-name-locale', value: '<locale>' },
  pseudoLocales: {
    flag: '--pseudo-locale',
    value: '<locale>[.<option>=<value>]',
  },
  aliases: { flag: '--alias', value: '<alias>=<locale>' },
  // No brackets around the option, unlike `--pseudo-locale`. A pseudo-locale entry with no options
  // is a locale declared with default transforms; a formatting entry with no options states
  // nothing, and the schema refuses it.
  formatting: { flag: '--formatting', value: '<locale>.<option>=<value>' },
  // `note` is required, so there is no bracketed form here either: an in-progress entry with
  // no reason is exactly what the schema refuses.
  inProgress: { flag: '--in-progress', value: '<locale>.<option>=<value>' },
  // Depth 1, like `--alias`, because a locale has one parent and not a set of options. `und` as
  // the value says the locale has no parent at all.
  parentLocales: { flag: '--parent-locale', value: '<locale>=<locale>' },
});

/** `--help` stays readable at a terminal width people actually have. */
const HELP_WIDTH = 100;

const LEAF_TYPES = new Set(['string', 'number', 'boolean']);

function leafType(member) {
  return typeof member?.type === 'string' && LEAF_TYPES.has(member.type)
    ? member.type
    : undefined;
}

function shapeOf(key, property) {
  const direct = leafType(property);
  if (direct !== undefined) {
    return { shape: 'scalar', depth: 0, leaf: direct, options: {} };
  }
  if (property?.type === 'array') {
    const item = leafType(property.items);
    if (item !== undefined) {
      return { shape: 'list', depth: 0, leaf: item, options: {} };
    }
  }
  if (property?.type === 'object') {
    const value = property.additionalProperties;
    const entry = leafType(value);
    if (entry !== undefined) {
      return { shape: 'map', depth: 1, leaf: entry, options: {} };
    }
    if (
      value?.type === 'object' &&
      value.additionalProperties === false &&
      value.properties !== undefined
    ) {
      const options = {};
      for (const [name, member] of Object.entries(value.properties)) {
        const type = leafType(member);
        assert.notEqual(
          type,
          undefined,
          `Configuration key ${key} has an entry option ${name} whose type is not string, number or boolean. The init flag conventions cover scalars only; teach this generator the new shape rather than letting the flag parser guess.`,
        );
        assert.equal(
          typeof member.description,
          'string',
          `Configuration key ${key} has an entry option ${name} with no description in ATLAS_CONFIGURATION_SCHEMA. atlas init --help prints it, so a field with none is a field the install line cannot state.`,
        );
        options[name] = { type, description: member.description };
      }
      // `leaf` is not consulted at depth 2, `options` carries the type of each field, and is
      // emitted as `string` so the descriptor shape stays one thing rather than two.
      return { shape: 'map', depth: 2, leaf: 'string', options };
    }
  }
  throw new Error(
    `Configuration key ${key} has a shape no init flag convention covers: ${JSON.stringify(property?.type ?? property)}. The conventions are a scalar, an array of scalars, an object of scalars, and an object of objects of scalars. Add the convention here rather than leaving the key unreachable from atlas init.`,
  );
}

// Settable means "not fixed by the schema". `schemaVersion` is a `const`, so an invocation cannot
// choose it and a flag for it would be a way to be wrong.
const settable = Object.entries(schema.properties).filter(
  ([, property]) => property?.const === undefined,
);
assert.ok(
  settable.length > 0,
  'ATLAS_CONFIGURATION_SCHEMA has no settable properties, so this generator would write an empty option table and every check below would pass on nothing.',
);

const settableKeys = settable.map(([key]) => key).sort();
const spelledKeys = Object.keys(SPELLINGS).sort();
assert.deepEqual(
  settableKeys,
  spelledKeys,
  `The init flag spellings and the configuration schema disagree. Only in SPELLINGS: ${spelledKeys.filter((key) => !settableKeys.includes(key)).join(', ') || 'none'}. Only in the schema: ${settableKeys.filter((key) => !spelledKeys.includes(key)).join(', ') || 'none'}. A configuration key with no flag is a key atlas init cannot set, which is exactly what 10.5 exists to prevent.`,
);

const required = new Set(schema.required ?? []);

const descriptors = settable.map(([key, property]) => {
  assert.equal(
    typeof property.description,
    'string',
    `Configuration key ${key} has no description in ATLAS_CONFIGURATION_SCHEMA. atlas init --help prints it, so a settable field with none is a field the install line cannot state.`,
  );
  const { shape, depth, leaf, options } = shapeOf(key, property);
  return {
    key,
    flag: SPELLINGS[key].flag,
    value: SPELLINGS[key].value,
    description: property.description,
    shape,
    depth,
    leaf,
    options,
    required: required.has(key),
    repeatable: shape !== 'scalar',
  };
});

// The order `--help` prints and the order the parser reports in. Required first, because a reader
// looking for the shortest working invocation should not have to scan for it; then schema order,
// which is the order the written file's keys appear in.
const ordered = [
  ...descriptors.filter(({ required: isRequired }) => isRequired),
  ...descriptors.filter(({ required: isRequired }) => !isRequired),
];

const helpLines = ['Init options:'];
for (const descriptor of ordered) {
  helpLines.push(
    `  ${descriptor.flag} ${descriptor.value}${descriptor.repeatable ? '   (repeatable)' : ''}`,
  );
  helpLines.push(`      ${descriptor.description}`);
  for (const [name, option] of Object.entries(descriptor.options)) {
    helpLines.push(`      ${name} (${option.type})`);
    helpLines.push(`        ${option.description}`);
  }
}
helpLines.push(
  '',
  '  A repeatable flag may appear more than once. Where a value contains "=", the left side is a',
  '  path beneath the field: "eg=ar-EG" sets one entry, "en-XA.markers=true" sets one option of',
  '  one entry. Every field atlas.config.json accepts is above; there is no other way to set one.',
);

for (const line of helpLines) {
  assert.ok(
    line.length <= HELP_WIDTH,
    `This atlas init --help line is ${line.length} characters and the budget is ${HELP_WIDTH}: ${line}\nShorten the description in ATLAS_CONFIGURATION_SCHEMA rather than raising the budget; help nobody can read in a terminal states nothing.`,
  );
}
const help = helpLines.join('\n');

// The line printed beside ATL1701, which the tooling specification requires to be the exact
// complete invocation. It was written out by hand beside the help block that was also written out
// by hand, so the two could disagree with the parser and with each other, and did: the help block
// named four flags and this line named the same four, both of them missing two fields the
// configuration accepts. Generated from the same descriptors, it cannot say less than --help does.
const invocation = [
  'atlas init',
  ...ordered.map((descriptor) => {
    const one = `${descriptor.flag} ${descriptor.value}`;
    if (!descriptor.repeatable) return one;
    return descriptor.required ? `${one} [${one} ...]` : `[${one} ...]`;
  }),
].join(' ');

// A generated help block that happened to contain none of its own flags would look like a working
// gate and describe nothing, so every flag is asserted present.
for (const { flag } of ordered) {
  assert.ok(
    help.includes(`  ${flag} `),
    `The generated help block does not name ${flag}, so --help would omit a settable field.`,
  );
}

const keyUnion = ordered.map(({ key }) => `'${key}'`).join('\n  | ');

const body = ordered
  .map((descriptor) =>
    [
      '  {',
      `    key: '${descriptor.key}',`,
      `    flag: '${descriptor.flag}',`,
      `    value: ${JSON.stringify(descriptor.value)},`,
      `    description: ${JSON.stringify(descriptor.description)},`,
      `    shape: '${descriptor.shape}',`,
      `    depth: ${descriptor.depth},`,
      `    leaf: '${descriptor.leaf}',`,
      `    options: Object.freeze(${JSON.stringify(
        Object.fromEntries(
          Object.entries(descriptor.options).map(([name, option]) => [
            name,
            option.type,
          ]),
        ),
      )}),`,
      `    required: ${descriptor.required},`,
      `    repeatable: ${descriptor.repeatable},`,
      '  },',
    ].join('\n'),
  )
  .join('\n');

const output = `${[
  '// Generated by tools/generate-cli-options.mjs from ATLAS_CONFIGURATION_SCHEMA. Do not edit.',
  '//',
  '// The option set atlas init accepts is the configuration schema rather than a list that agrees',
  '// with it, so a key added to the parser is settable on the day it lands. pnpm run',
  '// verify:cli-options fails when this file and the schema have drifted apart.',
  '',
  '/** What a flag does with the value beside it. */',
  "export type AtlasInitOptionShape = 'scalar' | 'list' | 'map';",
  '',
  '/** The scalar types the init flag conventions cover. A schema leaf outside these fails the build. */',
  "export type AtlasInitLeafType = 'string' | 'number' | 'boolean';",
  '',
  '/** Every configuration key an invocation can set. */',
  `export type AtlasInitOptionKey =\n  | ${keyUnion};`,
  '',
  '/** One flag, and everything the parser and the help text need to know about it. */',
  'export interface AtlasInitOptionDescriptor {',
  '  /** The configuration key this flag sets, spelled as atlas.config.json spells it. */',
  '  readonly key: AtlasInitOptionKey;',
  '  readonly flag: string;',
  '  /** The value placeholder --help prints beside the flag. */',
  '  readonly value: string;',
  '  /** The schema description, printed by --help and shipped in the JSON Schema. */',
  '  readonly description: string;',
  '  readonly shape: AtlasInitOptionShape;',
  '  /** Path segments beneath the key: 0 for a scalar or list, 1 for a map of scalars, 2 for a map of objects. */',
  '  readonly depth: number;',
  '  /** The value type at the end of the path. Not consulted at depth 2, where `options` carries each type. */',
  '  readonly leaf: AtlasInitLeafType;',
  '  /** For a depth-2 map, the option names beneath an entry and their types. Empty otherwise. */',
  '  readonly options: Readonly<Record<string, AtlasInitLeafType>>;',
  '  /** The configuration schema requires this key, so an invocation that omits it cannot be completed. */',
  '  readonly required: boolean;',
  '  /** The flag may appear more than once, each occurrence adding rather than replacing. */',
  '  readonly repeatable: boolean;',
  '}',
  '',
  '/** Required first, then schema order. */',
  '// prettier-ignore',
  'export const ATLAS_INIT_OPTIONS: readonly AtlasInitOptionDescriptor[] = Object.freeze([',
  body,
  ']);',
  '',
  '/** The "Init options:" block of atlas --help, wrapped to a width a terminal has. */',
  '// prettier-ignore',
  `export const ATLAS_INIT_HELP = ${JSON.stringify(help)};`,
  '',
  '/** The complete invocation printed beside ATL1701. Every settable field, required ones first. */',
  '// prettier-ignore',
  `export const ATLAS_INIT_INVOCATION = ${JSON.stringify(invocation)};`,
  '',
].join('\n')}`;

const outputPath = resolve(
  workspaceRoot,
  'packages/toolkit/src/cli-options.generated.ts',
);

if (process.argv.includes('--check')) {
  let current;
  try {
    current = await readFile(outputPath, 'utf8');
  } catch (error) {
    throw new Error(
      `${outputPath} is missing; run pnpm run generate:cli-options. (${error?.message ?? error})`,
    );
  }
  assert.equal(
    current,
    output,
    'The checked-in atlas init option table is stale; run pnpm run build && pnpm run generate:cli-options.',
  );
  console.log(
    `Verified ${ordered.length} atlas init options against ATLAS_CONFIGURATION_SCHEMA: ${ordered.map(({ flag }) => flag).join(' ')}. Every settable configuration key is reachable from the install line, and none of them is spelled by hand twice.`,
  );
} else {
  let current;
  try {
    current = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current !== output) await writeFile(outputPath, output, 'utf8');
}

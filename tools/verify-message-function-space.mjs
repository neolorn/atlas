/**
 * "What compiles, renders", checked as an invariant rather than as a list of cases.
 *
 * The specification's own words for this are in `specs/04-message-authoring-and-catalogs.spec.md`
 * section 6: where MessageFormat 2
 * leaves a behaviour implementation-defined, Atlas resolves it as a refusal at compile time, never
 * as a render-time fallback and never as a render-time throw. Three separate pieces of work turned
 * out to be instances of that being untrue (a literal operand that was not a number, `:integer`
 * inheriting a fraction-digit minimum above its own maximum, and `roundingIncrement`) and each was
 * fixed where it was found. Nothing checked the class.
 *
 * **The cases are not written here.** They are generated from the option table the compiler and the
 * evaluator both read, so a function that gains an option contributes its cases the day it lands and
 * a hand-kept list of what to try cannot fall behind. That table is imported from the installed
 * package rather than from source: it is the data the shipped compiler is actually using.
 *
 * Two things are asserted, because the failure has two shapes and only one of them throws.
 *
 *   1. **Nothing accepted throws.** Every message the compiler accepts renders, for an input that
 *      satisfies the contract the compiler published for it.
 *   2. **Nothing accepted is inert.** Every option a function accepts has at least one value whose
 *      rendering differs from the same message without it. An option that compiles, renders, and
 *      changes nothing is the worse half of this defect: the author who wrote `fields=weekday` got a
 *      date with no weekday in it and no diagnostic anywhere. Thirty-seven date options were in that
 *      state when this file was written.
 *
 * The walk is one option at a time. Pairs are a hundred times the cases and are run as a separate
 * measurement when the table changes, not on every gate: 94 seconds of pair walking on every
 * commit would be paid by everyone to catch something one run per table change catches.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NEWLINE = String.fromCharCode(10);
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const consumerToolkit = resolve(
  workspaceRoot,
  'tmp/package-consumer-verification/package-consumer/node_modules/@neolorn/atlas-toolkit/index.js',
);
if (!existsSync(consumerToolkit)) {
  process.stderr.write(
    'The function-space walk runs against the installed toolkit. Run "pnpm run verify:consumer" first.' +
      NEWLINE,
  );
  process.exit(1);
}
const tableModule = resolve(
  dirname(consumerToolkit),
  'message-function-options.js',
);
if (!existsSync(tableModule)) {
  process.stderr.write(
    `The installed toolkit has no ${tableModule}. The option table moved; this walk has nothing to derive its cases from.` +
      NEWLINE,
  );
  process.exit(1);
}

const table = await import(pathToFileURL(tableModule).href);
const tk = await import(pathToFileURL(consumerToolkit).href);
// The modules rather than the package entry. The compiler's own machinery is not published:
// nothing outside Atlas calls it, so it is not part of the toolkit's surface, and a gate that
// exercises it reaches the module that declares it. This is the same reach the option table above
// already makes.
const { compileAtlasLocalArtifacts } = await import(
  pathToFileURL(resolve(dirname(consumerToolkit), 'compiled-artifacts.js')).href
);
const { analyzeAtlasCatalogSet } = await import(
  pathToFileURL(resolve(dirname(consumerToolkit), 'semantic-model.js')).href
);
const messageFormat = await import(
  pathToFileURL(resolve(dirname(consumerToolkit), 'message-format.js')).href
);
const rt = await import(
  pathToFileURL(
    resolve(workspaceRoot, 'dist/runtime/fesm2022/neolorn-atlas.mjs'),
  ).href
);

const RULES = table.ATLAS_MESSAGE_OPTION_RULES;
const FUNCTIONS = table.ATLAS_MESSAGE_FUNCTION_OPTIONS;
if (RULES === undefined || FUNCTIONS === undefined) {
  process.stderr.write(
    'The installed option table does not export what this walk reads. Nothing was measured.' +
      NEWLINE,
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * What the walk needs that the table does not say.                    *
 * ------------------------------------------------------------------ */

/**
 * Options whose effect is invisible until something else is written beside them, and the option
 * that makes each one visible.
 *
 * This is about observation rather than about the specification, which is why it is here and not in
 * the product's table. `roundingIncrement` is ignored by ECMA-402 unless the fraction digits are
 * fixed and equal; `roundingPriority` only arbitrates when both a fraction and a significant-digit
 * constraint are present; `trailingZeroDisplay` needs a trailing zero to strip. Written alone, all
 * three render exactly like the bare message and would be reported as inert.
 *
 * Every entry is checked against the table below, so a name that stops being an option fails this
 * file rather than sitting here describing something that no longer exists.
 */
const COMPANIONS = {
  roundingIncrement: {
    options: 'minimumFractionDigits=2 maximumFractionDigits=2',
  },
  roundingPriority: {
    options: 'maximumFractionDigits=2 maximumSignificantDigits=3',
  },
  // And an integer operand, because `stripIfInteger` strips nothing from 1234.5 whatever it is set
  // to. An option can need a value as well as a neighbour before it says anything.
  trailingZeroDisplay: { options: 'minimumFractionDigits=2', operand: 1234 },
  // Rounding mode decides which way a rounded value goes, and nothing is rounded at the default
  // precision. `:currency` fixes its digits with a different option than the other three, which is
  // why the key can name a function as well as an option.
  roundingMode: { options: 'maximumFractionDigits=0' },
  'currency roundingMode': { options: 'fractionDigits=0' },
  'percent roundingMode': {
    options: 'maximumFractionDigits=0',
    operand: 0.123456,
  },
  // Accounting notation is the parenthesised negative. A positive amount is written the same way
  // whichever sign convention is asked for.
  currencySign: { operand: -1234.5 },
  // 1234.5 as a percentage is 123,450%, which has no fraction to keep or drop.
  'percent maximumFractionDigits': { operand: 0.123456 },
  'percent minimumSignificantDigits': { operand: 0.123456 },
  'percent maximumSignificantDigits': { operand: 0.123456 },
};

/** The companion for one option on one function, most specific first. */
const companionFor = (fn, option) =>
  COMPANIONS[fn + ' ' + option] ?? COMPANIONS[option];

/**
 * Options that are not formatting options, so a rendering identical to the bare form is correct.
 *
 * `select` decides which variant a `.match` chooses and never reaches a formatter. It is the only
 * one: `:offset`'s `add` and `subtract` do not reach `Intl` either, but they change the number that
 * does, so they are observable in exactly the way this walk means.
 */
const NOT_FORMATTING = new Set(['select']);

/** Options a function cannot render without, so every case for it carries one. */
const REQUIRED = { currency: 'currency=EUR', unit: 'unit=meter' };

/**
 * The operand each family takes, as a value satisfying the contract the compiler publishes.
 *
 * A fixed value for all of them reported 54 contract violations as invariant breaches on the first
 * run of an earlier draft: `:integer` publishes `integer`, and 1234.5 is not one. The declared type
 * is read from the compiled contract rather than assumed here.
 */
const OPERANDS = {
  number: 1234.5,
  integer: 1234,
  // Late enough in the day that a time zone changes the date and not only the clock. At midday
  // `timeZone=|Europe/Paris|` and `timeZone=UTC` render the same date, and an option that changes
  // nothing for the value it was tried with cannot be told from an option nothing reads.
  'date-time': new Date(Date.UTC(2026, 8, 5, 23, 30, 45)),
  string: 'Value',
};

const SAMPLED = {
  currency: ['EUR', 'JPY'],
  unit: ['meter', 'mile-per-hour'],
  timeZone: ['UTC', '|Europe/Paris|', 'input'],
  calendar: ['gregory', 'buddhist'],
};

const LOCALE = 'en-US';
const PROVIDER = 'space';
const SCOPE = 'walk';

/* ------------------------------------------------------------------ *
 * The extension seam.                                                  *
 * ------------------------------------------------------------------ */

/**
 * Two registered functions, so the walk ranges over an extension profile and not only over the
 * built-in table.
 *
 * An extension is a message function and has a profile like any other, and for a long time nobody
 * built one: the compiler was told a registered function's name and whether it selects, which is
 * not enough to say what its resolved value carries, so an extension declaration carried nothing
 * into the rest of the message while the runtime carried its whole option mapping. Both directions
 * were wrong (one message compiled and threw, another was refused and renders) and both were
 * invisible to a walk over the built-in table alone, because `.local $x = {$v :ext OPT=V}` followed
 * by `{$x :number}` is not a case any built-in profile generates.
 *
 * Both functions pass their operand through untouched, which is the point: what is under test is
 * not what an extension formats but what its declaration carries, so the only difference between a
 * direct case and its twin is which function the option was written on.
 *
 * Nothing is shipped. These are extension descriptors, the mechanism Atlas already has, declared
 * the way the conformance runner declares the suite's test functions.
 */
const seamOptionsFor = (fn) => {
  const profile = FUNCTIONS[fn];
  const inheritable =
    profile.inheritsOnly ??
    profile.accepts.filter(
      (name) => !profile.discardedFromOperand.includes(name),
    );
  return inheritable.filter((name) => !NOT_FORMATTING.has(name));
};

const declaredOptions = (names) =>
  Object.fromEntries(names.map((name) => [name, { type: 'string' }]));

const seamRegistry = tk.defineAtlasExtensionRegistry([
  {
    kind: 'message-function',
    id: 'walk:number',
    operandType: 'number',
    resultType: 'number',
    selector: 'none',
    maximumOutputLength: 256,
    options: declaredOptions(seamOptionsFor('number')),
  },
  {
    kind: 'message-function',
    id: 'walk:date',
    operandType: 'date-time',
    resultType: 'date-time',
    selector: 'none',
    maximumOutputLength: 256,
    options: declaredOptions(seamOptionsFor('date')),
  },
]);
if (!seamRegistry.ok) {
  process.stderr.write(
    'Atlas refused this walk own extension descriptors: ' +
      seamRegistry.diagnostics
        .map(({ code, summary }) => code + ' ' + summary)
        .join('; ') +
      NEWLINE,
  );
  process.exit(1);
}
const extensionRegistry = seamRegistry.value;

const passThrough = ({ operand }) => ({
  text: String(operand),
  value: operand,
});
const boundExtension = (id) => {
  const descriptor = extensionRegistry.descriptors.find(
    (candidate) => candidate.id === id,
  );
  if (descriptor === undefined) {
    throw new Error('The extension registry did not keep ' + id + '.');
  }
  return { descriptor, evaluate: passThrough };
};
const extensionBindings = rt.defineRuntimeExtensions([
  boundExtension('walk:number'),
  boundExtension('walk:date'),
]);

/** Which extension carries for each built-in the seam feeds. */
const SEAM = Object.freeze({ number: 'walk:number', date: 'walk:date' });

/* ------------------------------------------------------------------ *
 * The cases, generated.                                               *
 * ------------------------------------------------------------------ */

function valuesFor(name) {
  const rule = RULES[name];
  if (rule === undefined) return [];
  switch (rule.kind) {
    case 'enumerated':
      return [...rule.values];
    case 'boolean':
      return ['true', 'false'];
    case 'digit-size': {
      // The ends and one in the middle. A digit size option's effect is monotone in its value and
      // 100 renderings of it would say what three say, at a hundred times the price.
      const middle = Math.min(
        rule.maximum,
        Math.max(rule.minimum, rule.minimum + 2),
      );
      const values = [...new Set([rule.minimum, middle, rule.maximum])].map(
        String,
      );
      return rule.auto === true ? [...values, 'auto'] : values;
    }
    case 'identifier':
    case 'constructed':
      return SAMPLED[name] ?? [];
    case 'platform':
      // The sampled pair where there is one, so the walk stays the same size whatever ICU ships.
      return (
        SAMPLED[name] ?? [...table.atlasPlatformValues(rule.key)].slice(0, 2)
      );
    case 'unsupported':
      // Written on purpose: an option Atlas declines has to be refused, and a walk that skipped it
      // would never notice it being quietly accepted again.
      return ['whatever'];
    default:
      return [];
  }
}

/**
 * Every option is judged against its own baseline: the same message, the same companion, the same
 * operand, without the option written.
 *
 * Comparing against one bare form per function does not work and the reason is worth keeping. An
 * option needing a companion renders differently from the bare form because of the companion, so it
 * would pass while doing nothing itself; and `:offset` has no renderable bare form at all, since it
 * requires exactly one of `add` and `subtract`. A baseline per option answers both.
 */
const missingSamples = [];

/**
 * The table is where the cases come from, so the table is the one thing the walk cannot check by
 * walking. A function the compiler knows and the table does not is treated as an extension: its
 * options are accepted unread and never reach a formatter, which is the defect this whole file
 * exists for, and the walk that derives its cases from the table would answer by generating no
 * cases for it and reporting green.
 *
 * So the compiler's own list of built-in functions is compared to the table's, in both directions.
 * `ATLAS_MESSAGE_FUNCTION_PROFILE` is the list the parser accepts a `:name` from; anything in it
 * without an option profile is a function whose options nobody reads, and anything in the profile
 * table without an entry there is a vocabulary for a function that cannot be written.
 */
const declared = new Set(
  (messageFormat.ATLAS_MESSAGE_FUNCTION_PROFILE ?? []).map(({ name }) => name),
);
if (declared.size === 0) {
  process.stderr.write(
    'The installed toolkit publishes no built-in function profile, so this walk cannot tell whether ' +
      'the option table covers every function. Nothing was measured.' +
      NEWLINE,
  );
  process.exit(1);
}
for (const name of declared) {
  if (FUNCTIONS[name] === undefined) {
    missingSamples.push(
      `:${name} is a built-in function and the option table has no profile for it, so the compiler ` +
        'treats it as an extension and accepts every option written on it without reading one. ' +
        'This walk generated no cases for it.',
    );
  }
}
for (const name of Object.keys(FUNCTIONS)) {
  if (!declared.has(name)) {
    missingSamples.push(
      `The option table declares a vocabulary for :${name}, which is not a built-in function.`,
    );
  }
}

const cases = [];
const groups = new Map();
for (const [fn, profile] of Object.entries(FUNCTIONS)) {
  const required = REQUIRED[fn];
  cases.push({
    fn,
    option: undefined,
    written: required ?? '',
    operand: undefined,
  });
  for (const name of profile.accepts) {
    const values = valuesFor(name);
    if (values.length === 0) {
      missingSamples.push(
        `:${fn} accepts ${name} and this walk has no values to try for it. Its rule kind is ${RULES[name]?.kind ?? 'absent'}.`,
      );
      continue;
    }
    const companion = companionFor(fn, name);
    const context = [
      required !== undefined && !required.startsWith(`${name}=`)
        ? required
        : undefined,
      companion?.options,
    ].filter((each) => each !== undefined);
    const group = { baseline: cases.length, values: [] };
    groups.set(fn + ' ' + name, group);
    cases.push({
      fn,
      option: name,
      written: context.join(' '),
      operand: companion?.operand,
    });
    for (const value of values) {
      group.values.push(cases.length);
      cases.push({
        fn,
        option: name,
        value,
        written: [...context, `${name}=${value}`].join(' '),
        operand: companion?.operand,
      });
    }
  }
}

for (const key of Object.keys(COMPANIONS)) {
  const name = key.includes(' ') ? key.slice(key.indexOf(' ') + 1) : key;
  if (RULES[name] === undefined) {
    missingSamples.push(
      `This walk carries a companion for ${key}, and ${name} is no longer an option. Remove it.`,
    );
  }
}

/**
 * The second half of the walk: an option read by the next expression rather than by this one.
 *
 * `:time` accepts `calendar` because the specification requires it to, and a time of day shows no
 * calendar whatever it is set to: every value renders `11:30 PM`. The option is not inert: it is
 * carried on the resolved value, and the next annotation reads it. Judging it only by its own
 * output would report a defect that is not there; leaving it out of the walk would mean the
 * inheritance path, which is where two of this item's three original instances lived, had no
 * check at all.
 *
 * So every option a function inherits is also walked through a chain, and an option is observed if
 * it changes what this function renders or what a function inheriting it renders.
 */
const chains = new Map();
for (const [fn, profile] of Object.entries(FUNCTIONS)) {
  for (const name of profile.inheritsOnly ?? []) {
    const values = valuesFor(name);
    if (values.length === 0) continue;
    const group = { baseline: cases.length, values: [] };
    chains.set(fn + ' ' + name, group);
    cases.push({
      fn,
      option: name,
      chain: true,
      written: '',
      operand: undefined,
    });
    for (const value of values) {
      group.values.push(cases.length);
      cases.push({
        fn,
        option: name,
        chain: true,
        written: `${name}=${value}`,
        operand: undefined,
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Compiling and rendering, through the shipped surface.               *
 * ------------------------------------------------------------------ */

const configuration = tk.parseAtlasConfiguration(
  JSON.stringify({
    schemaVersion: 1,
    sourceLocale: LOCALE,
    defaultLocale: LOCALE,
    locales: [LOCALE],
  }),
  { sourcePath: 'atlas.config.json' },
);
if (!configuration.ok) {
  process.stderr.write(
    `The walk could not build a configuration: ${JSON.stringify(configuration.diagnostics)}${NEWLINE}`,
  );
  process.exit(1);
}

/**
 * The seam cases: the same option, written on an extension declaration instead of on the function
 * that reads it.
 *
 * What is asserted is equality with the direct case rather than "changes the output", and that is
 * the stronger statement: an option that survives a declaration must produce exactly what writing
 * it on the expression produces, and a combination the compiler refuses when it is written
 * directly must be refused here too. Both halves of the measured defect fail this: the carried
 * numeric conflict compiled where the direct one is refused, and the carried zone was refused where
 * the direct one renders.
 *
 * Only inheritable options are twinned. An option the consuming function discards from its operand,
 * or never inherits at all, is *meant* to render differently through a declaration, and asserting
 * equality for it would be asserting the opposite of the specification.
 */
const seam = [];
for (const [key, group] of groups) {
  const [fn, option] = key.split(' ');
  if (SEAM[fn] === undefined) continue;
  if (!seamOptionsFor(fn).includes(option)) continue;
  for (const direct of [group.baseline, ...group.values]) {
    seam.push({ direct, carried: cases.length, fn, option });
    cases.push({ ...cases[direct], seamOf: fn });
  }
}

const textFor = (index) => {
  const { fn, written, chain, seamOf } = cases[index];
  if (seamOf !== undefined) {
    return [
      '.local $x = {$v :' +
        SEAM[seamOf] +
        (written === '' ? '' : ' ' + written) +
        '}',
      '{{V: {$x :' + seamOf + '}}}',
    ].join(NEWLINE);
  }
  const annotated = ':' + fn + (written === '' ? '' : ' ' + written);
  return chain === true
    ? ['.local $x = {$v ' + annotated + '}', '{{V: {$x :datetime}}}'].join(
        NEWLINE,
      )
    : 'V: {$v ' + annotated + '}';
};
const parseOptions = {
  role: 'source',
  providerId: PROVIDER,
  scopeId: SCOPE,
  locale: LOCALE,
  extensions: extensionRegistry,
};
const catalogOf = (indices) =>
  ['messages:']
    .concat(indices.map((i) => `  m${i}: ${JSON.stringify(textFor(i))}`))
    .join(NEWLINE) + NEWLINE;

/**
 * The subset the compiler accepts, found by bisection.
 *
 * `parseAtlasCatalog` reports the first refusing message and stops, so dropping one refusal and
 * retrying the whole set is quadratic in the number of refusals: an earlier draft did exactly
 * that and did not finish in ten minutes. Halving instead is one parse per accepted run plus a
 * logarithmic tail per refusal.
 */
const refusals = new Map();
function accepted(subset) {
  if (subset.length === 0) return [];
  const attempt = tk.parseAtlasCatalog(catalogOf(subset), parseOptions);
  if (attempt.ok) return subset;
  if (subset.length === 1) {
    refusals.set(
      subset[0],
      attempt.diagnostics.map(({ code, summary }) => `${code} ${summary}`),
    );
    return [];
  }
  const middle = subset.length >> 1;
  return accepted(subset.slice(0, middle)).concat(
    accepted(subset.slice(middle)),
  );
}

const live = accepted(cases.map((_, index) => index));
const parsed = tk.parseAtlasCatalog(catalogOf(live), parseOptions);
if (!parsed.ok) {
  process.stderr.write(
    `The accepted subset did not parse as a whole. The walk is measuring itself.${NEWLINE}`,
  );
  process.exit(1);
}
const graph = analyzeAtlasCatalogSet({
  configuration: configuration.value,
  catalogs: [parsed.value],
  extensions: extensionRegistry,
});
if (!graph.ok) {
  process.stderr.write(
    `Analysis refused the accepted subset: ${JSON.stringify(graph.diagnostics.slice(0, 3))}${NEWLINE}`,
  );
  process.exit(1);
}
const compiled = compileAtlasLocalArtifacts({
  owner: {
    providerId: '@neolorn/atlas-verify',
    generatedRootPath: 'src/generated/i18n',
  },
  graph: graph.value,
  catalogs: [parsed.value],
  configuration: configuration.value,
});
if (!compiled.ok) {
  process.stderr.write(
    `Compilation refused the accepted subset: ${JSON.stringify(compiled.diagnostics.slice(0, 3))}${NEWLINE}`,
  );
  process.exit(1);
}

const artifacts = compiled.value;
const catalog = artifacts.catalogs[0];
const localization = rt.createLocalizationContext({
  setup: {
    configuration: Object.freeze({
      generatedAbi: 'atlas-generated/1',
      sourceLocale: LOCALE,
      defaultLocale: LOCALE,
      locales: Object.freeze([LOCALE]),
      aliases: Object.freeze({}),
      applicationContractFingerprint:
        artifacts.descriptor.applicationContractFingerprint,
      semanticRegistryFingerprint:
        artifacts.descriptor.semanticRegistryFingerprint,
      // From the graph rather than declared empty: a message using a registered function records
      // the descriptor it needs, and the runtime admits a catalog by comparing what it requires
      // against what the configuration declares.
      extensionDescriptors: Object.freeze([
        ...graph.value.extensionDescriptors,
      ]),
      scopes: Object.freeze([
        Object.freeze({
          providerId: PROVIDER,
          scopeId: SCOPE,
          applicationContractFingerprint:
            catalog.applicationContractFingerprint,
          semanticRegistryFingerprint: catalog.semanticRegistryFingerprint,
          requiredExtensions: Object.freeze([...catalog.requiredExtensions]),
        }),
      ]),
    }),
    catalogSet: artifacts.descriptor,
    catalogLoaders: {
      [`${PROVIDER}:${SCOPE}:${LOCALE}`]: () => Promise.resolve(catalog),
    },
    extensions: extensionBindings,
  },
  bootstrapScopes: [Object.freeze({ providerId: PROVIDER, scopeId: SCOPE })],
  // A consumer supplies one and Atlas refuses to format a date without it. `UTC` because it is the
  // one zone whose answer does not depend on where this runs.
  formattingContext: Object.freeze({ timeZone: 'UTC' }),
});

await localization.initialize();

const failures = [];
const rendered = new Map();
for (const semantic of graph.value.scopes[0].messages) {
  const index = Number(semantic.messageId.slice(1));
  const handle = Object.freeze({
    generatedAbi: 'atlas-generated/1',
    providerId: semantic.providerId,
    scopeId: semantic.scopeId,
    messageId: semantic.messageId,
    identity: semantic.identity,
    resultKind: semantic.resultKind,
    inputNames: Object.freeze(semantic.inputs.map(({ name }) => name)),
    slotNames: Object.freeze(semantic.slots.map(({ name }) => name)),
  });
  const declared = semantic.inputs[0]?.type;
  const value = cases[index].operand ?? OPERANDS[declared];
  if (value === undefined) {
    failures.push(
      `${textFor(index)} publishes an input of type ${String(declared)} and this walk has no value of that type to pass. It cannot answer for this message.`,
    );
    continue;
  }
  try {
    rendered.set(index, localization.evaluateText(handle, { v: value }).value);
  } catch (error) {
    failures.push(
      `${textFor(index)} compiled and threw while rendering: ${error?.message ?? String(error)}`,
    );
  }
}
localization.dispose();

/* ------------------------------------------------------------------ *
 * The two verdicts.                                                   *
 * ------------------------------------------------------------------ */

const distinctRenderings = (group) => {
  if (group === undefined) return 0;
  const values = group.values.filter((index) => rendered.has(index));
  // Every value refused is a complete answer: the option cannot be written at all, so it cannot be
  // written and ignored. `usage` is the standing case: Atlas declines unit conversion by name.
  if (values.length === 0) return 0;
  const seen = new Set(values.map((index) => rendered.get(index)));
  const baseline = rendered.get(group.baseline);
  if (baseline !== undefined) seen.add(baseline);
  return seen.size;
};

let inert = 0;
for (const [key, group] of groups) {
  const [fn, option] = key.split(' ');
  if (NOT_FORMATTING.has(option)) continue;
  const direct = distinctRenderings(group);
  if (direct === 0) continue;
  if (direct >= 2) continue;
  if (distinctRenderings(chains.get(key)) >= 2) continue;
  inert += 1;
  failures.push(
    `:${fn} accepts ${option} and every value of it renders exactly like :${fn} without it, ` +
      'here and in an expression that inherits it. The option is carried and never read, which ' +
      'is the half of this defect that does not throw.',
  );
}

/**
 * The third verdict: an option written on a declaration behaves as it does written on the
 * expression, whichever kind of function the declaration used.
 */
const accepted_ = new Set(live);
let seamBreaks = 0;
for (const { direct, carried, fn, option } of seam) {
  const directRefused = !accepted_.has(direct);
  const carriedRefused = !accepted_.has(carried);
  if (directRefused !== carriedRefused) {
    seamBreaks += 1;
    failures.push(
      option +
        ' written on a declaration and read by :' +
        fn +
        ' is ' +
        (carriedRefused ? 'refused' : 'accepted') +
        ', where the same option written on the :' +
        fn +
        ' expression itself is ' +
        (directRefused ? 'refused' : 'accepted') +
        '. ' +
        JSON.stringify(textFor(carried)),
    );
    continue;
  }
  if (directRefused) continue;
  if (rendered.get(direct) !== rendered.get(carried)) {
    seamBreaks += 1;
    failures.push(
      option +
        ' written on a declaration renders ' +
        JSON.stringify(rendered.get(carried)) +
        ', where the same option written on the :' +
        fn +
        ' expression itself renders ' +
        JSON.stringify(rendered.get(direct)) +
        '.',
    );
  }
}
if (seam.length === 0) {
  failures.push(
    'This walk generated no extension-seam cases, so it is not measuring the seam it was extended for.',
  );
}

for (const problem of missingSamples) failures.push(problem);

const refusedCount = cases.length - live.length;
process.stdout.write(
  [
    '=== Message function space, one option at a time',
    `  functions          ${Object.keys(FUNCTIONS).length}`,
    `  generated cases    ${cases.length}`,
    `  refused at compile ${refusedCount}`,
    `  rendered           ${rendered.size}`,
    `  options measured   ${groups.size}`,
    `  inherited chains   ${chains.size}`,
    `  extension twins    ${seam.length}`,
    '',
  ].join(NEWLINE),
);

if (failures.length > 0) {
  process.stdout.write(`=== FAILURES${NEWLINE}`);
  for (const failure of failures)
    process.stdout.write(`  ${failure}${NEWLINE}`);
  process.stdout.write(
    `${NEWLINE}${failures.length} invariant failures${NEWLINE}`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    'Everything the compiler accepts renders, every option it accepts does something, and an ' +
      'option written on a declaration does what it does written on the expression.' +
      NEWLINE,
  );
}

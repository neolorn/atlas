/**
 * MessageFormat 2 conformance, run against the built packages.
 *
 * Atlas *parses* MessageFormat 2 with the reference implementation, and that half is settled by
 * construction. It **evaluates** with its own code: selection, function resolution, the fallback
 * rules and the bidi strategy are all written here, and until this file existed every case that code
 * had ever passed was also written here, against the same reading of the specification that produced
 * it. A check drawn from the same source as its subject agrees by construction, and agreeing is
 * not the same as being right.
 *
 * `specs/01-standards-profile.spec.md` section 7 states the requirement this answers: a release is
 * verified against the working group's suite for the edition it pins, run through the built
 * packages.
 *
 * So the cases come from the working group. `standards/data/message-format-tests-48.2` is the
 * `test/` directory of `unicode-org/message-format-wg` at tag `LDML48.2`, pinned by digest in
 * `standards/sources.lock.json` and re-verified by `verify:standards-sources`, which runs before
 * this does. The revision matters: the lock pins the MessageFormat profile at LDML 48.2, and a suite
 * from another revision would test another specification and report the difference as a defect.
 *
 * **Every case runs through the built artifacts.** The toolkit is the one installed into the
 * materialized consumer and the runtime is `dist/`, so what is measured is the package a consumer
 * receives. A suite pointed at `src/` would prove the sources agree with each other.
 *
 * That constraint decides the shape of the whole file, because Atlas has no public "evaluate this
 * string" entry point and should not have one: a message reaches the runtime as compiled IR, always.
 * So each case becomes a one-message catalog, compiled by the built toolkit, and evaluated through a
 * real `Localization` booted over it. The consequence is that Atlas answers a case at whichever
 * stage is competent to answer it: most of the suite's error cases are refused by the compiler
 * rather than by the evaluator, which is the correct behavior for a compiled system and is
 * recorded as such rather than being forced into a runtime shape it does not have.
 *
 * `specs/12-verification.spec.md` section 6 states that as the general rule: the suite for the
 * edition the profile declares, pinned by digest, run through the built packages, and the stage
 * that answers a case recorded rather than the case reshaped to reach a particular one.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(resolve(workspaceRoot, 'package.json'));

/* ------------------------------------------------------------------ *
 * The suite.                                                          *
 * ------------------------------------------------------------------ */

const suiteRoot = resolve(
  workspaceRoot,
  'standards/data/message-format-tests-48.2/test/tests',
);

/**
 * The loader is shown to have loaded something.
 *
 * A walk that silently returns nothing (a renamed directory, a changed layout, a filter that
 * stopped matching) reports "0 failures" and looks exactly like a clean run. These two numbers are
 * what the suite held at the pinned revision, and they are a floor rather than a target:
 * a re-pin at a later revision is expected to move them and is expected to say so here.
 */
const EXPECTED_FILES = 16;
const EXPECTED_CASES = 461;

function suiteFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...suiteFiles(path));
    else if (entry.name.endsWith('.json')) found.push(path);
  }
  return found.sort();
}

function loadCases() {
  const files = suiteFiles(suiteRoot);
  const cases = [];
  for (const path of files) {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    const defaults = document.defaultTestProperties ?? {};
    const file = relative(suiteRoot, path).replaceAll('\\', '/');
    if (!Array.isArray(document.tests) || document.tests.length === 0) {
      throw new Error(`${file} declares no tests. The suite layout changed.`);
    }
    document.tests.forEach((test, index) => {
      cases.push({ ...defaults, ...test, file, index });
    });
  }
  if (files.length !== EXPECTED_FILES || cases.length !== EXPECTED_CASES) {
    throw new Error(
      `Expected ${EXPECTED_FILES} suite files and ${EXPECTED_CASES} cases, found ${files.length} and ${cases.length}. ` +
        'Either the pinned suite changed, update these two numbers with the re-pin, or the loader stopped seeing it.',
    );
  }
  return cases;
}

/* ------------------------------------------------------------------ *
 * The built packages.                                                 *
 * ------------------------------------------------------------------ */

await import(pathToFileURL(require_.resolve('@angular/compiler')).href);

// Read from the materialized consumer for the reason `verify-cost-budget.mjs` records: a staged
// package is a set of files, not an installed one, so nothing resolves its dependencies in place and
// importing it from the workspace root fails at its first bare specifier. The consumer install is
// the same artifact a consumer receives, correctly resolved.
const consumerToolkit = resolve(
  workspaceRoot,
  'tmp/package-consumer-verification/package-consumer/node_modules/@neolorn/atlas-toolkit/index.js',
);
if (!existsSync(consumerToolkit)) {
  process.stderr.write(
    'The conformance suite runs against the installed toolkit. Run "pnpm run verify:consumer" first.\n',
  );
  process.exit(1);
}
const tk = await import(pathToFileURL(consumerToolkit).href);
// The modules rather than the package entry. The compiler's own machinery is not published:
// nothing outside Atlas calls it, so it is not part of the toolkit's surface, and a gate that
// exercises it reaches the module that declares it.
const { compileAtlasLocalArtifacts } = await import(
  pathToFileURL(resolve(dirname(consumerToolkit), 'compiled-artifacts.js')).href
);
const { analyzeAtlasCatalogSet } = await import(
  pathToFileURL(resolve(dirname(consumerToolkit), 'semantic-model.js')).href
);
const rt = await import(
  pathToFileURL(
    resolve(workspaceRoot, 'dist/runtime/fesm2022/neolorn-atlas.mjs'),
  ).href
);

const PROVIDER = 'conformance';
const SCOPE = 'suite';
const MESSAGE_ID = 'conformance';

const configurations = new Map();
function configurationFor(locale) {
  const existing = configurations.get(locale);
  if (existing !== undefined) return existing;
  // Through the loader rather than as an object literal, for the reason the cost budget records: a
  // `.mjs` tool fabricating a value of a TypeScript type is unchecked by construction, and a field
  // added to the configuration later would arrive here as a crash instead of as its default.
  const parsed = tk.parseAtlasConfiguration(
    JSON.stringify({
      schemaVersion: 1,
      sourceLocale: locale,
      defaultLocale: locale,
      locales: [locale],
    }),
  );
  if (!parsed.ok) {
    throw new Error(
      `The suite asks for locale ${locale} and the Atlas configuration refused it: ${parsed.diagnostics
        .map(({ code, summary }) => `${code} ${summary}`)
        .join('; ')}`,
    );
  }
  configurations.set(locale, parsed.value);
  return parsed.value;
}

const describe = (diagnostics) =>
  (diagnostics ?? []).map(({ code, summary, message }) => ({
    code,
    detail: summary ?? message ?? '',
  }));

/* ------------------------------------------------------------------ *
 * The suite's test functions, as an Atlas extension.                  *
 * ------------------------------------------------------------------ */

/**
 * `:test:function`, `:test:select` and `:test:format`, declared through Atlas's own extension
 * registry and bound only here.
 *
 * They exist because the built-in functions' output is locale data and varies between
 * implementations, so the suite cannot assert on it, which is why `functions/` mostly asserts that
 * nothing errored. Selection is different: it is pure logic, the suite has a whole file for it, and
 * every one of those cases needs one of these functions. Excluding them excluded
 * `pattern-selection.json` entirely, and left the code that ranks variants reached by five cases
 * that happen to put a catch-all beside a real key.
 *
 * **Nothing is shipped.** These are extension descriptors, which is the mechanism Atlas already has
 * for a function it does not define, declared in this file and present in no published profile. It
 * also means the extension path itself is exercised by cases nobody here wrote, which nothing else
 * in this repository does.
 *
 * The behaviour is transcribed from the suite's own README, not from what Atlas's descriptor fields
 * appear to offer.
 *
 * **Both of the README's options are declared now, and one of them is deliberately only half
 * honoured.** `decimalPlaces` was unspellable until 3.16 gave the descriptor MessageFormat's own
 * `name` production; it is declared, set by six cases, and honoured in formatting, in matching and
 * in the ranking between `'1.0'` and `'1'`. `fails` is declared and its `never` value is the only
 * one Atlas can act on: the option asks for a function that fails as a selector but not as a
 * formatter, and Atlas refuses for both or neither. That is a position, not a shortfall, and the
 * gap table below carries the reason. Every case that sets `fails` is listed there.
 */
const testFunctionDescriptor = (id, selector) =>
  Object.freeze({
    kind: 'message-function',
    id,
    operandType: 'number',
    resultType: 'string',
    selector,
    maximumOutputLength: 32,
    // Both of the README's options, declared. `decimalPlaces` was unspellable until the descriptor
    // took MessageFormat's own `name` production; `fails` is declared and deliberately only
    // half-honoured, which the gap table below says and the excluded cases below that show.
    options: Object.freeze({
      decimalPlaces: Object.freeze({
        type: 'integer',
        values: Object.freeze([0, 1]),
      }),
      fails: Object.freeze({
        type: 'string',
        values: Object.freeze(['never', 'select', 'format', 'always']),
      }),
    }),
  });

const registryResult = tk.defineAtlasExtensionRegistry([
  testFunctionDescriptor('test:function', 'exact'),
  testFunctionDescriptor('test:select', 'exact'),
  // "except that it cannot be used for selection": the one part of the three definitions Atlas's
  // descriptor expresses exactly.
  testFunctionDescriptor('test:format', 'none'),
]);
if (!registryResult.ok) {
  throw new Error(
    `Atlas refused the suite's test-function descriptors: ${registryResult.diagnostics
      .map(({ code, summary }) => `${code} ${summary}`)
      .join('; ')}`,
  );
}
const extensionRegistry = registryResult.value;

/**
 * The README's formatting rule, both branches: sign, the truncated absolute integer part, and at
 * `DecimalPlaces` 1 a full stop and one more digit. `floor` throughout, because the text says floor.
 */
const formatTestValue = (input, decimalPlaces) => {
  const sign = input < 0 ? '-' : '';
  const whole = Math.floor(Math.abs(input));
  if (decimalPlaces !== 1) return `${sign}${whole}`;
  return `${sign}${whole}.${Math.floor((Math.abs(input) - whole) * 10)}`;
};

/**
 * The README's Match rule for `:test:function` and `:test:select`, as the ordered key list the
 * runtime now takes.
 *
 * *"If the `Input` is 1 and `DecimalPlaces` is 1, the method will return true for either `'1.0'` or
 * `'1'`"*, and BetterThan *"will return true if `key1` is `'1.0'`"*, so `'1.0'` is written first
 * and the order carries the ranking. At `DecimalPlaces` 0 only `'1'` matches, and for any other
 * input nothing does, which is an empty list rather than an absent one: the value supports
 * selection and matches no key.
 */
const testSelectKeys = (input, decimalPlaces) => {
  if (input !== 1) return [];
  return decimalPlaces === 1 ? ['1.0', '1'] : ['1'];
};

const evaluateTestFunction = ({ operand, options }) => {
  const decimalPlaces = Number(options.decimalPlaces ?? 0);
  // `value` is returned as the text because the descriptor's `resultType` is `string`; without it
  // the operand would be carried forward as the resolved value and fail that contract.
  return {
    text: formatTestValue(operand, decimalPlaces),
    value: formatTestValue(operand, decimalPlaces),
    selectKeys: testSelectKeys(operand, decimalPlaces),
  };
};

// Bound to the registry's own descriptors rather than to a second copy of the literals above. A
// runtime descriptor carries the fingerprint the compiler recorded in the artifact, so a binding
// built from a re-declared literal would be a second source of truth for the one thing the two
// sides use to agree with each other.
const registered = (id) => {
  const descriptor = extensionRegistry.descriptors.find(
    (candidate) => candidate.id === id,
  );
  if (descriptor === undefined) {
    throw new Error(`The extension registry did not keep ${id}.`);
  }
  return descriptor;
};

const extensionBindings = rt.defineRuntimeExtensions([
  {
    descriptor: registered('test:function'),
    evaluate: evaluateTestFunction,
  },
  { descriptor: registered('test:select'), evaluate: evaluateTestFunction },
  {
    descriptor: registered('test:format'),
    // A descriptor declaring `selector: 'none'` must not return `selectKeys`; the runtime refuses
    // the result if it does, which is the contract doing its job.
    evaluate: (invocation) => {
      const { selectKeys: _unusable, ...rest } =
        evaluateTestFunction(invocation);
      return rest;
    },
  },
]);

/**
 * One case, from source text to a formatted string, through the supported surface only.
 *
 * The stage a case stops at is part of the answer rather than an implementation detail. MessageFormat
 * describes one formatter that both rejects and formats; Atlas splits that across a compiler and a
 * runtime, so "the message was refused" is a real outcome and the report says where.
 */
async function evaluateCase(testCase) {
  const locale = testCase.locale;
  const configuration = configurationFor(locale);
  const source = `messages:\n  ${MESSAGE_ID}: ${JSON.stringify(testCase.src)}\n`;

  const parsed = tk.parseAtlasCatalog(source, {
    role: 'source',
    providerId: PROVIDER,
    scopeId: SCOPE,
    locale,
    extensions: extensionRegistry,
  });
  if (!parsed.ok) {
    return {
      stage: 'parse',
      refused: true,
      diagnostics: describe(parsed.diagnostics),
    };
  }

  // The envelope must be transparent before any refusal below it can be read as being about Atlas.
  // A YAML scalar that mangled a backslash, a brace or a newline would produce a message the suite
  // never wrote, and every failure downstream would be about this file.
  const authored = parsed.value.messages[MESSAGE_ID];
  if (authored?.kind !== 'message' || authored.message !== testCase.src) {
    throw new Error(
      `The catalog envelope did not carry ${testCase.file}#${testCase.index} verbatim. ` +
        `Wrote ${JSON.stringify(testCase.src)} and parsed back ${JSON.stringify(authored?.kind === 'message' ? authored.message : authored?.kind)}.`,
    );
  }

  const graph = analyzeAtlasCatalogSet({
    configuration,
    catalogs: [parsed.value],
    extensions: extensionRegistry,
  });
  if (!graph.ok) {
    return {
      stage: 'analyze',
      refused: true,
      diagnostics: describe(graph.diagnostics),
    };
  }
  const compiled = compileAtlasLocalArtifacts({
    owner: {
      providerId: '@neolorn/atlas-verify',
      generatedRootPath: 'src/generated/i18n',
    },
    graph: graph.value,
    catalogs: [parsed.value],
    configuration,
  });
  if (!compiled.ok) {
    return {
      stage: 'compile',
      refused: true,
      diagnostics: describe(compiled.diagnostics),
    };
  }

  const artifacts = compiled.value;
  const catalog = artifacts.catalogs[0];
  const semantic = graph.value.scopes[0].messages[0];
  // The handle is built from the toolkit's own semantic model, not written out here. It is the same
  // object `generateAtlasContracts` emits, from the same fields, so a handle shape that changed
  // would change both together instead of leaving this file describing a contract that moved.
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

  const localization = rt.createLocalizationContext({
    setup: {
      configuration: Object.freeze({
        generatedAbi: 'atlas-generated/1',
        sourceLocale: locale,
        defaultLocale: locale,
        locales: Object.freeze([locale]),
        aliases: Object.freeze({}),
        applicationContractFingerprint:
          artifacts.descriptor.applicationContractFingerprint,
        semanticRegistryFingerprint:
          artifacts.descriptor.semanticRegistryFingerprint,
        // From the graph and the compiled catalog rather than declared empty. A message using a
        // registered function records the descriptor it needs, and the runtime admits the catalog
        // by comparing what it requires against what the configuration declares, so an empty list
        // here would refuse exactly the cases the registry was added for.
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
        [`${PROVIDER}:${SCOPE}:${locale}`]: () => Promise.resolve(catalog),
      },
      extensions: extensionBindings,
    },
    bootstrapScopes: [Object.freeze({ providerId: PROVIDER, scopeId: SCOPE })],
    // Atlas refuses to format a date without an explicit zone, deliberately: a server and a browser
    // that disagree about the ambient zone render the same instant as two different days, and there
    // is no later correction. A consumer supplies one, so a runner that left it unset would be
    // reporting its own omission as fourteen conformance failures. `UTC` because it is the one zone
    // whose answer does not depend on where this runs; the suite's date cases assert that formatting
    // reports no error rather than asserting a particular rendering, so the choice is free.
    formattingContext: Object.freeze({ timeZone: 'UTC' }),
  });

  try {
    await localization.initialize();
    const inputs = marshalInputs(testCase, handle.inputNames);
    const result =
      handle.resultKind === 'plain'
        ? localization.evaluateText(handle, inputs)
        : localization.parts(handle, inputs);
    return {
      stage: 'evaluate',
      refused: false,
      resultKind: handle.resultKind,
      value: result.kind === 'text' ? result.value : result.text,
      diagnostics: (result.diagnostics ?? []).map(({ code, message }) => ({
        code,
        detail: message,
      })),
    };
  } catch (error) {
    return {
      stage: 'evaluate',
      refused: true,
      thrown: true,
      diagnostics: [
        {
          code: error?.diagnostic?.code ?? error?.name ?? 'threw',
          detail: error?.message ?? String(error),
        },
      ],
    };
  } finally {
    localization.dispose();
  }
}

/**
 * The suite's parameters, in the shape the generated contract declares.
 *
 * The suite marks a parameter it means as a date with `"type": "datetime"` and an ISO string, and
 * its own schema says that value "should be converted to a datetime". That conversion is the only
 * one this file performs. Everything else is handed over exactly as the suite wrote it.
 *
 * **Converting on the declared type instead would manufacture passes, and it did.** The first draft
 * also converted whenever Atlas's contract said `date-time`, which meant `{$x :datetime}` with the
 * suite's deliberately bad boolean operand became `new Date(true)`, and Atlas dutifully formatted
 * the first millisecond of 1970 for a case whose whole purpose is to be rejected. Repairing an
 * operand the specification says the formatter must reject is not marshalling; it is answering the
 * question on the implementation's behalf.
 *
 * **The name is a different question from the value, and it goes the other way.** A parameter is
 * addressed by the name the generated contract publishes, because that is the only name a consumer
 * can write: the contract is what they import. Atlas normalizes a variable name to NFC when it
 * compiles, so `.input {$D<combining dots>}` is published under its composed spelling, and passing
 * the suite's decomposed spelling produced "Unknown message input" on a case whose whole subject is
 * that the two spellings are one variable. Matching on the normalized name is speaking the
 * contract's language; the value it carries is still untouched.
 */
function marshalInputs(testCase, declaredNames) {
  const byNormalized = new Map(
    declaredNames.map((name) => [name.normalize('NFC'), name]),
  );
  const inputs = {};
  for (const parameter of testCase.params ?? []) {
    // Falls back to the suite's own spelling, so a parameter the message never declared is still
    // handed over under the name the suite wrote and still reported as unknown.
    const name =
      byNormalized.get(parameter.name.normalize('NFC')) ?? parameter.name;
    inputs[name] =
      parameter.type === 'datetime'
        ? new Date(parameter.value)
        : parameter.value;
  }
  return inputs;
}

/* ------------------------------------------------------------------ *
 * Judging.                                                            *
 * ------------------------------------------------------------------ */

/**
 * What the suite's test functions do that an Atlas extension descriptor still cannot say.
 *
 * There were five of these and there is one. The other four were closed in 3.16, each against the
 * pinned specification rather than against the failing case: the descriptor took MessageFormat's
 * own `name` production for an option name, `MessageFunctionResult.selectKey` became an ordered
 * `selectKeys` so Match and BetterThan are both read off one list, and an extension now inherits
 * its operand's resolved options the way the numeric built-ins already did.
 *
 * What is left is deliberate, and it is the same decision
 * `specs/04-message-authoring-and-catalogs.spec.md` section 6 makes everywhere
 * else. The suite's `fails` option asks a function to fail as a selector but not as a formatter, or
 * the reverse. Honouring it means a message that renders, selects the catch-all, and reports an
 * error while doing so: report-and-continue, which is the permission the standard grants and
 * Atlas declines by name. Atlas has one `evaluate` call that yields the text and the keys together
 * and either succeeds or refuses for both, and that is the position rather than the shortfall: 3.17
 * refused a whole message for a selector that cannot select, and accepting a half-failing function
 * here would contradict it.
 *
 * The six cases below are excluded rather than recorded as divergences because Atlas cannot run
 * them at all: there is no option value that produces a half-failure, so there is no outcome to
 * judge. A case is listed with every gap that stops it, not the first one, so closing one gap never
 * looks like it freed a case another still holds.
 */
const EXTENSION_MODEL_GAPS = Object.freeze({
  'split-failure':
    "the suite's `fails` option makes the function fail as a selector but not as a formatter, or the reverse, while one `evaluate` call produces the text and the select keys together and can only succeed or refuse for both: declined under the compile-time refusal rule rather than unimplemented",
});

const UNRUNNABLE_CASES = Object.freeze({
  'fallback.json#0': ['split-failure'],
  'fallback.json#1': ['split-failure'],
  'pattern-selection.json#12': ['split-failure'],
  'pattern-selection.json#13': ['split-failure'],
  'pattern-selection.json#20': ['split-failure'],
});

const excludedFor = (testCase) =>
  UNRUNNABLE_CASES[`${testCase.file}#${testCase.index}`];

/**
 * `expErrors: []` is an assertion, not an absence.
 *
 * Eight of the sixteen files declare it in `defaultTestProperties`, which is the suite's way of
 * saying "this case must format without reporting anything". Reading it as "no expectation" would
 * have made a case that produced a diagnostic look unjudged, and unjudged is indistinguishable from
 * passing in a count, which is the exact failure this item exists to prevent.
 */
function judge(testCase, outcome) {
  const errors = testCase.expErrors;
  const expectsError = Array.isArray(errors) && errors.length > 0;
  const assertsNoError = Array.isArray(errors) && errors.length === 0;
  const hasExpectation = typeof testCase.exp === 'string';

  if (outcome.refused) {
    // MessageFormat's formatter reports an error *and* still produces a fallback string. A compiled
    // system refuses the message instead, and where the suite expects only an error the two agree
    // about the message being invalid.
    if (expectsError && !hasExpectation) return 'pass';
    if (expectsError) return 'refused-with-expected-output';
    return 'refused';
  }

  const quiet = outcome.diagnostics.length === 0;
  if (hasExpectation && outcome.value !== testCase.exp) return 'mismatch';
  if (expectsError && quiet) return 'accepted-invalid';
  if (assertsNoError && !quiet) return 'accepted-with-diagnostic';
  if (!hasExpectation && !expectsError && !assertsNoError) {
    return 'unjudged';
  }
  return 'pass';
}

/* ------------------------------------------------------------------ *
 * Run.                                                                *
 * ------------------------------------------------------------------ */

const cases = loadCases();

// The same question again, on the exclusion list rather than on the loader. The list is now ten
// named ids instead of a substring match, so the way it can go wrong has changed: an id that
// names no case
// excludes nothing and reads as a clean run, and a gap key nothing points at reads as coverage of a
// limit this file stopped measuring. Both are checked, and so is the suite-side count that decides
// how many cases the extension registration was supposed to recover.
{
  const ids = new Set(cases.map(({ file, index }) => `${file}#${index}`));
  const unmatched = Object.keys(UNRUNNABLE_CASES).filter((id) => !ids.has(id));
  if (unmatched.length > 0) {
    throw new Error(
      `Excluded case ids that name no case in the suite: ${unmatched.join(', ')}.`,
    );
  }
  const claimed = new Set(Object.values(UNRUNNABLE_CASES).flat());
  const unused = Object.keys(EXTENSION_MODEL_GAPS).filter(
    (gap) => !claimed.has(gap),
  );
  if (unused.length > 0) {
    throw new Error(
      `Extension-model gaps that no excluded case attributes to them: ${unused.join(', ')}.`,
    );
  }
  const undeclared = [...claimed].filter(
    (gap) => EXTENSION_MODEL_GAPS[gap] === undefined,
  );
  if (undeclared.length > 0) {
    throw new Error(
      `Excluded cases attributed to gaps with no reason: ${undeclared.join(', ')}.`,
    );
  }
  const usingTestFunctions = cases.filter((testCase) =>
    [':test:function', ':test:select', ':test:format'].some((name) =>
      testCase.src.includes(name),
    ),
  ).length;
  if (usingTestFunctions !== 25) {
    throw new Error(
      `Expected 25 cases to use the suite's three defined test functions and found ${usingTestFunctions}. ` +
        'Counted at the pinned revision; a re-pin that moves it should move this number with it. ' +
        "(A twenty-sixth spelling, :test:undefined, is the suite's deliberately absent function and must run.)",
    );
  }
}

const records = [];
for (const testCase of cases) {
  const gaps = excludedFor(testCase);
  if (gaps !== undefined) {
    records.push({
      file: testCase.file,
      index: testCase.index,
      src: testCase.src,
      verdict: 'excluded',
      gaps,
      reasons: gaps.map((gap) => EXTENSION_MODEL_GAPS[gap]),
    });
    continue;
  }
  const outcome = await evaluateCase(testCase);
  const verdict = judge(testCase, outcome);
  records.push({
    file: testCase.file,
    index: testCase.index,
    src: testCase.src,
    locale: testCase.locale,
    bidiIsolation: testCase.bidiIsolation ?? 'default',
    expected: testCase.exp,
    expectedErrors: (testCase.expErrors ?? []).map(({ type }) => type),
    verdict,
    stage: outcome.stage,
    actual: outcome.value,
    diagnostics: outcome.diagnostics ?? [],
  });
}

const reportPath = resolve(
  workspaceRoot,
  'tmp/message-format-conformance-report.json',
);
writeFileSync(reportPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');

const counts = new Map();
for (const { verdict } of records) {
  counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
}
process.stdout.write('\n=== MessageFormat 2 conformance (LDML48.2)\n');
for (const [verdict, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`${String(count).padStart(4)}  ${verdict}\n`);
}
process.stdout.write(
  `\nReport written to ${relative(workspaceRoot, reportPath).replaceAll('\\', '/')}\n`,
);

/* ------------------------------------------------------------------ *
 * The gate.                                                           *
 * ------------------------------------------------------------------ */

/**
 * A hundred and twenty-three cases do not pass, and every one of them is written down.
 *
 * That is what makes this a gate rather than a report. A count of failures tells you nothing the
 * next time it changes: a case that started failing and a case that stopped are the same arithmetic.
 * So the baseline names each one with the class it belongs to and the reason that class exists, and
 * four different things fail this run: a case that regressed, a case that was fixed and left
 * listed, a case whose divergence changed shape, and a class nothing refers to any more.
 *
 * There is no `--capture`, because a baseline something can move for you has only ever been moved
 * in the direction that passes, and here the reasons are prose about specific behaviour that no
 * command could write. When this fails it prints what to add.
 */
const baseline = JSON.parse(
  readFileSync(
    resolve(workspaceRoot, 'tools/message-format-conformance-baseline.json'),
    'utf8',
  ),
);

const failures = [];
const referenced = new Set();
for (const record of records) {
  if (record.verdict === 'excluded') continue;
  const id = `${record.file}#${record.index}`;
  const known = baseline.cases[id];
  if (known === undefined) {
    if (record.verdict !== 'pass') {
      failures.push(
        `${id} now ${record.verdict} and is not in the baseline.\n` +
          `      src      ${JSON.stringify(record.src)}\n` +
          `      expected ${JSON.stringify(record.expected)}\n` +
          `      actual   ${JSON.stringify(record.actual)}\n` +
          `      ${record.diagnostics.map(({ code, detail }) => `${code} ${detail}`).join('; ')}`,
      );
    }
    continue;
  }
  referenced.add(known.class);
  if (record.verdict === 'pass') {
    failures.push(
      `${id} passes now. It is listed as ${known.verdict} under "${known.class}"; take it out, and take the class out with it if it was the last one.`,
    );
    continue;
  }
  if (record.verdict !== known.verdict) {
    failures.push(
      `${id} is listed as ${known.verdict} under "${known.class}" and is now ${record.verdict}.`,
    );
    continue;
  }
  if (known.verdict === 'mismatch' && record.actual !== known.actual) {
    failures.push(
      `${id} still mismatches but differently: was ${JSON.stringify(known.actual)}, now ${JSON.stringify(record.actual)}.`,
    );
  }
}

// The same question on the baseline itself. A class whose last case was fixed leaves prose behind
// that reads like a live divergence, and nothing else in this run would notice.
for (const name of Object.keys(baseline.classes)) {
  if (!referenced.has(name)) {
    failures.push(
      `The baseline class "${name}" has no cases left. Its divergence is gone; remove the class.`,
    );
  }
}

const standings = new Map();
for (const { class: name } of Object.values(baseline.cases)) {
  const standing = baseline.classes[name]?.standing ?? 'unknown';
  standings.set(standing, (standings.get(standing) ?? 0) + 1);
}
process.stdout.write('\n=== Recorded divergences\n');
for (const [standing, count] of [...standings].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`${String(count).padStart(4)}  ${standing}\n`);
}

if (failures.length > 0) {
  process.stdout.write('\n=== FAILURES\n');
  for (const failure of failures) process.stdout.write(`  ${failure}\n`);
  process.stdout.write(`\n${failures.length} conformance failures\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nEvery case passes or is a recorded divergence.\n');
}

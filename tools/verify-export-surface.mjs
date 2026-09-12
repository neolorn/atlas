/**
 * Is every published export reachable from something that is not a throwaway?
 *
 * The corpus is Atlas only, and the export list is read from the built declaration files. It
 * needs `build`.
 *
 * Two rules the corpus has to keep. A scan that counts throwaway files holds exports "used" on
 * evidence that disappears the day those files are cleaned away, and for a scratch directory
 * that day is always coming. And it must not read a consumer repository: a gate in a
 * product-neutral package cannot need a consumer to exist in order to verify itself.
 *
 * Statuses:
 *   consumer    a fixture consumer or its generated output names it
 *   exercised   a gate or a workspace test names it, but no consumer does
 *   structural  a consumer arrives at it by following the surface out of something the corpus
 *               already names, so it has to be nameable even though nothing names it yet
 *   candidate   none of the above
 *
 * A candidate that is not in BASELINE fails this gate. That is the point: the previous shape of this
 * question was a count, and a count is a ceiling that new dead surface fits under.
 *
 * `specs/12-verification.spec.md` section 7 covers the whole family: a type nothing
 * instantiates, a guard nothing crosses and an export nothing reaches are one defect, and each
 * of them compiles.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reachablePublishedNames } from './export-reachability.mjs';
import { publishedNames, runtimeDeclarations } from './published-surface.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Exports nothing reaches, accepted and listed by name.
 *
 * By name and never by count, so that a newly unreachable export fails this gate instead of taking
 * a freed slot under a ceiling. An entry that stops being a candidate must be removed, and the gate
 * says so rather than letting the list rot into a second copy of the surface.
 *
 * Two names, each published on purpose and each invisible to this corpus for a reason stated here
 * rather than deferred. A name reached through a signature a consumer binds, such as
 * `LabelAttribute` or `LocaleUrlResolutionSetup`, does not belong on this list: an occurrence
 * proxy cannot see that use, and the answer is a gate that can rather than an entry admitting it
 * cannot.
 */
const BASELINE = Object.freeze({
  // The plugin half of the extension contract: a plugin calls this to tell the compiler about the
  // same descriptors `defineRuntimeExtensions` registers at runtime, and
  // `docs/how-to/extend-atlas.md` is where that is written down. This corpus does not read `docs`,
  // deliberately, because a name in prose is not a use. The fixture declares its extensions in
  // `atlas.extensions.json` instead, which is the other supported way and exercises the parser
  // rather than the builder.
  atlasExtensionDescriptor:
    'toolkit API; the plugin surface the extension guide documents',
  // The project-host compile, beside the seven other verbs the programmatic API publishes. Those
  // seven are reached and this one is not, because Atlas's own gates drive compilation through the
  // command line rather than through the host API. The programmatic API mirrors the command line,
  // so publishing every verb but one would be a surface a caller cannot predict.
  compileAtlasProjectFromDisk:
    'toolkit API; the compile verb, beside the seven the corpus reaches',
});

const CORPUS = Object.freeze([
  {
    label: 'lab',
    dirs: ['fixtures/package-consumer-template/src'],
    consumer: true,
  },
  {
    label: 'minimal',
    dirs: ['fixtures/minimal-package-consumer-template/src'],
    consumer: true,
  },
  {
    label: 'analysis-fixtures',
    dirs: ['fixtures/semantic-analysis'],
    consumer: true,
  },
  { label: 'gates', dirs: ['tools'], consumer: false },
  { label: 'toolkit-tests', dirs: ['packages/toolkit/test'], consumer: false },
  { label: 'runtime-tests', dirs: ['packages/runtime/test'], consumer: false },
]);

/**
 * The corpus above names test directories by hand, and a hand-written list of directories is the
 * shape that goes quietly wrong.
 *
 * Atlas keeps source in five places, not one: `packages/runtime/src` plus the secondary entry
 * points beside it (`router`, `forms`, `testing`) and `packages/toolkit/src`. A scan aimed at
 * one of them finds nothing in the other four and reports that as nothing existing. That is not a
 * hypothetical: a grep scoped to `packages/runtime/src/*.ts` returned empty for two
 * symbols that were alive six hundred lines into `packages/runtime/router/src/public-api.ts`, and
 * the empty result was read as evidence they had been deleted.
 *
 * The general rule, which is what makes this worth enforcing rather than remembering: **an empty
 * result is the output of an instrument nobody calibrated.** A wrong root, a mistyped pattern and
 * a wrong `--include` all produce the same silence, and silence read as absence is a wrong answer
 * that arrives with no failure attached to notice. So a scan states the ground it covers, and
 * something checks that the ground is all of it.
 *
 * Here that check is cheap: every `test` directory under `packages/` must appear in CORPUS. A new
 * entry point that brings its own tests fails this on the day it lands rather than silently
 * contributing no evidence of use, which would let a genuinely reachable export read as dead.
 */
function packageTestDirectories() {
  const found = [];
  for (const pkg of readdirSync(join(workspaceRoot, 'packages'))) {
    for (const [relative] of [
      [`packages/${pkg}/test`],
      ...readdirSync(join(workspaceRoot, 'packages', pkg))
        .filter((entry) => {
          try {
            return statSync(
              join(workspaceRoot, 'packages', pkg, entry),
            ).isDirectory();
          } catch {
            return false;
          }
        })
        .map((entry) => [`packages/${pkg}/${entry}/test`]),
    ]) {
      try {
        if (statSync(join(workspaceRoot, relative)).isDirectory()) {
          found.push(relative);
        }
      } catch {
        // Not every package or entry point has tests.
      }
    }
  }
  return found;
}

const listedDirectories = new Set(CORPUS.flatMap((source) => source.dirs));
const unlisted = packageTestDirectories().filter(
  (directory) => !listedDirectories.has(directory),
);
assert.deepEqual(
  unlisted,
  [],
  `These test directories exist and are not in CORPUS, so nothing they reference counts as use: ${unlisted.join(', ')}`,
);

/**
 * Source with its comments removed, because a name written in prose is not a use of it.
 *
 * Both halves of this gate were counting documentation as evidence, and both were wrong the same
 * way. On the declaration side, the occurrence count that decides `structural` read the whole
 * `.d.ts`, so a doc comment naming a sibling export counted as that sibling being used: documenting
 * six toolkit exports moved two of them out of `candidate`, and the gate failed them as "no longer
 * unreferenced" when nothing had begun to reference them. On the corpus side, the same thing is
 * reachable by accident and worse: a baselined candidate would silently resolve the day anyone
 * wrote its name in a comment in `tools/`, a fixture or a test, which is a thing people do when
 * they are explaining why an export exists.
 *
 * The perverse part is the direction of it. Writing down what an export is for made the gate stop
 * tracking it, so it punished exactly the work it should have been indifferent to.
 *
 * Only block comments and whole-line `//` comments go. A `//` inside a string is ordinary in both
 * source and a `.d.ts` (`'https://...'`), and taking the rest of that line would corrupt a real
 * reference. The residual risk runs the safe way: anything this removes that it should not lowers a
 * count, which turns an export into a `candidate` and fails this gate loudly, rather than into a
 * `structural` or an `exercised` that nobody has to look at.
 *
 * HTML is left alone. Its comments are a different syntax, and `//` in an `href` is not one.
 */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^[^\S\n]*\/\/[^\n]*$/gmu, '');
}

const SKIP = new Set(['node_modules', 'dist', '.angular', '.atlas', 'tmp']);

function readAll(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(join(workspaceRoot, dir));
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const relative = `${dir}/${name}`;
    let stats;
    try {
      stats = statSync(join(workspaceRoot, relative));
    } catch {
      continue;
    }
    if (stats.isDirectory()) readAll(relative, out);
    // This file is in the `tools` corpus, and BASELINE below names every accepted candidate. Left
    // in, the gate reads its own baseline as evidence of use and reports every entry as resolved,
    // which is not a use, it is a record that there is none.
    else if (name === 'verify-export-surface.mjs') continue;
    else if (/\.(ts|mjs|js|html)$/u.test(name) && !name.endsWith('.d.ts')) {
      out.push({
        html: name.endsWith('.html'),
        text: readFileSync(join(workspaceRoot, relative), 'utf8'),
      });
    }
  }
  return out;
}

const corpus = new Map();
// Kept only so the stripper can be checked against what it was given. An empty result says as
// little about a filter as about a search: one that silently removed nothing would restore the
// defect it exists for and every count below would be exactly what it was, with nothing to
// notice.
let rawScript = '';
let strippedScript = '';
for (const source of CORPUS) {
  const files = source.dirs.flatMap((dir) => readAll(dir));
  const text = files
    .map(({ html, text: body }) => (html ? body : withoutComments(body)))
    .join('\n');
  assert.notEqual(
    text.length,
    0,
    `Corpus "${source.label}" is empty, so this gate would report every export it contains as unused.`,
  );
  for (const { html, text: body } of files) {
    if (html) continue;
    rawScript += body;
    strippedScript += withoutComments(body);
  }
  corpus.set(source.label, text);
}
assert.ok(
  rawScript.includes('/**'),
  'No file in any corpus carries a doc comment, so the comment stripper is being tested on nothing. This gate reads the wrong files.',
);
assert.ok(
  !strippedScript.includes('/**') && strippedScript.length < rawScript.length,
  'The comment stripper left documentation in the corpus, so a name written in a comment still counts as a use of the export it names.',
);
const consumerLabels = new Set(
  CORPUS.filter(({ consumer }) => consumer).map(({ label }) => label),
);

// Read from the build output rather than listed here.
//
// This was four filenames written out by hand, and adding the `ssr` entry point is what showed
// the cost: a new entry point ships with its whole export surface unaudited, and the gate stays
// green because it never knew to look. That is the rule that makes a search start at `packages/`,
// an entry point added later is covered the day it lands, applied to the place that reads what
// those entry points built.
//
// Shared with the reference page generator and the guide coverage gate, which ask their own
// questions of the same set. An empty or renamed output directory throws there rather than letting
// every check below pass on nothing, and a discovered list is exactly the shape that fails that way
// silently.
const RUNTIME_DECLARATIONS = runtimeDeclarations();

const declarationSets = [
  ...RUNTIME_DECLARATIONS,
  {
    entryPoint: 'toolkit',
    // The barrel, because it is what the package publishes: `exports["."].types` names it.
    text: readFileSync(join(workspaceRoot, 'dist/toolkit/index.d.ts'), 'utf8'),
  },
];

// Structural use is counted over *every* declaration file the package ships, not only the entry
// point. The toolkit's `index.d.ts` is a barrel of re-exports: a type named in another export's
// signature is named in the sibling file that declares it, so scanning the barrel alone reports
// almost every toolkit type as unreferenced.
const runtimeText = RUNTIME_DECLARATIONS.map(({ text }) => text).join('\n');
const toolkitText = readdirSync(join(workspaceRoot, 'dist/toolkit'))
  .filter((file) => file.endsWith('.d.ts'))
  .map((file) =>
    readFileSync(join(workspaceRoot, 'dist/toolkit', file), 'utf8'),
  )
  .join('\n');

/** Which corpora name a given export, read once so the reachability seed and the rows agree. */
const namedBy = new Map();
for (const { text } of declarationSets) {
  for (const name of publishedNames(text)) {
    if (namedBy.has(name)) continue;
    const word = new RegExp(`\\b${name}\\b`, 'gu');
    const seen = [];
    for (const [label, body] of corpus) {
      word.lastIndex = 0;
      if (word.test(body)) seen.push(label);
    }
    namedBy.set(name, seen);
  }
}

// Resolved rather than counted; `export-reachability.mjs` says why the count was the wrong
// instrument. The seed is the set above, so what comes back is everything a consumer arrives at by
// following the surface out of something Atlas's own consumers, gates and tests already hold.
const { reached, seeded } = reachablePublishedNames(
  (name) => (namedBy.get(name) ?? []).length > 0,
);
assert.ok(
  seeded > 50,
  `Only ${seeded} published export(s) seeded the reachability walk, so almost nothing could be reached through a signature and the whole surface would read as dead. The corpus scan above found nothing.`,
);

const rows = [];
for (const { entryPoint, text } of declarationSets) {
  for (const name of publishedNames(text)) {
    const seen = namedBy.get(name) ?? [];
    const byConsumer = seen.filter((label) => consumerLabels.has(label));
    rows.push({
      entryPoint,
      name,
      seen,
      status:
        byConsumer.length > 0
          ? 'consumer'
          : seen.length > 0
            ? 'exercised'
            : reached.has(name)
              ? 'structural'
              : 'candidate',
    });
  }
}

/**
 * A published function must not require an argument nobody can produce.
 *
 * Stated in general, because the specific instance is not interesting on its own.
 * `cache?: FormatterCache` sat on twenty exported signatures for months: a `declare class` with
 * private members, so nominally typed and unwritable as an object literal, and absent from the
 * export list, so unobtainable by name. Nothing a consumer could pass would type-check. The
 * parameter read as an option and was a dead end, and no gate here would have said so.
 *
 * **Nominal is the whole distinction, and it is why this is not "any unexported type".** A type is
 * unconstructable when it is a class carrying a `private` or `protected` member: TypeScript compares
 * those by declaration rather than by shape, so no object literal satisfies one. An unexported
 * *interface* is merely unnameable: a consumer can still write the object and pass it, and
 * failing on that would fail on parameters consumers call every day.
 *
 * **And unobtainable is the other half.** A nominal class a consumer cannot name is a perfectly good
 * opaque handle when some exported signature hands one back: receive it, pass it on, never name it.
 * So the failure is a nominal unexported class that appears in a parameter position and in no return
 * position anywhere on the surface. That is the shape with no way in.
 */
function nominalClasses(text) {
  const found = new Set();
  const heads = /declare (?:abstract )?class (\w+)[^{]*\{/gu;
  let head;
  while ((head = heads.exec(text)) !== null) {
    let depth = 0;
    let end = text.length;
    for (let at = heads.lastIndex - 1; at < text.length; at += 1) {
      if (text[at] === '{') depth += 1;
      else if (text[at] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = at;
          break;
        }
      }
    }
    if (
      /(?:^|\n)\s*(?:private|protected)\s/u.test(
        text.slice(heads.lastIndex, end),
      )
    ) {
      found.add(head[1]);
    }
  }
  return found;
}

/**
 * Split every signature in a declaration file into what it takes and what it gives back.
 *
 * One level of nesting is allowed inside the parameter list, which covers a function-typed
 * parameter. Anything deeper is not parsed rather than parsed wrongly: a signature this misses
 * contributes nothing, and the control below is what stops "misses everything" reading as "clean".
 */
function signatureHalves(text) {
  const parameters = [];
  const returns = [];
  const signature = /\(((?:[^()]|\([^()]*\))*)\)\s*:\s*([^;{]*)/gu;
  let match;
  while ((match = signature.exec(text)) !== null) {
    parameters.push(match[1]);
    returns.push(match[2]);
  }
  return { parameters: parameters.join('\n'), returns: returns.join('\n') };
}

// Once per package rather than once per entry point, and the export set is the union.
//
// The runtime's entry points share one declaration corpus, so a per-entry-point loop reports the
// same defect five or seven times over, and worse, it reads a class exported from the primary as
// unexported while scanning the core, when a consumer who can import it from one entry point can
// obtain it for all of them. The package boundary is the real one here; the entry-point boundary is
// not.
const unreachable = [];
let nominalSeen = 0;
for (const [pkg, declarations, published] of [
  [
    'runtime',
    runtimeText,
    new Set(
      RUNTIME_DECLARATIONS.flatMap(({ text }) => [...publishedNames(text)]),
    ),
  ],
  ['toolkit', toolkitText, publishedNames(toolkitText)],
]) {
  const halves = signatureHalves(declarations);
  for (const name of nominalClasses(declarations)) {
    nominalSeen += 1;
    if (published.has(name)) continue;
    const word = new RegExp(`\\b${name}\\b`, 'u');
    if (word.test(halves.parameters) && !word.test(halves.returns)) {
      unreachable.push({ pkg, name });
    }
  }
}

// The assertion this scan needs most. A regex that matched nothing (a changed
// declaration layout, a renamed output directory) would report a clean surface, and a clean
// surface is what this is trying to establish. Ten nominal classes are published today across the
// runtime entry points, all of them Angular services and pipes a consumer receives through DI.
assert.ok(
  nominalSeen >= 5,
  `Only ${nominalSeen} nominal class(es) found across the shipped declarations, which is fewer than the runtime is known to publish. The class scan has stopped matching, so the unconstructable-parameter check below is passing on an empty set.`,
);
assert.deepEqual(
  unreachable,
  [],
  `A published signature requires a parameter no consumer can produce: ${unreachable
    .map(({ pkg, name }) => `${pkg} / ${name}`)
    .join(
      ', ',
    )}. The type is a class with private members, so it cannot be written as an object literal, and nothing published returns one or names it. Export it, hand one back, or take it off the signature.`,
);

// Controls, so a broken matcher cannot report a clean surface quietly. One in each direction.
const statusOf = (name) => rows.find((row) => row.name === name)?.status;
assert.equal(
  statusOf('LocalizePipe'),
  'consumer',
  'Control failed: LocalizePipe is used by the feature lab, so a trace that cannot see it is broken.',
);
assert.notEqual(
  statusOf('formatNumberRange'),
  undefined,
  'Control failed: formatNumberRange is published, so a trace that cannot find it is broken.',
);
// The case the occurrence proxy got wrong, kept as a control on the walk that replaced it.
// `LabelAttribute` is written twice in the shipped declarations and is the type of the attribute
// the label directive binds, so a walk that cannot see it has stopped resolving.
assert.equal(
  statusOf('LabelAttribute'),
  'structural',
  'Control failed: LabelAttribute is the type of the attribute the label directive binds, so it is reachable from an export the fixtures use.',
);

const counts = {};
for (const { status } of rows) counts[status] = (counts[status] ?? 0) + 1;
process.stdout.write(`${rows.length} published exports traced\n`);
for (const [status, count] of Object.entries(counts).sort(
  (a, b) => b[1] - a[1],
)) {
  process.stdout.write(`  ${status.padEnd(12)} ${String(count).padStart(4)}\n`);
}

const candidates = rows.filter(({ status }) => status === 'candidate');
const unexpected = candidates.filter(
  ({ name }) => BASELINE[name] === undefined,
);
const resolved = Object.keys(BASELINE).filter(
  (name) => !candidates.some((row) => row.name === name),
);

if (unexpected.length > 0) {
  process.stdout.write('\nNothing names these, and no signature needs them:\n');
  for (const { entryPoint, name } of unexpected) {
    process.stdout.write(`  ${entryPoint} / ${name}\n`);
  }
}
if (resolved.length > 0) {
  process.stdout.write(
    '\nBaselined but no longer unreferenced. Remove from BASELINE:\n',
  );
  for (const name of resolved) process.stdout.write(`  ${name}\n`);
}

assert.equal(
  unexpected.length,
  0,
  `${unexpected.length} published export(s) are named by no consumer, gate or test, and are not in the accepted baseline. Reach them, unpublish them, or add them to BASELINE with the reason.`,
);
assert.equal(
  resolved.length,
  0,
  `${resolved.length} baselined export(s) are now referenced. Remove them from BASELINE so it keeps meaning what it says.`,
);

/**
 * Shapes that were collapsed into another one, and must not come back.
 *
 * A duplicated declaration site is not fixed by adding a cross-check between the two copies: that
 * keeps both and adds a third thing to maintain. It is fixed by one of them ceasing to exist, and
 * this is where that is asserted, on the published types rather than on the source, because the
 * published types are what a consumer can actually write against.
 *
 * Each entry names the interface, the members that were retired from it, and what replaced them, so
 * a failure says what to do rather than only that something is wrong.
 */
const RETIRED_MEMBERS = [
  {
    entryPoint: 'neolorn-atlas',
    interfaceName: 'RoutingOptions',
    members: ['localizedPaths', 'parameters', 'historical'],
    replacement:
      'the single `projection` field, which carries all three: pass the object built by ' +
      '`defineRouteProjection()` instead of restating its contents',
  },
];

for (const {
  entryPoint,
  interfaceName,
  members,
  replacement,
} of RETIRED_MEMBERS) {
  const declaration = RUNTIME_DECLARATIONS.find(
    (candidate) => candidate.entryPoint === entryPoint,
  );
  assert.notEqual(
    declaration,
    undefined,
    `${entryPoint} publishes no declaration file, so this check proves nothing.`,
  );
  const body = new RegExp(
    `interface ${interfaceName} \\{[\\s\\S]*?\\n\\}`,
    'u',
  ).exec(declaration.text);
  // The place an empty result deceives hardest: an absent member and an absent interface read
  // identically to a substring search, so the interface has to be found before its emptiness means
  // anything.
  assert.notEqual(
    body,
    null,
    `${interfaceName} is not in the published ${entryPoint} types, so "its members are gone" would pass for the wrong reason.`,
  );
  for (const member of members) {
    assert.equal(
      new RegExp(`readonly ${member}[?]?:`, 'u').test(body[0]),
      false,
      `${interfaceName}.${member} is published again. It was retired in favour of ${replacement}.`,
    );
  }
}

process.stdout.write(
  `\nAtlas export surface verified: ${candidates.length} accepted candidate(s), all named in the baseline.\n`,
);

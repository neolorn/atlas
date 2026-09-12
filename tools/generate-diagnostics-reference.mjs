/**
 * The diagnostics reference, written from the union that declares the codes.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 12 says Atlas's diagnostic codes are stable and
 * documented, and the second half of that was not true: no `ATL` code appeared anywhere in
 * `specs/`, and codes were built, argued and measured with nothing naming them. A list written
 * into a specification would not have made it true either: a hand-kept list of every code is a
 * second source, and it drifts from the union on the first commit that adds one.
 *
 * So the reference is derived, the same way `cli-options.generated.ts` is derived from the
 * configuration schema and `locale-profile.generated.ts` from `cldr-core`. The one hand-written
 * thing is the sentence per code, which lives in `packages/toolkit/src/diagnostic-reference.ts`
 * beside the union it is checked against: `satisfies Record<AtlasDiagnosticCode, string>` fails the
 * typecheck for a code with no sentence and for a sentence with no code, by name, in both
 * directions. This file turns that table into the document a reader gets, and `--check` fails when
 * the checked-in copy no longer matches.
 *
 * ## What this asserts beyond rendering
 *
 * Two things the type system cannot see.
 *
 * **Every section has codes and every code has a section.** The section is read off the code's own
 * number, so a new code joins a section by being numbered; a new *block* with no section title fails
 * here, and a title no code uses fails here too.
 *
 * **Every documented code is raised somewhere.** A code that nothing emits is a documented promise
 * with nothing behind it, and the union cannot notice one. The scan is over every `src` directory
 * under `packages/`, because the runtime publishes entry points beside its own, and it is checked
 * for non-vacuity before its emptiness is read:
 * a scan that matched nothing at all would report every code as unraised and look like a finding.
 *
 * ## Running it
 *
 * Reads `dist/toolkit/diagnostic-reference.js`, so it needs `build`. Nothing in the table derives
 * from the document, so a stale document still compiles and the loop is `build`, generate, `build`.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { format, resolveConfig } from 'prettier';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtReference = resolve(
  workspaceRoot,
  'dist/toolkit/diagnostic-reference.js',
);
const documentPath = resolve(workspaceRoot, 'packages/toolkit/DIAGNOSTICS.md');
// The same table, web readable. The package copy is what a reader with an install can open with
// no network; this is what a reader who has not installed anything yet can. Both come out of
// this run, so neither can describe a code union the other does not.
const webDocumentPath = resolve(workspaceRoot, 'docs/reference/diagnostics.md');
const check = process.argv.includes('--check');

let reference;
try {
  reference = await import(pathToFileURL(builtReference).href);
} catch (error) {
  throw new Error(
    `Could not read ${builtReference}. This generator reads the built table rather than the source, so run pnpm run build first. (${error?.message ?? error})`,
  );
}

const { ATLAS_DIAGNOSTIC_REFERENCE, ATLAS_DIAGNOSTIC_SECTIONS } = reference;
const codes = Object.keys(ATLAS_DIAGNOSTIC_REFERENCE).sort();
assert.ok(
  codes.length > 0,
  'The built diagnostics table is empty, so nothing below means anything.',
);

/* ------------------------------------------------------------------ *
 * Sections, both ways.                                                *
 * ------------------------------------------------------------------ */

const sectionOf = (code) => code.slice(3, 5);
const used = new Set(codes.map(sectionOf));
for (const section of used) {
  assert.ok(
    typeof ATLAS_DIAGNOSTIC_SECTIONS[section] === 'string',
    `Codes ATL${section}xx exist and no section is titled "${section}". Add one to ATLAS_DIAGNOSTIC_SECTIONS.`,
  );
}
for (const section of Object.keys(ATLAS_DIAGNOSTIC_SECTIONS)) {
  assert.ok(
    used.has(section),
    `Section "${section}" is titled and no code uses it. Take it out; the sections follow the codes.`,
  );
}

/* ------------------------------------------------------------------ *
 * Every documented code is raised somewhere.                          *
 * ------------------------------------------------------------------ */

function sourceFiles(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      sourceFiles(path, found);
    } else if (/\.ts$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

// Every `src` under `packages/`, so an entry point added later is covered the day it lands.
const roots = readdirSync(resolve(workspaceRoot, 'packages'), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(workspaceRoot, 'packages', entry.name, 'src'));
assert.ok(roots.length > 0, 'No package source roots were found.');

// The two files that name codes without raising them: the union that declares them, and the table
// that describes them. A code appearing only there is a code nothing can produce.
const DECLARATIONS = new Set(['diagnostics.ts', 'diagnostic-reference.ts']);
const raised = new Map(codes.map((code) => [code, []]));
let occurrences = 0;
let scanned = 0;
for (const root of roots) {
  for (const file of sourceFiles(root)) {
    if (DECLARATIONS.has(file.split(/[\\/]/u).at(-1))) continue;
    scanned += 1;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/'(ATL\d{4})'/gu)) {
      occurrences += 1;
      raised.get(match[1])?.push(relative(workspaceRoot, file));
    }
  }
}

// The scan is shown to have read something, before the empty results below are read as findings.
assert.ok(scanned > 0, 'The source scan read no files.');
assert.ok(
  occurrences > 0,
  'The source scan matched no diagnostic code at all, so "raised nowhere" below would be its own failure rather than a finding.',
);
const unraised = codes.filter((code) => raised.get(code).length === 0);
assert.deepEqual(
  unraised,
  [],
  `Documented but raised nowhere in packages/*/src: ${unraised.join(', ')}. A code nothing emits is a promise with nothing behind it.`,
);

/* ------------------------------------------------------------------ *
 * The document.                                                       *
 * ------------------------------------------------------------------ */

const sections = [...used].sort();

const body = [];
for (const section of sections) {
  body.push(`## ${ATLAS_DIAGNOSTIC_SECTIONS[section]}`, '');
  for (const code of codes.filter((each) => sectionOf(each) === section)) {
    body.push(`### ${code}`, '', ATLAS_DIAGNOSTIC_REFERENCE[code], '');
  }
}

const lines = [
  '# Atlas diagnostics',
  '',
  'Every code `@neolorn/atlas-toolkit` can report, and what it means. A diagnostic carries its own',
  'summary saying what happened at the place it happened; this says what the code is about.',
  '',
  '**Generated.** The list comes from the `AtlasDiagnosticCode` union and the sentences from the',
  'table beside it, and the gate re-renders this file and fails when it differs. Do not edit it here:',
  'edit `packages/toolkit/src/diagnostic-reference.ts`, which the compiler checks against the union in',
  'both directions.',
  '',
  '**Severity is not listed, on purpose.** Several codes carry the severity a run decides: the',
  "completeness family and `ATL1704` are advisory or blocking depending on the command's switches and",
  "the project's own declarations, so a severity written here would be wrong for exactly the codes",
  'most worth looking up. What a run does with a finding is decided on severity, and the finding says',
  'which one it carries.',
  '',
];

const document = `${[...lines, ...body].join('\n').trimEnd()}\n`;

const webDocument = `${[
  '# Diagnostics',
  '',
  'Every code `@neolorn/atlas-toolkit` reports, and what it means. A diagnostic carries its own',
  'summary describing what happened where it happened; this table describes the code.',
  '',
  'This page is generated from the code union and is not edited by hand. The same table ships inside',
  'the package as `DIAGNOSTICS.md`, readable from an install with no network.',
  '',
  'Severity is not listed. Several codes carry the severity the run decides: the completeness family',
  "and `ATL1704` are advisory or blocking depending on the command's switches and the project's own",
  'declarations. A finding states the severity it carries, and a run acts on that.',
  '',
  'What a diagnostic contains, and what it never contains, is',
  '[About diagnostics and runtime outcomes](../explanation/about-diagnostics.md).',
  '',
  ...body,
]
  .join('\n')
  .trimEnd()}\n`;

// Formatted the way every other document here is formatted, so the formatting check and this
// one cannot want two different files.
const prettierOptions = {
  ...((await resolveConfig(webDocumentPath)) ?? {}),
  parser: 'markdown',
};

const written = [
  [documentPath, document],
  [webDocumentPath, await format(webDocument, prettierOptions)],
];

if (check) {
  for (const [target, expected] of written) {
    let current;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      throw new Error(
        `${relative(workspaceRoot, target)} is missing. Run pnpm run generate:diagnostics-reference.`,
      );
    }
    assert.equal(
      current.replaceAll('\r\n', '\n'),
      expected,
      `${relative(workspaceRoot, target)} does not match the diagnostics table. Run pnpm run generate:diagnostics-reference.`,
    );
  }
  process.stdout.write(
    `Atlas diagnostics reference verified: ${codes.length} code(s) across ${sections.length} section(s), each raised in packages/*/src; ${occurrences} code reference(s) over ${scanned} file(s).\n`,
  );
} else {
  await mkdir(dirname(webDocumentPath), { recursive: true });
  for (const [target, contents] of written) {
    await writeFile(target, contents, 'utf8');
  }
  process.stdout.write(
    `Atlas diagnostics reference written: ${codes.length} code(s) across ${sections.length} section(s), in ${written.length} document(s).\n`,
  );
}

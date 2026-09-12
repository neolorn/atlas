/**
 * What does a consumer have to understand, and how much of it says anything?
 *
 * Both halves of that turn on *what counts as an item a consumer must understand*, and three
 * honest counts of the same shipped surface give 8.4%, 19.2% and 20.2% while it is left undefined.
 * Reading the inferred literal type of the six JSON Schema constants as 574 separate undocumented
 * items (`properties`, `minLength`, `maxItems`, each one) is a number, and it is not about
 * anything. So the tool defines the number, and anything citing a number cites the tool. No figure
 * about this surface is worth writing down unless something can recompute it.
 *
 * ## The definition
 *
 * An item is a **distinct declaration a consumer can name through a published entry point**, plus
 * the own members of the interfaces, classes and enums among them.
 *
 * - *Read from the built declarations*, not the sources. A package is verified through what it
 *   publishes, and the surface a consumer meets is `dist/`.
 * - *Through the TypeScript checker*, not a regular expression over lines. A line scan cannot tell
 *   an exported `const` from the eight hundred properties of its inferred type.
 * - *Distinct.* A symbol re-exported from two entry points is one thing to understand, so items are
 *   keyed by the declaration they resolve to and named for the first entry point that reaches them.
 * - *Own members only.* An inherited property is documented where it is declared; counting it again
 *   under every subtype would inflate the denominator with copies.
 * - *A `const` is one item.* Its type may have structure; a consumer reads the constant.
 * - *Not a member whose type is a single literal.* The declaration states the only value it can
 *   hold, so a sentence above it can do nothing but restate the line below it.
 *
 * Documented means the checker returns a documentation comment for the symbol: the same thing an
 * editor shows on hover, which is the question being asked.
 *
 * ## Why every item rather than a percentage
 *
 * A floor is a ceiling seen from below. It is met by documenting whichever items are cheapest, it
 * is met by *deleting* undocumented exports, and it says nothing about which items are the
 * documented ones, so every public entry point can stay bare while obscure type aliases carry
 * one-liners. The target is every item the definition above reaches, which leaves nothing to
 * choose between and no allowance a new bare export can fit under.
 *
 * One thing fails this gate: an item a consumer can name that says nothing about itself. The
 * failure names the item and the entry point it is reached through, so what is left to decide is
 * where the sentence goes rather than which items deserve one.
 *
 * A named list of the undocumented items would be a second place for the same fact to live, and one
 * that can only ever be empty, so the rule is all there is.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The entry points, discovered rather than listed.
 *
 * `verify-export-surface.mjs` learned this the expensive way: four filenames written out by hand
 * meant a new entry point shipped its whole surface unaudited while the gate stayed green because
 * it never knew to look.
 */
const runtimeTypesRoot = resolve(workspaceRoot, 'dist/runtime/types');
const entryPoints = [
  ...readdirSync(runtimeTypesRoot)
    .filter((file) => file.endsWith('.d.ts'))
    .sort()
    .map((file) => ({
      label: file.replace(/\.d\.ts$/u, ''),
      path: resolve(runtimeTypesRoot, file),
    })),
  {
    label: 'toolkit',
    path: resolve(workspaceRoot, 'dist/toolkit/index.d.ts'),
  },
];

// A renamed or empty output directory makes every check below pass on nothing, and a discovered
// list is exactly the shape that fails that way silently.
assert.ok(
  entryPoints.some(({ label }) => label === 'neolorn-atlas'),
  `No neolorn-atlas.d.ts under ${runtimeTypesRoot}. Every count below would be taken over nothing. Run pnpm run build first.`,
);

/**
 * The discovered list, checked against what the package actually publishes.
 *
 * Discovering the declaration files answers "what did the build emit", which is not the question.
 * The question is what a consumer can import, and that is `exports` in the manifest. The two can
 * come apart in both directions and each is silent: an entry point whose types stopped being
 * emitted would drop off this scan and take its whole surface with it, and a declaration file for
 * a subpath nobody can import would pad the denominator with names no consumer can reach.
 */
const runtimeManifest = JSON.parse(
  readFileSync(resolve(workspaceRoot, 'dist/runtime/package.json'), 'utf8'),
);
const publishedSubpaths = Object.keys(runtimeManifest.exports)
  .filter((subpath) => subpath !== './package.json')
  .map((subpath) =>
    subpath === '.'
      ? 'neolorn-atlas'
      : `neolorn-atlas-${subpath.replace(/^\.\//u, '')}`,
  )
  .sort();
assert.deepEqual(
  entryPoints
    .filter(({ label }) => label !== 'toolkit')
    .map(({ label }) => label)
    .sort(),
  publishedSubpaths,
  'The runtime declaration files and the subpaths the manifest publishes disagree. One of them is describing a surface that does not exist.',
);

const program = ts.createProgram(
  entryPoints.map(({ path }) => path),
  {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
  },
);
const checker = program.getTypeChecker();

function resolveAlias(symbol) {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function documented(symbol) {
  return symbol.getDocumentationComment(checker).length > 0;
}

/** Where a symbol is actually declared, so the same thing reached twice is counted once. */
function identity(symbol) {
  const declaration = symbol.declarations?.[0];
  if (declaration === undefined) return undefined;
  const file = declaration.getSourceFile();
  return `${relative(workspaceRoot, file.fileName).replaceAll('\\', '/')}:${declaration.pos}`;
}

/**
 * Whether a consumer can name this member at all.
 *
 * A `private` field survives into the declaration file because TypeScript compares classes that
 * carry one by declaration rather than by shape, so the emitted class needs it to stay nominal. It
 * is still not something a consumer reads, writes or passes, and without this eighty-seven of them
 * sit in the denominator, a caret-tracking flag and a composition guard counting the same as the
 * input a directive takes. Documentation written for those would be written for whoever maintains
 * the class, which is what the comments inside it are for.
 */
function nameable(member) {
  const declaration = member.declarations?.[0];
  if (declaration === undefined || !ts.canHaveModifiers(declaration)) {
    return true;
  }
  return !(ts.getModifiers(declaration) ?? []).some(
    (modifier) =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword ||
      modifier.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

/**
 * Whether a member's declaration already says everything a sentence could.
 *
 * A member typed as a single literal has exactly one value and names it on the line itself, so the
 * only sentence available above it repeats that value. Requiring one buys a line that says nothing
 * on the day it is written and is wrong on the day the literal changes.
 */
function selfDescribing(member) {
  const declaration = member.declarations?.[0];
  if (declaration === undefined) return false;
  const type = checker.getTypeOfSymbolAtLocation(member, declaration);
  return (type.flags & ts.TypeFlags.Literal) !== 0;
}

/**
 * The own members a consumer has to understand, and nothing else.
 *
 * `symbol.members` rather than `checker.getPropertiesOfType`, because the latter walks the
 * inheritance chain: every member of `AtlasPseudoLocaleTransform` would be counted again under
 * `AtlasPseudoLocaleOptions`, documented in one place and undocumented in the other.
 */
function ownMembers(symbol) {
  const found = [];
  const members = symbol.members;
  if (members === undefined) return found;
  members.forEach((member, name) => {
    if (typeof name !== 'string' || name.startsWith('__')) return;
    if (
      (member.flags &
        (ts.SymbolFlags.Property |
          ts.SymbolFlags.Method |
          ts.SymbolFlags.GetAccessor |
          ts.SymbolFlags.SetAccessor |
          ts.SymbolFlags.EnumMember)) ===
      0
    ) {
      return;
    }
    if (!nameable(member) || selfDescribing(member)) return;
    found.push({ name, symbol: member });
  });
  return found.sort((left, right) => (left.name < right.name ? -1 : 1));
}

const MEMBER_BEARING =
  ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.RegularEnum;

const items = new Map();
const seen = new Set();

for (const { label, path } of entryPoints) {
  const sourceFile = program.getSourceFile(path);
  assert.ok(sourceFile !== undefined, `TypeScript did not load ${path}.`);
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  assert.ok(
    moduleSymbol !== undefined,
    `${path} has no module symbol, so it publishes nothing this tool can see.`,
  );
  const exported = checker
    .getExportsOfModule(moduleSymbol)
    .slice()
    .sort((left, right) => (left.name < right.name ? -1 : 1));
  assert.ok(
    exported.length > 0,
    `${label} exports nothing, so every count below would be taken over nothing.`,
  );

  for (const exportedSymbol of exported) {
    const symbol = resolveAlias(exportedSymbol);
    const key = identity(symbol);
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);

    const id = `${label}#${exportedSymbol.name}`;
    items.set(id, {
      id,
      entryPoint: label,
      documented: documented(symbol) || documented(exportedSymbol),
    });

    if ((symbol.flags & MEMBER_BEARING) === 0) continue;
    for (const member of ownMembers(symbol)) {
      const memberKey = identity(member.symbol);
      if (memberKey === undefined || seen.has(memberKey)) continue;
      seen.add(memberKey);
      const memberId = `${label}#${exportedSymbol.name}.${member.name}`;
      items.set(memberId, {
        id: memberId,
        entryPoint: label,
        documented: documented(member.symbol),
      });
    }
  }
}

const all = [...items.values()];

// Every entry point is shown contributing. One that contributed nothing would silently be a
// surface this gate does not cover, and the totals would look no different.
for (const { label } of entryPoints) {
  assert.ok(
    all.some((item) => item.entryPoint === label),
    `${label} contributed no items, so nothing it publishes is covered by this gate.`,
  );
}
const undocumented = all.filter(({ documented: has }) => !has);
const covered = all.length - undocumented.length;
const percent = ((covered / all.length) * 100).toFixed(1);

const failures = undocumented.map(
  ({ id, entryPoint }) =>
    `${id} carries no documentation, and ${entryPoint} publishes it.`,
);

if (failures.length > 0) {
  console.error(
    `Atlas documentation coverage: ${covered} of ${all.length} items documented (${percent}%).\n`,
  );
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    `\n${failures.length} problem(s). Every item a consumer can name carries a documentation comment, so there is no number a new bare export can fit under.`,
  );
  process.exitCode = 1;
} else {
  const perEntryPoint = entryPoints
    .map(({ label }) => {
      const mine = all.filter((item) => item.entryPoint === label);
      const hasDocs = mine.filter(({ documented: has }) => has).length;
      return `${label} ${hasDocs}/${mine.length}`;
    })
    .join(', ');
  console.log(
    `Atlas documentation coverage verified: ${covered} of ${all.length} items documented (${percent}%), across ${entryPoints.length} published entry points, with nothing undocumented. By entry point: ${perEntryPoint}.`,
  );
}

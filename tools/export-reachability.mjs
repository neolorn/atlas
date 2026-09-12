/**
 * Which published names does a consumer arrive at by following the surface from something it holds?
 *
 * The question `verify-export-surface.mjs` asks about a type is whether a consumer has to be able
 * to name it. Occurrence counting answered that with a proxy: a name written more than twice across
 * the shipped declarations was called structural, on the argument that the third mention must be
 * another export's signature. The proxy is wrong in both directions. Two exports that only name
 * each other pass it together, and a type held once, in the one signature that matters, fails it:
 * `LabelAttribute` is the type of the attribute a consumer binds on the label directive, and it sat
 * in the accepted baseline for months because it is written exactly twice.
 *
 * So the reference is resolved rather than counted. Start from the exports something outside the
 * packages actually names, walk each declaration through the checker, and enqueue every symbol its
 * identifiers resolve to. What that reaches is what a consumer can arrive at: the parameter types,
 * the return types, the members of those, the constraints on the generics, and so on outward. What
 * it never reaches is a name with no path to it from anything anyone calls.
 *
 * The seed is the corpus rather than a list written here, so this calibrates itself: an export that
 * stops being used stops seeding, and whatever only it held becomes reachable from nothing and is
 * reported. A list would have to be maintained in the opposite direction, and the direction it gets
 * maintained in is the one that passes.
 */

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeTypesRoot = resolve(workspaceRoot, 'dist/runtime/types');
const toolkitRoot = resolve(workspaceRoot, 'dist/toolkit');

function entryFiles() {
  const runtime = readdirSync(runtimeTypesRoot)
    .filter((file) => file.endsWith('.d.ts'))
    .sort()
    .map((file) => resolve(runtimeTypesRoot, file));
  assert.ok(
    runtime.length > 0,
    `No declaration files under ${runtimeTypesRoot}. Everything below would be reachable from nothing. Run pnpm run build first.`,
  );
  return [...runtime, resolve(toolkitRoot, 'index.d.ts')];
}

/**
 * The published names reachable from the ones the corpus already names.
 *
 * `namedByCorpus` decides what to start from and nothing else; the walk itself reads only the
 * declarations. Returns the set of published names reached, the seeds included.
 */
export function reachablePublishedNames(namedByCorpus) {
  const files = entryFiles();
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
    baseUrl: workspaceRoot,
    // The entry points import one another by package name, and the package is not installed in this
    // workspace. Without this the primary's imports from the core resolve to nothing, the walk stops
    // at the entry-point boundary, and every core type held only by the primary reads as unreachable.
    paths: {
      '@neolorn/atlas': ['dist/runtime/types/neolorn-atlas.d.ts'],
      '@neolorn/atlas/*': ['dist/runtime/types/neolorn-atlas-*.d.ts'],
    },
  });
  const checker = program.getTypeChecker();

  // The control that matters most here. A path mapping that stopped resolving would make the walk
  // report a surface no consumer can reach, which is the answer this is trying to establish.
  const unresolved = [];
  for (const path of files) {
    for (const statement of program.getSourceFile(path).statements) {
      const specifier =
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier
          : undefined;
      if (specifier === undefined) continue;
      if (!specifier.text.startsWith('@neolorn/')) continue;
      if (checker.getSymbolAtLocation(specifier) === undefined) {
        unresolved.push(
          `${relative(workspaceRoot, path)} -> ${specifier.text}`,
        );
      }
    }
  }
  assert.deepEqual(
    unresolved,
    [],
    `These imports between entry points did not resolve, so the walk stops at the package boundary: ${unresolved.join(', ')}`,
  );

  const ours = new Set(
    program
      .getSourceFiles()
      .map((file) => file.fileName)
      .filter((name) => {
        const full = resolve(name);
        return (
          full.startsWith(runtimeTypesRoot) || full.startsWith(toolkitRoot)
        );
      }),
  );

  const resolveAlias = (symbol) =>
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;

  const identity = (symbol) => {
    const declaration = symbol.declarations?.[0];
    if (declaration === undefined) return undefined;
    const file = declaration.getSourceFile().fileName;
    return `${relative(workspaceRoot, file).split(String.fromCharCode(92)).join('/')}:${declaration.pos}`;
  };

  const published = [];
  for (const path of files) {
    const moduleSymbol = checker.getSymbolAtLocation(
      program.getSourceFile(path),
    );
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = resolveAlias(exported);
      published.push({ name: exported.name, key: identity(symbol), symbol });
    }
  }
  assert.ok(
    published.length > 100,
    `Only ${published.length} published export(s) resolved through the checker, which is fewer than Atlas is known to publish. This is reading the wrong files.`,
  );

  const visited = new Set();
  const queue = [];
  const enqueue = (symbol) => {
    const resolved = resolveAlias(symbol);
    const declarations = resolved.declarations ?? [];
    if (
      !declarations.some((declaration) =>
        ours.has(declaration.getSourceFile().fileName),
      )
    ) {
      return;
    }
    const key = identity(resolved);
    if (key === undefined || visited.has(key)) return;
    visited.add(key);
    queue.push(resolved);
  };

  let seeded = 0;
  for (const row of published) {
    if (!namedByCorpus(row.name)) continue;
    seeded += 1;
    enqueue(row.symbol);
  }

  while (queue.length > 0) {
    const symbol = queue.pop();
    for (const declaration of symbol.declarations ?? []) {
      if (!ours.has(declaration.getSourceFile().fileName)) continue;
      const visit = (node) => {
        if (ts.isIdentifier(node)) {
          const found = checker.getSymbolAtLocation(node);
          if (found !== undefined) enqueue(found);
        }
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(declaration, visit);
    }
  }

  const reached = new Set();
  for (const { name, key } of published) {
    if (key !== undefined && visited.has(key)) reached.add(name);
  }
  return { reached, seeded, published: published.length };
}

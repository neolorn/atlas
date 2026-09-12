/**
 * The template and type analysis Atlas performs, done through published compiler APIs only.
 *
 * `specs/02-packages-and-platform.spec.md` section 10 requires documented, supported APIs behind
 * Atlas-owned adapters, and the way that requirement fails quietly is a private export that keeps
 * working until a patch release removes it. So the same analysis the toolkit performs is run here
 * against a fixture using nothing but what `@angular/compiler` and TypeScript publish. If the
 * public surface stops being enough, this stops passing before a release goes out.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TmplAstRecursiveVisitor,
  parseTemplate,
  tmplAstVisitAll,
} from '@angular/compiler';
import ts from 'typescript';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(workspaceRoot, 'fixtures/semantic-analysis');
const componentPath = resolve(fixtureRoot, 'probe.component.ts');
const templatePath = resolve(fixtureRoot, 'probe.component.html');
const routesPath = resolve(fixtureRoot, 'routes.ts');
const rootNames = [
  componentPath,
  routesPath,
  resolve(fixtureRoot, 'about.component.ts'),
];

const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  experimentalDecorators: true,
  strict: true,
  noEmit: true,
  skipLibCheck: false,
};
const program = ts.createProgram({ rootNames, options: compilerOptions });
const diagnostics = ts.getPreEmitDiagnostics(program);
assert.deepEqual(
  diagnostics.map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  ),
  [],
);

const checker = program.getTypeChecker();
const componentSource = program.getSourceFile(componentPath);
assert.ok(componentSource);

let componentClass;
for (const statement of componentSource.statements) {
  if (
    ts.isClassDeclaration(statement) &&
    statement.name?.text === 'ProbeComponent'
  ) {
    componentClass = statement;
    break;
  }
}
assert.ok(componentClass, 'The component class was not discovered');

const decorators = ts.canHaveDecorators(componentClass)
  ? (ts.getDecorators(componentClass) ?? [])
  : [];
assert.equal(decorators.length, 1);
const decoratorCall = decorators[0].expression;
assert.ok(ts.isCallExpression(decoratorCall));
const decoratorSymbol = checker.getSymbolAtLocation(decoratorCall.expression);
assert.ok(decoratorSymbol);
const resolvedDecorator =
  decoratorSymbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(decoratorSymbol)
    : decoratorSymbol;
assert.equal(resolvedDecorator.name, 'Component');
assert.ok(
  resolvedDecorator
    .getDeclarations()
    ?.some((declaration) =>
      declaration
        .getSourceFile()
        .fileName.replaceAll('\\', '/')
        .includes('/@angular/core/'),
    ),
  'The component decorator did not resolve to the public @angular/core symbol',
);

const metadata = decoratorCall.arguments[0];
assert.ok(ts.isObjectLiteralExpression(metadata));
const templateUrlProperty = metadata.properties.find(
  (property) =>
    ts.isPropertyAssignment(property) &&
    property.name.getText() === 'templateUrl',
);
assert.ok(templateUrlProperty && ts.isPropertyAssignment(templateUrlProperty));
assert.ok(ts.isStringLiteralLike(templateUrlProperty.initializer));
assert.equal(templateUrlProperty.initializer.text, './probe.component.html');

const parsedTemplate = parseTemplate(
  await readFile(templatePath, 'utf8'),
  templatePath,
  { preserveWhitespaces: false },
);
assert.deepEqual(
  (parsedTemplate.errors ?? []).map((error) => error.toString()),
  [],
);

class TemplateProbeVisitor extends TmplAstRecursiveVisitor {
  elements = new Set();
  boundTextCount = 0;
  deferredBlockCount = 0;
  ifBlockCount = 0;

  visitElement(element) {
    this.elements.add(element.name);
    super.visitElement(element);
  }

  visitBoundText(text) {
    this.boundTextCount += 1;
    super.visitBoundText(text);
  }

  visitDeferredBlock(block) {
    this.deferredBlockCount += 1;
    super.visitDeferredBlock(block);
  }

  visitIfBlock(block) {
    this.ifBlockCount += 1;
    super.visitIfBlock(block);
  }
}

const templateVisitor = new TemplateProbeVisitor();
tmplAstVisitAll(templateVisitor, parsedTemplate.nodes);
assert.deepEqual([...templateVisitor.elements].sort(), ['a', 'h1', 'p']);
assert.equal(templateVisitor.boundTextCount, 3);
assert.equal(templateVisitor.deferredBlockCount, 1);
assert.equal(templateVisitor.ifBlockCount, 1);

const routesSource = program.getSourceFile(routesPath);
assert.ok(routesSource);
let routesDeclaration;
for (const statement of routesSource.statements) {
  if (!ts.isVariableStatement(statement)) {
    continue;
  }

  for (const declaration of statement.declarationList.declarations) {
    if (
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === 'routes'
    ) {
      routesDeclaration = declaration;
    }
  }
}
assert.ok(routesDeclaration?.initializer);
assert.ok(ts.isSatisfiesExpression(routesDeclaration.initializer));

const routeContract = checker.getTypeFromTypeNode(
  routesDeclaration.initializer.type,
);
assert.equal(routeContract.aliasSymbol?.name, 'Routes');
assert.ok(
  routeContract.aliasSymbol
    ?.getDeclarations()
    ?.some((declaration) =>
      declaration
        .getSourceFile()
        .fileName.replaceAll('\\', '/')
        .includes('/@angular/router/'),
    ),
  'The route contract did not resolve to the public @angular/router type',
);

const routePaths = [];
let dynamicImportCount = 0;
const visitRouteSyntax = (node) => {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText() === 'path' &&
    ts.isStringLiteralLike(node.initializer)
  ) {
    routePaths.push(node.initializer.text);
  }

  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    dynamicImportCount += 1;
  }
  ts.forEachChild(node, visitRouteSyntax);
};
visitRouteSyntax(routesDeclaration.initializer.expression);
assert.deepEqual(routePaths, ['', 'about']);
assert.equal(dynamicImportCount, 1);

process.stdout.write(
  'Angular component, template, control-flow, and route analysis verified through public APIs.\n',
);

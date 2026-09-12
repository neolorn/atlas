/**
 * The typed surface a consumer's code sees, projected from the catalog rather than written.
 *
 * `specs/04-message-authoring-and-catalogs.spec.md` section 9 projects each dotted identity into a
 * deep-readonly tree of opaque handles, and the input contract each handle carries is
 * `specs/04-message-authoring-and-catalogs.spec.md` section 7. The projection is checked in both
 * directions because a lower camel case name can be reached from more than one kebab-case part,
 * so a collision is caught at compile time rather than when a consumer adds the second message.
 */
import {
  atlasDiagnostic,
  atlasFailure,
  atlasSuccess,
  type AtlasDiagnostic,
  type AtlasResult,
} from './diagnostics.js';
import { digestAtlasCanonicalJson } from './canonical-json.js';
import { atlasMessagePartInCode } from './identities.js';
import { atlasLocaleEndonym, atlasShippedFallbackChain } from './locales.js';
import {
  ATLAS_GENERATED_ABI_PROFILE,
  type AtlasEffectiveInputContract,
  type AtlasSemanticFamily,
  type AtlasSemanticGraph,
  type AtlasSemanticMessage,
  type AtlasSemanticScope,
} from './semantic-model.js';
import { compareCodePoint } from './sorted-records.js';

export interface AtlasGeneratedContractFile {
  readonly path: string;
  readonly contents: string;
}

export interface AtlasGeneratedRouteProjection {
  readonly id: string;
  readonly path: string;
  readonly parameterNames: readonly string[];
  readonly indexing?: 'indexable' | 'non-indexable' | 'private';
  /**
   * What this route claims about itself in a sitemap.
   *
   * Absent for a route whose class the owner's sitemap declaration does not list, and absent for
   * every route when the owner declared none. The two optional elements are a claim rather than a
   * requirement, so an entry without them is a complete entry.
   */
  readonly sitemap?: {
    readonly changefreq?: string;
    readonly priority?: number;
    readonly lastmod?: string;
  };
  /**
   * The scopes this route must load before it renders.
   *
   * Only scopes the first render does not already carry: a route behind a lazy boundary downloads
   * its code when it activates, and the messages that code uses have to arrive with it. Derived
   * from the same analysis that decided which scopes are not startup scopes, so no application
   * declares scopes per route, which is the whole reason deferring a scope is safe.
   */
  readonly scopes?: readonly {
    readonly providerId: string;
    readonly scopeId: string;
  }[];
  readonly sourcePath?: string;
}

export interface AtlasGenerateContractsOptions {
  readonly routes?: readonly AtlasGeneratedRouteProjection[];
  readonly recoveryMessageIdentities?: readonly string[];
  /**
   * Scopes whose messages the first render does not use.
   *
   * Derived from the route tree: a scope every one of whose uses sits behind a `loadComponent` or
   * `loadChildren` boundary is not needed until that route activates, so loading it at startup
   * would make first render pay for text nobody is looking at. Emitted into the generated
   * configuration so the runtime can act on it without any application writing a list.
   */
  readonly deferredScopeIds?: readonly string[];
  /**
   * Which form of the ready-made provider to emit.
   *
   * `'implementation'` is the real one, generated into the owner's `#i18n`.
   *
   * `'declaration'` is what the provisional overlay carries while Atlas analyses the application.
   * The implementation imports `@angular/core` and the catalog set, loaders, and recovery payload;
   * an overlay is not an Angular application and has no reason to synthesize those, and an owner
   * that is a library has no `@angular/core` to resolve them against.
   *
   * Omitting it entirely was the earlier answer, and it was wrong in a way nothing caught: an
   * application composes the runtime by calling `provideLocalization` from `#i18n`, so an overlay
   * without it reports that import as unresolved and makes every application look like one that
   * composes nothing. A declaration resolves the import, carries the symbol detection resolves,
   * and pulls in nothing.
   */
  readonly provider?: 'implementation' | 'declaration';
}

interface ProjectionNode {
  message?: AtlasSemanticMessage;
  readonly children: Map<string, ProjectionNode>;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function inputBaseType(input: AtlasEffectiveInputContract): string {
  if (input.enum !== undefined) {
    return input.enum
      .map((value) => JSON.stringify(value))
      .sort(compareCodePoint)
      .join(' | ');
  }
  switch (input.type) {
    case 'boolean':
      return 'boolean';
    case 'date-time':
      return 'Date | number';
    case 'integer':
    case 'number':
      return 'number';
    case 'string':
      return 'string';
  }
}

function inputObjectType(
  inputs: readonly AtlasEffectiveInputContract[],
): string {
  if (inputs.length === 0) return 'Readonly<Record<never, never>>';
  const properties = inputs.map((input) => {
    const property = quote(input.name);
    const optional = input.optional ? '?' : '';
    const nullable = input.nullable ? ' | null' : '';
    return `readonly ${property}${optional}: ${inputBaseType(input)}${nullable};`;
  });
  return `{ ${properties.join(' ')} }`;
}

function slotUnion(message: AtlasSemanticMessage): string {
  if (message.slots.length === 0) return 'never';
  return message.slots.map(({ name }) => quote(name)).join(' | ');
}

function handleExpression(message: AtlasSemanticMessage): string {
  const identityType = quote(message.identity);
  const inputsType = inputObjectType(message.inputs);
  const slotsType = slotUnion(message);
  const resultType = quote(message.resultKind);
  return [
    `defineAtlasMessageHandle<${identityType}, ${inputsType}, ${slotsType}, ${resultType}>({`,
    `  generatedAbi: ${quote(ATLAS_GENERATED_ABI_PROFILE)},`,
    `  providerId: ${quote(message.providerId)},`,
    `  scopeId: ${quote(message.scopeId)},`,
    `  messageId: ${quote(message.messageId)},`,
    `  identity: ${quote(message.identity)},`,
    `  resultKind: ${resultType},`,
    `  inputNames: Object.freeze([${message.inputs.map(({ name }) => quote(name)).join(', ')}]),`,
    `  slotNames: Object.freeze([${message.slots.map(({ name }) => quote(name)).join(', ')}]),`,
    '})',
  ].join('\n');
}

function messageReference(messageId: string): string {
  return messageId
    .split('.')
    .map(atlasMessagePartInCode)
    .reduce((value, part) => `${value}[${quote(part)}]`, 'messages');
}

function familyExpression(family: AtlasSemanticFamily): string {
  const segmentType =
    family.segments.length === 0
      ? 'Readonly<Record<never, never>>'
      : `{ ${family.segments
          .map(({ name }) => `readonly ${quote(name)}: string;`)
          .join(' ')} }`;
  const handleType = family.members
    .map(({ messageId }) => `typeof ${messageReference(messageId)}`)
    .join(' | ');
  const memberRows = family.members.map(({ messageId, segments }) => {
    const key = JSON.stringify(
      family.segments.map(({ name }) => segments[name] as string),
    );
    return `      ${quote(key)}: ${messageReference(messageId)},`;
  });
  const validation = family.segments
    .map(
      ({ name, syntax, maximumLength }) =>
        `    if (!isAtlasFamilySegment(segments[${quote(name)}], ${quote(syntax)}, ${maximumLength})) return undefined;`,
    )
    .join('\n');
  const keyValues = family.segments
    .map(({ name }) => `segments[${quote(name)}]`)
    .join(', ');
  return [
    `defineAtlasMessageFamily<${quote(family.name)}, ${segmentType}, ${handleType}>({`,
    `  name: ${quote(family.name)},`,
    `  template: ${quote(family.template)},`,
    `  memberIds: Object.freeze([${family.members.map(({ messageId }) => quote(messageId)).join(', ')}]),`,
    `  segmentNames: Object.freeze([${family.segments.map(({ name }) => quote(name)).join(', ')}]),`,
    `  resolve(segments) {`,
    `    if (!hasExactAtlasFamilySegments(segments, this.segmentNames)) return undefined;`,
    validation,
    `    const members = Object.freeze({`,
    ...memberRows,
    `    });`,
    `    const key = JSON.stringify([${keyValues}]);`,
    `    return Object.prototype.hasOwnProperty.call(members, key)`,
    `      ? members[key as keyof typeof members]`,
    `      : undefined;`,
    `  },`,
    `})`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

function renderFamilies(scope: AtlasSemanticScope): string {
  if (scope.families.length === 0) return 'Object.freeze({})';
  return [
    'Object.freeze({',
    ...scope.families.map(
      (family) =>
        `  ${quote(atlasMessagePartInCode(family.name))}: ${familyExpression(
          family,
        )
          .split('\n')
          .map((line, index) => (index === 0 ? line : `  ${line}`))
          .join('\n')},`,
    ),
    '})',
  ].join('\n');
}

function renderProjectionNode(node: ProjectionNode): string {
  const children = [...node.children.entries()].sort(([left], [right]) =>
    compareCodePoint(left, right),
  );
  if (children.length === 0) {
    if (node.message === undefined) {
      throw new TypeError(
        'An empty Atlas generated projection node is invalid.',
      );
    }
    return handleExpression(node.message);
  }

  const childObject = [
    '{',
    ...children.map(
      ([name, child]) =>
        `  ${quote(name)}: ${renderProjectionNode(child)
          .split('\n')
          .map((line, index) => (index === 0 ? line : `  ${line}`))
          .join('\n')},`,
    ),
    '}',
  ].join('\n');
  if (node.message === undefined) {
    return `Object.freeze(${childObject})`;
  }
  return `Object.freeze(Object.assign(${handleExpression(node.message)}, ${childObject}))`;
}

function projectionTree(
  scope: AtlasSemanticScope,
  diagnostics: AtlasDiagnostic[],
): ProjectionNode {
  const root: ProjectionNode = { children: new Map() };
  const reverse = new Map<string, string>();
  for (const message of scope.messages) {
    const projected = message.messageId
      .split('.')
      .map(atlasMessagePartInCode)
      .join('.');
    const existing = reverse.get(projected);
    if (existing !== undefined && existing !== message.messageId) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1305',
          `Message identities ${JSON.stringify(existing)} and ${JSON.stringify(message.messageId)} collide at generated path ${JSON.stringify(projected)}.`,
          { path: ['messages', message.messageId] },
        ),
      );
      continue;
    }
    reverse.set(projected, message.messageId);
    let node = root;
    for (const part of message.messageId
      .split('.')
      .map(atlasMessagePartInCode)) {
      const child = node.children.get(part) ?? { children: new Map() };
      node.children.set(part, child);
      node = child;
    }
    if (node.message !== undefined) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1305',
          `Generated message path ${JSON.stringify(projected)} is duplicated.`,
          { path: ['messages', message.messageId] },
        ),
      );
    } else {
      node.message = message;
    }
  }
  return root;
}

const handlePrelude = `declare const atlasGeneratedMessageHandle: unique symbol;

export interface GeneratedMessageHandle<
  Identity extends string,
  Inputs,
  Slots extends string,
  ResultKind extends 'plain' | 'structured',
> {
  readonly [atlasGeneratedMessageHandle]: {
    readonly identity: Identity;
    readonly inputs: Inputs;
    readonly slots: Slots;
    readonly resultKind: ResultKind;
  };
  /** Type-only runtime inference contract; no corresponding value is emitted. */
  readonly __atlasContract?: {
    readonly inputs: Inputs;
    readonly slots: Slots;
    readonly resultKind: ResultKind;
  };
  readonly generatedAbi: '${ATLAS_GENERATED_ABI_PROFILE}';
  readonly providerId: string;
  readonly scopeId: string;
  readonly messageId: string;
  readonly identity: Identity;
  readonly resultKind: ResultKind;
  readonly inputNames: readonly (keyof Inputs & string)[];
  readonly slotNames: readonly Slots[];
}

function defineAtlasMessageHandle<
  Identity extends string,
  Inputs,
  Slots extends string,
  ResultKind extends 'plain' | 'structured',
>(value: {
  readonly generatedAbi: '${ATLAS_GENERATED_ABI_PROFILE}';
  readonly providerId: string;
  readonly scopeId: string;
  readonly messageId: string;
  readonly identity: Identity;
  readonly resultKind: ResultKind;
  readonly inputNames: readonly (keyof Inputs & string)[];
  readonly slotNames: readonly Slots[];
}): GeneratedMessageHandle<Identity, Inputs, Slots, ResultKind> {
  return Object.freeze(value) as GeneratedMessageHandle<
    Identity,
    Inputs,
    Slots,
    ResultKind
  >;
}

export interface GeneratedMessageFamily<
  Name extends string,
  Segments extends Readonly<Record<string, string>>,
  Handle,
> {
  readonly name: Name;
  readonly template: string;
  readonly memberIds: readonly string[];
  readonly segmentNames: readonly (keyof Segments & string)[];
  resolve(segments: Segments): Handle | undefined;
}

function defineAtlasMessageFamily<
  Name extends string,
  Segments extends Readonly<Record<string, string>>,
  Handle,
>(value: GeneratedMessageFamily<Name, Segments, Handle>): GeneratedMessageFamily<Name, Segments, Handle> {
  return Object.freeze(value);
}

function hasExactAtlasFamilySegments(
  segments: Readonly<Record<string, string>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(segments).sort();
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function isAtlasFamilySegment(
  value: unknown,
  syntax: 'lower-kebab' | 'ascii-token' | 'unicode-token',
  maximumLength: number,
): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.normalize('NFC') !== value) return false;
  switch (syntax) {
    case 'lower-kebab':
      return /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/u.test(value);
    case 'ascii-token':
      return /^[A-Za-z][A-Za-z0-9-]*$/u.test(value);
    case 'unicode-token':
      return /^[\\p{L}\\p{N}][\\p{L}\\p{N}-]*$/u.test(value);
  }
}`;

function scopeModule(
  scope: AtlasSemanticScope,
  diagnostics: AtlasDiagnostic[],
): string {
  const tree = projectionTree(scope, diagnostics);
  const rendered = renderProjectionNode(tree);
  const families = renderFamilies(scope);
  return [
    '/** Generated by Atlas. Do not edit. */',
    handlePrelude,
    '',
    `export const providerId = ${quote(scope.providerId)} as const;`,
    `export const scopeId = ${quote(scope.scopeId)} as const;`,
    `export const applicationContractFingerprint = ${quote(scope.applicationContractFingerprint)} as const;`,
    `export const semanticRegistryFingerprint = ${quote(scope.semanticRegistryFingerprint)} as const;`,
    `export const requiredExtensions = Object.freeze(${JSON.stringify(scope.requiredExtensions)} as const);`,
    '',
    `export const messages = ${rendered};`,
    '',
    `export const families = ${families};`,
    '',
  ].join('\n');
}

/**
 * The setup and the ready-made provider over it, emitted into `#i18n` beside the configuration.
 *
 * The provisional overlay gets declarations instead: same names, same call shape, no imports.
 */
function providerLines(
  form: 'implementation' | 'declaration',
): readonly string[] {
  if (form === 'declaration') {
    return [
      '/**',
      ' * Provisional. The real one is generated once this owner has been analysed.',
      ' *',
      ' * Declared rather than implemented so that the overlay resolving `#i18n` during analysis',
      ' * pulls in none of the generated modules the implementation closes over, while still',
      ' * resolving the import an application composes the runtime through.',
      ' *',
      ' * The return type asserts nothing, which is the honest thing for a stub to do. `unknown`',
      ' * asserted something false: it made every application`s own providers array report a type',
      ' * error during analysis, Atlas telling a consumer their correct code is wrong. Naming',
      ' * `EnvironmentProviders` would be precise and would drag `@angular/core` into the overlay',
      ' * of every owner, including the ones that have no Angular at all. The real provider,',
      ' * generated after analysis, is precisely typed.',
      ' */',
      'export declare function provideLocalization(',
      '  ...features: readonly unknown[]',
      '): any;',
      '',
      '/**',
      ' * Provisional. The real one is generated once this owner has been analysed.',
      ' *',
      ' * Declared for the same reason as the provider above: an owner`s own test files are part of',
      ' * the graph Atlas analyses, and a test that imports this must resolve during analysis, before',
      ' * there is anything to import.',
      ' */',
      'export declare const localizationSetup: any;',
      '',
    ];
  }
  return providerImplementationLines();
}

function providerImplementationLines(): readonly string[] {
  return [
    // Decision section 3: one import and one call. Everything closed over here is something Atlas
    // generated for itself, which every application was importing by hand to pass straight back.
    // What an application actually decides (locale sources, persistence, recovery message,
    // extension bindings) stays an argument, because Atlas cannot know it.
    "import type { EnvironmentProviders } from '@angular/core';",
    "import { provideLocalizationSetup } from '@neolorn/atlas';",
    "import type { LocalizationFeature } from '@neolorn/atlas';",
    // Package-import specifiers rather than relative paths: the provisional overlay Atlas compiles
    // during analysis resolves `#i18n/*` and knows nothing about relative paths inside it, and a
    // consumer's own tsconfig resolves the same specifiers through package imports. One form works
    // in both places.
    "import { catalogSet } from '#i18n/catalog-set';",
    "import { catalogLoaders } from '#i18n/catalog-loaders';",
    "import { recoveryPayload } from '#i18n/recovery-payload';",
    "import { personNames } from '#i18n/person-names';",
    "import { routeProjection } from '#i18n/routes';",
    '',
    // Named, and exported, because the provider is not the only thing that composes it. A test
    // reaches the runtime through `provideLocalizationTesting()` from `@neolorn/atlas/testing`,
    // which takes the setup rather than building it, and before this existed every such test
    // hand-assembled these six fields from five generated modules: the exact hand-assembly the
    // provider below was created to remove, reappearing the moment anyone wrote a test.
    //
    // Hand-assembly also drifts, and it had. `testing-entry-point.spec.ts` composed five of the
    // six (no `personNames`, no `routeProjection`) under the name "composes the same runtime
    // the application provider does". It did not, and nothing could notice: two copies of a shape
    // only one of which anything checks.
    'export const localizationSetup = Object.freeze({',
    '  configuration: configuration,',
    '  catalogSet: catalogSet,',
    '  catalogLoaders: catalogLoaders,',
    '  recoveryPayload: recoveryPayload,',
    // Only the configured locales' profiles. Atlas carries the pinned release whole; an
    // application carries what its own locales reach.
    '  personNames: personNames,',
    // The half of a route projection Atlas knows. `withRouting()` carries the half it cannot
    // (the URL policy, localized spellings, parameter codecs) so the table is declared once.
    '  routeProjection: routeProjection,',
    '});',
    '',
    'export function provideLocalization(',
    '  ...features: readonly LocalizationFeature[]',
    '): EnvironmentProviders {',
    '  return provideLocalizationSetup(localizationSetup, ...features);',
    '}',
    '',
  ];
}

function indexModule(
  graph: AtlasSemanticGraph,
  deferredScopeIds: readonly string[],
  provider: 'implementation' | 'declaration',
): string {
  const deferred = new Set(deferredScopeIds);
  const scopeRows = graph.scopes.map(
    (scope) =>
      `  Object.freeze({ providerId: ${quote(scope.providerId)}, scopeId: ${quote(scope.scopeId)}, applicationContractFingerprint: ${quote(scope.applicationContractFingerprint)}, semanticRegistryFingerprint: ${quote(scope.semanticRegistryFingerprint)}, startup: ${deferred.has(scope.scopeId) ? 'false' : 'true'}, requiredExtensions: Object.freeze(${JSON.stringify(scope.requiredExtensions)} as const) }),`,
  );
  const aliases = Object.entries(graph.aliases)
    .sort(([left], [right]) => compareCodePoint(left, right))
    .map(([alias, locale]) => `  ${quote(alias)}: ${quote(locale)},`);
  // One name per configured locale, looked up at build time so the visitor's engine does not get
  // a vote. A locale CLDR has no name for is left out rather than given its tag: the runtime falls
  // back to the engine there, which is what it did for every locale before this existed.
  const localeNames = Object.fromEntries(
    graph.locales.flatMap((locale) => {
      const endonym = atlasLocaleEndonym(locale);
      return endonym === undefined ? [] : [[locale, endonym] as const];
    }),
  );
  // Each locale's own chain, resolved here because the runtime has no parent table and must not
  // carry one, and filtered to the locales this owner ships: a member with no catalog would cost a
  // lookup and answer nothing. A locale whose chain is empty after the filter is left out, so an
  // application whose locales are unrelated to each other carries no table at all.
  const localeFallbacks = Object.fromEntries(
    graph.locales.flatMap((locale) => {
      const chain = atlasShippedFallbackChain(
        locale,
        graph.locales,
        graph.parentLocales,
      );
      return chain.length === 0 ? [] : [[locale, chain] as const];
    }),
  );
  const declaredFormatting = Object.fromEntries(
    Object.entries(graph.formatting).filter(([locale]) =>
      graph.locales.includes(locale as (typeof graph.locales)[number]),
    ),
  );
  const formatting =
    Object.keys(declaredFormatting).length === 0
      ? undefined
      : `  formatting: Object.freeze(${JSON.stringify(declaredFormatting)} as const),`;
  return [
    '/** Generated by Atlas. Do not edit. */',
    `export const generatedAbi = ${quote(graph.generatedAbi)} as const;`,
    'export const aliases = Object.freeze(Object.assign(',
    '  Object.create(null) as Record<string, string>,',
    '  {',
    ...aliases,
    '  },',
    '));',
    `export const configuration = Object.freeze({`,
    `  generatedAbi: generatedAbi,`,
    `  sourceLocale: ${quote(graph.sourceLocale)},`,
    `  defaultLocale: ${quote(graph.defaultLocale)},`,
    `  locales: Object.freeze([${graph.locales.map(quote).join(', ')}]),`,
    '  aliases: aliases,',
    ...(Object.keys(localeNames).length === 0
      ? []
      : [
          `  localeNames: Object.freeze(${JSON.stringify(localeNames)} as const),`,
        ]),
    // Emitted only when the owner declared something, and only for locales this generation
    // actually produced. An empty object would say the application had considered how each locale
    // is written and chosen nothing, and the runtime's absent-means-CLDR rule already says the
    // same thing with no data at all.
    //
    // The filter is what makes a pseudo-locale declaration safe. `pseudoLocales` is part of the
    // configuration whether or not `--pseudo` asked for one, so a production build's locale table
    // does not carry them, and a formatting entry for a locale the table does not list is a
    // table built against a different configuration, which the runtime refuses on arrival.
    ...(formatting === undefined ? [] : [formatting]),
    ...(Object.keys(localeFallbacks).length === 0
      ? []
      : [
          `  localeFallbacks: Object.freeze(${JSON.stringify(localeFallbacks)} as const),`,
        ]),
    `  applicationContractFingerprint: ${quote(graph.applicationContractFingerprint)},`,
    `  semanticRegistryFingerprint: ${quote(graph.semanticRegistryFingerprint)},`,
    `  extensionDescriptors: Object.freeze(${JSON.stringify(graph.extensionDescriptors)} as const),`,
    '  scopes: Object.freeze([',
    ...scopeRows,
    '  ]),',
    '} as const);',
    '',
    ...providerLines(provider),
  ].join('\n');
}

function routeModule(routes: readonly AtlasGeneratedRouteProjection[]): string {
  const ordered = [...routes].sort((left, right) =>
    compareCodePoint(
      `${left.id}\u0000${left.path}\u0000${left.sourcePath ?? ''}`,
      `${right.id}\u0000${right.path}\u0000${right.sourcePath ?? ''}`,
    ),
  );
  const identity = digestAtlasCanonicalJson(
    'atlas-route-projection/1',
    ordered.map((route) => ({
      id: route.id,
      path: route.path,
      parameterNames: [...route.parameterNames],
      ...(route.indexing === undefined ? {} : { indexing: route.indexing }),
      // In the identity, so that editing a claim reprojects. A digest that ignored it would call a
      // projection fresh while the sitemap it produces has changed.
      ...(route.sitemap === undefined ? {} : { sitemap: route.sitemap }),
      ...(route.scopes === undefined || route.scopes.length === 0
        ? {}
        : {
            scopes: route.scopes.map(({ providerId, scopeId }) => ({
              providerId,
              scopeId,
            })),
          }),
    })),
  );
  const sitemapClaim = (
    claim: AtlasGeneratedRouteProjection['sitemap'],
  ): string => {
    if (claim === undefined) return '';
    const parts = [
      ...(claim.changefreq === undefined
        ? []
        : [`changefreq: ${quote(claim.changefreq)}`]),
      ...(claim.priority === undefined ? [] : [`priority: ${claim.priority}`]),
      ...(claim.lastmod === undefined
        ? []
        : [`lastmod: ${quote(claim.lastmod)}`]),
    ];
    return parts.length === 0
      ? ''
      : `, sitemap: Object.freeze({ ${parts.join(', ')} })`;
  };
  const rows = ordered.map(
    (route) =>
      `    Object.freeze({ id: ${quote(route.id)}, path: ${quote(route.path)}, parameterNames: Object.freeze([${route.parameterNames.map(quote).join(', ')}] as const)${route.indexing === undefined ? '' : `, indexing: ${quote(route.indexing)}`}${sitemapClaim(route.sitemap)}${route.scopes === undefined || route.scopes.length === 0 ? '' : `, scopes: Object.freeze([${route.scopes.map(({ providerId, scopeId }) => `Object.freeze({ providerId: ${quote(providerId)}, scopeId: ${quote(scopeId)} })`).join(', ')}] as const)`}${route.sourcePath === undefined ? '' : `, sourcePath: ${quote(route.sourcePath)}`} }),`,
  );
  return [
    '/** Generated by Atlas. Do not edit. */',
    'export const routeProjection = Object.freeze({',
    "  profile: 'atlas-route-projection/1',",
    `  identity: ${quote(identity)},`,
    '  routes: Object.freeze([',
    ...rows,
    '  ]),',
    '} as const);',
    '',
  ].join('\n');
}

function recoveryModule(
  graph: AtlasSemanticGraph,
  identities: readonly string[],
  diagnostics: AtlasDiagnostic[],
): string {
  const messages = new Map(
    graph.scopes.flatMap((scope) =>
      scope.messages.map((message) => [message.identity, message] as const),
    ),
  );
  const rows: string[] = [];
  for (const identity of [...new Set(identities)].sort(compareCodePoint)) {
    const message = messages.get(identity);
    if (
      message === undefined ||
      message.resultKind !== 'plain' ||
      message.inputs.length > 0
    ) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1304',
          `Recovery identity ${JSON.stringify(identity)} must select an existing plain message with no inputs.`,
          { path: ['recovery', identity] },
        ),
      );
      continue;
    }
    rows.push(
      `  Object.freeze({ identity: ${quote(message.identity)}, sourceFingerprint: ${quote(message.sourceFingerprint)} }),`,
    );
  }
  return [
    '/** Generated by Atlas. Do not edit. */',
    'export const recoveryRoots = Object.freeze([',
    ...rows,
    '] as const);',
    '',
  ].join('\n');
}

export function generateAtlasContracts(
  graph: AtlasSemanticGraph,
  options: AtlasGenerateContractsOptions = {},
): AtlasResult<readonly AtlasGeneratedContractFile[]> {
  const diagnostics: AtlasDiagnostic[] = [];
  const files: AtlasGeneratedContractFile[] = [
    Object.freeze({
      path: 'index.ts',
      contents: indexModule(
        graph,
        options.deferredScopeIds ?? [],
        options.provider ?? 'implementation',
      ),
    }),
    Object.freeze({
      path: 'routes.ts',
      contents: routeModule(options.routes ?? []),
    }),
    Object.freeze({
      path: 'recovery.ts',
      contents: recoveryModule(
        graph,
        options.recoveryMessageIdentities ?? [],
        diagnostics,
      ),
    }),
  ];
  for (const scope of graph.scopes) {
    files.push(
      Object.freeze({
        path: `${scope.scopeId}.ts`,
        contents: scopeModule(scope, diagnostics),
      }),
    );
  }
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    return atlasFailure(diagnostics);
  }
  files.sort((left, right) => compareCodePoint(left.path, right.path));
  return atlasSuccess(Object.freeze(files), diagnostics);
}

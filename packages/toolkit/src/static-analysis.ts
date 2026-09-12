/**
 * Reading the route declarations an application wrote, and reporting the ones nothing can read.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 1 makes the Angular route declarations
 * the authored source and one derived projection the only other copy. It also fixes what happens
 * at the limit of what this file can see: a route assembled at run time, spread in from
 * elsewhere, or returned by a helper is reported rather than fatal, because an application is
 * allowed to have that shape and refusing to generate would turn this analysis into a bar on
 * adoption.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 5 is the rest of the rule: the analysis
 * follows the project's real compilation graph, its symbols and its exact spans, and never
 * executes application code, calls a getter or a service, or resolves anything over a network.
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  ASTWithSource,
  ImplicitReceiver,
  LiteralArray,
  PropertyRead,
  RecursiveAstVisitor,
  LiteralPrimitive,
  TmplAstRecursiveVisitor,
  parseTemplate,
  tmplAstVisitAll,
  type AST,
  type TmplAstBoundAttribute,
  type TmplAstBoundEvent,
  type TmplAstBoundText,
  type TmplAstElement,
  type TmplAstLetDeclaration,
} from '@angular/compiler';
import ts from 'typescript';

import {
  atlasDiagnostic,
  atlasFailure,
  atlasSourceSpan,
  atlasSuccess,
  type AtlasDiagnostic,
  type AtlasDiagnosticSeverity,
  type AtlasResult,
} from './diagnostics.js';
import { admitAtlasHostCompatibility } from './host-compatibility.js';
import { containedPath } from './output-host.js';
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';
import { ATLAS_GENERATED_ABI_PROFILE } from './semantic-model.js';
import { compareCodePoint } from './sorted-records.js';
import { portablePath } from './file-system.js';

/** A source file supplied directly rather than read from disk, for analysing something in memory. */
export interface AtlasAnalysisSource {
  /** The path it is to be treated as having, which is what diagnostics about it will name. */
  readonly path: string;
  /** Its text. */
  readonly contents: string;
}

export interface AtlasVirtualModule {
  readonly specifier: string;
  readonly contents: string;
}

export interface AtlasApplicationAnalysisRequest {
  readonly projectRoot: string;
  readonly rootNames: readonly string[];
  readonly sources?: readonly AtlasAnalysisSource[];
  readonly virtualModules?: readonly AtlasVirtualModule[];
  readonly knownMessageIdentities?: readonly string[];
  readonly typeNames?: readonly string[];
  readonly maxDiagnostics?: number;
  /**
   * The consumer's own resolved compiler options. Analysis must observe the
   * program the consumer's compiler actually builds; imposing different
   * options produces findings about a program that does not exist. Omitted
   * when the owner has no selectable TypeScript configuration.
   */
  readonly compilerOptions?: ts.CompilerOptions;
}

/**
 * One place the application uses a message.
 *
 * Collected across the whole application, which is what answers both directions: which messages
 * nothing reaches, and where a message would have to be changed if it were renamed.
 */
export interface AtlasMessageUsage {
  /** Which message, by the identity its handle carries. */
  readonly identity: string;
  /** The file it is used in. */
  readonly sourcePath: string;
  /** Where the use begins, as characters from the start of the file. */
  readonly start: number;
  /** Where it ends. */
  readonly end: number;
  /** Whether the use is in code or in a component's template. */
  readonly surface: 'typescript' | 'template';
}

/**
 * One route the application declares, read out of its source.
 *
 * What localized routing is derived from: the translated spellings, the reciprocal alternates, the
 * sitemap entry, and which messages arrive with which lazily loaded route.
 */
export interface AtlasRouteProjection {
  /**
   * A stable name for this address.
   *
   * Derived from the route's full path, because the path is what the id has to survive: renaming
   * `:id` to `:orderId` leaves the URL, the page, and its indexed copy untouched, so it must leave
   * the key those messages are authored under untouched too. Every parameter therefore collapses
   * to one mark and only literal segments contribute names. A consumer that wants a different
   * name declares `data.atlasRouteId`.
   */
  readonly id: string;
  /** The route's full path as authored, with its parameters still in it. */
  readonly path: string;
  /** The parameters the path names, in the order they appear. */
  readonly parameterNames: readonly string[];
  /**
   * What this route claims about being indexed, resolved from the class its own data names.
   *
   * Absent when the owner declared no indexing policy, or when the route's class is not one the
   * policy lists.
   */
  readonly indexing?: 'indexable' | 'non-indexable' | 'private';
  /**
   * What this route claims in a sitemap, resolved from the class its own data names.
   *
   * Absent when the owner declared no sitemap policy, and absent when the route's class is one the
   * policy does not list. Both produce an entry carrying its address and its alternates, which is
   * a complete entry: the two optional elements are a claim, not a requirement.
   */
  readonly sitemap?: {
    readonly changefreq?: string;
    readonly priority?: number;
    readonly lastmod?: string;
  };
  /**
   * The files this route brings in that the first render does not.
   *
   * A route behind `loadComponent` or `loadChildren` downloads its code when it activates, and the
   * messages that code uses have to arrive with it. Deriving the set here is what lets Atlas load
   * them without any application listing scopes per route: the same analysis already decided
   * which scopes are not startup scopes, and this says which route is responsible for each.
   */
  readonly deferredSourcePaths: readonly string[];
  /** The file the route is declared in. */
  readonly sourcePath: string;
  /** Where the declaration begins, as characters from the start of that file. */
  readonly start: number;
  /** Where it ends. */
  readonly end: number;
}

/**
 * A template saying something about a locale in its own words.
 *
 * Reported, not judged. This layer knows what the source says and not what the configuration says,
 * and deciding whether `"en-US"` in a template is a locale needs the locale set, which is the same
 * division `routePolicy` above is written under.
 *
 * Two shapes, because a hand-written locale option has two halves. The locale itself arrives as a
 * string in an expression (a click handler, an attribute binding, a comparison) and the option's
 * language and direction arrive as static attributes that repeat what the runtime already knows.
 */
export interface AtlasTemplateLocaleMention {
  readonly kind: 'literal' | 'attribute';
  /** `lang`, for a static attribute mention. */
  readonly attribute?: string;
  readonly text: string;
  /** A static `dir` on the same element, which is the other half of a hand-written option. */
  readonly siblingDirection?: string;
  readonly componentName: string;
  readonly sourcePath: string;
  readonly templatePath: string;
  readonly start: number;
  readonly end: number;
}

/**
 * An address a template hands to the Router, in the forms a build can read one.
 *
 * Reported, not judged, on the same division as `AtlasTemplateLocaleMention` above: this layer
 * knows that a template writes `routerLink="/ar-eg/articles"` and does not know that `ar-eg` is a
 * segment this owner's policy claims. The layer that holds the policy decides.
 *
 * `routerLink` alone, and that is the scope rather than an omission. It is the one attribute whose
 * value Atlas resolves on the way out: the click hands the Router the address as written, and
 * `UrlHandlingStrategy.extract` rewrites it to its canonical form before anything matches it. An
 * `href` is a full-page address the browser supplies and `LocationStrategy.path()` delocalizes on
 * arrival, so a locale in one is a working link to that locale's page and legitimate content.
 *
 * Three forms, because a `routerLink` is written three ways and a check that read one of them would
 * be silent for the other two. The address is assembled here because assembling it is reading:
 * an array is a list of commands the Router joins, and joining them is not a judgement.
 */
export interface AtlasTemplateAddress {
  readonly attribute: string;
  /** `static` for `routerLink="..."`, `bound` for a string expression, `array` for the command list. */
  readonly form: 'static' | 'bound' | 'array';
  /** The address as written, joined for the array form. Absolute: it always begins with `/`. */
  readonly address: string;
  readonly componentName: string;
  readonly sourcePath: string;
  readonly templatePath: string;
  readonly start: number;
  readonly end: number;
}

/** A component whose template lives in its own file, and where both of them are. */
export interface AtlasComponentTemplateAnalysis {
  /** The component class's name. */
  readonly componentName: string;
  /** The file the class is declared in. */
  readonly sourcePath: string;
  /** The template file it points at, which is where the template surface's usages were found. */
  readonly templatePath: string;
}

/**
 * What reading the application's own source found out about how it uses localization.
 *
 * Everything Atlas knows that a catalog cannot say. Reported rather than judged: this layer knows
 * what the source says and not what the configuration says, and comparing the two belongs to the
 * layer holding both.
 */
export interface AtlasApplicationAnalysis {
  /** Every place a message is used, in code and in templates. */
  readonly messageUsages: readonly AtlasMessageUsage[];
  /**
   * The messages selected for the failure path, found by resolving the symbol rather than by name.
   *
   * These are compiled separately, so they can be read when no catalog could be loaded.
   */
  readonly recoveryMessageIdentities: readonly string[];
  /**
   * Whether this owner composes the Angular application runtime.
   *
   * `specs/10-compiler-and-tooling.spec.md` section 10 makes a missing recovery root a
   * correctness error for an owner that selects an application runtime, and nothing could tell
   * that an owner had. So the error could
   * never fire: an owner authoring recovery copy and never selecting it passed generate and check
   * with no diagnostics at all. Detected the same way recovery selection itself
   * is: by resolving the symbol and requiring its declaration to come from the Atlas package,
   * rather than by matching a name any consumer could shadow.
   */
  readonly selectsApplicationRuntime?: boolean;
  /** Every route the application declares, with what each one claims about itself. */
  readonly routes: readonly AtlasRouteProjection[];
  /**
   * The locale set this owner's route policy declares, when it declares one readably.
   *
   * Reported rather than judged here: this layer knows what the source says and not what the
   * configuration says, and comparing the two is the job of the layer that holds both. Absent when
   * the owner builds no policy, or builds one from something a build cannot read.
   */
  readonly routePolicy?: AtlasRoutePolicyDeclaration;
  /** Every component whose template is a separate file, so a usage in one can be traced back. */
  readonly components: readonly AtlasComponentTemplateAnalysis[];
  /** Every locale-shaped thing a component template spells out for itself. */
  readonly localeMentions: readonly AtlasTemplateLocaleMention[];
  /** Every absolute address a component template hands to the Router. */
  readonly templateAddresses: readonly AtlasTemplateAddress[];
  /**
   * Files a route reaches only through a lazy boundary, and everything they pull in.
   *
   * Angular splits an application at `loadComponent` and `loadChildren`, and the code behind those
   * boundaries is not downloaded until the route activates. The messages used there should not be
   * either. Deriving the set is what lets Atlas load only what the first render needs without any
   * application listing scopes by hand: the list was a workaround for analysis Atlas can do.
   */
  readonly deferredSourcePaths?: readonly string[];
}

function normalizePath(path: string): string {
  return resolve(path).replaceAll('\\', '/');
}

function sourceSpan(
  source: string,
  start: number,
  length: number,
  sourcePath: string,
) {
  return atlasSourceSpan(source, start, length, sourcePath);
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
}

function typeScriptDiagnostic(
  projectRoot: string,
  diagnostic: ts.Diagnostic,
  severity: AtlasDiagnosticSeverity = 'error',
): AtlasDiagnostic {
  if (
    diagnostic.file === undefined ||
    diagnostic.start === undefined ||
    diagnostic.length === undefined
  ) {
    return atlasDiagnostic(
      'ATL1401',
      `TypeScript: ${diagnosticMessage(diagnostic)}`,
      { severity },
    );
  }
  const path = portablePath(projectRoot, diagnostic.file.fileName);
  return atlasDiagnostic(
    'ATL1401',
    `TypeScript: ${diagnosticMessage(diagnostic)}`,
    {
      severity,
      span: sourceSpan(
        diagnostic.file.text,
        diagnostic.start,
        diagnostic.length,
        path,
      ),
    },
  );
}

function propertyStringLiteral(
  checker: ts.TypeChecker,
  type: ts.Type,
  propertyName: string,
  location: ts.Node,
): string | undefined {
  const property = type.getProperty(propertyName);
  if (property === undefined) return undefined;
  const propertyType = checker.getTypeOfSymbolAtLocation(property, location);
  return propertyType.isStringLiteral() ? propertyType.value : undefined;
}

function resolvedMessageIdentity(
  checker: ts.TypeChecker,
  node: ts.Node,
): string | undefined {
  return typeMessageIdentity(checker, checker.getTypeAtLocation(node), node);
}

/**
 * A handle held in a named property of whatever an argument evaluates to.
 *
 * Read off the type rather than off an object literal's syntax, so an options object assembled in
 * a constant, spread together, or returned by a helper is seen the same way a literal at the call
 * site is. A recovery message the analysis cannot see is a message the payload does not carry, and
 * the failure is a blank region at the one moment the application has nothing else to show.
 */
function propertyMessageIdentity(
  checker: ts.TypeChecker,
  node: ts.Node,
  propertyName: string,
): string | undefined {
  const property = checker.getTypeAtLocation(node).getProperty(propertyName);
  if (property === undefined) return undefined;
  return typeMessageIdentity(
    checker,
    checker.getTypeOfSymbolAtLocation(property, node),
    node,
  );
}

function typeMessageIdentity(
  checker: ts.TypeChecker,
  type: ts.Type,
  node: ts.Node,
): string | undefined {
  if (
    propertyStringLiteral(checker, type, 'generatedAbi', node) !==
      ATLAS_GENERATED_ABI_PROFILE ||
    !['plain', 'structured'].includes(
      propertyStringLiteral(checker, type, 'resultKind', node) ?? '',
    )
  ) {
    return undefined;
  }
  return propertyStringLiteral(checker, type, 'identity', node);
}

/**
 * The symbol an expression names, with import aliases followed to what they alias.
 *
 * Every Atlas call is recognized this way rather than by name: a consumer function called
 * `withRouting` configures nothing, and one called `provideLocalization` composes nothing.
 */
function resolvedSymbol(
  checker: ts.TypeChecker,
  node: ts.Expression,
): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol === undefined) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function declaredIn(symbol: ts.Symbol, fragment: string): boolean {
  return (
    symbol
      .getDeclarations()
      ?.some((item) =>
        item.getSourceFile().fileName.replaceAll('\\', '/').includes(fragment),
      ) ?? false
  );
}

/**
 * A call that composes this owner's Atlas application runtime.
 *
 * Two spellings reach the same place. An application ordinarily calls the generated
 * `provideLocalization()`, whose declaration is in this owner's generated `#i18n`: that is the
 * whole point of generating it. An application that has a reason to assemble the setup itself
 * calls `provideLocalizationSetup()` from the package.
 *
 * Matching only the package spelling was what this did after `provideLocalization` was renamed to
 * `provideLocalizationSetup` there, and it stopped recognizing every real consumer: they all call
 * the generated wrapper. Nothing noticed, because the test for it declared its own
 * `provideLocalization` in a `@neolorn/atlas` stub: an API that no longer existed.
 */
function atlasProvideLocalization(
  checker: ts.TypeChecker,
  node: ts.CallExpression,
  generatedRoot: string,
): boolean {
  const resolved = resolvedSymbol(checker, node.expression);
  if (resolved === undefined) return false;
  if (
    resolved.name === 'provideLocalizationSetup' &&
    declaredIn(resolved, '/@neolorn/atlas/')
  ) {
    return true;
  }
  return (
    resolved.name === 'provideLocalization' &&
    declaredIn(resolved, generatedRoot)
  );
}

const ATLAS_MESSAGE_GROUP_DEPTH = 8;
const ATLAS_MESSAGE_GROUP_MEMBERS = 4096;

/**
 * Every message inside an expression that is a group of them.
 *
 * A message selected by a value only the running program has, a failure code from a service,
 * cannot be named in source, so the code that selects it hands Atlas the group instead and Atlas
 * counts every member as used. Anything less would report those messages unused and eventually
 * drop them, and the first sign of it would be a customer reading a generic apology in place of
 * what actually went wrong.
 *
 * Bounded on both depth and count: this walks a type a consumer wrote, and a type can be as deep
 * and as wide as a consumer likes.
 */
function groupMessageIdentities(
  checker: ts.TypeChecker,
  node: ts.Node,
): readonly string[] {
  const found: string[] = [];
  const seen = new Set<ts.Type>();
  const walk = (type: ts.Type, depth: number): void => {
    if (depth > ATLAS_MESSAGE_GROUP_DEPTH) return;
    if (found.length >= ATLAS_MESSAGE_GROUP_MEMBERS) return;
    if (seen.has(type)) return;
    seen.add(type);
    for (const property of checker.getPropertiesOfType(type)) {
      if (found.length >= ATLAS_MESSAGE_GROUP_MEMBERS) return;
      const propertyType = checker.getTypeOfSymbolAtLocation(property, node);
      const identity = typeMessageIdentity(checker, propertyType, node);
      if (identity !== undefined) {
        found.push(identity);
        continue;
      }
      if ((propertyType.flags & ts.TypeFlags.Object) !== 0) {
        walk(propertyType, depth + 1);
      }
    }
  };
  const type = checker.getTypeAtLocation(node);
  if ((type.flags & ts.TypeFlags.Object) === 0) return [];
  walk(type, 0);
  return found;
}

/**
 * How this owner's route data says which routes are indexable.
 *
 * Read out of the `withRouting()` call's source text rather than by running it: `field` and the
 * values beside it are string literals precisely so that they can be. A consumer that classifies
 * its routes already points Atlas at the field it already has; one that does not gets
 * `atlasIndexing`.
 */
interface AtlasRouteIndexingPolicy {
  readonly field: string;
  readonly values: ReadonlyMap<
    string,
    'indexable' | 'non-indexable' | 'private'
  >;
}

const DEFAULT_ROUTE_INDEXING_FIELD = 'atlasIndexing';

/**
 * What a class of routes claims in a sitemap, read out of `withRouting()` the same way.
 *
 * The seven `changefreq` values are the protocol's own enumeration and `priority` is bounded at 0
 * and 1, so a declaration outside either is refused here rather than written into a document a
 * validator then rejects. Refused, not dropped: a value somebody typed and Atlas silently ignored
 * is the failure this whole declaration exists to avoid.
 *
 * `lastmodField` names a second route-data field carrying a date. It is separate because a date
 * belongs to one page and a class does not have one, and it is read rather than computed, because
 * a build time is not a date the page changed on.
 */
interface AtlasRouteSitemapPolicy {
  readonly field: string;
  readonly values: ReadonlyMap<string, AtlasRouteSitemapClass>;
  readonly lastmodField?: string;
}

interface AtlasRouteSitemapClass {
  readonly changefreq?: string;
  readonly priority?: number;
}

const SITEMAP_CHANGE_FREQUENCIES = new Set([
  'always',
  'hourly',
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'never',
]);

const SITEMAP_W3C_DATE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u;

const ATLAS_DEFAULT_ROUTE_INDEXING_VALUES = new Map<
  string,
  'indexable' | 'non-indexable' | 'private'
>([
  ['indexable', 'indexable'],
  ['non-indexable', 'non-indexable'],
  ['private', 'private'],
]);

/**
 * The sitemap half of `withRouting()`, read from source text for the same reason the indexing half
 * is: the field name is the consumer's and the table is literals, so a build can see both without
 * running anything.
 *
 * A malformed entry is reported by the caller, which has the diagnostics list. This returns what it
 * could read and the refusals beside it, so one walk produces both.
 */
function routeSitemapPolicy(
  checker: ts.TypeChecker,
  node: ts.CallExpression,
):
  | {
      readonly policy: AtlasRouteSitemapPolicy;
      readonly refusals: readonly string[];
    }
  | undefined {
  const resolved = resolvedSymbol(checker, node.expression);
  if (
    resolved === undefined ||
    resolved.name !== 'withRouting' ||
    !declaredIn(resolved, '/@neolorn/atlas/')
  ) {
    return undefined;
  }
  const argument = node.arguments[0];
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
    return undefined;
  }
  const sitemap = objectProperty(argument, 'sitemap');
  if (sitemap === undefined || !ts.isObjectLiteralExpression(sitemap)) {
    return undefined;
  }
  const field = objectProperty(sitemap, 'field');
  if (field === undefined || !ts.isStringLiteralLike(field)) return undefined;
  const lastmodField = objectProperty(sitemap, 'lastmodField');
  const refusals: string[] = [];
  const values = new Map<string, AtlasRouteSitemapClass>();
  const table = objectProperty(sitemap, 'values');
  if (table !== undefined && ts.isObjectLiteralExpression(table)) {
    for (const item of table.properties) {
      if (!ts.isPropertyAssignment(item)) continue;
      const key = ts.isIdentifier(item.name)
        ? item.name.text
        : ts.isStringLiteralLike(item.name)
          ? item.name.text
          : undefined;
      const value = item.initializer;
      if (key === undefined || !ts.isObjectLiteralExpression(value)) continue;
      const changefreq = objectProperty(value, 'changefreq');
      const priority = objectProperty(value, 'priority');
      const claim: { changefreq?: string; priority?: number } = {};
      if (changefreq !== undefined) {
        if (
          ts.isStringLiteralLike(changefreq) &&
          SITEMAP_CHANGE_FREQUENCIES.has(changefreq.text)
        ) {
          claim.changefreq = changefreq.text;
        } else {
          refusals.push(
            `${JSON.stringify(key)} declares a changefreq the sitemap protocol does not list; it admits ${[...SITEMAP_CHANGE_FREQUENCIES].join(', ')}`,
          );
        }
      }
      if (priority !== undefined) {
        const read = ts.isNumericLiteral(priority)
          ? Number(priority.text)
          : undefined;
        if (read !== undefined && read >= 0 && read <= 1) {
          claim.priority = read;
        } else {
          refusals.push(
            `${JSON.stringify(key)} declares a priority that is not a number literal between 0 and 1`,
          );
        }
      }
      if (claim.changefreq !== undefined || claim.priority !== undefined) {
        values.set(key, Object.freeze(claim));
      }
    }
  }
  return {
    policy: Object.freeze({
      field: field.text,
      values,
      ...(lastmodField !== undefined && ts.isStringLiteralLike(lastmodField)
        ? { lastmodField: lastmodField.text }
        : {}),
    }),
    refusals: Object.freeze(refusals),
  };
}

function routeIndexingPolicy(
  checker: ts.TypeChecker,
  node: ts.CallExpression,
): AtlasRouteIndexingPolicy | undefined {
  const resolved = resolvedSymbol(checker, node.expression);
  if (
    resolved === undefined ||
    resolved.name !== 'withRouting' ||
    !declaredIn(resolved, '/@neolorn/atlas/')
  ) {
    return undefined;
  }
  const argument = node.arguments[0];
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
    return undefined;
  }
  const indexing = objectProperty(argument, 'indexing');
  if (indexing === undefined || !ts.isObjectLiteralExpression(indexing)) {
    return undefined;
  }
  const field = objectProperty(indexing, 'field');
  if (field === undefined || !ts.isStringLiteralLike(field)) return undefined;
  const values = new Map<string, 'indexable' | 'non-indexable' | 'private'>();
  const table = objectProperty(indexing, 'values');
  if (table !== undefined && ts.isObjectLiteralExpression(table)) {
    for (const item of table.properties) {
      if (!ts.isPropertyAssignment(item)) continue;
      const key = ts.isIdentifier(item.name)
        ? item.name.text
        : ts.isStringLiteralLike(item.name)
          ? item.name.text
          : undefined;
      const value = item.initializer;
      if (key === undefined || !ts.isStringLiteralLike(value)) continue;
      if (
        value.text === 'indexable' ||
        value.text === 'non-indexable' ||
        value.text === 'private'
      ) {
        values.set(key, value.text);
      }
    }
  }
  return Object.freeze({ field: field.text, values });
}

/**
 * What a route policy declares, read out of the call that builds it.
 *
 * An application states its locales twice and always has: once in `atlas.config.json`, which is
 * what generates the catalogs, and once in the call that builds its locale URL policy, which is
 * what turns a locale into an address. The two have to agree and nothing compared them: the
 * toolkit had no knowledge of the policy at all, so none of its diagnostics could have covered it.
 * Adding a locale to one and not the other is silent in both directions: a locale with catalogs and
 * no address is unreachable, and an address with no catalogs renders in the default language.
 *
 * It also declares the leading path segments it owns, and those are read here for a second
 * question the toolkit is the only place that can ask. A canonical route whose own first segment
 * spells one of them is an address the resolver reads as a locale rather than as a route, so the
 * route is unreachable at its own address. The policy is one file and the projection is another;
 * this is where a build first holds both.
 *
 * Read from source text rather than by running the call, for the same reason `withRouting`'s
 * indexing policy is: the keys are string literals precisely so that a build can see them. A policy
 * assembled from a computed object is not readable here, and is reported as unreadable rather than
 * as empty: an unreadable policy and a policy naming no locales must not look alike.
 *
 * All four factories are recognized, and by resolved symbol, so a consumer's own function of any of
 * those names declares nothing. Recognizing two of them was itself a hole: a policy built by
 * `createDefaultLocalePrefixPolicy` or `createLocaleNeutralPolicy` was invisible, so every check
 * that reads this was silent for it, and a check that is silent for half the ways of spelling the
 * thing it checks is not a check.
 */
/**
 * A leading path segment the policy has claimed, and what it claimed it as.
 *
 * The kind decides how it is compared, which is not a choice made here: the resolver corrects the
 * case of a prefix and of an alias, so those are matched case-insensitively, and it compares a
 * locale-neutral root exactly, so that one is matched exactly. The same rule is written in the
 * runtime, against the built policy object rather than against source text: the two packages
 * observe different things and neither can be derived from the other, so the rule is stated twice
 * and pinned together by a test rather than shared through a dependency the toolkit does not have.
 */
/**
 * A leading path segment the locale policy has taken, so an application route cannot also use it.
 *
 * What catches a route named `en` in a project whose addresses begin with a locale: the two would
 * collide, and which one wins would depend on the order they were registered in.
 */
export interface AtlasClaimedRouteSegment {
  /** The segment itself, as it appears at the start of an address. */
  readonly segment: string;
  /** Why it is taken: a locale, a spelling that resolves to one, or a root kept out of the scheme. */
  readonly kind: 'locale prefix' | 'locale alias' | 'locale-neutral root';
}

/**
 * The locale policy the application's own source declares, as the source declares it.
 *
 * Absent from the analysis when the application builds no policy, or builds one out of something a
 * build cannot read. Compared against the configuration by the layer that holds both, which is what
 * catches a policy naming locales the project does not build.
 */
export interface AtlasRoutePolicyDeclaration {
  /** Where the policy puts the locale: in the path, in the host, or nowhere. */
  readonly kind: 'path-prefix' | 'locale-host' | 'locale-neutral';
  /** The locales it names. */
  readonly locales: readonly string[];
  /**
   * Every leading path segment the policy has claimed: its locale prefixes, its aliases, and its
   * locale-neutral roots. Empty for a policy that puts no locale in the path and declares no
   * neutral roots.
   */
  readonly claimedSegments: readonly AtlasClaimedRouteSegment[];
  /** Whether the default locale's addresses carry no prefix, so a route's own segment leads. */
  readonly omitDefaultPrefix: boolean;
  /** The locale the policy treats as the default, when it names one. */
  readonly defaultLocale?: string;
  /** The file the policy is declared in. */
  readonly sourcePath: string;
  /** Where the declaration begins, as characters from the start of that file. */
  readonly start: number;
  /** Where it ends. */
  readonly end: number;
}

interface RoutePolicyFactory {
  readonly kind: AtlasRoutePolicyDeclaration['kind'];
  /** The option holding the locale table, and whether locales are its keys or its elements. */
  readonly localeOption: string;
  readonly localesAre: 'keys' | 'elements';
  /** Whether the option's values are the locale prefixes, rather than origins or nothing. */
  readonly valuesArePrefixes: boolean;
  readonly omitDefaultPrefix?: true;
}

const ROUTE_POLICY_FACTORIES = new Map<string, RoutePolicyFactory>([
  [
    'createPathPrefixLocalePolicy',
    {
      kind: 'path-prefix',
      localeOption: 'locales',
      localesAre: 'keys',
      valuesArePrefixes: true,
    },
  ],
  [
    // The same policy with `omitDefaultPrefix` fixed on, which is exactly the shape in which a
    // route's own leading segment becomes the first segment of an address.
    'createDefaultLocalePrefixPolicy',
    {
      kind: 'path-prefix',
      localeOption: 'locales',
      localesAre: 'keys',
      valuesArePrefixes: true,
      omitDefaultPrefix: true,
    },
  ],
  [
    'createHostLocalePolicy',
    {
      kind: 'locale-host',
      localeOption: 'origins',
      localesAre: 'keys',
      valuesArePrefixes: false,
    },
  ],
  [
    'createLocaleNeutralPolicy',
    {
      kind: 'locale-neutral',
      localeOption: 'locales',
      localesAre: 'elements',
      valuesArePrefixes: false,
    },
  ],
]);

/** The literal text of an object literal's property name, when it has one. */
function propertyName(item: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(item)) return undefined;
  return ts.isIdentifier(item.name) || ts.isStringLiteralLike(item.name)
    ? item.name.text
    : undefined;
}

/** The literal strings of an array literal, skipping anything not spelled out. */
function literalElements(node: ts.Expression | undefined): string[] {
  if (node === undefined || !ts.isArrayLiteralExpression(node)) return [];
  return node.elements
    .filter((element): element is ts.StringLiteralLike =>
      ts.isStringLiteralLike(element),
    )
    .map((element) => element.text);
}

function routePolicyDeclaration(
  projectRoot: string,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  node: ts.CallExpression,
): AtlasRoutePolicyDeclaration | undefined {
  const resolved = resolvedSymbol(checker, node.expression);
  if (resolved === undefined || !declaredIn(resolved, '/@neolorn/atlas/')) {
    return undefined;
  }
  const factory = ROUTE_POLICY_FACTORIES.get(resolved.name);
  if (factory === undefined) return undefined;
  const argument = node.arguments[0];
  const common = {
    kind: factory.kind,
    sourcePath: portablePath(projectRoot, sourceFile.fileName),
    start: node.getStart(sourceFile),
    end: node.getEnd(),
  };
  if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
    return Object.freeze({
      locales: Object.freeze([]),
      claimedSegments: Object.freeze([]),
      omitDefaultPrefix: factory.omitDefaultPrefix ?? false,
      ...common,
    });
  }
  const table = objectProperty(argument, factory.localeOption);
  const defaultLocale = objectProperty(argument, 'defaultLocale');
  const locales: string[] = [];
  const claimed = new Map<string, AtlasClaimedRouteSegment>();
  const claim = (
    segment: string,
    kind: AtlasClaimedRouteSegment['kind'],
  ): void => {
    if (!claimed.has(segment)) claimed.set(segment, { segment, kind });
  };
  if (factory.localesAre === 'elements') {
    locales.push(...literalElements(table));
  } else if (table !== undefined && ts.isObjectLiteralExpression(table)) {
    for (const item of table.properties) {
      const name = propertyName(item);
      if (name === undefined) continue;
      locales.push(name);
      const value = (item as ts.PropertyAssignment).initializer;
      if (factory.valuesArePrefixes && ts.isStringLiteralLike(value)) {
        claim(value.text, 'locale prefix');
      }
    }
  }
  // Aliases are claimed by their key, the older spelling, and neutral roots by their own text.
  // Both are leading segments the resolver reads before it reads a route, which is the only thing
  // that puts them in this list.
  const aliases = objectProperty(argument, 'aliases');
  if (
    factory.valuesArePrefixes &&
    aliases !== undefined &&
    ts.isObjectLiteralExpression(aliases)
  ) {
    for (const item of aliases.properties) {
      const name = propertyName(item);
      if (name !== undefined) claim(name, 'locale alias');
    }
  }
  for (const root of literalElements(
    objectProperty(argument, 'localeNeutralRoots'),
  )) {
    claim(root, 'locale-neutral root');
  }
  const omitOption = objectProperty(argument, 'omitDefaultPrefix');
  return Object.freeze({
    locales: Object.freeze(locales),
    claimedSegments: Object.freeze(
      [...claimed.values()].map((entry) => Object.freeze(entry)),
    ),
    omitDefaultPrefix:
      factory.omitDefaultPrefix ??
      (omitOption !== undefined &&
        omitOption.kind === ts.SyntaxKind.TrueKeyword),
    ...(defaultLocale !== undefined && ts.isStringLiteralLike(defaultLocale)
      ? { defaultLocale: defaultLocale.text }
      : {}),
    ...common,
  });
}

/** The initializer of one property of an object literal, unwrapped of parentheses and assertions. */
function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const item of object.properties) {
    if (!ts.isPropertyAssignment(item)) continue;
    const matches =
      (ts.isIdentifier(item.name) && item.name.text === name) ||
      (ts.isStringLiteralLike(item.name) && item.name.text === name);
    if (!matches) continue;
    let current: ts.Expression = item.initializer;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  }
  return undefined;
}

/**
 * The module specifier of a dynamic import inside a route loader.
 *
 * Angular accepts `() => import('./x')`, `() => import('./x').then(m => m.C)`, and the same
 * wrapped in `async`. Only a literal specifier is recognized: a computed one cannot be resolved at
 * build time by anyone, including the bundler, so treating it as a boundary would be a guess.
 */
function dynamicImportSpecifier(node: ts.Node): string | undefined {
  let found: string | undefined;
  const visit = (current: ts.Node): void => {
    if (found !== undefined) return;
    if (
      ts.isCallExpression(current) &&
      current.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const argument = current.arguments[0];
      if (argument !== undefined && ts.isStringLiteralLike(argument)) {
        found = argument.text;
        return;
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/**
 * The files reachable from a set of entry modules by ordinary static imports.
 *
 * Used twice, for the two halves of the same question: what the first render pulls in, and what a
 * lazy route pulls in. A file in both is eager, because something outside the boundary already
 * needed it.
 */
function staticImportClosure(
  program: ts.Program,
  entries: readonly ts.SourceFile[],
): Set<string> {
  const reached = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as ts.SourceFile;
    const key = normalizePath(file.fileName);
    if (reached.has(key)) continue;
    reached.add(key);
    for (const statement of file.statements) {
      const specifier =
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteralLike(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      if (specifier === undefined) continue;
      const resolved = resolveModule(program, file, specifier);
      if (resolved !== undefined && !resolved.isDeclarationFile) {
        pending.push(resolved);
      }
    }
  }
  return reached;
}

function resolveModule(
  program: ts.Program,
  from: ts.SourceFile,
  specifier: string,
): ts.SourceFile | undefined {
  const resolved = ts.resolveModuleName(
    specifier,
    from.fileName,
    program.getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  return resolved === undefined
    ? undefined
    : program.getSourceFile(resolved.resolvedFileName);
}

function componentDecorator(
  checker: ts.TypeChecker,
  declaration: ts.ClassDeclaration,
): ts.CallExpression | undefined {
  const decorators = ts.canHaveDecorators(declaration)
    ? (ts.getDecorators(declaration) ?? [])
    : [];
  for (const decorator of decorators) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const symbol = checker.getSymbolAtLocation(decorator.expression.expression);
    if (symbol === undefined) continue;
    const resolved =
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    if (
      resolved.name === 'Component' &&
      resolved
        .getDeclarations()
        ?.some((item) =>
          item
            .getSourceFile()
            .fileName.replaceAll('\\', '/')
            .includes('/@angular/core/'),
        )
    ) {
      return decorator.expression;
    }
  }
  return undefined;
}

function metadataString(
  metadata: ts.ObjectLiteralExpression,
  name: string,
): ts.StringLiteralLike | undefined {
  for (const property of metadata.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ((ts.isIdentifier(property.name) && property.name.text === name) ||
        (ts.isStringLiteralLike(property.name) &&
          property.name.text === name)) &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

/**
 * Does this string have the shape of a language tag?
 *
 * A cheap prefilter, and deliberately only that. It keeps every ordinary template string out of the
 * report (a CSS class, a route path, a message) without deciding anything: whether `"en-US"` is
 * one of this application's locales is a question for the layer holding the locale set, and a two
 * to eight letter primary subtag with optional script and region subtags is the smallest shape that
 * cannot exclude a real one. `ltr` and `rtl` match it and are meant to; the judging layer knows
 * which attribute they came from.
 */
const LANGUAGE_TAG_SHAPE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/** The attribute whose value Atlas resolves, and the only one this reports. */
const ROUTER_LINK = 'routerLink';

/**
 * The absolute address a `routerLink` value spells, or nothing.
 *
 * Nothing is the answer for three different situations and they are all the same answer here: a
 * relative address, which resolves under the route the reader is already on and can carry no
 * prefix; an address whose leading segments are computed, which is decided per value at runtime
 * exactly as a parameterised route path is; and an expression that is not an address at all.
 *
 * The array form is the Router's command list, and only its leading literal run is read. `['/', x]`
 * yields `/` and stops, which spells no segment and is declined: the same rule as a route path
 * whose first segment is `:slug`. Repeated separators collapse because the Router joins commands
 * with one, so `['/', 'ar-eg']` and `['/ar-eg']` are the same address written twice.
 */
function absoluteAddress(written: string): string | undefined {
  const collapsed = written.replaceAll(/\/{2,}/gu, '/');
  return collapsed.startsWith('/') ? collapsed : undefined;
}

function routerLinkAddress(
  value: AST,
): { readonly form: 'bound' | 'array'; readonly address: string } | undefined {
  const ast = value instanceof ASTWithSource ? value.ast : value;
  if (ast instanceof LiteralPrimitive) {
    if (typeof ast.value !== 'string') return undefined;
    const address = absoluteAddress(ast.value);
    return address === undefined ? undefined : { form: 'bound', address };
  }
  if (!(ast instanceof LiteralArray)) return undefined;
  const commands: string[] = [];
  for (const element of ast.expressions) {
    if (!(element instanceof LiteralPrimitive)) break;
    if (typeof element.value !== 'string') break;
    commands.push(element.value);
  }
  if (commands.length === 0) return undefined;
  const address = absoluteAddress(commands.join('/'));
  return address === undefined || address === '/'
    ? undefined
    : { form: 'array', address };
}

function templatePropertyPath(
  ast: PropertyRead,
): readonly string[] | undefined {
  const result: string[] = [];
  let current: AST = ast;
  while (current instanceof PropertyRead) {
    result.push(current.name);
    current = current.receiver;
  }
  return current instanceof ImplicitReceiver ? result.reverse() : undefined;
}

function templateMessageIdentity(
  checker: ts.TypeChecker,
  component: ts.ClassDeclaration,
  path: readonly string[],
): string | undefined {
  let type = checker.getTypeAtLocation(component);
  for (const part of path) {
    const property = type.getProperty(part);
    if (property === undefined) return undefined;
    type = checker.getTypeOfSymbolAtLocation(property, component);
  }
  return propertyStringLiteral(checker, type, 'identity', component);
}

class TemplateExpressionVisitor extends RecursiveAstVisitor {
  constructor(
    private readonly onPropertyRead: (property: PropertyRead) => void,
    private readonly onStringLiteral: (literal: LiteralPrimitive) => void,
  ) {
    super();
  }

  override visitPropertyRead(ast: PropertyRead, context: unknown): unknown {
    this.onPropertyRead(ast);
    return super.visitPropertyRead(ast, context);
  }

  override visitLiteralPrimitive(
    ast: LiteralPrimitive,
    context: unknown,
  ): unknown {
    if (typeof ast.value === 'string') this.onStringLiteral(ast);
    return super.visitLiteralPrimitive(ast, context);
  }
}

class TemplateNodeVisitor extends TmplAstRecursiveVisitor {
  constructor(
    private readonly expressions: TemplateExpressionVisitor,
    private readonly onElement: (element: TmplAstElement) => void,
  ) {
    super();
  }

  override visitElement(element: TmplAstElement): void {
    this.onElement(element);
    super.visitElement(element);
  }

  private visitExpression(expression: AST): void {
    expression.visit(this.expressions);
  }

  override visitBoundText(text: TmplAstBoundText): void {
    this.visitExpression(text.value);
    super.visitBoundText(text);
  }

  override visitBoundAttribute(attribute: TmplAstBoundAttribute): void {
    this.visitExpression(attribute.value);
    super.visitBoundAttribute(attribute);
  }

  override visitBoundEvent(event: TmplAstBoundEvent): void {
    this.visitExpression(event.handler);
    super.visitBoundEvent(event);
  }

  override visitLetDeclaration(declaration: TmplAstLetDeclaration): void {
    this.visitExpression(declaration.value);
    super.visitLetDeclaration(declaration);
  }
}

/**
 * The symbol a type carries, or nothing where it carries none.
 *
 * The compiler API declares `symbol` as always present. An anonymous object type, a union and an
 * intrinsic type each reach here without one, and the type under inspection is a consumer's.
 */
function typeSymbol(type: ts.Type): ts.Symbol | undefined {
  return type.symbol;
}

function isRoutesContract(
  checker: ts.TypeChecker,
  declaration: ts.VariableDeclaration,
): ts.Expression | undefined {
  const initializer = declaration.initializer;
  const typeNode =
    initializer !== undefined && ts.isSatisfiesExpression(initializer)
      ? initializer.type
      : declaration.type;
  const expression =
    initializer !== undefined && ts.isSatisfiesExpression(initializer)
      ? initializer.expression
      : initializer;
  if (typeNode === undefined || expression === undefined) return undefined;
  const type = checker.getTypeFromTypeNode(typeNode);
  const symbol = type.aliasSymbol ?? typeSymbol(type);
  if (
    symbol?.name !== 'Routes' ||
    !symbol
      .getDeclarations()
      ?.some((item) =>
        item
          .getSourceFile()
          .fileName.replaceAll('\\', '/')
          .includes('/@angular/router/'),
      )
  ) {
    return undefined;
  }
  return expression;
}

/**
 * The runtime's route-identity grammar, restated where ids are made.
 *
 * `angular.ts` rejects a `routeId` outside this shape when generated routing state is adopted.
 * Deriving an id here that fails there would move a build-time naming mistake into the browser,
 * so the two must agree; the constant is duplicated rather than imported because the toolkit does
 * not depend on the runtime package.
 */
const ROUTE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const ROUTE_IDENTITY_PREFIX = 'route:';

/**
 * One mark for every parameter segment.
 *
 * `_` cannot come out of `routeSegmentSlug`, so a marked segment can never be confused with a
 * literal one: `/orders/:id` and a literal `/orders/_` are different ids, as they are different
 * URLs.
 */
const ROUTE_PARAMETER_MARK = '_';

/** The empty path. Unreachable from any literal, for the same reason as the parameter mark. */
const ROUTE_ROOT_MARK = '_index';

function routeSegments(fullPath: string): readonly string[] {
  return fullPath.split('/').filter((segment) => segment.length > 0);
}

/**
 * A literal path segment reduced to the identity alphabet.
 *
 * One pass: runs of unusable characters collapse to a single `-`, and none survives at either end.
 * A segment with nothing usable in it (punctuation only, or a non-Latin script the identity
 * grammar has no room for) yields the empty string, and the caller reports that rather than
 * inventing a name for it.
 */
function routeSegmentSlug(segment: string): string {
  let slug = '';
  let separated = false;
  for (const character of segment) {
    const usable =
      (character >= 'A' && character <= 'Z') ||
      (character >= 'a' && character <= 'z') ||
      (character >= '0' && character <= '9');
    if (!usable) {
      separated = true;
      continue;
    }
    if (separated && slug.length > 0) slug += '-';
    separated = false;
    slug += character;
  }
  return slug;
}

/** `undefined` when the path cannot be named within the identity grammar. */
function routeIdentity(fullPath: string): string | undefined {
  const segments = routeSegments(fullPath);
  const marks: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(':')) {
      marks.push(ROUTE_PARAMETER_MARK);
      continue;
    }
    const slug = routeSegmentSlug(segment);
    if (slug.length === 0) return undefined;
    marks.push(slug);
  }
  const identity = `${ROUTE_IDENTITY_PREFIX}${marks.length === 0 ? ROUTE_ROOT_MARK : marks.join('.')}`;
  return ROUTE_IDENTITY_PATTERN.test(identity) ? identity : undefined;
}

/**
 * A route as read, before its name is settled.
 *
 * Naming cannot happen while reading: a collision is a fact about two routes, and the second one
 * may be declared in another file.
 */
interface AtlasRouteDraft {
  readonly declaredId?: string;
  readonly path: string;
  readonly parameterNames: readonly string[];
  /**
   * The route's own string-valued `data`, as written.
   *
   * Kept rather than resolved on the spot because the field to read is named in the provider file,
   * which is a different file and may be read after this one. Bounded, and transient: it is
   * consulted once when routes are classified and never emitted.
   */
  readonly data: readonly (readonly [string, string])[];
  /** The lazy entry modules on this route's path from the root, innermost last. */
  readonly lazyEntries: readonly string[];
  readonly sourcePath: string;
  readonly start: number;
  readonly end: number;
}

const ATLAS_ROUTE_DATA_ENTRIES = 32;
const ATLAS_ROUTE_DATA_VALUE_CHARACTERS = 128;

function declaresRouteData(draft: AtlasRouteDraft): boolean {
  return draft.declaredId !== undefined || draft.data.length > 0;
}

/**
 * Settle every route's name, and say so when one cannot be settled.
 *
 * Two routes sharing an address are one route: a parent and its `{ path: '' }` child describe the
 * same URL, and the deeper declaration is the one that renders the page, so its explicit route
 * data wins. Two *different* addresses sharing a name is the opposite, a defect, and neither
 * is indexed until the consumer separates them, because indexing one of them under a name that
 * also describes the other silently attaches a page's copy to the wrong page.
 *
 * Nothing here blocks a build. Route projection feeds an optional capability, and an application
 * that never enables it should not fail to compile over the name of a route it does not index.
 */
function resolveRouteIdentities(
  drafts: readonly AtlasRouteDraft[],
  policy: AtlasRouteIndexingPolicy | undefined,
  sitemapPolicy: AtlasRouteSitemapPolicy | undefined,
  deferredFor: (draft: AtlasRouteDraft) => readonly string[],
  diagnostics: AtlasDiagnostic[],
): AtlasRouteProjection[] {
  const field = policy?.field ?? DEFAULT_ROUTE_INDEXING_FIELD;
  const values = policy?.values ?? ATLAS_DEFAULT_ROUTE_INDEXING_VALUES;
  /**
   * A route's sitemap claim, or nothing.
   *
   * There is no Atlas default field here, unlike indexing. A route with no claim is published with
   * its address and its alternates and says nothing more, which is a complete entry; a route with
   * no indexing class has to be sorted into one, because whether a crawler may see it is not a
   * question a document can decline to answer.
   */
  const claimOf = (draft: AtlasRouteDraft): AtlasRouteProjection['sitemap'] => {
    if (sitemapPolicy === undefined) return undefined;
    const written = draft.data.find(
      ([key]) => key === sitemapPolicy.field,
    )?.[1];
    const declared =
      written === undefined ? undefined : sitemapPolicy.values.get(written);
    const lastmodField = sitemapPolicy.lastmodField;
    const lastmod =
      lastmodField === undefined
        ? undefined
        : draft.data.find(([key]) => key === lastmodField)?.[1];
    if (lastmod !== undefined && !SITEMAP_W3C_DATE.test(lastmod)) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1412',
          `Route ${JSON.stringify(`/${draft.path}`)} declares ${JSON.stringify(lastmodField)} as ${JSON.stringify(lastmod)}, which is not a W3C date such as 2026-09-08 or 2026-09-08T17:33:30+03:00. It is left out of the sitemap rather than written into a document a validator refuses.`,
          { path: ['routes', draft.sourcePath], severity: 'warning' },
        ),
      );
    }
    const claim = {
      ...(declared?.changefreq === undefined
        ? {}
        : { changefreq: declared.changefreq }),
      ...(declared?.priority === undefined
        ? {}
        : { priority: declared.priority }),
      ...(lastmod === undefined || !SITEMAP_W3C_DATE.test(lastmod)
        ? {}
        : { lastmod }),
    };
    return Object.keys(claim).length === 0 ? undefined : Object.freeze(claim);
  };
  // Routes default to indexable, so only the exceptions need naming. An unlisted value is not an
  // error: a consumer's field classifies routes for the consumer's own reasons, and most of those
  // reasons say nothing about indexing.
  const classify = (
    draft: AtlasRouteDraft,
  ): 'indexable' | 'non-indexable' | 'private' => {
    const written = draft.data.find(([key]) => key === field)?.[1];
    return written === undefined
      ? 'indexable'
      : (values.get(written) ?? 'indexable');
  };
  const byPath = new Map<string, AtlasRouteDraft>();
  for (const draft of drafts) {
    const existing = byPath.get(draft.path);
    if (
      existing === undefined ||
      (!declaresRouteData(existing) && declaresRouteData(draft))
    ) {
      byPath.set(draft.path, draft);
    }
  }

  const named: { readonly id: string; readonly draft: AtlasRouteDraft }[] = [];
  for (const draft of byPath.values()) {
    if (draft.declaredId !== undefined) {
      if (!ROUTE_IDENTITY_PATTERN.test(draft.declaredId)) {
        diagnostics.push(
          atlasDiagnostic(
            'ATL1404',
            `Route ${JSON.stringify(`/${draft.path}`)} declares the identity ${JSON.stringify(draft.declaredId)}, which the localization runtime will refuse. An identity begins with a letter or digit and continues with letters, digits, and ".", "_", ":", or "-", up to 128 characters.`,
            { path: ['routes', draft.sourcePath], severity: 'warning' },
          ),
        );
        continue;
      }
      named.push({ id: draft.declaredId, draft });
      continue;
    }
    const identity = routeIdentity(draft.path);
    if (identity === undefined) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1404',
          `Atlas could not derive a stable identity for route ${JSON.stringify(`/${draft.path}`)}. Declare one as \`data.atlasRouteId\` to index it.`,
          { path: ['routes', draft.sourcePath], severity: 'warning' },
        ),
      );
      continue;
    }
    named.push({ id: identity, draft });
  }

  const byIdentity = new Map<string, AtlasRouteDraft[]>();
  for (const entry of named) {
    const group = byIdentity.get(entry.id);
    if (group === undefined) byIdentity.set(entry.id, [entry.draft]);
    else group.push(entry.draft);
  }

  const projections: AtlasRouteProjection[] = [];
  for (const entry of named) {
    const group = byIdentity.get(entry.id) as AtlasRouteDraft[];
    if (group.length > 1) {
      if (group[0] === entry.draft) {
        diagnostics.push(
          atlasDiagnostic(
            'ATL1404',
            `Routes ${group.map(({ path }) => JSON.stringify(`/${path}`)).join(', ')} all resolve to the identity ${JSON.stringify(entry.id)}. Declare \`data.atlasRouteId\` on each to separate them; none is indexed until they differ.`,
            { path: ['routes', entry.draft.sourcePath], severity: 'warning' },
          ),
        );
      }
      continue;
    }
    const { declaredId: _declaredId, data: _data, ...rest } = entry.draft;
    const { lazyEntries: _lazyEntries, ...projected } = rest;
    // Asked once. It reports a malformed date, so a second call would report it twice.
    const claim = claimOf(entry.draft);
    projections.push(
      Object.freeze({
        id: entry.id,
        ...projected,
        indexing: classify(entry.draft),
        ...(claim === undefined ? {} : { sitemap: claim }),
        deferredSourcePaths: deferredFor(entry.draft),
      }),
    );
  }
  return projections;
}

function analyzeRoutes(
  projectRoot: string,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  routes: AtlasRouteDraft[],
  program: ts.Program,
  lazyEntryFiles: Set<ts.SourceFile>,
  diagnostics: AtlasDiagnostic[],
  childRouteFiles: Set<string>,
): void {
  const unwrap = (expression: ts.Expression): ts.Expression => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const property = (
    object: ts.ObjectLiteralExpression,
    name: string,
  ): ts.PropertyAssignment | undefined =>
    object.properties.find(
      (item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) &&
        ((ts.isIdentifier(item.name) && item.name.text === name) ||
          (ts.isStringLiteralLike(item.name) && item.name.text === name)),
    );
  const literal = (
    object: ts.ObjectLiteralExpression,
    name: string,
  ): string | undefined => {
    const value = property(object, name)?.initializer;
    return value !== undefined && ts.isStringLiteralLike(unwrap(value))
      ? (unwrap(value) as ts.StringLiteralLike).text
      : undefined;
  };
  const dataLiteral = (
    object: ts.ObjectLiteralExpression,
    name: string,
  ): string | undefined => {
    const data = property(object, 'data')?.initializer;
    const unwrapped = data === undefined ? undefined : unwrap(data);
    return unwrapped !== undefined && ts.isObjectLiteralExpression(unwrapped)
      ? literal(unwrapped, name)
      : undefined;
  };
  // Every string-valued entry, because which one matters is decided in another file.
  const routeData = (
    object: ts.ObjectLiteralExpression,
  ): readonly (readonly [string, string])[] => {
    const data = property(object, 'data')?.initializer;
    const unwrapped = data === undefined ? undefined : unwrap(data);
    if (unwrapped === undefined || !ts.isObjectLiteralExpression(unwrapped)) {
      return [];
    }
    const entries: (readonly [string, string])[] = [];
    for (const item of unwrapped.properties) {
      if (entries.length >= ATLAS_ROUTE_DATA_ENTRIES) break;
      if (!ts.isPropertyAssignment(item)) continue;
      const key = ts.isIdentifier(item.name)
        ? item.name.text
        : ts.isStringLiteralLike(item.name)
          ? item.name.text
          : undefined;
      const value = unwrap(item.initializer);
      if (
        key === undefined ||
        !ts.isStringLiteralLike(value) ||
        value.text.length > ATLAS_ROUTE_DATA_VALUE_CHARACTERS
      ) {
        continue;
      }
      entries.push(Object.freeze([key, value.text] as const));
    }
    return Object.freeze(entries);
  };
  const join = (parent: string, child: string): string =>
    [parent, child].filter((segment) => segment.length > 0).join('/');
  // `parentPath` has no default on purpose: `undefined` means "an address Atlas cannot know", and
  // a default would quietly turn that into the root, naming a whole subtree as if it sat at the
  // top of the application.
  const visitArray = (
    expression: ts.Expression,
    parentPath: string | undefined,
    parentLazyEntries: readonly string[],
  ): void => {
    const array = unwrap(expression);
    if (!ts.isArrayLiteralExpression(array)) return;
    for (const element of array.elements) {
      const unwrapped = unwrap(element as ts.Expression);
      if (!ts.isObjectLiteralExpression(unwrapped)) continue;
      const pathProperty = property(unwrapped, 'path');
      const pathInitializer = pathProperty?.initializer;
      const pathExpression =
        pathInitializer === undefined ? undefined : unwrap(pathInitializer);
      // A route with no `path` is pathless: it renders without contributing a URL segment, so it
      // has its parent's address rather than none. A computed `path` is an address Atlas cannot
      // know, which leaves the subtree below it unnameable rather than invisible. Ending the visit
      // at either hides every route beneath a pathless layout, and with them every lazy boundary
      // beneath it: those messages then load eagerly, forever, with nothing to say so.
      const ownPath =
        pathExpression === undefined
          ? ''
          : ts.isStringLiteralLike(pathExpression)
            ? pathExpression.text
            : undefined;
      const fullPath =
        parentPath === undefined || ownPath === undefined
          ? undefined
          : join(parentPath, ownPath);
      // Where Angular splits the bundle. A dynamic import in either position means the code,
      // and therefore the messages, behind this route are not part of the first render. Read
      // before the route is recorded, because which boundary a route sits behind is part of what
      // is recorded about it.
      const ownEntries: string[] = [];
      let defersChildRoutes = false;
      for (const name of ['loadComponent', 'loadChildren']) {
        const loader = property(unwrapped, name)?.initializer;
        if (loader === undefined) continue;
        if (name === 'loadChildren') defersChildRoutes = true;
        const specifier = dynamicImportSpecifier(unwrap(loader));
        const target =
          specifier === undefined
            ? undefined
            : resolveModule(program, sourceFile, specifier);
        if (target !== undefined && !target.isDeclarationFile) {
          lazyEntryFiles.add(target);
          ownEntries.push(normalizePath(target.fileName));
          // A file reached through `loadChildren` holds child routes, and it declares them as a
          // `Routes` constant like any other route file. The pass over every source file would
          // therefore visit it as a route table of its own, with no parent, and project `detail`
          // where the application serves `section/detail`. Recorded here and dropped after the
          // walk, because that file may be visited before the route that references it.
          if (name === 'loadChildren') {
            childRouteFiles.add(portablePath(projectRoot, target.fileName));
          }
        }
      }
      const lazyEntries =
        ownEntries.length === 0
          ? parentLazyEntries
          : Object.freeze([...parentLazyEntries, ...ownEntries]);

      const redirect = property(unwrapped, 'redirectTo');
      const children = property(unwrapped, 'children')?.initializer;
      const portableSourcePath = portablePath(projectRoot, sourceFile.fileName);
      const address =
        fullPath !== undefined
          ? JSON.stringify(`/${fullPath}`)
          : ownPath !== undefined
            ? JSON.stringify(`\u2026/${ownPath}`)
            : 'A route with a computed address';

      // Angular's own rule, restated where it runs.
      //
      // `validateNode` throws on a route carrying none of these
      // (`@angular/router/fesm2022/_router-chunk.mjs:2788`), and both of its call sites sit inside
      // `if (typeof ngDevMode === 'undefined' || ngDevMode)`. A production build validates no route
      // config at all: a route nothing can render ships, and surfaces only for whoever next runs a
      // development build. Atlas reads the same table at generate time, before either build, and is
      // the only thing standing between such a route and the projection, which would otherwise
      // give it an identity, a localized spelling per locale, and a place in the catalog.
      if (
        redirect === undefined &&
        children === undefined &&
        !defersChildRoutes &&
        property(unwrapped, 'component') === undefined &&
        property(unwrapped, 'loadComponent') === undefined
      ) {
        diagnostics.push(
          atlasDiagnostic(
            'ATL1405',
            `${address} carries none of \`component\`, \`loadComponent\`, \`redirectTo\`, \`children\` or \`loadChildren\`, so nothing renders it. Angular refuses this route too, but only in a development build.`,
            { path: ['routes', portableSourcePath] },
          ),
        );
      }

      // What the projection cannot reach, said out loud.
      //
      // Atlas localizes the routes its analysis can name, and a route it was never shown is not one
      // of them. Two constructs hide addresses and neither is exotic: a `path` that is not a string
      // literal makes the route and everything beneath it unnameable, and `loadChildren` puts the
      // child table in a file this one only references. The consequence is not a missing page,
      // the Router serves it either way, but a prerendered file at a localized address rendered
      // in the default locale, which is worse than no file, because it looks right.
      //
      // Diagnosed rather than covered, deliberately. Following the `loadChildren` target would
      // close this instance and none of the class: a table assembled at runtime, spread in from a
      // helper, or returned by a function hides routes in exactly the same way and would each need
      // their own reader. What Atlas owes is to know which routes it covers and to be loud about
      // the rest.
      //
      // A warning rather than a refusal, and the deciding reason is what a check can be made to
      // fail on rather than any argument about `loadChildren`.
      //
      // `analyzeAtlasApplication` returns `atlasFailure` on any error-severity diagnostic, and it
      // returns there **before** the lazy closure is computed and before any value reaches a caller.
      // So at error severity two behaviours below this line stop being observable: the boundary
      // reading under an unnameable address, which decides whether those messages defer, and the
      // drop that stops a child route table from being projected at an address the application does
      // not serve. Both still run in the sense that the code is there. Neither can be tested, because
      // every test of them reaches the same early return this diagnostic causes.
      //
      // The check and the thing it checks share a source here, in a shape that is not a test:
      // this function's own failure path, so the check agrees by construction and stays green
      // either way. With `ATL1406` at error severity, disabling the drop entirely changes no test
      // in the suite. At warning severity the same mutation fails, reporting `route:detail` beside
      // `route:section`. A severity that makes its own neighbours unfalsifiable is the wrong
      // severity whatever else recommends it.
      //
      // The rest of the case, which would not have been enough on its own: `loadChildren` is
      // ordinary, supported Angular, and refusing to generate on it would mean no application
      // containing one anywhere can adopt Atlas at all, with "restructure your routing" as the only
      // remedy. That is a wall rather than a limit, and Atlas is meant to sit in applications it did
      // not design. What the item actually requires is that this not be silent, and a named warning
      // carrying the route, the consequence and the remedy is not silence.
      if (parentPath !== undefined && ownPath === undefined) {
        diagnostics.push(
          atlasDiagnostic(
            'ATL1406',
            `A route under ${JSON.stringify(`/${parentPath}`)} computes its \`path\`, so Atlas can name neither it nor anything below it. Those addresses stay outside the localized route table and are served at their canonical spelling, in the default locale. Give the route a string-literal \`path\`, or keep the subtree out of the localized table on purpose.`,
            { path: ['routes', portableSourcePath], severity: 'warning' },
          ),
        );
      }
      if (defersChildRoutes) {
        diagnostics.push(
          atlasDiagnostic(
            'ATL1406',
            `${address} loads its children through \`loadChildren\`, so their addresses live in a file this route only references and stay outside the localized route table. They are served at their canonical spelling, in the default locale, including under a locale prefix, where the address looks localized and the page is not. Declare those children inline to localize them.`,
            { path: ['routes', portableSourcePath], severity: 'warning' },
          ),
        );
      }

      if (
        redirect === undefined &&
        fullPath !== undefined &&
        pathExpression !== undefined &&
        // A wildcard matches every address, at any depth, so it names none of them.
        !routeSegments(fullPath).includes('**')
      ) {
        const declaredId = dataLiteral(unwrapped, 'atlasRouteId');
        routes.push(
          Object.freeze({
            ...(declaredId === undefined ? {} : { declaredId }),
            path: fullPath,
            parameterNames: Object.freeze(
              fullPath
                .split('/')
                .filter((segment) => segment.startsWith(':'))
                .map((segment) => segment.slice(1)),
            ),
            data: routeData(unwrapped),
            lazyEntries,
            sourcePath: portableSourcePath,
            start: pathExpression.getStart(sourceFile),
            end: pathExpression.getEnd(),
          }),
        );
      }
      if (children !== undefined) visitArray(children, fullPath, lazyEntries);
    }
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const expression = isRoutesContract(checker, declaration);
      if (expression === undefined) continue;
      visitArray(expression, '', []);
    }
  }
}

function sourceMap(
  sources: readonly AtlasAnalysisSource[],
): ReadonlyMap<string, string> {
  return new Map(
    sources.map((source) => [normalizePath(source.path), source.contents]),
  );
}

export function analyzeAtlasApplication(
  request: AtlasApplicationAnalysisRequest,
): AtlasResult<AtlasApplicationAnalysis> {
  const hostCompatibility = admitAtlasHostCompatibility();
  if (!hostCompatibility.ok) return hostCompatibility;
  const projectRoot = resolve(request.projectRoot);
  const diagnostics: AtlasDiagnostic[] = [];
  const suppliedSources = sourceMap(request.sources ?? []);
  const virtualRoot = resolve(projectRoot, '.atlas-virtual');
  const virtualPaths = new Map<string, string>();
  const virtualSources = new Map<string, string>();
  for (const module of request.virtualModules ?? []) {
    if (!module.specifier.startsWith('#i18n')) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1403',
          `Virtual analysis module ${JSON.stringify(module.specifier)} is outside the generated #i18n namespace.`,
        ),
      );
      continue;
    }
    const suffix =
      module.specifier === '#i18n' ? 'index' : module.specifier.slice(7);
    const path = resolve(virtualRoot, `${suffix}.ts`);
    virtualPaths.set(module.specifier, path);
    virtualSources.set(normalizePath(path), module.contents);
  }
  if (diagnostics.length > 0) return atlasFailure(diagnostics);

  // Used only when the owner exposes no selectable TypeScript configuration.
  // A consumer that has one governs its own program.
  const fallbackOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.Preserve,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    experimentalDecorators: true,
    strict: true,
    baseUrl: projectRoot,
  };
  const virtualPathEntries = [...virtualPaths.entries()].map(
    ([specifier, path]): [string, string[]] => [specifier, [path]],
  );
  // Generated #i18n specifiers overlay the consumer's own aliases rather than
  // replacing them; discarding the consumer's paths would leave real imports
  // unresolved and degrade every type the analysis depends on.
  const compilerOptions: ts.CompilerOptions = {
    ...(request.compilerOptions ?? fallbackOptions),
    noEmit: true,
    ignoreDeprecations: '6.0',
    paths: {
      ...(request.compilerOptions?.paths ?? {}),
      ...Object.fromEntries(virtualPathEntries),
    },
    ...(request.typeNames === undefined
      ? {}
      : { types: [...request.typeNames] }),
  };
  const defaultHost = ts.createCompilerHost(compilerOptions, true);
  const suppliedDirectories = new Set(
    [...suppliedSources.keys(), ...virtualSources.keys()].map((path) =>
      normalizePath(dirname(path)),
    ),
  );
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (path) => {
      const normalized = normalizePath(path);
      return (
        suppliedSources.has(normalized) ||
        virtualSources.has(normalized) ||
        defaultHost.fileExists(path)
      );
    },
    readFile: (path) => {
      const normalized = normalizePath(path);
      return (
        suppliedSources.get(normalized) ??
        virtualSources.get(normalized) ??
        defaultHost.readFile(path)
      );
    },
    directoryExists: (path) =>
      suppliedDirectories.has(normalizePath(path)) ||
      (defaultHost.directoryExists?.(path) ?? false),
    getSourceFile: (
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      const normalized = normalizePath(fileName);
      const contents =
        suppliedSources.get(normalized) ?? virtualSources.get(normalized);
      return contents === undefined
        ? defaultHost.getSourceFile(
            fileName,
            languageVersion,
            onError,
            shouldCreateNewSourceFile,
          )
        : ts.createSourceFile(fileName, contents, languageVersion, true);
    },
  };
  const program = ts.createProgram({
    rootNames: request.rootNames.map((path) =>
      isAbsolute(path) ? path : resolve(projectRoot, path),
    ),
    options: compilerOptions,
    host,
  });
  const maximum = Math.max(1, Math.min(request.maxDiagnostics ?? 100, 1000));
  // A defect inside a generated #i18n module is Atlas's own and must block.
  // A finding in consumer source is reported for visibility but never blocks:
  // the consumer's build is the authority on whether their application
  // compiles, and generation must stay reachable so a missing #i18n contract
  // can always be restored.
  const virtualModulePaths = new Set(virtualSources.keys());
  const isAtlasOwned = (diagnostic: ts.Diagnostic): boolean =>
    diagnostic.file !== undefined &&
    virtualModulePaths.has(normalizePath(diagnostic.file.fileName));

  // The cap is a bound on reporting volume, and volume comes from consumer source. Partitioning
  // before truncating keeps it from doing two things it was never meant to do: discarding Atlas's
  // own errors because enough consumer findings sorted ahead of them, and turning a pile of
  // individually non-blocking findings into one blocking result.
  const preEmit = ts.getPreEmitDiagnostics(program);
  const atlasOwned = preEmit.filter(isAtlasOwned);
  const consumerOwned = preEmit.filter(
    (diagnostic) => !isAtlasOwned(diagnostic),
  );

  diagnostics.push(
    ...atlasOwned.map((diagnostic) =>
      typeScriptDiagnostic(projectRoot, diagnostic, 'error'),
    ),
    ...consumerOwned
      .slice(0, maximum)
      .map((diagnostic) =>
        typeScriptDiagnostic(projectRoot, diagnostic, 'warning'),
      ),
  );

  if (consumerOwned.length > maximum) {
    diagnostics.push(
      atlasDiagnostic(
        'ATL1401',
        `TypeScript analysis reported the first ${maximum} of ${consumerOwned.length} findings in consumer source.`,
        // A truncation notice inherits the severity of what it truncated. These are the consumer's
        // own findings, which do not block, so neither does the notice that there were more of
        // them. Reporting it as an error is what made a large refactor unable to generate.
        { severity: 'warning' },
      ),
    );
  }

  const checker = program.getTypeChecker();
  const knownIdentities = new Set(request.knownMessageIdentities ?? []);
  const usages: AtlasMessageUsage[] = [];
  const recoveryMessageIdentities = new Set<string>();
  let selectsApplicationRuntime = false;
  let declaredRouteIndexing: AtlasRouteIndexingPolicy | undefined;
  let declaredRouteSitemap: AtlasRouteSitemapPolicy | undefined;
  let declaredRoutePolicy: AtlasRoutePolicyDeclaration | undefined;
  const routes: AtlasRouteDraft[] = [];
  const lazyEntryFiles = new Set<ts.SourceFile>();
  const childRouteFiles = new Set<string>();
  const components: AtlasComponentTemplateAnalysis[] = [];
  const localeMentions: AtlasTemplateLocaleMention[] = [];
  const templateAddresses: AtlasTemplateAddress[] = [];
  const seenUsage = new Set<string>();
  const addUsage = (
    identity: string,
    sourcePath: string,
    start: number,
    end: number,
    surface: AtlasMessageUsage['surface'],
  ): void => {
    const key = `${surface}\u0000${sourcePath}\u0000${start}\u0000${identity}`;
    if (seenUsage.has(key)) return;
    seenUsage.add(key);
    if (knownIdentities.size > 0 && !knownIdentities.has(identity)) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1403',
          `Static analysis resolved unknown generated message identity ${JSON.stringify(identity)}.`,
          { path: ['message', identity] },
        ),
      );
      return;
    }
    usages.push(Object.freeze({ identity, sourcePath, start, end, surface }));
  };

  for (const sourceFile of program.getSourceFiles()) {
    const normalized = normalizePath(sourceFile.fileName);
    if (
      sourceFile.isDeclarationFile ||
      normalized.startsWith(`${normalizePath(virtualRoot)}/`)
    ) {
      continue;
    }
    const portableSourcePath = portablePath(projectRoot, sourceFile.fileName);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        propertyStringLiteral(
          checker,
          checker.getTypeAtLocation(node),
          'ɵkind',
          node,
        ) === 'recovery-message'
      ) {
        const argument = node.arguments[0];
        // Both, because both are compiled into the payload and a retry label the analysis missed
        // would leave the control unnamed in every locale but the source one.
        for (const property of ['message', 'retryLabel']) {
          const identity =
            argument === undefined
              ? undefined
              : propertyMessageIdentity(checker, argument, property);
          if (identity !== undefined) recoveryMessageIdentities.add(identity);
        }
      }
      if (ts.isCallExpression(node)) {
        if (
          atlasProvideLocalization(checker, node, normalizePath(virtualRoot))
        ) {
          selectsApplicationRuntime = true;
        }
        const policy = routePolicyDeclaration(
          projectRoot,
          checker,
          sourceFile,
          node,
        );
        if (policy !== undefined) {
          if (declaredRoutePolicy === undefined) {
            declaredRoutePolicy = policy;
          } else {
            // Two policies in one owner is not automatically wrong, a test fixture builds extra
            // ones, but only one can be the application's, and Atlas cannot tell which. Reported
            // rather than guessed at, and the first is the one carried forward, matching what the
            // indexing field above does when it meets the same situation.
            diagnostics.push(
              atlasDiagnostic(
                'ATL1408',
                `This owner builds more than one locale URL policy, so Atlas cannot tell which one states the application's locales. The first is the one it checked. Build the application's policy once and pass that object where it is needed.`,
                { path: ['routes', portableSourcePath], severity: 'warning' },
              ),
            );
          }
        }
        const declaredSitemap = routeSitemapPolicy(checker, node);
        if (declaredSitemap !== undefined) {
          for (const refusal of declaredSitemap.refusals) {
            diagnostics.push(
              atlasDiagnostic(
                'ATL1412',
                `This owner's sitemap declaration cannot be used as written: ${refusal}. That class claims nothing until the value is corrected.`,
                { path: ['routes', portableSourcePath], severity: 'warning' },
              ),
            );
          }
          if (declaredRouteSitemap === undefined) {
            declaredRouteSitemap = declaredSitemap.policy;
          } else if (
            declaredRouteSitemap.field !== declaredSitemap.policy.field
          ) {
            diagnostics.push(
              atlasDiagnostic(
                'ATL1412',
                `This owner declares two route sitemap fields, ${JSON.stringify(declaredRouteSitemap.field)} and ${JSON.stringify(declaredSitemap.policy.field)}. One owner classifies its routes one way; the first declaration is the one Atlas used.`,
                { path: ['routes', portableSourcePath], severity: 'warning' },
              ),
            );
          }
        }
        const declared = routeIndexingPolicy(checker, node);
        if (declared !== undefined) {
          if (declaredRouteIndexing === undefined) {
            declaredRouteIndexing = declared;
          } else if (declaredRouteIndexing.field !== declared.field) {
            diagnostics.push(
              atlasDiagnostic(
                'ATL1404',
                `This owner declares two route indexing fields, ${JSON.stringify(declaredRouteIndexing.field)} and ${JSON.stringify(declared.field)}. One owner classifies its routes one way; the first declaration is the one Atlas used.`,
                { path: ['routes', portableSourcePath], severity: 'warning' },
              ),
            );
          }
        }
      }
      if (
        ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) {
        const identity = resolvedMessageIdentity(checker, node);
        const isPropertyName =
          ts.isIdentifier(node) &&
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node;
        const parentContinuesHandlePath =
          (ts.isPropertyAccessExpression(node.parent) &&
            node.parent.expression === node &&
            resolvedMessageIdentity(checker, node.parent) !== undefined) ||
          (ts.isElementAccessExpression(node.parent) &&
            node.parent.expression === node &&
            resolvedMessageIdentity(checker, node.parent) !== undefined);
        // A group counts where it is handed to something, not merely where it is named. Walking
        // through `messages` to reach `messages.appTitle` says nothing about the rest of the
        // scope, and neither does importing it: treating either as a use of everything under it
        // would make the unused-message advisory permanently silent.
        const handedOff =
          (ts.isCallExpression(node.parent) &&
            node.parent.arguments.some((argument) => argument === node)) ||
          (ts.isPropertyAssignment(node.parent) &&
            node.parent.initializer === node) ||
          ts.isShorthandPropertyAssignment(node.parent) ||
          ts.isArrayLiteralExpression(node.parent);
        if (
          identity !== undefined &&
          !isPropertyName &&
          !parentContinuesHandlePath
        ) {
          addUsage(
            identity,
            portableSourcePath,
            node.getStart(sourceFile),
            node.getEnd(),
            'typescript',
          );
        } else if (identity === undefined && !isPropertyName && handedOff) {
          // A group handed to something, rather than walked through on the way to one member.
          // `messages` in `messages.appTitle` is a receiver and means nothing on its own; the same
          // expression passed as an argument means every message under it is in play.
          for (const member of groupMessageIdentities(checker, node)) {
            addUsage(
              member,
              portableSourcePath,
              node.getStart(sourceFile),
              node.getEnd(),
              'typescript',
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    analyzeRoutes(
      projectRoot,
      checker,
      sourceFile,
      routes,
      program,
      lazyEntryFiles,
      diagnostics,
      childRouteFiles,
    );

    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const decorator = componentDecorator(checker, statement);
      const metadataNode = decorator?.arguments[0];
      if (
        metadataNode === undefined ||
        !ts.isObjectLiteralExpression(metadataNode)
      ) {
        continue;
      }
      const inline = metadataString(metadataNode, 'template');
      const templateUrl = metadataString(metadataNode, 'templateUrl');
      if (inline === undefined && templateUrl === undefined) continue;
      const templatePath =
        templateUrl === undefined
          ? portableSourcePath
          : portablePath(
              projectRoot,
              resolve(dirname(sourceFile.fileName), templateUrl.text),
            );
      let templateSource: string;
      if (inline !== undefined) {
        templateSource = inline.text;
      } else {
        const absoluteTemplatePath = resolve(projectRoot, templatePath);
        const supplied = suppliedSources.get(
          normalizePath(absoluteTemplatePath),
        );
        if (supplied !== undefined) {
          templateSource = supplied;
        } else if (!containedPath(absoluteTemplatePath, projectRoot)) {
          // B2. The project host already filtered escaping paths out of suppliedSources by
          // containment, and this fallback then read them from disk anyway, so a templateUrl of
          // '../../secret/leak.html' was opened and parsed. Atlas analyses the selected owner and
          // nothing else; a path outside it is refused rather than read.
          diagnostics.push(
            atlasDiagnostic(
              'ATL1402',
              `Angular component template ${JSON.stringify(templatePath)} resolves outside the selected Atlas owner and was not read.`,
              { path: ['components', portableSourcePath] },
            ),
          );
          continue;
        } else {
          try {
            templateSource = readFileSync(absoluteTemplatePath, 'utf8');
          } catch {
            diagnostics.push(
              atlasDiagnostic(
                'ATL1402',
                `Angular component template ${JSON.stringify(templatePath)} could not be read.`,
                {
                  span: sourceSpan(
                    sourceFile.text,
                    templateUrl?.getStart(sourceFile) ??
                      statement.getStart(sourceFile),
                    templateUrl?.getWidth(sourceFile) ??
                      statement.getWidth(sourceFile),
                    portableSourcePath,
                  ),
                },
              ),
            );
            continue;
          }
        }
      }
      const parsed = parseTemplate(templateSource, templatePath, {
        preserveWhitespaces: false,
      });
      for (const error of parsed.errors ?? []) {
        const start = error.span.start.offset;
        const end = error.span.end.offset;
        diagnostics.push(
          atlasDiagnostic('ATL1402', `Angular template: ${error.msg}`, {
            span: sourceSpan(
              templateSource,
              start,
              Math.max(1, end - start),
              templatePath,
            ),
          }),
        );
      }
      const componentName = statement.name?.text ?? '<anonymous>';
      const noteMention = (
        mention: Omit<
          AtlasTemplateLocaleMention,
          'componentName' | 'sourcePath' | 'templatePath'
        >,
      ): void => {
        if (localeMentions.length >= ATLAS_RESOURCE_LIMITS.diagnostics) return;
        localeMentions.push(
          Object.freeze({
            ...mention,
            componentName,
            sourcePath: portableSourcePath,
            templatePath,
          }),
        );
      };
      const noteAddress = (
        address: Omit<
          AtlasTemplateAddress,
          'componentName' | 'sourcePath' | 'templatePath'
        >,
      ): void => {
        if (templateAddresses.length >= ATLAS_RESOURCE_LIMITS.diagnostics)
          return;
        templateAddresses.push(
          Object.freeze({
            ...address,
            componentName,
            sourcePath: portableSourcePath,
            templatePath,
          }),
        );
      };
      const expressionVisitor = new TemplateExpressionVisitor(
        (property) => {
          const path = templatePropertyPath(property);
          if (path === undefined) return;
          const identity = templateMessageIdentity(checker, statement, path);
          if (identity === undefined) return;
          addUsage(
            identity,
            templatePath,
            property.sourceSpan.start,
            property.sourceSpan.end,
            'template',
          );
        },
        (literal) => {
          const text = String(literal.value);
          if (!LANGUAGE_TAG_SHAPE.test(text)) return;
          noteMention({
            kind: 'literal',
            text,
            start: literal.sourceSpan.start,
            end: literal.sourceSpan.end,
          });
        },
      );
      tmplAstVisitAll(
        new TemplateNodeVisitor(expressionVisitor, (element) => {
          // Both spellings, from the one place that sees both. A static `routerLink` is a text
          // attribute the expression visitor never receives, and a bound one is an expression whose
          // literals it receives with nothing saying which attribute they came from.
          const written = element.attributes.find(
            (attribute) => attribute.name === ROUTER_LINK,
          );
          const address =
            written === undefined ? undefined : absoluteAddress(written.value);
          if (written !== undefined && address !== undefined) {
            noteAddress({
              attribute: ROUTER_LINK,
              form: 'static',
              address,
              start: written.sourceSpan.start.offset,
              end: written.sourceSpan.end.offset,
            });
          }
          for (const input of element.inputs) {
            if (input.name !== ROUTER_LINK) continue;
            const bound = routerLinkAddress(input.value);
            if (bound === undefined) continue;
            noteAddress({
              attribute: ROUTER_LINK,
              ...bound,
              start: input.sourceSpan.start.offset,
              end: input.sourceSpan.end.offset,
            });
          }
          // Keyed on the static `lang`, with the static `dir` reported beside it. A lone `dir` is
          // not a claim about a locale, a page laid out right-to-left says so on its root and
          // means it, and reporting the pair as one mention is what lets the judging layer decide
          // without inferring which attribute belonged to which element.
          const language = element.attributes.find(
            (attribute) => attribute.name === 'lang',
          );
          if (language === undefined) return;
          const direction = element.attributes.find(
            (attribute) => attribute.name === 'dir',
          );
          noteMention({
            kind: 'attribute',
            attribute: 'lang',
            text: language.value,
            ...(direction === undefined
              ? {}
              : { siblingDirection: direction.value }),
            start: language.sourceSpan.start.offset,
            end: language.sourceSpan.end.offset,
          });
        }),
        parsed.nodes,
      );
      components.push(
        Object.freeze({
          componentName,
          sourcePath: portableSourcePath,
          templatePath,
        }),
      );
    }
  }

  if (diagnostics.some(({ severity }) => severity === 'error')) {
    return atlasFailure(diagnostics);
  }
  usages.sort((left, right) =>
    compareCodePoint(
      `${left.sourcePath}\u0000${left.start.toString().padStart(12, '0')}\u0000${left.identity}`,
      `${right.sourcePath}\u0000${right.start.toString().padStart(12, '0')}\u0000${right.identity}`,
    ),
  );
  // Drop what a `loadChildren` target contributed at the root.
  //
  // The pass above visits every file declaring a `Routes` constant, and a child route table is one
  // of those files. Visited on its own it has no parent, so `detail` enters the projection at
  // `detail` while the application serves it at `section/detail`. That is not a route Atlas failed
  // to cover; it is a route Atlas invented, and a localized branch built from it addresses nothing.
  // The diagnostic above has already said the subtree is uncovered: this stops the projection
  // from simultaneously claiming otherwise.
  if (childRouteFiles.size > 0) {
    routes.splice(
      0,
      routes.length,
      ...routes.filter((draft) => !childRouteFiles.has(draft.sourcePath)),
    );
  }

  routes.sort((left, right) =>
    compareCodePoint(
      `${left.sourcePath}\u0000${left.start.toString().padStart(12, '0')}`,
      `${right.sourcePath}\u0000${right.start.toString().padStart(12, '0')}`,
    ),
  );
  components.sort((left, right) =>
    compareCodePoint(left.sourcePath, right.sourcePath),
  );

  // What only a lazy route reaches. A file behind a boundary that something eager also imports is
  // eager: the first render already pays for it, so deferring its messages would defer nothing and
  // risk rendering a component whose text has not arrived.
  const lazyClosure = staticImportClosure(program, [...lazyEntryFiles]);
  const eagerEntries = program
    .getSourceFiles()
    .filter(
      (file) =>
        !file.isDeclarationFile &&
        !lazyClosure.has(normalizePath(file.fileName)) &&
        containedPath(normalizePath(file.fileName), normalizePath(projectRoot)),
    );
  const eagerClosure = staticImportClosure(program, eagerEntries);

  // A loader that defers nothing.
  //
  // Writing `loadComponent: () => import('./page')` while anything in the initial bundle also
  // imports `./page` puts the component in that bundle and leaves every other signal intact: chunk
  // names, prerendered output and the route table all read exactly as they do when the split works.
  // Atlas notices because it has to, it decides which messages ship with the first render out of
  // this same closure, so the route's messages are correctly marked eager while whoever wrote the
  // loader believes they are deferred.
  //
  // Keyed on the loader's *target file* sitting in the eager closure, never on the route table
  // mentioning it. `staticImportClosure` follows `import` and `export` declarations only, so the
  // dynamic import inside the loader never puts its own target in the eager set; a check keyed on
  // mentions reports every lazy route in the application, because a route table always names its
  // own loaders.
  //
  // A warning rather than an error. A component can legitimately be both routed lazily and
  // rendered by an eager shell, and the application is correct either way. What is wrong is the
  // belief that the boundary is doing something.
  const reportedEagerEntries = new Set<string>();
  for (const draft of routes) {
    for (const entry of draft.lazyEntries) {
      if (!eagerClosure.has(entry) || reportedEagerEntries.has(entry)) continue;
      reportedEagerEntries.add(entry);
      diagnostics.push(
        atlasDiagnostic(
          'ATL1407',
          `Route ${JSON.stringify(`/${draft.path}`)} loads ${JSON.stringify(portablePath(projectRoot, entry))} through a lazy boundary, but something in the initial bundle imports it statically, so it ships with the first render and the boundary defers nothing.`,
          { path: ['routes', draft.sourcePath], severity: 'warning' },
        ),
      );
    }
  }
  // Which route is responsible for which of those files. A file is attributed to a route when
  // that route's own boundary reaches it, so the route that downloads the code is the route that
  // has to bring its messages with it.
  const deferredFor = (draft: AtlasRouteDraft): readonly string[] => {
    if (draft.lazyEntries.length === 0) return Object.freeze([]);
    const entries = draft.lazyEntries
      .map((path) => program.getSourceFile(path))
      .filter((file): file is ts.SourceFile => file !== undefined);
    return Object.freeze(
      [...staticImportClosure(program, entries)]
        .filter((path) => !eagerClosure.has(path))
        .map((path) => portablePath(projectRoot, path))
        .sort(compareCodePoint),
    );
  };

  const deferredSourcePaths = [...lazyClosure]
    .filter((path) => !eagerClosure.has(path))
    .map((path) => portablePath(projectRoot, path))
    .sort(compareCodePoint);
  // Non-blocking findings must still reach the caller; a successful analysis
  // that silently drops its advisories hides consumer-source problems.
  return atlasSuccess(
    Object.freeze({
      messageUsages: Object.freeze(usages),
      deferredSourcePaths: Object.freeze(deferredSourcePaths),
      selectsApplicationRuntime,
      recoveryMessageIdentities: Object.freeze(
        [...recoveryMessageIdentities].sort(compareCodePoint),
      ),
      ...(declaredRoutePolicy === undefined
        ? {}
        : { routePolicy: declaredRoutePolicy }),
      routes: Object.freeze(
        resolveRouteIdentities(
          routes,
          declaredRouteIndexing,
          declaredRouteSitemap,
          deferredFor,
          diagnostics,
        ),
      ),
      components: Object.freeze(components),
      localeMentions: Object.freeze(localeMentions),
      templateAddresses: Object.freeze(templateAddresses),
    }),
    diagnostics,
  );
}

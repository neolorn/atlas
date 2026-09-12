/**
 * One request in, one complete answer out, with nothing of the machine in between.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 2 keeps this core deterministic and
 * framework-neutral: it takes the configuration, the catalogs, the owner and whatever is
 * optional beside them, and returns diagnostics, the semantic graph, an invalidation decision
 * and the artifacts. Process state, networking, filesystem mutation, scheduling and the watch
 * lifecycle are the host's, so the same inputs answer the same way whichever surface asked.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import {
  digestAtlasCanonicalJson,
  type AtlasCanonicalJsonObject,
  type AtlasCanonicalJsonValue,
} from './canonical-json.js';
import type { AtlasCatalog, AtlasCatalogMessage } from './catalog.js';
import type { AtlasProjectConfiguration } from './configuration.js';
import { canonicalizeAtlasLocale } from './locales.js';
import {
  atlasDiagnostic,
  atlasSuccess,
  type AtlasDiagnostic,
  type AtlasResult,
} from './diagnostics.js';
import {
  compileAtlasLocalArtifacts,
  type AtlasOwnerIdentity,
  type AtlasCompiledLocalArtifacts,
} from './compiled-artifacts.js';
import { generateAtlasContracts } from './generated-contracts.js';
import {
  analyzeAtlasApplication,
  type AtlasAnalysisSource,
  type AtlasApplicationAnalysis,
} from './static-analysis.js';
import {
  analyzeAtlasCatalogSet,
  type AtlasSemanticGraph,
  type AtlasSemanticScope,
} from './semantic-model.js';
import type { AtlasExtensionRegistry } from './extensions.js';
import {
  ATLAS_TOOLKIT_EVENT_CODES,
  emitAtlasToolkitEvent,
  type AtlasToolkitObservabilityOptions,
} from './observability.js';
import { compareCodePoint } from './sorted-records.js';

/** The version stamp on the state a compilation carries forward, checked before one is reused. */
export const ATLAS_COMPILER_STATE_PROFILE = 'atlas-compiler-state/1' as const;

/**
 * What the static analysis needs to read an application's own source and see which messages it
 * uses.
 *
 * Optional on a compilation. Without it the messages still compile; what is lost is everything
 * that depends on knowing the application: which messages nothing reaches, which routes are
 * localized, and where a message is used.
 */
export interface AtlasCompilerAnalysisInput {
  /** The directory paths are resolved against. */
  readonly projectRoot: string;
  /** The entry files to analyse from, which is usually what the application's own build compiles. */
  readonly rootNames: readonly string[];
  /** Source text supplied directly, for analysing something that is not on disk. */
  readonly sources?: readonly AtlasAnalysisSource[];
  /** The type names to look for, when the application names its handles something of its own. */
  readonly typeNames?: readonly string[];
  /** The most diagnostics to collect before stopping, so one broken file cannot fill a log. */
  readonly maxDiagnostics?: number;
  /** The options to compile the application's source under. */
  readonly compilerOptions?: ts.CompilerOptions;
  /**
   * Portable, machine-independent projection of `compilerOptions` used for
   * cache identity. Absolute paths never enter the digest.
   */
  readonly compilerOptionsDigestInput?: AtlasCanonicalJsonObject;
}

/** One input to a compilation, and a digest of what it held, for deciding what changed. */
export interface AtlasCompilerInputDigest {
  /** What the input is, as a stable name rather than an absolute path. */
  readonly identity: string;
  /** A digest of its content. */
  readonly digest: string;
}

/**
 * What one compilation remembers so the next can tell whether anything moved.
 *
 * Hand it back as `previousState` on the next run. Everything in it is machine-independent, so a
 * state written on one machine is usable on another and a cache survives a checkout somewhere else.
 */
export interface AtlasCompilerState {
  /** The state-shape version stamp. A state from another version is ignored rather than misread. */
  readonly profile: typeof ATLAS_COMPILER_STATE_PROFILE;
  /** A digest of every input together, which is the quick answer to whether anything changed. */
  readonly inputFingerprint: string;
  /** The inputs one by one, which is what says which of them changed. */
  readonly inputs: readonly AtlasCompilerInputDigest[];
  /** A digest of the files the compilation planned to write. */
  readonly outputPlanDigest: string;
}

export interface AtlasCompilerInputFingerprint {
  readonly inputFingerprint: string;
  readonly inputs: readonly AtlasCompilerInputDigest[];
}

/** What a compilation concluded about what had changed since the state it was given. */
export interface AtlasInvalidationDecision {
  /**
   * Whether there was a previous state at all, nothing changed, or something did.
   *
   * `initial` means the first run, or a state that could not be used.
   */
  readonly kind: 'initial' | 'none' | 'inputs-changed';
  /** Which inputs differ from the previous state. Empty when nothing did. */
  readonly changedInputs: readonly string[];
  /** Which generated files those inputs reach, which is what a watch reports as rebuilt. */
  readonly affectedOutputs: readonly string[];
}

/**
 * Everything one compilation needs, with nothing read from disk.
 *
 * What `compileAtlasProject` takes. The file reading is `compileAtlasProjectFromDisk`'s job, so a
 * caller that already has its catalogs in memory, a test or an editor integration, compiles without
 * writing them out first.
 */
export interface AtlasCompileProjectRequest extends AtlasToolkitObservabilityOptions {
  /** The project's locales, scopes and options, parsed. */
  readonly configuration: AtlasProjectConfiguration;
  /** The catalogs to compile, source and target alike. */
  readonly catalogs: readonly AtlasCatalog[];
  /** Who this output belongs to; see {@link AtlasOwnerIdentity}. */
  readonly owner: AtlasOwnerIdentity;
  /** The extensions the messages may call. Leaving it out refuses a message that calls one. */
  readonly extensions?: AtlasExtensionRegistry;
  /** What to analyse the application's own source with. Without it, usage is not measured. */
  readonly analysis?: AtlasCompilerAnalysisInput;
  /**
   * The messages to compile separately, for the failure path.
   *
   * These are readable when no catalog could be loaded, which is what the recovery region shows.
   * Detected from the application's source when the analysis runs, and passed here otherwise.
   */
  readonly recoveryMessageIdentities?: readonly string[];
  /** What the previous compilation remembered, which is what makes this one incremental. */
  readonly previousState?: AtlasCompilerState;
  /** Release-gate completeness: see AtlasCatalogSetAnalysisRequest.requireCompleteTargets. */
  readonly requireCompleteTargets?: boolean;
}

/** Everything a compilation produced, in memory. Nothing here has been written. */
export interface AtlasCompileProjectResult {
  /** The whole project analysed: every locale, scope and message, with their contracts. */
  readonly graph: AtlasSemanticGraph;
  /** What reading the application's own source found. Absent when no analysis was asked for. */
  readonly analysis?: AtlasApplicationAnalysis;
  /** The compiled catalogs, the descriptor, the recovery messages, and what writes them. */
  readonly artifacts: AtlasCompiledLocalArtifacts;
  /** What to hand back as `previousState` next time. */
  readonly state: AtlasCompilerState;
  /** What changed since the state this run was given. */
  readonly invalidation: AtlasInvalidationDecision;
}

/**
 * Source messages nothing reaches.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 6 makes this a grouped source-located
 * advisory with an optional safe cleanup preview, and keeps friendly mode from deleting the
 * message, failing the compilation, writing a tombstone, or requiring a waiver or a
 * suppression ledger. Reachability was already collected and already
 * load-bearing (it drives message usages, recovery-root detection and route extraction) so the
 * advisory was the one part missing, and an owner had no way to see what its catalogs were still
 * carrying.
 *
 * Grouped into one diagnostic per scope rather than one per message: a catalog that has drifted
 * has drifted by dozens, and dozens of separate advisories would bury the errors underneath them.
 * Reported only when the analysis ran, because without a TypeScript graph every message is
 * unreachable and the advisory would be noise rather than information.
 */
/**
 * Scopes the first render does not use.
 *
 * A scope is deferred when it is used and every use sits behind a lazy route boundary. Used
 * nowhere Atlas can see is not the same thing: that scope stays a startup scope, because absence
 * of evidence is not evidence that a route will not reach it, and being wrong in that direction
 * renders a component whose text never arrives.
 */
function deferredScopeIds(
  graph: AtlasSemanticGraph,
  analysis: AtlasApplicationAnalysis,
): readonly string[] {
  // Absent means nothing is known to be deferred, so everything is a startup scope. Both of this
  // type's derived fields default in the conservative direction, because a caller that constructs
  // an analysis by hand, the refactoring API takes one, must not have a behaviour invented for
  // it, and being wrong the other way renders a component whose text never arrives.
  const deferredPaths = new Set(analysis.deferredSourcePaths ?? []);
  // A message used in a component's template is reported against the template, which is the file
  // a developer opens to change it. The module graph has never heard of that file: a `.html` is
  // not imported by anything, so read literally every template usage sits outside every lazy
  // boundary and no scope a template uses could ever be deferred. Reachability is a question
  // about modules, so it is asked about the component that owns the template.
  const owningSource = new Map<string, string>();
  for (const component of analysis.components) {
    owningSource.set(component.templatePath, component.sourcePath);
  }
  const scopeOf = new Map<string, string>();
  for (const scope of graph.scopes) {
    for (const message of scope.messages)
      scopeOf.set(message.identity, scope.scopeId);
  }
  const seen = new Set<string>();
  const eager = new Set<string>();
  for (const usage of analysis.messageUsages) {
    const scopeId = scopeOf.get(usage.identity);
    if (scopeId === undefined) continue;
    seen.add(scopeId);
    const path = owningSource.get(usage.sourcePath) ?? usage.sourcePath;
    if (!deferredPaths.has(path)) eager.add(scopeId);
  }
  return Object.freeze(
    [...seen].filter((scopeId) => !eager.has(scopeId)).sort(compareCodePoint),
  );
}

/**
 * The scopes a route has to have ready before it renders.
 *
 * Every startup scope, plus the scopes used by the files this route brings in behind its own lazy
 * boundary. The startup ones are in the list even though bootstrap already loaded them, because
 * "startup" means loaded for the locale the page started in, and a locale transition has to have
 * every scope the page renders ready in the *new* locale before it commits. Leaving them out
 * committed a locale whose shell catalog had not arrived, and the shell then failed to evaluate.
 */
function routeScopes(
  graph: AtlasSemanticGraph,
  analysis: AtlasApplicationAnalysis,
  deferredSourcePaths: readonly string[],
): readonly { readonly providerId: string; readonly scopeId: string }[] {
  const deferred = new Set(deferredSourcePaths);
  const owningSource = new Map<string, string>();
  for (const component of analysis.components) {
    owningSource.set(component.templatePath, component.sourcePath);
  }
  const scopeOf = new Map<string, AtlasSemanticScope>();
  for (const scope of graph.scopes) {
    for (const message of scope.messages) scopeOf.set(message.identity, scope);
  }
  const needed = new Map<string, { providerId: string; scopeId: string }>();
  for (const usage of analysis.messageUsages) {
    const path = owningSource.get(usage.sourcePath) ?? usage.sourcePath;
    if (!deferred.has(path)) continue;
    const scope = scopeOf.get(usage.identity);
    if (scope === undefined) continue;
    const key = `${scope.providerId}\u0000${scope.scopeId}`;
    if (!needed.has(key)) {
      needed.set(key, {
        providerId: scope.providerId,
        scopeId: scope.scopeId,
      });
    }
  }
  const deferredScopes = new Set(deferredScopeIds(graph, analysis));
  for (const scope of graph.scopes) {
    if (deferredScopes.has(scope.scopeId)) continue;
    const key = `${scope.providerId}\u0000${scope.scopeId}`;
    if (!needed.has(key)) {
      needed.set(key, {
        providerId: scope.providerId,
        scopeId: scope.scopeId,
      });
    }
  }
  return Object.freeze(
    [...needed.values()]
      .sort((left, right) => compareCodePoint(left.scopeId, right.scopeId))
      .map((scope) => Object.freeze(scope)),
  );
}

function unusedSourceMessages(
  graph: AtlasSemanticGraph,
  analysis: AtlasApplicationAnalysis,
): readonly AtlasDiagnostic[] {
  const reached = new Set([
    ...analysis.messageUsages.map(({ identity }) => identity),
    ...analysis.recoveryMessageIdentities,
  ]);
  const diagnostics: AtlasDiagnostic[] = [];
  for (const scope of graph.scopes) {
    const unused = scope.messages
      .filter(({ identity }) => !reached.has(identity))
      .map(({ messageId }) => messageId)
      .sort(compareCodePoint);
    if (unused.length === 0) continue;
    const listed = unused.slice(0, 20);
    diagnostics.push(
      atlasDiagnostic(
        'ATL1311',
        `Scope ${scope.scopeId} defines ${unused.length} source ${
          unused.length === 1 ? 'message' : 'messages'
        } nothing reaches: ${listed.map((id) => JSON.stringify(id)).join(', ')}${
          unused.length > listed.length
            ? `, and ${unused.length - listed.length} more`
            : ''
        }. Removing them changes no rendered output. Reachability is the program the consumer builds, so a message used only from a file outside it, a test for instance, reads as unreached here.`,
        { severity: 'info' },
      ),
    );
  }
  return Object.freeze(diagnostics);
}

/**
 * `JSON.stringify` as it behaves rather than as it is declared.
 *
 * The declaration promises a string back. Nothing comes back for `undefined`, for a function or
 * for a symbol, and the values reaching here are a project's rather than this code's own.
 */
function serializeJson(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function canonicalValue(value: unknown): AtlasCanonicalJsonValue {
  const serialized = serializeJson(value);
  if (serialized === undefined) {
    throw new TypeError('Atlas compiler input is not JSON serializable.');
  }
  return JSON.parse(serialized) as AtlasCanonicalJsonValue;
}

function catalogMessageInput(message: AtlasCatalogMessage): unknown {
  return {
    kind: message.kind,
    ...(message.kind === 'message'
      ? { canonicalSource: message.semantics.canonicalSource }
      : {}),
    ...(message.description === undefined
      ? {}
      : { description: message.description }),
    ...(message.context === undefined ? {} : { context: message.context }),
    inputs: message.inputs,
    slots: message.slots,
  };
}

function portableAnalysisPath(projectRoot: string, path: string): string {
  const absolute = isAbsolute(path)
    ? resolve(path)
    : resolve(projectRoot, path);
  const portable = relative(projectRoot, absolute);
  if (
    portable === '..' ||
    portable.startsWith(`..${sep}`) ||
    isAbsolute(portable)
  ) {
    throw new TypeError(
      `Atlas analysis input is outside the selected project: ${path}`,
    );
  }
  const normalized = portable.replaceAll('\\', '/');
  if (
    normalized.length === 0 ||
    normalized.normalize('NFC') !== normalized ||
    normalized
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`Atlas analysis input path is not portable: ${path}`);
  }
  return normalized;
}

function compilerInputDigests(
  request: AtlasCompileProjectRequest,
): readonly AtlasCompilerInputDigest[] {
  const inputs: AtlasCompilerInputDigest[] = [
    Object.freeze({
      identity: 'configuration',
      digest: digestAtlasCanonicalJson(
        'atlas-compiler-configuration-input/1',
        canonicalValue(request.configuration),
      ),
    }),
  ];
  if (request.extensions !== undefined) {
    inputs.push(
      Object.freeze({
        identity: 'extension-registry',
        digest: request.extensions.fingerprint,
      }),
    );
  }
  if (request.analysis !== undefined) {
    const projectRoot = resolve(request.analysis.projectRoot);
    inputs.push(
      Object.freeze({
        identity: 'analysis-graph',
        digest: digestAtlasCanonicalJson('atlas-compiler-analysis-graph/1', {
          rootNames: [...request.analysis.rootNames]
            .map((path) => portableAnalysisPath(projectRoot, path))
            .sort(compareCodePoint),
          ...(request.analysis.typeNames === undefined
            ? {}
            : {
                typeNames: [...request.analysis.typeNames].sort(
                  compareCodePoint,
                ),
              }),
          ...(request.analysis.compilerOptionsDigestInput === undefined
            ? {}
            : { compilerOptions: request.analysis.compilerOptionsDigestInput }),
        }),
      }),
    );
  }
  if ((request.recoveryMessageIdentities?.length ?? 0) > 0) {
    inputs.push(
      Object.freeze({
        identity: 'recovery-message-identities',
        digest: digestAtlasCanonicalJson(
          'atlas-compiler-recovery-input/1',
          [...(request.recoveryMessageIdentities ?? [])].sort(compareCodePoint),
        ),
      }),
    );
  }
  for (const catalog of request.catalogs) {
    inputs.push(
      Object.freeze({
        identity: `catalog:${catalog.providerId}:${catalog.scopeId}:${catalog.locale}:${catalog.role}`,
        digest: digestAtlasCanonicalJson(
          'atlas-compiler-catalog-input/1',
          canonicalValue({
            role: catalog.role,
            providerId: catalog.providerId,
            scopeId: catalog.scopeId,
            locale: catalog.locale,
            messages: Object.fromEntries(
              Object.entries(catalog.messages).map(([id, message]) => [
                id,
                catalogMessageInput(message),
              ]),
            ),
            families: catalog.families,
          }),
        ),
      }),
    );
  }
  for (const source of request.analysis?.sources ?? []) {
    const projectRoot = resolve(request.analysis?.projectRoot ?? '.');
    const sourcePath = portableAnalysisPath(projectRoot, source.path);
    inputs.push(
      Object.freeze({
        identity: `source:${sourcePath}`,
        digest: digestAtlasCanonicalJson(
          'atlas-compiler-static-source-input/1',
          source.contents,
        ),
      }),
    );
  }
  inputs.sort((left, right) => compareCodePoint(left.identity, right.identity));
  return Object.freeze(inputs);
}

export function fingerprintAtlasCompilerInputs(
  request: AtlasCompileProjectRequest,
): AtlasCompilerInputFingerprint {
  const inputs = compilerInputDigests(request);
  return Object.freeze({
    inputs,
    inputFingerprint: digestAtlasCanonicalJson(
      'atlas-compiler-input-set/1',
      inputs.map(({ identity, digest }) => ({ identity, digest })),
    ),
  });
}

/**
 * A compiler state as it came back, with the stamp saying which compiler wrote it still unread.
 *
 * The state is carried across runs, which means it is read from wherever the caller kept it. A
 * state written by another version of the compiler is the case the profile exists to catch.
 */
type ReceivedCompilerState = Omit<AtlasCompilerState, 'profile'> & {
  readonly profile: unknown;
};

function invalidationDecision(
  previous: ReceivedCompilerState | undefined,
  inputs: readonly AtlasCompilerInputDigest[],
  affectedOutputs: readonly string[],
): AtlasInvalidationDecision {
  if (
    previous === undefined ||
    previous.profile !== ATLAS_COMPILER_STATE_PROFILE
  ) {
    return Object.freeze({
      kind: 'initial',
      changedInputs: Object.freeze(inputs.map(({ identity }) => identity)),
      affectedOutputs: Object.freeze([...affectedOutputs]),
    });
  }
  const prior = new Map(
    previous.inputs.map((input) => [input.identity, input.digest]),
  );
  const current = new Map(
    inputs.map((input) => [input.identity, input.digest]),
  );
  const changedInputs = [...new Set([...prior.keys(), ...current.keys()])]
    .filter((identity) => prior.get(identity) !== current.get(identity))
    .sort(compareCodePoint);
  return Object.freeze({
    kind: changedInputs.length === 0 ? 'none' : 'inputs-changed',
    changedInputs: Object.freeze(changedInputs),
    affectedOutputs: Object.freeze(
      changedInputs.length === 0 ? [] : [...affectedOutputs],
    ),
  });
}

function virtualModules(
  files: readonly { readonly path: string; readonly contents: string }[],
) {
  return [
    ...files
      .filter(({ path }) => path.endsWith('.ts'))
      .map(({ path, contents }) => ({
        specifier:
          path === 'index.ts' ? '#i18n' : `#i18n/${path.replace(/\.ts$/u, '')}`,
        contents,
      })),
    {
      specifier: '#i18n/catalog-set',
      contents:
        "import type { CatalogSetDescriptor } from '@neolorn/atlas';\nexport declare const catalogSet: CatalogSetDescriptor;\n",
    },
    {
      specifier: '#i18n/catalog-loaders',
      contents:
        "import type { CatalogLoaders } from '@neolorn/atlas';\nexport declare const catalogLoaders: CatalogLoaders;\n",
    },
    {
      specifier: '#i18n/recovery-payload',
      contents:
        "import type { RecoveryRepresentation } from '@neolorn/atlas';\nexport declare const recoveryPayload: readonly RecoveryRepresentation[];\n",
    },
  ];
}

/**
 * The whole compilation, in the order `specs/05-compiled-artifacts-and-trust.spec.md` section 4
 * states it, returning a failure rather than a partial result at every step.
 *
 * Nothing is written from here. The result carries one output plan and publication is a separate
 * call, so a compilation that stops halfway leaves no half-written generated root behind it.
 */
function compileAtlasProjectCore(
  request: AtlasCompileProjectRequest,
): AtlasResult<AtlasCompileProjectResult> {
  const diagnostics: AtlasDiagnostic[] = [];
  const graph = analyzeAtlasCatalogSet({
    configuration: request.configuration,
    catalogs: request.catalogs,
    ...(request.extensions === undefined
      ? {}
      : { extensions: request.extensions }),
    ...(request.requireCompleteTargets === undefined
      ? {}
      : { requireCompleteTargets: request.requireCompleteTargets }),
  });
  if (!graph.ok) return graph;
  diagnostics.push(...graph.diagnostics);

  // The provider is in the provisional overlay too, as a declaration. It is the only thing an
  // application imports from `#i18n` to compose the runtime, so an overlay without it makes every
  // real consumer look like one that composes nothing, and reports the import it does have as
  // unresolved.
  //
  // `specs/10-compiler-and-tooling.spec.md` section 3 is the run this belongs to: the overlay
  // serves the analysis pass and is never written, imported at run time, or cached as an
  // authority for what a clean generation produces.
  const provisionalContracts = generateAtlasContracts(graph.value, {
    provider: 'declaration',
    ...(request.recoveryMessageIdentities === undefined
      ? {}
      : { recoveryMessageIdentities: request.recoveryMessageIdentities }),
  });
  if (!provisionalContracts.ok) return provisionalContracts;
  diagnostics.push(...provisionalContracts.diagnostics);

  let analysis: AtlasApplicationAnalysis | undefined;
  if (request.analysis !== undefined) {
    const analyzed = analyzeAtlasApplication({
      projectRoot: request.analysis.projectRoot,
      rootNames: request.analysis.rootNames,
      ...(request.analysis.sources === undefined
        ? {}
        : { sources: request.analysis.sources }),
      ...(request.analysis.maxDiagnostics === undefined
        ? {}
        : { maxDiagnostics: request.analysis.maxDiagnostics }),
      ...(request.analysis.typeNames === undefined
        ? {}
        : { typeNames: request.analysis.typeNames }),
      ...(request.analysis.compilerOptions === undefined
        ? {}
        : { compilerOptions: request.analysis.compilerOptions }),
      virtualModules: virtualModules(provisionalContracts.value),
      knownMessageIdentities: graph.value.scopes.flatMap((scope) =>
        scope.messages.map(({ identity }) => identity),
      ),
    });
    if (!analyzed.ok) return analyzed;
    diagnostics.push(...analyzed.diagnostics);
    analysis = analyzed.value;
  }

  const recoveryMessageIdentities = Object.freeze(
    [
      ...(request.recoveryMessageIdentities ?? []),
      ...(analysis?.recoveryMessageIdentities ?? []),
    ]
      .filter((identity, index, values) => values.indexOf(identity) === index)
      .sort(compareCodePoint),
  );

  if (
    analysis?.selectsApplicationRuntime === true &&
    recoveryMessageIdentities.length === 0
  ) {
    // `specs/10-compiler-and-tooling.spec.md` section 10: for an owner that selects an
    // application runtime, a missing recovery root is a protected correctness error in both
    // generate and bare check. The rule existed and
    // could never fire, because nothing could tell that an owner had selected one, so an owner
    // that authored recovery copy and never selected it passed both commands silently, and the
    // first anyone learned of it was a blank page.
    diagnostics.push(
      atlasDiagnostic(
        'ATL1310',
        'This owner composes the Atlas application runtime but selects no recovery message. Pass one to provideLocalization through withRecoveryMessage so a failed bootstrap can still say something.',
      ),
    );
  }

  // The locale set, stated twice, compared once.
  //
  // `atlas.config.json` says which locales this owner has catalogs for. The route policy says which
  // locales have addresses. They are separate statements in separate files and they have to agree,
  // and until now nothing compared them: the toolkit had no knowledge of the policy, so none of
  // its diagnostics could have covered this.
  //
  // Both directions are wrong and they fail differently, which is why both are reported rather than
  // one being treated as the source of truth. A locale with catalogs and no address cannot be
  // reached: the translations exist and nothing can navigate to them. A locale with an address and
  // no catalogs is worse, because it resolves: the address works and every message on the page
  // falls back to the default language, which looks like a translation gap rather than a
  // configuration mistake.
  //
  // An error rather than a warning. Unlike the route-coverage warnings, neither direction here has a
  // legitimate form: there is no application that means to have a locale in one list and not the
  // other, and both symptoms are silent at runtime.
  const policyLocales = analysis?.routePolicy;
  if (policyLocales !== undefined && policyLocales.locales.length > 0) {
    const canonical = (value: string): string => {
      const result = canonicalizeAtlasLocale(value);
      return result.ok ? result.value : value;
    };
    const declared = new Set(policyLocales.locales.map(canonical));
    const configured = new Set(graph.value.locales.map(canonical));
    // A declared pseudo-locale is exempt from both directions, and the reason is the same one:
    // whether it exists in a given build is decided by the build, while the locale URL policy is a
    // source file that cannot vary per build. Binding the two would make one of them wrong in every
    // build of the other kind.
    //
    // Forward, configured but unaddressable, is a pseudo-locale's ordinary state. It is a
    // development view of the product, not a locale the product serves, and requiring an address
    // would put a fabricated locale into what the application advertises: its alternate-language
    // links and its sitemap. It would also mean enabling a pseudo-locale required a source edit,
    // which is the one thing this feature must not need.
    //
    // Reverse, addressed but not configured, is what a consumer gets the moment they do give
    // one an address, which they must to server-render or prerender it. That address is written
    // once, in source; the catalog behind it exists only in a build that asked for it. Without this
    // exemption, adding the address would fail every production build.
    //
    // Neither exemption weakens the check for anything else: an ordinary locale missing from either
    // list is still an error, and a locale in the policy that is neither configured nor declared as
    // a pseudo-locale is still an error.
    const pseudoLocales = new Set(
      Object.keys(request.configuration.pseudoLocales).map(canonical),
    );
    const missingFromPolicy = [...configured]
      .filter((locale) => !declared.has(locale) && !pseudoLocales.has(locale))
      .sort(compareCodePoint);
    const missingFromConfiguration = [...declared]
      .filter((locale) => !configured.has(locale) && !pseudoLocales.has(locale))
      .sort(compareCodePoint);
    const span = {
      path: ['routes', policyLocales.sourcePath] as readonly string[],
    };
    if (missingFromPolicy.length > 0) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1408',
          `${missingFromPolicy.map((locale) => JSON.stringify(locale)).join(', ')} ${missingFromPolicy.length === 1 ? 'is a configured locale' : 'are configured locales'} that this owner's locale URL policy gives no address. Catalogs are generated for ${missingFromPolicy.length === 1 ? 'it' : 'them'} and nothing can navigate to ${missingFromPolicy.length === 1 ? 'it' : 'them'}. Add ${missingFromPolicy.length === 1 ? 'it' : 'them'} to the policy, or remove ${missingFromPolicy.length === 1 ? 'it' : 'them'} from the configuration.`,
          span,
        ),
      );
    }
    if (missingFromConfiguration.length > 0) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1408',
          `${missingFromConfiguration.map((locale) => JSON.stringify(locale)).join(', ')} ${missingFromConfiguration.length === 1 ? 'has an address' : 'have addresses'} in this owner's locale URL policy and no catalogs. ${missingFromConfiguration.length === 1 ? 'That address resolves' : 'Those addresses resolve'} and every message renders in the default locale, which reads as missing translations rather than as a missing locale. Add ${missingFromConfiguration.length === 1 ? 'it' : 'them'} to the configuration, or remove ${missingFromConfiguration.length === 1 ? 'it' : 'them'} from the policy.`,
          span,
        ),
      );
    }
    if (
      policyLocales.defaultLocale !== undefined &&
      canonical(policyLocales.defaultLocale) !==
        canonical(graph.value.defaultLocale)
    ) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1408',
          `This owner's configuration makes ${JSON.stringify(graph.value.defaultLocale)} the default locale and its locale URL policy makes ${JSON.stringify(policyLocales.defaultLocale)} the default. The policy's default decides which addresses carry no prefix and which locale an unprefixed address means, so the two disagreeing sends visitors to a different locale than the one the application falls back to.`,
          span,
        ),
      );
    }
  }

  // A canonical route whose leading segment is one the policy already owns.
  //
  // The policy claims the first segment of an address before any route does: a locale prefix names
  // the locale and is removed, an alias redirects, a locale-neutral root is answered by nothing. A
  // route declared at `ar-eg/tools` under an `ar-eg` prefix is therefore not a route at a free
  // address: it is an address the resolver reads as the ar-EG locale and a route called `tools`,
  // and the declared route is unreachable at the address it declared. `buildLocalizedRoute` will
  // hand out that address, `localizedServerRoutes` will schedule a rendered file at it, and
  // `toInternalPath` will strip the segment and lose the route.
  //
  // This is the first point in a build that holds both statements. The policy is one source file
  // and the route projection is another; the validator that checks the projection is handed no
  // policy at all, and the runtime functions that meet both meet them one address at a time, after
  // the build has finished. So the whole-projection question is asked here or nowhere.
  //
  // Every route is checked, not only those whose addresses drop the prefix. Under `omitDefaultPrefix`
  // the collision is what a visitor gets; under full prefixing it is what the canonical layer, the
  // authored Angular route table, and every internal address carry. The address exists either way.
  //
  // A leading segment that is a route parameter is not checked here and cannot be: whether a slug
  // serializes to something the policy owns is decided per value, at runtime, which is where the
  // matching refusal lives.
  const policyDeclaration = analysis?.routePolicy;
  if (
    policyDeclaration !== undefined &&
    policyDeclaration.claimedSegments.length > 0
  ) {
    const exact = new Map(
      policyDeclaration.claimedSegments
        .filter((claim) => claim.kind === 'locale-neutral root')
        .map((claim) => [claim.segment, claim] as const),
    );
    const folded = new Map(
      policyDeclaration.claimedSegments
        .filter((claim) => claim.kind !== 'locale-neutral root')
        .map((claim) => [claim.segment.toLowerCase(), claim] as const),
    );
    for (const route of analysis?.routes ?? []) {
      const leading = route.path.split('/')[0];
      if (leading === undefined || leading.length === 0) continue;
      if (leading.startsWith(':')) continue;
      const claim = exact.get(leading) ?? folded.get(leading.toLowerCase());
      if (claim === undefined) continue;
      diagnostics.push(
        atlasDiagnostic(
          'ATL1409',
          `Route ${JSON.stringify(route.id)} is declared at ${JSON.stringify(`/${route.path}`)} and its leading segment ${JSON.stringify(leading)} is this owner's ${claim.kind} ${JSON.stringify(claim.segment)}. Atlas reads the first segment of an address as the ${claim.kind} before it reads it as a route, so this route is unreachable at its own address and Atlas will publish addresses for it that it cannot resolve. Rename the route's leading segment, or spell the ${claim.kind} differently in ${JSON.stringify(policyDeclaration.sourcePath)}.`,
          { path: ['routes', route.sourcePath] },
        ),
      );
    }

    // A template that writes a locale into an address it hands to the Router.
    //
    // The contract this defends: a consumer writes `routerLink="/articles/x"` and never
    // `/ar-eg/articles/x`. Nothing enforced the never, so the first place the mistake was
    // reported was a console warning in development, after the click, to whoever happened to be
    // looking.
    //
    // `routerLink` alone, and the reason is what Atlas transforms rather than what the HTML
    // specification calls a URL. A click hands the Router the address as written, and
    // `UrlHandlingStrategy.extract` resolves it to its canonical form before anything matches it:
    // the prefix is removed and the page renders in the locale that is committed now. So the link
    // cannot do the one thing its address says it does, whichever locale the reader is in. An
    // `href` is a different mechanism (a full-page address the browser supplies, which
    // `LocationStrategy.path()` delocalizes on arrival) so a locale in one works, and a link to
    // another locale's page is legitimate content.
    //
    // Error, with no warning half, because unlike a static `lang` there is no legitimate form. A
    // deliberately locale-pinned `routerLink` is not a stricter version of the same thing; it is an
    // address the Router will not honour.
    //
    // Judged against the claimed segments and not the locale set, which is what makes this the
    // sibling of the check above rather than a widening of ATL1410. A policy may spell a prefix
    // differently from the tag, and an alias is claimed too. `folded` is asked and `exact` is not,
    // so the neutral roots are excluded: a locale-neutral root is the one leading segment a
    // policy claims that survives the resolution, so an address that begins with one goes where it
    // says and is correct.
    for (const address of analysis?.templateAddresses ?? []) {
      const leading = address.address.split('/')[1];
      if (leading === undefined || leading.length === 0) continue;
      const claim = folded.get(leading.toLowerCase());
      if (claim === undefined) continue;
      diagnostics.push(
        atlasDiagnostic(
          'ATL1411',
          `The template of ${JSON.stringify(address.componentName)} writes routerLink=${JSON.stringify(address.address)}, whose leading segment ${JSON.stringify(leading)} is this owner's ${claim.kind} ${JSON.stringify(claim.segment)}. Atlas resolves a routerLink to its canonical address before the Router matches it, so the locale in this one is discarded and the link opens the page in whichever locale is committed. Write the canonical address without the ${claim.kind}, ${JSON.stringify(address.address.slice(leading.length + 1) || '/')}, and change locale with "Localization.changeLocale()", which is the operation that moves the reader between locales.`,
          { path: ['components', address.templatePath] },
        ),
      );
    }
  }

  // A template that spells out a locale.
  //
  // A switcher written by hand carries the same thing three or four times per option: the locale as
  // a string, the option's language as a static `lang`, its direction as a static `dir`, and its
  // name in its own language as literal text. All four are answers Atlas already has, and every one
  // of them is authored again for each locale, in each template, in a language the author may not
  // read. Adding a locale then means finding every one of those places, and nothing fails when one
  // is missed: the option simply reads wrongly, aloud, to the people who need it most.
  //
  // Judged here rather than in the analysis, which reports what a template says and does not hold
  // the locale set. The same division `routePolicy` is checked under.
  //
  // Two severities, because the two halves are not equally wrong.
  //
  // A locale spelled as a string inside a template expression is an error. There is no form of it
  // that survives a locale being added: the expression is either a switch to a locale the template
  // names, or a branch on one, and in both cases the template has to be edited for a change that
  // belongs in the configuration. Atlas has the list.
  //
  // A static `lang` is a warning, because there is one legitimate form and this check cannot tell
  // it apart: a page carrying a fixed passage in another language marks that passage up exactly
  // this way, and a quotation in a language the application also serves is correct HTML. What the
  // warning can do is say so where the author is looking, with the thing to use instead named.
  if (analysis !== undefined && analysis.localeMentions.length > 0) {
    const canonical = (value: string): string => {
      const result = canonicalizeAtlasLocale(value);
      return result.ok ? result.value.toLowerCase() : value.toLowerCase();
    };
    const configured = new Set(graph.value.locales.map(canonical));
    // The primary language subtag is the first subtag of a canonical tag, by the grammar. `lang` on
    // a single option is written as the bare subtag (`en`, not `en-US`) so both spellings have
    // to be recognised or the check misses the exact shape it exists for.
    const languages = new Set(
      [...configured].map((locale) => locale.split('-')[0] ?? locale),
    );
    for (const mention of analysis.localeMentions) {
      const text = canonical(mention.text);
      const names =
        mention.kind === 'literal'
          ? configured.has(text)
          : configured.has(text) || languages.has(text);
      if (!names) continue;
      const what =
        mention.kind === 'literal'
          ? `names the locale ${JSON.stringify(mention.text)} as a literal`
          : mention.siblingDirection === undefined
            ? `writes lang=${JSON.stringify(mention.text)} by hand`
            : `writes lang=${JSON.stringify(mention.text)} and dir=${JSON.stringify(mention.siblingDirection)} by hand`;
      const literal = mention.kind === 'literal';
      diagnostics.push(
        atlasDiagnostic(
          'ATL1410',
          `The template of ${JSON.stringify(mention.componentName)} ${what}. Atlas already knows every configured locale, its language subtag, its direction and its name in its own language: read them from "localization.localeChoices()" and put "[localeChoice]" on the control, which writes lang, dir, aria-current and aria-busy and performs the switch. A switcher built that way gains a locale when the configuration gains one.${literal ? '' : ' If this is a fixed passage in another language rather than a locale control, this is the right markup and the warning is expected.'}`,
          {
            ...(literal ? {} : { severity: 'warning' as const }),
            path: ['components', mention.templatePath],
          },
        ),
      );
    }
  }

  if (analysis !== undefined) {
    diagnostics.push(...unusedSourceMessages(graph.value, analysis));
  }

  const deferredScopes =
    analysis === undefined ? [] : deferredScopeIds(graph.value, analysis);

  const contracts = generateAtlasContracts(graph.value, {
    ...(deferredScopes.length === 0
      ? {}
      : { deferredScopeIds: deferredScopes }),
    ...(recoveryMessageIdentities.length === 0
      ? {}
      : { recoveryMessageIdentities }),
    ...(analysis === undefined
      ? {}
      : {
          routes: analysis.routes.map(
            ({
              id,
              path,
              parameterNames,
              indexing,
              sitemap,
              sourcePath,
              deferredSourcePaths,
            }) => {
              const scopes = routeScopes(
                graph.value,
                analysis,
                deferredSourcePaths,
              );
              return {
                ...(scopes.length === 0 ? {} : { scopes }),
                id,
                path,
                parameterNames,
                ...(indexing === undefined ? {} : { indexing }),
                ...(sitemap === undefined ? {} : { sitemap }),
                sourcePath,
              };
            },
          ),
        }),
  });
  if (!contracts.ok) return contracts;
  diagnostics.push(...contracts.diagnostics);
  const artifacts = compileAtlasLocalArtifacts({
    graph: graph.value,
    catalogs: request.catalogs,
    owner: request.owner,
    contractFiles: contracts.value,
    ...(recoveryMessageIdentities.length === 0
      ? {}
      : { recoveryMessageIdentities }),
  });
  if (!artifacts.ok) return artifacts;
  diagnostics.push(...artifacts.diagnostics);

  const { inputs, inputFingerprint } = fingerprintAtlasCompilerInputs(request);
  const state: AtlasCompilerState = Object.freeze({
    profile: ATLAS_COMPILER_STATE_PROFILE,
    inputFingerprint,
    inputs,
    outputPlanDigest: artifacts.value.outputPlan.planDigest,
  });
  const invalidation = invalidationDecision(
    request.previousState,
    inputs,
    artifacts.value.outputPlan.files.map(({ path }) => path),
  );
  return atlasSuccess(
    Object.freeze({
      graph: graph.value,
      ...(analysis === undefined ? {} : { analysis }),
      artifacts: artifacts.value,
      state,
      invalidation,
    }),
    diagnostics,
  );
}

/**
 * Compiles a project from catalogs already in memory, and touches no files.
 *
 * Analyses the catalogs together, settles each message's contract across its locales, compiles the
 * bodies, and produces the artifacts and an output plan that would write them. Returns all of it, or the
 * reasons it could not.
 *
 * Incremental when handed the previous run's state: what did not change is not recompiled, and the
 * result says which inputs moved and which outputs they reach.
 *
 * The verb to reach for when the input is not a directory: a test, an editor, a script that
 * assembles catalogs itself. `compileAtlasProjectFromDisk` is the one that reads a project.
 */
export function compileAtlasProject(
  request: AtlasCompileProjectRequest,
): AtlasResult<AtlasCompileProjectResult> {
  const sink = request.observability;
  if (sink === undefined) return compileAtlasProjectCore(request);
  emitAtlasToolkitEvent(sink, {
    code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
    phase: 'compilation',
    status: 'started',
  });
  let result: AtlasResult<AtlasCompileProjectResult>;
  try {
    result = compileAtlasProjectCore(request);
  } catch (error) {
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
      phase: 'compilation',
      status: 'failed',
    });
    throw error;
  }
  if (result.ok) {
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
      phase: 'compilation',
      status: 'succeeded',
      count: result.value.artifacts.outputPlan.files.length,
    });
  } else {
    const diagnosticCode = result.diagnostics[0]?.code;
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
      phase: 'compilation',
      status: 'failed',
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    });
  }
  return result;
}

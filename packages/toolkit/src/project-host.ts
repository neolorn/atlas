import { randomBytes } from 'node:crypto';
import { watch as watchFileSystem, type FSWatcher } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

import ts from 'typescript';

import {
  formatAtlasCatalogSource,
  parseAtlasCatalog,
  type AtlasCatalog,
} from './catalog.js';
import {
  compileAtlasProject,
  fingerprintAtlasCompilerInputs,
  type AtlasCompileProjectRequest,
  type AtlasCompileProjectResult,
  type AtlasCompilerAnalysisInput,
  type AtlasCompilerState,
} from './compiler.js';
import {
  ATLAS_TRANSLATION_STATE_PATH,
  EMPTY_ATLAS_TRANSLATION_STATE,
  formatAtlasTranslationState,
  parseAtlasTranslationState,
  reconcileAtlasTranslationState,
  type AtlasStaleTranslation,
} from './translation-state.js';
import { ATLAS_INIT_OPTIONS } from './cli-options.generated.js';
import {
  atlasCompletenessPolicy,
  atlasPseudoLocales,
  formatAtlasConfiguration,
  parseAtlasConfiguration,
  type AtlasInitConfiguration,
  type AtlasProjectConfiguration,
} from './configuration.js';
import {
  atlasMessageCustomFunctions,
  formatAtlasExtensionRegistry,
  parseAtlasExtensionRegistry,
  type AtlasExtensionRegistry,
} from './extensions.js';
import { createAtlasPseudoCatalog } from './pseudo-localization.js';
import {
  atlasDiagnostic,
  atlasFailure,
  atlasSourceSpan,
  atlasSuccess,
  type AtlasDiagnostic,
  type AtlasDiagnosticSeverity,
  type AtlasResult,
} from './diagnostics.js';
import {
  digestAtlasCanonicalJson,
  type AtlasCanonicalJsonObject,
  type AtlasCanonicalJsonValue,
} from './canonical-json.js';
import { admitAtlasHostCompatibility } from './host-compatibility.js';
import { parseAtlasProviderId } from './identities.js';
import { canonicalizeAtlasLocale } from './locales.js';
import {
  ATLAS_TOOLKIT_EVENT_CODES,
  emitAtlasToolkitEvent,
  type AtlasToolkitObservabilityOptions,
  type AtlasToolkitObservabilitySink,
} from './observability.js';
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';
import {
  ATLAS_COMPILER_CACHE_PATH,
  ATLAS_WORK_OWNER_PATH,
  ATLAS_WORK_OWNER_PROFILE,
  applyAtlasOutputPlan,
  cleanAtlasOutput,
  containedPath,
  inspectAtlasOutputFreshness,
  type AtlasApplyOutputPlanResult,
  type AtlasCleanOutputResult,
  type AtlasOutputFreshness,
} from './output-host.js';
import { compareCodePoint } from './sorted-records.js';
import {
  pathExists,
  pathMetadata,
  portablePath,
  writeSynced,
} from './file-system.js';

export const ATLAS_COMPILER_CACHE_PROFILE = 'atlas-compiler-cache/1' as const;

const CONFIGURATION_NAME = 'atlas.config.json';
const PACKAGE_MANIFEST_NAME = 'package.json';
const EXTENSION_REGISTRY_NAME = 'atlas.extensions.json';
const GENERATED_ROOT = 'src/generated/i18n';
const WORK_ROOT = '.atlas';
/**
 * The `#i18n` map for an owner whose generated output sits at `generatedRootPortablePath`.
 *
 * Almost always `src/generated/i18n` directly under the owner, which is what a per-application
 * layout produces. It differs when an owner at a workspace root has its Angular application
 * nested: the generated output belongs to the application that was analyzed, so the map has to
 * reach it.
 */
function packageImports(
  generatedRootPortablePath: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    '#i18n': `./${generatedRootPortablePath}/index.ts`,
    '#i18n/*': `./${generatedRootPortablePath}/*.ts`,
  });
}
/**
 * The script entries `init` writes and keeps.
 *
 * Exported so a verification gate can assert what Atlas declares rather than what a fixture author
 * happened to type. A gate that runs `pnpm run atlas:init` proves only that a person added that
 * entry to the fixture manifest, because Atlas writes no such script.
 */
export const ATLAS_PACKAGE_SCRIPTS = Object.freeze({
  'atlas:generate': 'atlas generate',
  'atlas:check': 'atlas check',
  'atlas:format': 'atlas format',
  'atlas:clean': 'atlas clean',
  'atlas:watch': 'atlas watch',
});

/**
 * Which project on disk an operation runs against, and what it may report while it does.
 *
 * Every project verb takes this or something extending it. All of it is optional: with nothing
 * given, the operation finds the project from the current working directory.
 */
export interface AtlasProjectSelection extends AtlasToolkitObservabilityOptions {
  /** Where to start looking for the project. Defaults to the current working directory. */
  readonly cwd?: string;
  /** The configuration file to use, for a repository holding more than one Atlas project. */
  readonly project?: string;
  /**
   * Generate the catalogs for the configured pseudo-locales. Off unless asked for.
   *
   * The switch is here, on the invocation, rather than in the configuration file that declares the
   * pseudo-locales, so one configuration serves both builds and the production build differs by
   * what it was asked to do, not by a file it had to edit first. `atlas generate --pseudo` is a
   * development command; a production build runs `atlas generate` and receives a locale table with
   * no pseudo-locale in it and no catalog to load.
   *
   * Deliberately not an environment variable. An environment variable set once on a CI runner
   * applies to every build on it, including the production one, which is the failure this switch
   * exists to make impossible. A flag has to be written into the specific command that wants it,
   * and it is visible in the `package.json` script where a reader will look.
   */
  readonly pseudoLocales?: boolean;
}

export interface AtlasProjectLocation {
  readonly ownerRoot: string;
  readonly configurationPath: string;
  readonly packagePath: string;
  readonly generatedRoot: string;
  /** The generated root as a portable path relative to the owner, for the `#i18n` map. */
  readonly generatedRootPath: string;
  readonly workRoot: string;
}

export interface AtlasLoadedCatalog {
  readonly absolutePath: string;
  readonly portablePath: string;
  readonly source: string;
  readonly catalog: AtlasCatalog;
}

export interface AtlasLoadedProject extends AtlasProjectLocation {
  readonly providerId: string;
  readonly configurationSource: string;
  readonly configuration: AtlasProjectConfiguration;
  readonly packageSource: string;
  readonly packageManifest: Readonly<Record<string, unknown>>;
  readonly catalogFiles: readonly AtlasLoadedCatalog[];
  readonly catalogs: readonly AtlasCatalog[];
  readonly extensionSource?: string;
  readonly extensions?: AtlasExtensionRegistry;
  readonly analysis?: AtlasCompilerAnalysisInput;
  readonly recoveryMessageIdentities: readonly string[];
}

/** What every project verb returns at minimum: the compilation it ran. */
export interface AtlasProjectCompilation {
  /** The analysis, the compiled artifacts, the generated files, and everything reported. */
  readonly compilation: AtlasCompileProjectResult;
}

interface AtlasLoadedProjectCompilation extends AtlasProjectCompilation {
  readonly project: AtlasLoadedProject;
}

/** What generating takes: a project, and whether to actually write. */
export interface AtlasGenerateProjectOptions extends AtlasProjectSelection {
  /** Work out the whole result and write nothing. The result still says what would have changed. */
  readonly dryRun?: boolean;
}

/** What generating produced, and what it did to the generated tree. */
export interface AtlasGenerateProjectResult extends AtlasProjectCompilation {
  /** What was written, what was removed, and whether anything changed at all. */
  readonly publication: AtlasApplyOutputPlanResult;
}

/** What checking takes: a project, and how strict to be about what it finds. */
export interface AtlasCheckProjectOptions extends AtlasProjectSelection {
  /** Reformat the catalogs that are not in canonical form, rather than only reporting them. */
  readonly fix?: boolean;
  /**
   * Require every target locale the project expects to be finished to be finished.
   *
   * For a team whose release rule is that no required locale may ship short of the source, this
   * is the switch that enforces it. Off by default, because during development a source message
   * ordinarily lands before its translations and a hard failure there would stop the work that
   * produces them.
   *
   * **What it covers is the whole family, not a selection from it.** `ATL1306` (the locale has no
   * catalog for a scope at all), `ATL1307` (a catalog omits a message), `ATL1308` (a message omits
   * a plural or ordinal category) and `ATL1309` (a translation was written against an older
   * source) are one question asked at four granularities, and they escalate together. They did not
   * always: this switch reached `ATL1307` and `ATL1308` only, so a locale missing one message of
   * three blocked a release and the same locale with no catalog at all passed it.
   *
   * **Which locales it applies to is not this option's to say.** Every locale is required unless
   * the project's own configuration declares it still in progress, which is a fact about the
   * project rather than about this run. This option decides only whether the run enforces it.
   *
   * **The name is `require`, and it stays.** The behaviour is a severity escalation, and the word
   * looked like a mismatch for that, until the pair is read together. `requireFreshOutput` does
   * the same thing to `ATL1704`, and both say the same true thing: the condition is *required for
   * this run*, and a run that does not meet it does not pass. Renaming one would separate a pair
   * that reads as a pair, and renaming both would spend a public-surface break on a word that was
   * already accurate.
   */
  readonly requireCompleteTargets?: boolean;
  /**
   * Require the generated output on disk to match what the sources would generate.
   *
   * Off by default and deliberately so: `specs/10-compiler-and-tooling.spec.md` section 12 keeps
   * freshness a non-blocking advisory in friendly mode, because generated output is routinely
   * stale in the middle of ordinary
   * authoring and a command that failed on it would be unusable. On, `ATL1704` is raised at
   * `error` rather than `warning`, which is what makes it blocking: the exit code is keyed to
   * severity, so nothing else has to be told about this option.
   *
   * Separate from `requireCompleteTargets` rather than folded into one strictness switch.
   * `specs/10-compiler-and-tooling.spec.md` section 12 enumerates completeness, freshness,
   * hygiene and automation thresholds as four opt-in policies,
   * and they are independently useful: wanting a release gate to block on stale output is not
   * wanting it to block on an untranslated message. Separate switches can be aggregated behind a
   * convenience flag later; one switch cannot be split without breaking the callers that set it.
   */
  readonly requireFreshOutput?: boolean;
}

/** What checking found: whether the generated tree is current, and what it rewrote. */
export interface AtlasCheckProjectResult extends AtlasProjectCompilation {
  /** Whether what is on disk matches what the sources would produce now, and where it does not. */
  readonly freshness: AtlasOutputFreshness;
  /** The catalog files reformatted, empty unless `fix` was asked for. */
  readonly fixedFiles: readonly string[];
}

/** Which project to format, and whether to write anything. */
export interface AtlasFormatProjectOptions extends AtlasProjectSelection {
  /** Work out the rewrites and write none of them, so a check can report without changing. */
  readonly dryRun?: boolean;
}

/** What formatting rewrote, or would have rewritten under a dry run. */
export interface AtlasFormatProjectResult {
  /** Whether anything was out of canonical form. False on a project already formatted. */
  readonly changed: boolean;
  /** The files rewritten, as repository-relative paths, sorted. */
  readonly files: readonly string[];
}

/**
 * Which project to initialize, what to write into its configuration, and whether to write at all.
 *
 * Unlike the other three, this one is required rather than defaulted: initialization has to be told
 * at least the source locale, and there is no sensible guess for a project's languages.
 */
export interface AtlasInitProjectOptions extends AtlasProjectSelection {
  /**
   * The configuration fields to write, spelled as `atlas.config.json` spells them.
   *
   * One field rather than one per key, and that is correctness rather than convenience. Naming
   * four of the six the parser accepts leaves `personNameLocales` and `pseudoLocales` unreachable
   * from `init`: a test that passes one has it silently discarded, and the initialized project is
   * valid, so nothing fails and nothing says anything. A named field per key is a second statement
   * of the configuration shape, and the second one going quiet is the defect rather than a risk.
   *
   * `AtlasInitConfiguration` is derived from the parser's own shape, so this follows the parser
   * without anyone keeping it in step.
   */
  readonly configuration?: AtlasInitConfiguration;
  /** Work out the files and write none of them, which is how a caller previews an init. */
  readonly dryRun?: boolean;
}

/** What initialization wrote, and the configuration the project now has. */
export interface AtlasInitProjectResult {
  /** Whether anything was written. False on a project already initialized the same way. */
  readonly changed: boolean;
  /** The files written or that would be written, as repository-relative paths, sorted. */
  readonly files: readonly string[];
  /**
   * The configuration as parsed back, with the defaults filled in.
   *
   * What the project now has rather than what was asked for, so a caller reading the locale list
   * reads the one the parser accepted.
   */
  readonly configuration: AtlasProjectConfiguration;
}

/** Which project to clean, and whether to delete anything. */
export interface AtlasCleanProjectOptions extends AtlasProjectSelection {
  /** Work out what would be removed and remove none of it. */
  readonly dryRun?: boolean;
}

/** Which project to remove Atlas from, whether to delete anything, and how far to go. */
export interface AtlasUninstallProjectOptions extends AtlasProjectSelection {
  /** Work out what would be removed and remove none of it. */
  readonly dryRun?: boolean;
  /** Remove authored catalogs too. Off unless asked for by name. */
  readonly catalogs?: boolean;
}

/** What uninstalling took back, what it left behind, and why. */
export interface AtlasUninstallProjectResult {
  /** Whether anything was removed. */
  readonly changed: boolean;
  /** The files taken back, as repository-relative paths, sorted. */
  readonly removed: readonly string[];
  /**
   * What Atlas wrote, then somebody changed, and Atlas therefore left alone.
   *
   * Named rather than reverted: an edited script or a repointed `#i18n` specifier belongs to
   * whoever edited it, and silently undoing that is the same class of mistake as silently
   * deleting a comment.
   */
  readonly retained: readonly string[];
  /** The authored catalogs removed, which is empty unless `catalogs` was asked for. */
  readonly catalogs: readonly string[];
}

/** One pass of the watcher: what number it was, and how it ended. */
export interface AtlasWatchCycle {
  /** Which pass this is, counting from one, so a log can be read in order. */
  readonly sequence: number;
  /** What generating produced this time, including a failure, which does not stop the watch. */
  readonly result: AtlasResult<AtlasGenerateProjectResult>;
}

/** What watching takes: a project, a way to stop, and somewhere to report each pass. */
export interface AtlasWatchProjectOptions extends AtlasProjectSelection {
  /**
   * How the watch is stopped. Required: there is no other way out.
   *
   * Aborting it lets the pass in flight finish and then returns.
   */
  readonly signal: AbortSignal;
  /**
   * How long to wait for the edits to stop before regenerating.
   *
   * A save can touch several files, and an editor can write one file twice. Waiting is what turns
   * that into one pass instead of four.
   */
  readonly debounceMilliseconds?: number;
  /**
   * Called once per pass, with what it produced.
   *
   * The only way to see a pass's diagnostics: the watch returns once, at the end, and by then every
   * pass but the last is over. It must not throw.
   */
  readonly onCycle?: (cycle: AtlasWatchCycle) => void;
}

/** What a finished watch has to say, which is how much it did. */
export interface AtlasWatchProjectResult {
  /** How many passes ran before the watch was stopped. */
  readonly cycles: number;
}

interface CompilerCacheEnvelope {
  readonly profile: typeof ATLAS_COMPILER_CACHE_PROFILE;
  readonly ownerId: string;
  readonly stateDigest: string;
  readonly state: AtlasCompilerState;
}

interface CachedCompilerState {
  readonly ownerId: string;
  readonly state: AtlasCompilerState;
  readonly diagnostics: readonly AtlasDiagnostic[];
}

interface TextFileChange {
  readonly absolutePath: string;
  readonly portablePath: string;
  readonly previous: string | undefined;
  readonly contents: string;
}

/**
 * A short list of paths for a diagnostic, without a wall of them.
 *
 * Six is where a reader stops counting and starts scrolling, and a project with every catalog
 * broken at once has one cause rather than forty.
 */
function namedPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 6);
  const rest = paths.length - shown.length;
  return rest === 0 ? shown.join(', ') : `${shown.join(', ')} and ${rest} more`;
}

function parentPath(path: string): string | undefined {
  const parent = dirname(path);
  return parent === path ? undefined : parent;
}

async function assertOrdinaryContainedPath(
  ownerRoot: string,
  target: string,
): Promise<void> {
  if (!containedPath(target, ownerRoot)) {
    throw new TypeError(`Atlas path escapes its selected owner: ${target}`);
  }
  const portable = relative(ownerRoot, target);
  let current = ownerRoot;
  for (const segment of portable === '' ? [] : portable.split(sep)) {
    current = resolve(current, segment);
    const metadata = await pathMetadata(current);
    if (metadata === undefined) break;
    if (metadata.isSymbolicLink()) {
      throw new TypeError(`Atlas refuses linked project content: ${current}`);
    }
  }
}

async function readUtf8(path: string, maximumBytes: number): Promise<string> {
  const contents = await readFile(path);
  if (contents.byteLength > maximumBytes) {
    throw new TypeError(
      `Atlas refuses ${path} because it exceeds ${maximumBytes} bytes.`,
    );
  }
  return contents.toString('utf8');
}

function projectDiagnostic(
  summary: string,
  severity: AtlasDiagnosticSeverity = 'error',
): AtlasDiagnostic {
  return atlasDiagnostic('ATL1702', summary, { severity });
}

async function explicitOwner(
  project: string,
  cwd: string,
): Promise<AtlasResult<string>> {
  const candidate = resolve(cwd, project);
  const metadata = await pathMetadata(candidate);
  if (metadata === undefined) {
    return atlasFailure([
      projectDiagnostic(
        `Selected Atlas project ${JSON.stringify(project)} does not exist.`,
      ),
    ]);
  }
  if (metadata.isSymbolicLink()) {
    return atlasFailure([
      projectDiagnostic('Atlas project selection cannot be a symbolic link.'),
    ]);
  }
  if (metadata.isDirectory()) return atlasSuccess(candidate);
  if (metadata.isFile() && basename(candidate) === CONFIGURATION_NAME) {
    return atlasSuccess(dirname(candidate));
  }
  return atlasFailure([
    projectDiagnostic(
      'Atlas --project must select an owner directory or atlas.config.json.',
    ),
  ]);
}

/**
 * The owner this working directory is in, searched no further than the package it is in.
 *
 * Discovery walks upward, and unbounded it walks to the filesystem root, selecting one
 * `atlas.config.json` however far above and whatever stands between.
 * `specs/10-compiler-and-tooling.spec.md` section 4 says a working-directory accident never merges
 * projects, and section 10 says an application never inherits a neighboring configuration by
 * directory accident; this is the same accident one directory up.
 *
 * Unbounded, `atlas init` inside `parent/child`, where `child` has its own `package.json` and
 * `parent` has an `atlas.config.json`, initializes **`parent`** and reports success, naming three
 * files the reader cannot find where they are standing. In this repository it goes further: a
 * stray configuration at the workspace root makes every consumer materialized under `tmp/`
 * select that root as its owner instead of itself, and four gate stages then fail with "Atlas init
 * is already complete" against a consumer whose configuration does not exist.
 *
 * **So the boundary is the nearest `package.json` upward, inclusive.** That directory is the
 * project's root (it is what a package manager, Node's own resolution and Atlas's provider
 * identity all already treat as one) and a configuration above it belongs to a different project.
 * The workspace-root owner with a nested application still resolves, because nothing between the
 * application and that root carries a manifest of its own (section 134).
 *
 * With no `package.json` anywhere above, there is no project, so the only directory a configuration
 * could belong to is this one.
 */
type AtlasOwnerSearch =
  | { readonly outcome: 'one'; readonly ownerRoot: string }
  | { readonly outcome: 'many'; readonly candidates: readonly string[] }
  | {
      readonly outcome: 'none';
      readonly boundary: string;
      readonly beyond: string | undefined;
    };

async function searchOwnerWithinPackage(
  cwd: string,
): Promise<AtlasOwnerSearch> {
  const candidates: string[] = [];
  let boundary: string | undefined;
  let current: string | undefined = cwd;
  while (current !== undefined) {
    if (await pathExists(resolve(current, CONFIGURATION_NAME))) {
      candidates.push(current);
    }
    if (await pathExists(resolve(current, PACKAGE_MANIFEST_NAME))) {
      boundary = current;
      break;
    }
    current = parentPath(current);
  }
  const within =
    boundary === undefined
      ? candidates.filter((candidate) => candidate === cwd)
      : candidates;
  if (within.length === 1) {
    return { outcome: 'one', ownerRoot: within[0] as string };
  }
  if (within.length > 1) return { outcome: 'many', candidates: within };
  // Looked for only on the way to reporting nothing, and only to answer the question the reader is
  // about to ask. A configuration they can see, under a message saying none was found, is what
  // sends someone looking for a bug in discovery.
  const searched = boundary ?? cwd;
  return {
    outcome: 'none',
    boundary: searched,
    beyond: await configurationAbove(searched),
  };
}

async function discoverOwnerWithinPackage(
  cwd: string,
): Promise<AtlasResult<string>> {
  const search = await searchOwnerWithinPackage(cwd);
  if (search.outcome === 'one') return atlasSuccess(search.ownerRoot);
  if (search.outcome === 'many') {
    return atlasFailure([
      projectDiagnostic(
        `Atlas project discovery is ambiguous: ${search.candidates
          .map((path) => JSON.stringify(path))
          .join(', ')}. Use --project.`,
      ),
    ]);
  }
  return atlasFailure([projectDiagnostic(noOwnerFound(search))]);
}

function noOwnerFound(
  search: Extract<AtlasOwnerSearch, { outcome: 'none' }>,
): string {
  return search.beyond === undefined
    ? `No atlas.config.json was found in ${JSON.stringify(search.boundary)}. Select an owner with --project or run atlas init.`
    : `No atlas.config.json was found in ${JSON.stringify(search.boundary)}, which is the package this directory is in. There is one at ${JSON.stringify(search.beyond)}, above that boundary, and it belongs to that project rather than this one. Run atlas init here, or select that project with --project if this directory really is part of it.`;
}

/** The nearest configuration strictly above a boundary, for a diagnostic that has to name it. */
async function configurationAbove(
  boundary: string,
): Promise<string | undefined> {
  let current = parentPath(boundary);
  while (current !== undefined) {
    if (await pathExists(resolve(current, CONFIGURATION_NAME))) return current;
    current = parentPath(current);
  }
  return undefined;
}

export async function discoverAtlasProject(
  selection: AtlasProjectSelection = {},
): Promise<AtlasResult<AtlasProjectLocation>> {
  const cwd = resolve(selection.cwd ?? process.cwd());
  let ownerRoot: string;
  if (selection.project !== undefined) {
    const selected = await explicitOwner(selection.project, cwd);
    if (!selected.ok) return selected;
    ownerRoot = selected.value;
  } else {
    const discovered = await discoverOwnerWithinPackage(cwd);
    if (!discovered.ok) return discovered;
    ownerRoot = discovered.value;
  }
  const ownerMetadata = await pathMetadata(ownerRoot);
  if (
    ownerMetadata === undefined ||
    !ownerMetadata.isDirectory() ||
    ownerMetadata.isSymbolicLink()
  ) {
    return atlasFailure([
      projectDiagnostic('Atlas owner must be an existing ordinary directory.'),
    ]);
  }
  const generatedRoot = await generatedRootPath(ownerRoot);
  return atlasSuccess(
    Object.freeze({
      ownerRoot,
      configurationPath: resolve(ownerRoot, CONFIGURATION_NAME),
      packagePath: resolve(ownerRoot, 'package.json'),
      generatedRoot: resolve(ownerRoot, ...generatedRoot.split('/')),
      generatedRootPath: generatedRoot,
      workRoot: resolve(ownerRoot, WORK_ROOT),
    }),
  );
}

/**
 * The manifest an owner is identified by.
 *
 * `create` is set only by `atlas init`. Scaffolding commands author files and build commands do
 * not, which is the division `tsc --init` and `tsc`, `eslint --init`, `git init` and
 * `cargo init` all draw. The practical reason is stronger than the convention: `generate`,
 * `check` and `watch` run unattended inside build pipelines and dev servers, so letting them
 * author files means one mistyped `--project` scatters manifests through a build.
 */
async function readPackageManifest(
  location: AtlasProjectLocation,
  create = false,
): Promise<
  AtlasResult<{
    readonly source: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly providerId: string;
    readonly created: boolean;
  }>
> {
  const metadata = await pathMetadata(location.packagePath);
  if (metadata !== undefined && metadata.isSymbolicLink()) {
    return atlasFailure([
      projectDiagnostic(
        'The selected Atlas owner package.json is a link. Atlas refuses linked project content; replace it with an ordinary file.',
      ),
    ]);
  }
  if (metadata !== undefined && !metadata.isFile()) {
    return atlasFailure([
      projectDiagnostic(
        'The selected Atlas owner package.json is not an ordinary file.',
      ),
    ]);
  }
  if (metadata === undefined) {
    if (!create) {
      // The remedy, not just the fact. A missing manifest is the ordinary state of a new
      // application in a multi-application workspace, and the whole of what to do about it is one
      // command.
      return atlasFailure([
        projectDiagnostic(
          `The selected Atlas owner has no package.json at ${JSON.stringify(portablePath(location.ownerRoot, location.packagePath))}. Run atlas init in that directory to create it; generate, check, format and watch never author files.`,
        ),
      ]);
    }
    const created = createdPackageManifest(location.ownerRoot);
    if (!created.ok) return created;
    const parsed = JSON.parse(created.value) as Readonly<
      Record<string, unknown>
    >;
    const provider = parseAtlasProviderId(parsed['name']);
    if (!provider.ok) return provider;
    return atlasSuccess(
      Object.freeze({
        source: created.value,
        value: parsed,
        providerId: provider.value,
        created: true,
      }),
    );
  }
  const source = await readUtf8(location.packagePath, 1024 * 1024);
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return atlasFailure([
      projectDiagnostic('The selected owner package.json is not valid JSON.'),
    ]);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return atlasFailure([
      projectDiagnostic('The selected owner package.json must be an object.'),
    ]);
  }
  const manifest = value as Readonly<Record<string, unknown>>;
  if (typeof manifest['name'] !== 'string') {
    return atlasFailure([
      projectDiagnostic(
        'The selected owner package.json requires a package name for its provider identity.',
      ),
    ]);
  }
  const provider = parseAtlasProviderId(manifest['name']);
  if (!provider.ok) {
    return atlasFailure([
      projectDiagnostic(
        `Package name ${JSON.stringify(manifest['name'])} is not a valid Atlas provider identity.`,
      ),
    ]);
  }
  return atlasSuccess(
    Object.freeze({
      source,
      value: manifest,
      providerId: provider.value,
      created: false,
    }),
  );
}

/**
 * The manifest `atlas init` writes when an application has none.
 *
 * The package name comes from the directory, because that is the only name present: Atlas has no
 * way to know a workspace's scope, and inventing one would put a wrong provider identity into
 * every compiled artifact. A directory whose name is not a usable identity is reported rather than
 * sanitized, since the identity is durable and a silently corrected one is worse than a refusal.
 */
function createdPackageManifest(ownerRoot: string): AtlasResult<string> {
  const name = basename(ownerRoot);
  const provider = parseAtlasProviderId(name);
  if (!provider.ok) {
    return atlasFailure([
      projectDiagnostic(
        `Atlas cannot name a package after the directory ${JSON.stringify(name)}, which is not a valid package name. Create package.json with a name of your choosing and run atlas init again.`,
      ),
    ]);
  }
  return atlasSuccess(
    `${JSON.stringify({ name: provider.value, private: true }, null, 2)}\n`,
  );
}

function packageSetupDiagnostics(
  manifest: Readonly<Record<string, unknown>>,
  generatedRootPortablePath: string,
): readonly AtlasDiagnostic[] {
  const diagnostics: AtlasDiagnostic[] = [];
  const imports = manifest['imports'];
  if (
    typeof imports !== 'object' ||
    imports === null ||
    Array.isArray(imports)
  ) {
    diagnostics.push(
      atlasDiagnostic(
        'ATL1705',
        'package.json does not contain the Atlas #i18n import mappings. Run atlas init.',
      ),
    );
    return diagnostics;
  }
  for (const [specifier, target] of Object.entries(
    packageImports(generatedRootPortablePath),
  )) {
    if ((imports as Record<string, unknown>)[specifier] !== target) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1705',
          `package.json must map ${JSON.stringify(specifier)} to ${JSON.stringify(target)}. Run atlas init.`,
          { path: ['imports', specifier] },
        ),
      );
    }
  }
  return diagnostics;
}

async function readConfiguration(location: AtlasProjectLocation): Promise<
  AtlasResult<{
    readonly source: string;
    readonly value: AtlasProjectConfiguration;
  }>
> {
  const metadata = await pathMetadata(location.configurationPath);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.isSymbolicLink()
  ) {
    return atlasFailure([
      projectDiagnostic(
        'The selected Atlas owner requires an ordinary atlas.config.json.',
      ),
    ]);
  }
  const source = await readUtf8(location.configurationPath, 1024 * 1024);
  const parsed = parseAtlasConfiguration(source, {
    sourcePath: CONFIGURATION_NAME,
  });
  return parsed.ok
    ? atlasSuccess(
        Object.freeze({ source, value: parsed.value }),
        parsed.diagnostics,
      )
    : parsed;
}

async function readExtensionRegistry(location: AtlasProjectLocation): Promise<
  AtlasResult<
    | {
        readonly source: string;
        readonly value: AtlasExtensionRegistry;
      }
    | undefined
  >
> {
  const path = resolve(location.ownerRoot, EXTENSION_REGISTRY_NAME);
  const metadata = await pathMetadata(path);
  if (metadata === undefined) return atlasSuccess(undefined);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return atlasFailure([
      projectDiagnostic(
        `${EXTENSION_REGISTRY_NAME} must be an ordinary contained file.`,
      ),
    ]);
  }
  await assertOrdinaryContainedPath(location.ownerRoot, path);
  const source = await readUtf8(path, 1024 * 1024);
  const parsed = parseAtlasExtensionRegistry(source, {
    sourcePath: EXTENSION_REGISTRY_NAME,
  });
  return parsed.ok
    ? atlasSuccess(
        Object.freeze({ source, value: parsed.value }),
        parsed.diagnostics,
      )
    : parsed;
}

/**
 * One derived catalog per declared pseudo-locale per scope, built from that scope's source catalog.
 *
 * The result is an ordinary target catalog: same shape, same provider, same scope, and a locale the
 * rest of the pipeline has no way to tell apart from a translated one. That is the design, not a
 * convenience: it is why prerendering, server rendering, lazy scopes and the locale switcher all
 * work on a pseudo-locale without knowing the concept exists.
 *
 * Derived only from `role === 'source'`. A pseudo-locale built from a translation would compound
 * two transformations and measure neither.
 */
function derivePseudoCatalogs(
  configuration: AtlasProjectConfiguration,
  authored: readonly AtlasCatalog[],
  extensions: AtlasExtensionRegistry | undefined,
): AtlasResult<readonly AtlasCatalog[]> {
  const tags = Object.keys(configuration.pseudoLocales);
  if (tags.length === 0) return atlasSuccess(Object.freeze([]));
  // The same registry the authored catalogs were parsed with. A derived catalog is an ordinary
  // catalog, and that has to include how it is read, not only what it looks like afterwards.
  const customFunctions = atlasMessageCustomFunctions(extensions);
  const derived: AtlasCatalog[] = [];
  const diagnostics: AtlasDiagnostic[] = [];
  for (const source of authored) {
    if (source.role !== 'source') continue;
    for (const tag of tags) {
      const transform = configuration.pseudoLocales[tag];
      if (transform === undefined) continue;
      const catalog = createAtlasPseudoCatalog(source, {
        locale: tag,
        ...transform,
        customFunctions,
      });
      diagnostics.push(...catalog.diagnostics);
      if (!catalog.ok) continue;
      derived.push(catalog.value);
    }
  }
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    return atlasFailure(diagnostics);
  }
  return atlasSuccess(Object.freeze(derived), diagnostics);
}

async function discoverCatalogs(
  location: AtlasProjectLocation,
  providerId: string,
  configuration: AtlasProjectConfiguration,
  extensions: AtlasExtensionRegistry | undefined,
): Promise<AtlasResult<readonly AtlasLoadedCatalog[]>> {
  const catalogRoot = resolve(location.ownerRoot, 'i18n');
  const rootMetadata = await pathMetadata(catalogRoot);
  if (
    rootMetadata === undefined ||
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink()
  ) {
    return atlasFailure([
      projectDiagnostic(
        'The selected Atlas owner requires an ordinary i18n directory.',
      ),
    ]);
  }
  const diagnostics: AtlasDiagnostic[] = [];
  const catalogs: AtlasLoadedCatalog[] = [];
  // Conventional catalog files that were found and read off disk but never became a catalog.
  const unreadable: string[] = [];
  const scopeEntries = await readdir(catalogRoot, { withFileTypes: true });
  scopeEntries.sort((left, right) => compareCodePoint(left.name, right.name));
  for (const scopeEntry of scopeEntries) {
    if (scopeEntry.isSymbolicLink() || !scopeEntry.isDirectory()) {
      diagnostics.push(
        projectDiagnostic(
          `Atlas catalog root contains unsupported entry ${JSON.stringify(scopeEntry.name)}.`,
        ),
      );
      continue;
    }
    const scopeRoot = resolve(catalogRoot, scopeEntry.name);
    const localeEntries = await readdir(scopeRoot, { withFileTypes: true });
    localeEntries.sort((left, right) =>
      compareCodePoint(left.name, right.name),
    );
    for (const localeEntry of localeEntries) {
      if (
        localeEntry.isSymbolicLink() ||
        !localeEntry.isFile() ||
        extname(localeEntry.name) !== '.yaml'
      ) {
        diagnostics.push(
          projectDiagnostic(
            `Atlas scope ${JSON.stringify(scopeEntry.name)} contains unsupported entry ${JSON.stringify(localeEntry.name)}.`,
          ),
        );
        continue;
      }
      const localeName = basename(localeEntry.name, '.yaml');
      const canonicalLocale = canonicalizeAtlasLocale(localeName);
      if (!canonicalLocale.ok || canonicalLocale.value !== localeName) {
        diagnostics.push(
          projectDiagnostic(
            `Catalog filename ${JSON.stringify(localeEntry.name)} must use a canonical locale identifier.`,
          ),
        );
        continue;
      }
      const absolutePath = resolve(scopeRoot, localeEntry.name);
      await assertOrdinaryContainedPath(location.ownerRoot, absolutePath);
      const source = await readUtf8(absolutePath, 16 * 1024 * 1024);
      const portable = portablePath(location.ownerRoot, absolutePath);
      // Counted where the file is read rather than where it is accepted, because the difference
      // between the two is the whole of the diagnostic below.
      unreadable.push(portable);
      const parsed = parseAtlasCatalog(source, {
        role:
          canonicalLocale.value === configuration.sourceLocale
            ? 'source'
            : 'target',
        providerId,
        scopeId: scopeEntry.name,
        locale: canonicalLocale.value,
        sourcePath: portable,
        ...(extensions === undefined ? {} : { extensions }),
      });
      diagnostics.push(...parsed.diagnostics);
      if (parsed.ok) {
        unreadable.pop();
        catalogs.push(
          Object.freeze({
            absolutePath,
            portablePath: portable,
            source,
            catalog: parsed.value,
          }),
        );
      }
    }
  }
  if (catalogs.length === 0) {
    // This said *"Atlas found no conventional i18n/<scope>/<locale>.yaml catalogs"*
    // whether none existed or every one of them existed and failed to parse, and it said it above
    // the parse errors for the very files it had just read. A reader who has an `en-US.yaml` open in
    // front of them is told Atlas cannot find it, which sends them to check the path convention,
    // the scope name and the locale spelling, none of which is wrong.
    //
    // Absence and unreadability are different facts and they take different sentences. The
    // unreadable case names the files, because ordering diagnostics is `orderedDiagnostics`'s
    // business and "see the errors below" is a claim about a layout this code does not control.
    //
    // They are also different *severities*. A project with no messages is not a broken
    // project: it is the state every project is in the moment after `atlas init`, and the install
    // line is `init` then `generate` with nothing authored in between. So absence is a note that
    // says where the first message goes, and only unreadability is an error. The severity carries
    // it rather than a second code, the way `ATL1704` does: one fact, one diagnostic, and the
    // severity-keyed exit path decides whether it blocks.
    diagnostics.push(
      unreadable.length === 0
        ? projectDiagnostic(
            `Atlas found no messages yet. Write the first catalog at i18n/<scope>/${configuration.sourceLocale}.yaml, for example i18n/shell/${configuration.sourceLocale}.yaml.`,
            'info',
          )
        : projectDiagnostic(
            unreadable.length === 1
              ? `Atlas found 1 conventional catalog and could not read it: ${namedPaths(unreadable)}.`
              : `Atlas found ${unreadable.length} conventional catalogs and could not read any of them: ${namedPaths(unreadable)}.`,
          ),
    );
  }
  if (diagnostics.some(({ severity }) => severity === 'error')) {
    return atlasFailure(diagnostics);
  }
  catalogs.sort((left, right) =>
    compareCodePoint(left.portablePath, right.portablePath),
  );
  return atlasSuccess(Object.freeze(catalogs), diagnostics);
}

function typescriptDiagnostic(
  ownerRoot: string,
  diagnostic: ts.Diagnostic,
): AtlasDiagnostic {
  const summary = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (
    diagnostic.file === undefined ||
    diagnostic.start === undefined ||
    diagnostic.length === undefined
  ) {
    return atlasDiagnostic('ATL1401', `TypeScript configuration: ${summary}`);
  }
  return atlasDiagnostic('ATL1401', `TypeScript configuration: ${summary}`, {
    span: atlasSourceSpan(
      diagnostic.file.text,
      diagnostic.start,
      diagnostic.length,
      portablePath(ownerRoot, diagnostic.file.fileName),
    ),
  });
}

interface AngularApplication {
  /** Portable path of the application root, relative to the owner. Empty at the owner root. */
  readonly root: string;
  readonly tsConfig: string;
}

function angularApplication(
  ownerRoot: string,
  angular: Readonly<Record<string, unknown>>,
): AtlasResult<AngularApplication | undefined> {
  const projects = angular['projects'];
  if (
    typeof projects !== 'object' ||
    projects === null ||
    Array.isArray(projects)
  ) {
    return atlasSuccess(undefined);
  }
  const candidates: AngularApplication[] = [];
  for (const [, rawProject] of Object.entries(projects).sort(
    ([left], [right]) => compareCodePoint(left, right),
  )) {
    if (
      typeof rawProject !== 'object' ||
      rawProject === null ||
      Array.isArray(rawProject)
    ) {
      continue;
    }
    const project = rawProject as Readonly<Record<string, unknown>>;
    if (project['projectType'] !== 'application') continue;
    const projectRoot =
      typeof project['root'] === 'string' ? project['root'] : '';
    const absoluteProjectRoot = resolve(ownerRoot, projectRoot);
    if (!containedPath(absoluteProjectRoot, ownerRoot)) continue;
    const architect = project['architect'] ?? project['targets'];
    if (
      typeof architect !== 'object' ||
      architect === null ||
      Array.isArray(architect)
    ) {
      continue;
    }
    const build = (architect as Readonly<Record<string, unknown>>)['build'];
    if (typeof build !== 'object' || build === null || Array.isArray(build))
      continue;
    const options = (build as Readonly<Record<string, unknown>>)['options'];
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    ) {
      continue;
    }
    const tsConfig = (options as Readonly<Record<string, unknown>>)['tsConfig'];
    if (typeof tsConfig === 'string') {
      const root = portablePath(ownerRoot, absoluteProjectRoot);
      candidates.push(
        Object.freeze({
          // portablePath answers '.' for the owner root itself; an application at the owner root
          // has no prefix at all, and carrying one would put './' into every generated path.
          root: root === '.' ? '' : root,
          tsConfig: resolve(ownerRoot, tsConfig),
        }),
      );
    }
  }
  const unique = [
    ...new Map(candidates.map((entry) => [entry.tsConfig, entry])).values(),
  ].sort((left, right) => compareCodePoint(left.tsConfig, right.tsConfig));
  if (unique.length > 1) {
    return atlasFailure([
      projectDiagnostic(
        `Atlas found multiple Angular application TypeScript graphs: ${unique
          .map(({ tsConfig }) =>
            JSON.stringify(portablePath(ownerRoot, tsConfig)),
          )
          .join(', ')}. Select one application owner with --project.`,
      ),
    ]);
  }
  return atlasSuccess(unique[0]);
}

async function selectAngularApplication(
  ownerRoot: string,
): Promise<AtlasResult<AngularApplication | undefined>> {
  const angularPath = resolve(ownerRoot, 'angular.json');
  if (await pathExists(angularPath)) {
    let angular: unknown;
    try {
      angular = JSON.parse(await readUtf8(angularPath, 4 * 1024 * 1024));
    } catch {
      return atlasFailure([
        projectDiagnostic('The selected owner angular.json is not valid JSON.'),
      ]);
    }
    if (
      typeof angular === 'object' &&
      angular !== null &&
      !Array.isArray(angular)
    ) {
      const selected = angularApplication(
        ownerRoot,
        angular as Readonly<Record<string, unknown>>,
      );
      if (!selected.ok || selected.value !== undefined) return selected;
    }
  }
  for (const name of ['tsconfig.app.json', 'tsconfig.json']) {
    const path = resolve(ownerRoot, name);
    if (await pathExists(path)) {
      return atlasSuccess(Object.freeze({ root: '', tsConfig: path }));
    }
  }
  return atlasSuccess(undefined);
}

/**
 * Where this owner's generated source belongs.
 *
 * Inside the Angular application Atlas analyzed, always. When the owner is the application, the
 * per-application layout, that is `src/generated/i18n` under the owner. When an owner at a
 * workspace root has its application nested, writing to the owner's own `src/generated/i18n` would
 * create a source directory belonging to no Angular project and sitting outside the tsconfig of
 * the application just analyzed.
 */
async function generatedRootPath(ownerRoot: string): Promise<string> {
  const application = await selectAngularApplication(ownerRoot);
  const root = application.ok ? (application.value?.root ?? '') : '';
  return root === '' ? GENERATED_ROOT : `${root}/${GENERATED_ROOT}`;
}

function externalTemplatePaths(
  ownerRoot: string,
  sourcePath: string,
  source: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const paths = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'templateUrl') ||
        (ts.isStringLiteralLike(node.name) &&
          node.name.text === 'templateUrl')) &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      const path = resolve(dirname(sourcePath), node.initializer.text);
      if (containedPath(path, ownerRoot)) paths.add(path);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...paths].sort(compareCodePoint);
}

// Machine-specific locations that describe where a project sits rather than
// how it is analyzed. They must never reach a cache digest.
const NON_PORTABLE_COMPILER_OPTIONS: ReadonlySet<string> = new Set([
  'configFilePath',
  'pathsBasePath',
  'outDir',
  'outFile',
  'rootDir',
  'rootDirs',
  'declarationDir',
  'tsBuildInfoFile',
  'sourceRoot',
  'mapRoot',
  'project',
]);

function portableCompilerOptions(
  ownerRoot: string,
  options: ts.CompilerOptions,
): AtlasCanonicalJsonObject {
  const portableValue = (value: unknown): AtlasCanonicalJsonValue => {
    if (typeof value === 'string') {
      return isAbsolute(value) ? portablePath(ownerRoot, value) : value;
    }
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    if (Array.isArray(value)) return value.map(portableValue);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, nested]): [string, AtlasCanonicalJsonValue] => [
            key,
            portableValue(nested),
          ])
          .sort(([left], [right]) => compareCodePoint(left, right)),
      );
    }
    return null;
  };
  const entries = Object.entries(options)
    .filter(
      ([key, value]) =>
        !NON_PORTABLE_COMPILER_OPTIONS.has(key) && value !== undefined,
    )
    .map(([key, value]): [string, AtlasCanonicalJsonValue] => [
      key,
      portableValue(value),
    ])
    .sort(([left], [right]) => compareCodePoint(left, right));
  return Object.freeze(Object.fromEntries(entries));
}

async function loadAnalysisGraph(
  location: AtlasProjectLocation,
): Promise<AtlasResult<AtlasCompilerAnalysisInput | undefined>> {
  const host = admitAtlasHostCompatibility();
  if (!host.ok) return host;
  const selected = await selectAngularApplication(location.ownerRoot);
  if (!selected.ok) return selected;
  if (selected.value === undefined) {
    // Silence was the worst available answer. With no TypeScript graph, Atlas cannot see a single
    // template or call site, so every message looks unused, reachability is empty, and generation
    // produces an owner with nothing in it, and it all reports success. Every application meets
    // first-time configuration exactly once, so this is the moment a workspace adopting Atlas is
    // most likely to hit it and least able to recognise it. Reported as a project-selection
    // failure rather than an environment one, because the fix is in the project.
    return atlasFailure([
      ...selected.diagnostics,
      projectDiagnostic(
        'Atlas found no TypeScript graph for this owner, so no template or call site can be analyzed and every message would appear unused. Expected an Angular application build tsConfig in angular.json, or tsconfig.app.json or tsconfig.json beside package.json.',
      ),
    ]);
  }
  const configPath = selected.value.tsConfig;
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) {
    return atlasFailure([typescriptDiagnostic(location.ownerRoot, read.error)]);
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    return atlasFailure(
      parsed.errors.map((diagnostic) =>
        typescriptDiagnostic(location.ownerRoot, diagnostic),
      ),
    );
  }
  const rootNames = parsed.fileNames
    .map((path) => resolve(path))
    .filter(
      (path) =>
        containedPath(path, location.ownerRoot) &&
        !containedPath(path, location.generatedRoot) &&
        !containedPath(path, location.workRoot) &&
        !portablePath(location.ownerRoot, path).startsWith('node_modules/'),
    )
    .sort(compareCodePoint);
  const diagnostics: AtlasDiagnostic[] = [];
  if (rootNames.length > ATLAS_RESOURCE_LIMITS.analysisSourceFiles) {
    diagnostics.push(
      atlasDiagnostic(
        'ATL1403',
        `Atlas TypeScript analysis exceeds the ${ATLAS_RESOURCE_LIMITS.analysisSourceFiles}-source implementation ceiling.`,
      ),
    );
  }
  for (const path of parsed.fileNames.map((item) => resolve(item))) {
    if (!containedPath(path, location.ownerRoot)) {
      diagnostics.push(
        projectDiagnostic(
          `The selected TypeScript graph contains root ${JSON.stringify(path)} outside the Atlas owner.`,
        ),
      );
    }
  }
  if (diagnostics.length > 0) return atlasFailure(diagnostics);
  const sourceMap = new Map<string, string>();
  let sourceBytes = 0;
  const addSource = (path: string, source: string): boolean => {
    if (sourceMap.has(path)) return true;
    sourceBytes += Buffer.byteLength(source, 'utf8');
    if (
      sourceMap.size + 1 > ATLAS_RESOURCE_LIMITS.analysisSourceFiles ||
      sourceBytes > ATLAS_RESOURCE_LIMITS.analysisSourceBytes
    ) {
      return false;
    }
    sourceMap.set(path, source);
    return true;
  };
  for (const path of rootNames) {
    await assertOrdinaryContainedPath(location.ownerRoot, path);
    const source = await readUtf8(path, 4 * 1024 * 1024);
    if (!addSource(path, source)) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1403',
          `Atlas analysis exceeds its ${ATLAS_RESOURCE_LIMITS.analysisSourceFiles}-source or ${ATLAS_RESOURCE_LIMITS.analysisSourceBytes}-byte implementation ceiling.`,
        ),
      ]);
    }
    for (const templatePath of externalTemplatePaths(
      location.ownerRoot,
      path,
      source,
    )) {
      const metadata = await pathMetadata(templatePath);
      if (metadata?.isSymbolicLink()) {
        return atlasFailure([
          atlasDiagnostic(
            'ATL1402',
            `Atlas refuses linked Angular template ${JSON.stringify(
              portablePath(location.ownerRoot, templatePath),
            )}.`,
          ),
        ]);
      }
      if (
        metadata !== undefined &&
        metadata.isFile() &&
        !metadata.isSymbolicLink()
      ) {
        if (
          !addSource(
            templatePath,
            await readUtf8(templatePath, 4 * 1024 * 1024),
          )
        ) {
          return atlasFailure([
            atlasDiagnostic(
              'ATL1403',
              `Atlas analysis exceeds its ${ATLAS_RESOURCE_LIMITS.analysisSourceFiles}-source or ${ATLAS_RESOURCE_LIMITS.analysisSourceBytes}-byte implementation ceiling.`,
            ),
          ]);
        }
      }
    }
  }
  const sources = [...sourceMap.entries()]
    .sort(([left], [right]) => compareCodePoint(left, right))
    .map(([path, contents]) => Object.freeze({ path, contents }));
  return atlasSuccess(
    Object.freeze({
      projectRoot: location.ownerRoot,
      rootNames: Object.freeze(rootNames),
      sources: Object.freeze(sources),
      ...(parsed.options.types === undefined
        ? {}
        : { typeNames: Object.freeze([...parsed.options.types]) }),
      compilerOptions: parsed.options,
      compilerOptionsDigestInput: portableCompilerOptions(
        location.ownerRoot,
        parsed.options,
      ),
      maxDiagnostics: 100,
    }),
  );
}

export async function loadAtlasProject(
  selection: AtlasProjectSelection = {},
  options: { readonly requirePackageSetup?: boolean } = {},
): Promise<AtlasResult<AtlasLoadedProject>> {
  const location = await discoverAtlasProject(selection);
  if (!location.ok) return location;
  const packageManifest = await readPackageManifest(location.value);
  if (!packageManifest.ok) return packageManifest;
  if (options.requirePackageSetup === true) {
    const setupDiagnostics = packageSetupDiagnostics(
      packageManifest.value.value,
      location.value.generatedRootPath,
    );
    if (setupDiagnostics.length > 0) return atlasFailure(setupDiagnostics);
  }
  const configuration = await readConfiguration(location.value);
  if (!configuration.ok) return configuration;
  const extensions = await readExtensionRegistry(location.value);
  if (!extensions.ok) return extensions;
  const catalogs = await discoverCatalogs(
    location.value,
    packageManifest.value.providerId,
    configuration.value.value,
    extensions.value?.value,
  );
  if (!catalogs.ok) return catalogs;
  const analysis = await loadAnalysisGraph(location.value);
  if (!analysis.ok) return analysis;

  // Pseudo-locales enter here and nowhere else. `configuration` gains their tags so the generated
  // locale table, the availability lookup and the typed constants include them; `catalogs` gains
  // the derived catalogs so every later stage compiles them like any other. Nothing downstream is
  // told which locales are pseudo, and nothing downstream asks, which is what makes leaving the
  // flag off an absence rather than a disabled feature.
  //
  // They stay out of `catalogFiles`, which is the list of authored files on disk: `format` writes
  // to those paths and `uninstall` deletes them, and a derived catalog has no file to do either to.
  const authoredCatalogs = Object.freeze(
    catalogs.value.map(({ catalog }) => catalog),
  );
  const pseudo =
    selection.pseudoLocales === true
      ? derivePseudoCatalogs(
          configuration.value.value,
          authoredCatalogs,
          extensions.value?.value,
        )
      : atlasSuccess(Object.freeze([] as readonly AtlasCatalog[]));
  if (!pseudo.ok) return pseudo;
  const configurationValue =
    pseudo.value.length === 0
      ? configuration.value.value
      : Object.freeze({
          ...configuration.value.value,
          locales: Object.freeze([
            ...configuration.value.value.locales,
            ...atlasPseudoLocales(configuration.value.value),
          ]),
        });

  return atlasSuccess(
    Object.freeze({
      ...location.value,
      providerId: packageManifest.value.providerId,
      configurationSource: configuration.value.source,
      configuration: configurationValue,
      packageSource: packageManifest.value.source,
      packageManifest: packageManifest.value.value,
      catalogFiles: catalogs.value,
      catalogs: Object.freeze([...authoredCatalogs, ...pseudo.value]),
      ...(extensions.value === undefined
        ? {}
        : {
            extensionSource: extensions.value.source,
            extensions: extensions.value.value,
          }),
      ...(analysis.value === undefined ? {} : { analysis: analysis.value }),
      recoveryMessageIdentities: Object.freeze([]),
    }),
    [
      ...configuration.diagnostics,
      ...extensions.diagnostics,
      ...catalogs.diagnostics,
      ...analysis.diagnostics,
      ...pseudo.diagnostics,
    ],
  );
}

function compileRequest(
  project: AtlasLoadedProject,
  previousState?: AtlasCompilerState,
  observability?: AtlasToolkitObservabilitySink,
  requireCompleteTargets?: boolean,
): AtlasCompileProjectRequest {
  return {
    configuration: project.configuration,
    catalogs: project.catalogs,
    owner: {
      providerId: project.providerId,
      generatedRootPath: project.generatedRootPath,
    },
    ...(requireCompleteTargets === undefined ? {} : { requireCompleteTargets }),
    ...(project.extensions === undefined
      ? {}
      : { extensions: project.extensions }),
    ...(project.analysis === undefined ? {} : { analysis: project.analysis }),
    recoveryMessageIdentities: project.recoveryMessageIdentities,
    ...(previousState === undefined ? {} : { previousState }),
    ...(observability === undefined ? {} : { observability }),
  };
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256-[A-Za-z0-9_-]{43}$/u.test(value);
}

function validCachedInputIdentity(identity: string): boolean {
  if (
    identity.length === 0 ||
    identity.includes('\u0000') ||
    identity.includes('\\') ||
    identity.normalize('NFC') !== identity
  ) {
    return false;
  }
  if (!identity.startsWith('source:')) return true;
  const path = identity.slice('source:'.length);
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..')
  );
}

function parseCompilerState(value: unknown): AtlasCompilerState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).sort().join(',') !==
      'inputFingerprint,inputs,outputPlanDigest,profile' ||
    state['profile'] !== 'atlas-compiler-state/1' ||
    !validDigest(state['inputFingerprint']) ||
    !validDigest(state['outputPlanDigest']) ||
    !Array.isArray(state['inputs'])
  ) {
    return undefined;
  }
  const inputs: { identity: string; digest: string }[] = [];
  for (const input of state['inputs']) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return undefined;
    }
    const record = input as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',') !== 'digest,identity' ||
      typeof record['identity'] !== 'string' ||
      !validCachedInputIdentity(record['identity']) ||
      !validDigest(record['digest'])
    ) {
      return undefined;
    }
    inputs.push({ identity: record['identity'], digest: record['digest'] });
  }
  if (
    inputs.some(
      (input, index) =>
        index > 0 &&
        compareCodePoint(inputs[index - 1]?.identity ?? '', input.identity) >=
          0,
    )
  ) {
    return undefined;
  }
  return Object.freeze({
    profile: 'atlas-compiler-state/1',
    inputFingerprint: state['inputFingerprint'],
    outputPlanDigest: state['outputPlanDigest'],
    inputs: Object.freeze(inputs.map((input) => Object.freeze(input))),
  });
}

function compilerCacheContents(
  ownerId: string,
  state: AtlasCompilerState,
): string {
  const stateDigest = digestAtlasCanonicalJson('atlas-compiler-cache-state/1', {
    ownerId,
    state: JSON.parse(JSON.stringify(state)),
  });
  const envelope: CompilerCacheEnvelope = Object.freeze({
    profile: ATLAS_COMPILER_CACHE_PROFILE,
    ownerId,
    stateDigest,
    state,
  });
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

async function readCompilerCache(
  project: AtlasProjectLocation,
): Promise<CachedCompilerState | undefined> {
  const cachePath = resolve(
    project.workRoot,
    ...ATLAS_COMPILER_CACHE_PATH.split('/'),
  );
  if (!(await pathExists(cachePath))) return undefined;
  await assertOrdinaryContainedPath(project.ownerRoot, cachePath);
  let value: unknown;
  try {
    value = JSON.parse(await readUtf8(cachePath, 4 * 1024 * 1024));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Object.freeze({
        ownerId: '',
        state: Object.freeze({
          profile: 'atlas-compiler-state/1',
          inputFingerprint:
            'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          outputPlanDigest:
            'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          inputs: Object.freeze([]),
        }),
        diagnostics: Object.freeze([
          atlasDiagnostic(
            'ATL1703',
            'Atlas ignored a corrupt incremental compiler cache and will recompute it.',
            { severity: 'info' },
          ),
        ]),
      });
    }
    throw error;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    value = undefined;
  }
  const record = value as Record<string, unknown> | undefined;
  const state = parseCompilerState(record?.['state']);
  const ownerId = record?.['ownerId'];
  const expectedDigest =
    typeof ownerId === 'string' && state !== undefined
      ? digestAtlasCanonicalJson('atlas-compiler-cache-state/1', {
          ownerId,
          state: JSON.parse(JSON.stringify(state)),
        })
      : undefined;
  if (
    record === undefined ||
    Object.keys(record).sort().join(',') !==
      'ownerId,profile,state,stateDigest' ||
    record['profile'] !== ATLAS_COMPILER_CACHE_PROFILE ||
    !validDigest(ownerId) ||
    state === undefined ||
    record['stateDigest'] !== expectedDigest
  ) {
    return Object.freeze({
      ownerId: '',
      state: Object.freeze({
        profile: 'atlas-compiler-state/1',
        inputFingerprint: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        outputPlanDigest: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        inputs: Object.freeze([]),
      }),
      diagnostics: Object.freeze([
        atlasDiagnostic(
          'ATL1703',
          'Atlas ignored an incompatible incremental compiler cache and will recompute it.',
          { severity: 'info' },
        ),
      ]),
    });
  }
  return Object.freeze({
    ownerId,
    state,
    diagnostics: Object.freeze([]),
  });
}

async function writeCompilerCache(
  project: AtlasLoadedProject,
  ownerId: string,
  state: AtlasCompilerState,
): Promise<readonly AtlasDiagnostic[]> {
  const markerPath = resolve(project.workRoot, ATLAS_WORK_OWNER_PATH);
  const marker = JSON.parse(await readUtf8(markerPath, 1024 * 1024)) as Record<
    string,
    unknown
  >;
  if (
    marker['profile'] !== ATLAS_WORK_OWNER_PROFILE ||
    marker['ownerId'] !== ownerId
  ) {
    return Object.freeze([
      atlasDiagnostic(
        'ATL1703',
        'Atlas skipped incremental cache persistence because work ownership changed.',
        { severity: 'warning' },
      ),
    ]);
  }
  const cachePath = resolve(
    project.workRoot,
    ...ATLAS_COMPILER_CACHE_PATH.split('/'),
  );
  const cacheRoot = dirname(cachePath);
  await assertOrdinaryContainedPath(project.ownerRoot, cacheRoot);
  await mkdir(cacheRoot, { recursive: true });
  await assertOrdinaryContainedPath(project.ownerRoot, cachePath);
  const contents = compilerCacheContents(ownerId, state);
  if (
    (await pathExists(cachePath)) &&
    (await readFile(cachePath, 'utf8')) === contents
  ) {
    return Object.freeze([]);
  }
  await writeFile(cachePath, contents, 'utf8');
  return Object.freeze([]);
}

async function compileLoadedProject(
  project: AtlasLoadedProject,
  observability?: AtlasToolkitObservabilitySink,
  requireCompleteTargets?: boolean,
): Promise<AtlasResult<AtlasLoadedProjectCompilation>> {
  const cached = await readCompilerCache(project);
  const candidateState = cached?.ownerId === '' ? undefined : cached?.state;
  let compiled = compileAtlasProject(
    compileRequest(
      project,
      candidateState,
      observability,
      requireCompleteTargets,
    ),
  );
  if (!compiled.ok) return compiled;
  if (
    cached !== undefined &&
    cached.ownerId !== compiled.value.artifacts.ownerId
  ) {
    compiled = compileAtlasProject(
      compileRequest(project, undefined, observability, requireCompleteTargets),
    );
    if (!compiled.ok) return compiled;
  }
  return atlasSuccess(Object.freeze({ project, compilation: compiled.value }), [
    ...(cached?.diagnostics ?? []),
    ...compiled.diagnostics,
  ]);
}

async function compileAtlasProjectFromDiskInternalCore(
  selection: AtlasProjectSelection & {
    readonly requireCompleteTargets?: boolean;
  } = {},
): Promise<AtlasResult<AtlasLoadedProjectCompilation>> {
  const project = await loadAtlasProject(selection, {
    requirePackageSetup: true,
  });
  if (!project.ok) return project;
  const compiled = await compileLoadedProject(
    project.value,
    selection.observability,
    selection.requireCompleteTargets,
  );
  return compiled.ok
    ? atlasSuccess(compiled.value, [
        ...project.diagnostics,
        ...compiled.diagnostics,
      ])
    : compiled;
}

async function compileAtlasProjectFromDiskInternal(
  selection: AtlasProjectSelection & {
    readonly requireCompleteTargets?: boolean;
  } = {},
): Promise<AtlasResult<AtlasLoadedProjectCompilation>> {
  const sink = selection.observability;
  if (sink === undefined)
    return compileAtlasProjectFromDiskInternalCore(selection);
  emitAtlasToolkitEvent(sink, {
    code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
    phase: 'integration',
    status: 'started',
  });
  let result: AtlasResult<AtlasLoadedProjectCompilation>;
  try {
    result = await compileAtlasProjectFromDiskInternalCore(selection);
  } catch (error) {
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
      phase: 'integration',
      status: 'failed',
    });
    throw error;
  }
  if (result.ok) {
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
      phase: 'integration',
      status: 'succeeded',
      count: result.value.compilation.artifacts.outputPlan.files.length,
    });
  } else {
    const diagnosticCode = result.diagnostics[0]?.code;
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
      phase: 'integration',
      status: 'failed',
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    });
  }
  return result;
}

/**
 * Compiles a project from the files on disk and writes nothing.
 *
 * Finds the configuration, reads the catalogs and the extension registry, analyses them, and
 * compiles. Returns everything that came out, or the reasons it could not.
 *
 * For a caller that wants the result rather than the side effect: a report over the messages, a
 * custom check, an editor integration. `generateAtlasProject` is the one that writes.
 */
export async function compileAtlasProjectFromDisk(
  selection: AtlasProjectSelection = {},
): Promise<AtlasResult<AtlasProjectCompilation>> {
  const compiled = await compileAtlasProjectFromDiskInternal(selection);
  return compiled.ok
    ? atlasSuccess(
        Object.freeze({ compilation: compiled.value.compilation }),
        compiled.diagnostics,
      )
    : compiled;
}

async function readTranslationState(ownerRoot: string) {
  try {
    return parseAtlasTranslationState(
      await readUtf8(
        resolve(ownerRoot, ATLAS_TRANSLATION_STATE_PATH),
        4 * 1024 * 1024,
      ),
    );
  } catch {
    // Absent or unreadable is the ordinary first-run case, not a failure.
    return EMPTY_ATLAS_TRANSLATION_STATE;
  }
}

/**
 * The fourth member of the completeness family, and the one that is about time rather than count.
 *
 * A translation written against an older source is present and wrong, which is a worse failure than
 * one that is absent and obviously so: the reader gets confident text that no longer says what
 * the source says. It escalates with the rest for that reason: "is this locale finished" is one
 * question, and a locale whose messages all exist but half of them answer an older question is not
 * finished.
 *
 * Only `check` can escalate it. `generate` has no completeness switch, so it passes `false` and the
 * finding stays the advisory it is during authoring.
 */
function staleTranslationDiagnostics(
  stale: readonly AtlasStaleTranslation[],
  configuration: Pick<AtlasProjectConfiguration, 'inProgress'>,
  requireComplete: boolean,
): readonly AtlasDiagnostic[] {
  return Object.freeze(
    stale.map((entry) => {
      const policy = atlasCompletenessPolicy(
        configuration,
        requireComplete,
        entry.locale,
      );
      return atlasDiagnostic(
        'ATL1309',
        `Translation ${JSON.stringify(entry.messageId)} in ${entry.locale} was written against an older ${entry.scopeId} source and may no longer match it.${policy.suffix}`,
        { path: ['messages', entry.messageId], severity: policy.severity },
      );
    }),
  );
}

/**
 * Re-read the inputs and fingerprint them again, to catch a source edited during compilation.
 *
 * The reload has to use the same selection as the compile that produced the fingerprint being
 * compared against. Any selection field that changes what is loaded changes the fingerprint, so
 * reloading under a different one reports every such build as a source that moved underneath it.
 * `observability` is dropped rather than carried: it is the one field that does not affect what
 * is loaded, and passing it would emit a second set of events for a read the caller did not ask
 * for. Spreading the rest means a field added later is honoured here without being remembered.
 */
async function revalidatedInputFingerprint(
  ownerRoot: string,
  selection: AtlasProjectSelection,
): Promise<string> {
  const { observability: _observability, ...inputSelection } = selection;
  const project = await loadAtlasProject(
    { ...inputSelection, cwd: ownerRoot, project: ownerRoot },
    { requirePackageSetup: true },
  );
  if (!project.ok) {
    throw new TypeError(
      project.diagnostics
        .map(({ code, summary }) => `${code}: ${summary}`)
        .join('\n'),
    );
  }
  return fingerprintAtlasCompilerInputs(compileRequest(project.value))
    .inputFingerprint;
}

async function generateAtlasProjectCore(
  options: AtlasGenerateProjectOptions = {},
): Promise<AtlasResult<AtlasGenerateProjectResult>> {
  const compiled = await compileAtlasProjectFromDiskInternal(options);
  if (!compiled.ok) return compiled;
  const { project, compilation } = compiled.value;
  const publication = await applyAtlasOutputPlan({
    ownerRoot: project.ownerRoot,
    generatedRoot: project.generatedRoot,
    workRoot: project.workRoot,
    ownerId: compilation.artifacts.ownerId,
    plan: compilation.artifacts.outputPlan,
    dryRun: options.dryRun === true,
    expectedInputFingerprint: compilation.state.inputFingerprint,
    revalidateInputFingerprint: () =>
      revalidatedInputFingerprint(project.ownerRoot, options),
  });
  if (!publication.ok) return publication;

  // The record only moves forward when output is actually published. A dry run must observe
  // staleness without recording that it observed it, or the next real run would see nothing.
  const translationState = reconcileAtlasTranslationState(
    compilation.graph,
    await readTranslationState(project.ownerRoot),
  );
  const staleDiagnostics = staleTranslationDiagnostics(
    translationState.stale,
    project.configuration,
    false,
  );
  if (options.dryRun !== true && translationState.changed) {
    try {
      await writeFile(
        resolve(project.ownerRoot, ATLAS_TRANSLATION_STATE_PATH),
        formatAtlasTranslationState(translationState.state),
        'utf8',
      );
    } catch {
      // Losing the record costs an advisory, never correctness: the next run re-stamps.
    }
  }

  let cacheDiagnostics: readonly AtlasDiagnostic[] = [];
  if (options.dryRun !== true) {
    try {
      cacheDiagnostics = await writeCompilerCache(
        project,
        compilation.artifacts.ownerId,
        compilation.state,
      );
    } catch {
      cacheDiagnostics = Object.freeze([
        atlasDiagnostic(
          'ATL1703',
          'Atlas accepted generated output but could not persist its disposable incremental cache.',
          { severity: 'warning' },
        ),
      ]);
    }
  }
  return atlasSuccess(
    Object.freeze({ ...compiled.value, publication: publication.value }),
    [
      ...compiled.diagnostics,
      ...publication.diagnostics,
      ...cacheDiagnostics,
      ...staleDiagnostics,
    ],
  );
}

/**
 * Compiles a project and writes its generated tree.
 *
 * The verb a build runs. Writes only the files whose content changed and removes the ones the
 * sources no longer produce, so an unchanged project leaves the tree and its timestamps alone.
 *
 * Returns what was written and removed, or the reasons nothing was. Pass `dryRun` to find out what
 * it would do without doing it.
 */
export async function generateAtlasProject(
  options: AtlasGenerateProjectOptions = {},
): Promise<AtlasResult<AtlasGenerateProjectResult>> {
  const sink = options.observability;
  if (sink === undefined) return generateAtlasProjectCore(options);
  emitAtlasToolkitEvent(sink, {
    code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
    phase: 'generation',
    status: 'started',
  });
  let result: AtlasResult<AtlasGenerateProjectResult>;
  try {
    result = await generateAtlasProjectCore(options);
  } catch (error) {
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
      phase: 'generation',
      status: 'failed',
    });
    throw error;
  }
  if (result.ok) {
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
      phase: 'generation',
      status: result.value.publication.changed ? 'succeeded' : 'unchanged',
      count:
        result.value.publication.written.length +
        result.value.publication.removed.length,
    });
  } else {
    const diagnosticCode = result.diagnostics[0]?.code;
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
      phase: 'generation',
      status: 'failed',
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    });
  }
  return result;
}

/**
 * Checks a project without writing its generated tree.
 *
 * The verb a pull request runs. Everything generating would report, plus whether what is on disk is
 * still what the sources produce, which is how a generated tree somebody forgot to commit is
 * caught.
 *
 * Returns the compilation, the freshness, and anything it reformatted. Pass `fix` to have it
 * rewrite catalogs that are out of canonical form, and `requireCompleteTargets` to make an
 * unfinished locale an error rather than a warning.
 */
export async function checkAtlasProject(
  options: AtlasCheckProjectOptions = {},
): Promise<AtlasResult<AtlasCheckProjectResult>> {
  let fixedFiles: readonly string[] = Object.freeze([]);
  if (options.fix === true) {
    const formatted = await formatAtlasProject(options);
    if (!formatted.ok) return formatted;
    fixedFiles = formatted.value.files;
  }
  const compiled = await compileAtlasProjectFromDiskInternal(options);
  if (!compiled.ok) return compiled;
  const { project, compilation } = compiled.value;
  const freshness = await inspectAtlasOutputFreshness({
    ownerRoot: project.ownerRoot,
    generatedRoot: project.generatedRoot,
    workRoot: project.workRoot,
    ownerId: compilation.artifacts.ownerId,
    plan: compilation.artifacts.outputPlan,
  });
  if (!freshness.ok) return freshness;

  // Reconciled but not persisted: check reports what it sees and leaves the record for generate to
  // move, so a read-only command cannot quietly retire a warning it just raised.
  const translationState = reconcileAtlasTranslationState(
    compilation.graph,
    await readTranslationState(project.ownerRoot),
  );

  const diagnostics = [
    ...compiled.diagnostics,
    ...freshness.diagnostics,
    ...staleTranslationDiagnostics(
      translationState.stale,
      project.configuration,
      options.requireCompleteTargets === true,
    ),
  ];
  if (!freshness.value.fresh) {
    diagnostics.push(
      atlasDiagnostic(
        'ATL1704',
        `Generated output is stale (${freshness.value.missing.length} missing, ${freshness.value.changed.length} changed, ${freshness.value.stale.length} stale). Run atlas generate.`,
        // The same finding either way; the policy decides whether it blocks. Escalating the
        // severity rather than raising a second code keeps one diagnostic for one fact, and the
        // severity-keyed exit path does the rest.
        {
          severity: options.requireFreshOutput === true ? 'error' : 'warning',
        },
      ),
    );
  }
  return atlasSuccess(
    Object.freeze({
      ...compiled.value,
      freshness: freshness.value,
      fixedFiles: Object.freeze([...fixedFiles]),
    }),
    diagnostics,
  );
}

async function applyTextChanges(
  ownerRoot: string,
  changes: readonly TextFileChange[],
  dryRun: boolean,
): Promise<AtlasResult<AtlasFormatProjectResult>> {
  const changed = changes
    .filter(({ previous, contents }) => previous !== contents)
    .sort((left, right) =>
      compareCodePoint(left.portablePath, right.portablePath),
    );
  if (dryRun || changed.length === 0) {
    return atlasSuccess(
      Object.freeze({
        changed: changed.length > 0,
        files: Object.freeze(changed.map(({ portablePath: path }) => path)),
      }),
    );
  }
  const lockPath = resolve(ownerRoot, '.atlas-authoring.lock');
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  const transactionId = randomBytes(12).toString('hex');
  const operations: {
    change: TextFileChange;
    temporary: string;
    backup: string;
    published: boolean;
  }[] = [];
  try {
    lockHandle = await open(lockPath, 'wx');
    for (const change of changed) {
      await assertOrdinaryContainedPath(ownerRoot, change.absolutePath);
      const current = (await pathExists(change.absolutePath))
        ? await readFile(change.absolutePath, 'utf8')
        : undefined;
      if (current !== change.previous) {
        throw new TypeError(
          `Atlas input ${change.portablePath} changed before publication.`,
        );
      }
      const temporary = resolve(
        dirname(change.absolutePath),
        `.${basename(change.absolutePath)}.atlas-${transactionId}.tmp`,
      );
      const backup = resolve(
        dirname(change.absolutePath),
        `.${basename(change.absolutePath)}.atlas-${transactionId}.bak`,
      );
      await writeSynced(temporary, change.contents);
      operations.push({ change, temporary, backup, published: false });
    }
    for (const operation of operations) {
      if (operation.change.previous !== undefined) {
        await rename(operation.change.absolutePath, operation.backup);
      }
      await rename(operation.temporary, operation.change.absolutePath);
      operation.published = true;
    }
    for (const operation of operations) {
      if (operation.change.previous !== undefined)
        await unlink(operation.backup);
    }
    return atlasSuccess(
      Object.freeze({
        changed: true,
        files: Object.freeze(changed.map(({ portablePath: path }) => path)),
      }),
    );
  } catch (error) {
    for (const operation of [...operations].reverse()) {
      try {
        if (operation.published)
          await rm(operation.change.absolutePath, { force: true });
        if (await pathExists(operation.backup)) {
          await rename(operation.backup, operation.change.absolutePath);
        }
        await rm(operation.temporary, { force: true });
      } catch {
        return atlasFailure([
          atlasDiagnostic(
            'ATL1602',
            'Atlas authoring publication failed and automatic rollback could not be completed safely.',
          ),
        ]);
      }
    }
    return atlasFailure([
      atlasDiagnostic(
        'ATL1602',
        `Atlas authoring publication failed safely: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ]);
  } finally {
    if (lockHandle !== undefined) {
      await lockHandle.close();
      await rm(lockPath, { force: true });
    }
  }
}

/**
 * Rewrites a project's authored files into canonical form, and writes nothing else.
 *
 * The configuration, the catalogs and the extension registry, each through the same formatter that
 * parses them, so what is written parses back to what was there. A file whose round trip does not
 * hold is reported rather than written, because a formatter that changes meaning is worse than one
 * that declines.
 *
 * Takes the project to work on and whether to write; with no options it formats the project found
 * from the current directory. Reports what it rewrote, or the diagnostics that stopped it.
 */
export async function formatAtlasProject(
  options: AtlasFormatProjectOptions = {},
): Promise<AtlasResult<AtlasFormatProjectResult>> {
  const project = await loadAtlasProject(options);
  if (!project.ok) return project;
  const changes: TextFileChange[] = [];
  const configurationText = formatAtlasConfiguration(
    project.value.configuration,
  );
  const configurationRoundTrip = parseAtlasConfiguration(configurationText);
  if (
    !configurationRoundTrip.ok ||
    JSON.stringify(configurationRoundTrip.value) !==
      JSON.stringify(project.value.configuration)
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1703',
        'Atlas refused configuration formatting because semantic equality was not proven.',
      ),
    ]);
  }
  changes.push({
    absolutePath: project.value.configurationPath,
    portablePath: CONFIGURATION_NAME,
    previous: project.value.configurationSource,
    contents: configurationText,
  });
  if (
    project.value.extensions !== undefined &&
    project.value.extensionSource !== undefined
  ) {
    const contents = formatAtlasExtensionRegistry(project.value.extensions);
    const roundTrip = parseAtlasExtensionRegistry(contents);
    if (
      !roundTrip.ok ||
      JSON.stringify(roundTrip.value) !==
        JSON.stringify(project.value.extensions)
    ) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1703',
          'Atlas refused extension-registry formatting because semantic equality was not proven.',
        ),
      ]);
    }
    changes.push({
      absolutePath: resolve(project.value.ownerRoot, EXTENSION_REGISTRY_NAME),
      portablePath: EXTENSION_REGISTRY_NAME,
      previous: project.value.extensionSource,
      contents,
    });
  }
  for (const file of project.value.catalogFiles) {
    const catalogOptions = {
      role: file.catalog.role,
      providerId: file.catalog.providerId,
      scopeId: file.catalog.scopeId,
      locale: file.catalog.locale,
      sourcePath: file.portablePath,
      ...(project.value.extensions === undefined
        ? {}
        : { extensions: project.value.extensions }),
    };
    // The authored document, restyled. Formatting an authored catalog from the semantic model
    // deleted every comment in it, because comments are not in that model.
    const formatted = formatAtlasCatalogSource(file.source, catalogOptions);
    if (!formatted.ok) return formatted;
    const contents = formatted.value;
    const roundTrip = parseAtlasCatalog(contents, catalogOptions);
    if (
      !roundTrip.ok ||
      JSON.stringify(roundTrip.value) !== JSON.stringify(file.catalog)
    ) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1703',
          `Atlas refused formatting ${JSON.stringify(file.portablePath)} because semantic equality was not proven.`,
        ),
      ]);
    }
    changes.push({
      absolutePath: file.absolutePath,
      portablePath: file.portablePath,
      previous: file.source,
      contents,
    });
  }
  return applyTextChanges(
    project.value.ownerRoot,
    changes,
    options.dryRun === true,
  );
}

async function initOwner(
  selection: AtlasProjectSelection,
): Promise<AtlasResult<AtlasProjectLocation>> {
  if (selection.project !== undefined) {
    const owner = await explicitOwner(
      selection.project,
      resolve(selection.cwd ?? process.cwd()),
    );
    if (!owner.ok) return owner;
    return discoverAtlasProject({ ...selection, project: owner.value });
  }
  // `init` is the one command that may proceed when discovery finds nothing: creating the project
  // is what it is for. Which outcome it was is read from the search rather than from the wording
  // of the diagnostic. Reading it as `summary.startsWith('No atlas.config.json was found.')` makes
  // improving that sentence turn `init` into a command that refuses an empty directory.
  const ownerRoot = resolve(selection.cwd ?? process.cwd());
  const search = await searchOwnerWithinPackage(ownerRoot);
  if (search.outcome !== 'none') {
    return discoverAtlasProject(selection);
  }
  const metadata = await pathMetadata(ownerRoot);
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    return atlasFailure([
      projectDiagnostic(
        'Atlas init requires an existing ordinary owner directory.',
      ),
    ]);
  }
  const generatedRoot = await generatedRootPath(ownerRoot);
  return atlasSuccess(
    Object.freeze({
      ownerRoot,
      configurationPath: resolve(ownerRoot, CONFIGURATION_NAME),
      packagePath: resolve(ownerRoot, 'package.json'),
      generatedRoot: resolve(ownerRoot, ...generatedRoot.split('/')),
      generatedRootPath: generatedRoot,
      workRoot: resolve(ownerRoot, WORK_ROOT),
    }),
  );
}

function requestedConfiguration(
  options: AtlasInitProjectOptions,
): AtlasResult<AtlasProjectConfiguration> {
  const requested = (options.configuration ?? {}) as Readonly<
    Record<string, unknown>
  >;
  // Required, and what to type to supply it, both read from the generated option table, which is
  // itself read from `ATLAS_CONFIGURATION_SCHEMA`. `required` is a schema fact; the flag beside it
  // is how a person sets that field, and a diagnostic about a missing input that does not say what
  // to type has told the reader the half they already knew.
  const missing = ATLAS_INIT_OPTIONS.filter((option) => {
    if (!option.required) return false;
    const value = requested[option.key];
    // An empty list is an absence rather than a choice: `locales: []` cannot be what anyone meant,
    // and letting it through would report it as a schema violation against a file nobody wrote.
    return value === undefined || (Array.isArray(value) && value.length === 0);
  });
  if (missing.length > 0) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1701',
        `Noninteractive atlas init requires ${missing
          .map(
            (option) =>
              `${option.flag} ${option.value}${option.repeatable ? ' (repeat for each)' : ''}`,
          )
          .join(', ')}.`,
      ),
    ]);
  }
  // Everything the caller supplied, unexamined. What is acceptable is `parseAtlasConfiguration`'s
  // question and it is about to be asked: a key list here would answer it a second time, in a
  // second place, and the two would disagree the day one of them was edited.
  const source = `${JSON.stringify(
    { schemaVersion: 1, ...requested },
    null,
    2,
  )}\n`;
  return parseAtlasConfiguration(source, { sourcePath: CONFIGURATION_NAME });
}

function updatedPackageSource(
  source: string,
  manifest: Readonly<Record<string, unknown>>,
  generatedRootPortablePath: string,
): AtlasResult<string> {
  const mutable = JSON.parse(JSON.stringify(manifest)) as Record<
    string,
    unknown
  >;
  const currentImports = mutable['imports'];
  if (
    currentImports !== undefined &&
    (typeof currentImports !== 'object' ||
      currentImports === null ||
      Array.isArray(currentImports))
  ) {
    return atlasFailure([
      atlasDiagnostic('ATL1705', 'package.json imports must be an object.'),
    ]);
  }
  const imports = (currentImports ?? {}) as Record<string, unknown>;
  for (const [specifier, target] of Object.entries(
    packageImports(generatedRootPortablePath),
  )) {
    const existing = imports[specifier];
    if (existing !== undefined && existing !== target) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1705',
          `Atlas init refuses conflicting package import ${JSON.stringify(specifier)}.`,
          { path: ['imports', specifier] },
        ),
      ]);
    }
    imports[specifier] = target;
  }
  mutable['imports'] = imports;
  const currentScripts = mutable['scripts'];
  if (
    currentScripts !== undefined &&
    (typeof currentScripts !== 'object' ||
      currentScripts === null ||
      Array.isArray(currentScripts))
  ) {
    return atlasFailure([
      atlasDiagnostic('ATL1705', 'package.json scripts must be an object.'),
    ]);
  }
  const scripts = (currentScripts ?? {}) as Record<string, unknown>;
  for (const [name, command] of Object.entries(ATLAS_PACKAGE_SCRIPTS)) {
    const existing = scripts[name];
    if (existing !== undefined && existing !== command) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1705',
          `Atlas init refuses conflicting package script ${JSON.stringify(name)}.`,
          { path: ['scripts', name] },
        ),
      ]);
    }
    scripts[name] = command;
  }
  mutable['scripts'] = scripts;
  const formatted = `${JSON.stringify(mutable, null, 2)}\n`;
  return atlasSuccess(formatted === source ? source : formatted);
}

/**
 * Sets a project up: writes the configuration, the package scripts, and the generated-output root.
 *
 * Safe to run again. An existing configuration is read and merged rather than replaced, and a
 * package script that already means something else is refused by name instead of overwritten.
 *
 * Takes at least the locales to configure, which is why the options are required here. Reports what
 * it wrote and the configuration the project now has, or the diagnostics that stopped it. Two
 * things are left for the project to write and are named in the result's diagnostics: the first
 * catalog, and the recovery message a visitor reads if the translations cannot be loaded.
 */
export async function initializeAtlasProject(
  options: AtlasInitProjectOptions,
): Promise<AtlasResult<AtlasInitProjectResult>> {
  const location = await initOwner(options);
  if (!location.ok) return location;
  const packageManifest = await readPackageManifest(location.value, true);
  if (!packageManifest.ok) return packageManifest;
  const existingConfiguration = (await pathExists(
    location.value.configurationPath,
  ))
    ? await readConfiguration(location.value)
    : undefined;
  if (existingConfiguration !== undefined && !existingConfiguration.ok) {
    return existingConfiguration;
  }
  const suppliedAny =
    options.configuration !== undefined &&
    Object.keys(options.configuration).length > 0;
  const requested =
    existingConfiguration === undefined || suppliedAny
      ? requestedConfiguration(options)
      : atlasSuccess(existingConfiguration.value.value);
  if (!requested.ok) return requested;
  if (
    existingConfiguration !== undefined &&
    formatAtlasConfiguration(existingConfiguration.value.value) !==
      formatAtlasConfiguration(requested.value)
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1705',
        'Atlas init arguments conflict with the existing atlas.config.json.',
      ),
    ]);
  }
  const packageSource = updatedPackageSource(
    packageManifest.value.source,
    packageManifest.value.value,
    location.value.generatedRootPath,
  );
  if (!packageSource.ok) return packageSource;
  const configurationSource = formatAtlasConfiguration(requested.value);
  const changes: TextFileChange[] = [
    {
      absolutePath: location.value.configurationPath,
      portablePath: CONFIGURATION_NAME,
      previous: existingConfiguration?.value.source,
      contents: configurationSource,
    },
    {
      absolutePath: location.value.packagePath,
      portablePath: 'package.json',
      // A manifest Atlas is creating has no previous contents, and claiming one would make the
      // change look like an edit to a file that was never there.
      previous: packageManifest.value.created
        ? undefined
        : packageManifest.value.source,
      contents: packageSource.value,
    },
  ];
  const applied = await applyTextChanges(
    location.value.ownerRoot,
    changes,
    options.dryRun === true,
  );
  if (!applied.ok) return applied;

  // The container, and never anything in it.
  //
  // `generate` has to succeed on a project with no messages, because that is the state every
  // project is in the moment after `init` and the install line is `init` then `generate`. The one
  // thing a consumer cannot work out for themselves is the directory's name, so `init` makes it.
  //
  // It writes no catalog. A first catalog would be Atlas's words sitting in a consumer's product,
  // and an empty one is not a file that can exist: `messages.minProperties: 1` in
  // `ATLAS_SOURCE_CATALOG_SCHEMA` refuses `messages: {}`. Relaxing that would admit empty scopes,
  // which `specs/04-message-authoring-and-catalogs.spec.md` section 3 prohibits as reservation
  // scaffolding. So: the directory, and nothing.
  const catalogRoot = resolve(location.value.ownerRoot, 'i18n');
  const catalogRootMissing = !(await pathExists(catalogRoot));
  if (catalogRootMissing && options.dryRun !== true) {
    await assertOrdinaryContainedPath(location.value.ownerRoot, catalogRoot);
    await mkdir(catalogRoot, { recursive: true });
  }
  const files = catalogRootMissing
    ? Object.freeze(
        [...applied.value.files, 'i18n'].sort((left, right) =>
          compareCodePoint(left, right),
        ),
      )
    : applied.value.files;

  return atlasSuccess(
    Object.freeze({
      changed: applied.value.changed || catalogRootMissing,
      files,
      configuration: requested.value,
    }),
    [
      ...requested.diagnostics,
      ...applied.diagnostics,
      // The two things `init` cannot do for this project, said here rather than met one at a time.
      //
      // Both are content, and content is the consumer's. The first catalog is their words; the
      // recovery message is the sentence a visitor reads when the translations cannot be loaded.
      // Atlas writing either would be Atlas's words sitting in someone else's product, so neither
      // is scaffolded, and what `init` owes instead is to name them.
      //
      // The recovery message is here because it is the one nobody expects. `ATL1702` already names
      // the first catalog at the next `generate`; nothing named the recovery message until
      // `ATL1310` refused a build that was otherwise finished, by which time the reader has already
      // composed `provideLocalization` believing every feature optional. It is not optional for an
      // owner that composes the application runtime, and the honest time to say so is before the
      // composing rather than after it.
      atlasDiagnostic(
        'ATL1706',
        `Atlas init is done. Two things are yours to write: the first catalog at i18n/<scope>/${requested.value.sourceLocale}.yaml, for example i18n/shell/${requested.value.sourceLocale}.yaml, and a recovery message. One plain message passed to provideLocalization through withRecoveryMessage, which is what a visitor reads if the translations cannot be loaded.`,
        { severity: 'info' },
      ),
    ],
  );
}

/**
 * Removes Atlas from a project: the generated output, the configuration, and the package scripts.
 *
 * Takes the project to work on, whether to write, and whether to take the authored catalogs with
 * it; with no options it uninstalls the project found from the current directory and leaves the
 * catalogs alone. Reports what it removed and what it left, or the diagnostics that stopped it.
 *
 * `clean` means "remove build output" everywhere else in the ecosystem (`cargo clean`,
 * `make clean`, `ng cache clean` all leave project configuration alone) so it keeps that
 * meaning, and this is a separate command rather than a flag on it. A flag that turns "remove
 * build output" into "remove the tool" is one that eventually runs in a pipeline by accident.
 *
 * Authored catalogs are the consumer's content and stay unless removal is asked for by name.
 * Deleting a project's translations as a side effect of uninstalling a tool would be
 * indefensible.
 *
 * Only what Atlas wrote is taken back. A `#i18n` specifier a consumer has repointed, or a script
 * they have edited, is theirs now: it is left exactly as it is and named in the result, because
 * silently reverting an edit is the same class of mistake as silently deleting a comment.
 */
export async function uninstallAtlasProject(
  options: AtlasUninstallProjectOptions = {},
): Promise<AtlasResult<AtlasUninstallProjectResult>> {
  const location = await discoverAtlasProject(options);
  if (!location.ok) return location;
  const dryRun = options.dryRun === true;

  // Read while the project can still be loaded. Everything below removes the configuration that
  // makes loading possible, so asking afterwards would find nothing and quietly remove nothing.
  const authoredCatalogs =
    options.catalogs === true ? await loadAtlasProject(options) : undefined;
  if (authoredCatalogs !== undefined && !authoredCatalogs.ok) {
    return authoredCatalogs;
  }

  const cleaned = await cleanAtlasOutput({
    ownerRoot: location.value.ownerRoot,
    generatedRoot: location.value.generatedRoot,
    workRoot: location.value.workRoot,
    dryRun,
  });
  if (!cleaned.ok) return cleaned;

  const manifest = await readPackageManifest(location.value);
  if (!manifest.ok) return manifest;
  const retained: string[] = [];
  const mutable = JSON.parse(JSON.stringify(manifest.value.value)) as Record<
    string,
    unknown
  >;

  const imports = mutable['imports'];
  if (
    typeof imports === 'object' &&
    imports !== null &&
    !Array.isArray(imports)
  ) {
    const entries = imports as Record<string, unknown>;
    for (const [specifier, target] of Object.entries(
      packageImports(location.value.generatedRootPath),
    )) {
      if (!(specifier in entries)) continue;
      if (entries[specifier] === target) delete entries[specifier];
      else retained.push(`imports.${specifier}`);
    }
    // `init` creates this key when an owner has none. Leaving `"imports": {}` behind would leave
    // a trace of a tool that is supposed to be gone.
    if (Object.keys(entries).length === 0) delete mutable['imports'];
  }

  const scripts = mutable['scripts'];
  if (
    typeof scripts === 'object' &&
    scripts !== null &&
    !Array.isArray(scripts)
  ) {
    const entries = scripts as Record<string, unknown>;
    for (const [name, command] of Object.entries(ATLAS_PACKAGE_SCRIPTS)) {
      if (!(name in entries)) continue;
      if (entries[name] === command) delete entries[name];
      else retained.push(`scripts.${name}`);
    }
    if (Object.keys(entries).length === 0) delete mutable['scripts'];
  }

  const packageContents = `${JSON.stringify(mutable, null, 2)}\n`;
  const changes: TextFileChange[] = [];
  if (packageContents !== manifest.value.source) {
    changes.push({
      absolutePath: location.value.packagePath,
      portablePath: 'package.json',
      previous: manifest.value.source,
      contents: packageContents,
    });
  }
  const applied = await applyTextChanges(
    location.value.ownerRoot,
    changes,
    dryRun,
  );
  if (!applied.ok) return applied;

  const removed = [...cleaned.value.removed, ...applied.value.files];
  if (await pathExists(location.value.configurationPath)) {
    removed.push(CONFIGURATION_NAME);
    if (!dryRun) await rm(location.value.configurationPath, { force: true });
  }

  let catalogs: readonly string[] = [];
  if (authoredCatalogs?.ok === true) {
    const files = authoredCatalogs.value.catalogFiles;
    if (!dryRun) {
      for (const file of files) await rm(file.absolutePath, { force: true });
    }
    catalogs = Object.freeze(
      files.map((file) => file.portablePath).sort(compareCodePoint),
    );
    removed.push(...catalogs);
  }

  return atlasSuccess(
    Object.freeze({
      changed: removed.length > 0,
      removed: Object.freeze([...new Set(removed)].sort(compareCodePoint)),
      retained: Object.freeze([...retained].sort(compareCodePoint)),
      catalogs,
    }),
    [...cleaned.diagnostics, ...applied.diagnostics],
  );
}

/**
 * Removes a project's generated output and leaves everything else alone.
 *
 * The configuration, the authored catalogs and the package scripts stay, which is what `clean`
 * means everywhere else. Removing Atlas itself is `uninstallAtlasProject`, a separate call rather
 * than a flag on this one, because a flag that turns "remove build output" into "remove the tool"
 * eventually runs in a pipeline by accident.
 *
 * Takes the project to work on and whether to delete; with no options it cleans the project found
 * from the current directory. Reports what it removed, or the diagnostics that stopped it.
 */
export async function cleanAtlasProject(
  options: AtlasCleanProjectOptions = {},
): Promise<AtlasResult<AtlasCleanOutputResult>> {
  const location = await discoverAtlasProject(options);
  if (!location.ok) return location;
  return cleanAtlasOutput({
    ownerRoot: location.value.ownerRoot,
    generatedRoot: location.value.generatedRoot,
    workRoot: location.value.workRoot,
    dryRun: options.dryRun === true,
  });
}

function watchIgnored(
  ownerRoot: string,
  fileName: string | Buffer | null,
): boolean {
  if (fileName === null) return false;
  const path = fileName.toString().replaceAll('\\', '/');
  return (
    path === '.atlas' ||
    path.startsWith('.atlas/') ||
    path === GENERATED_ROOT ||
    path.startsWith(`${GENERATED_ROOT}/`) ||
    path === 'dist' ||
    path.startsWith('dist/') ||
    path === 'node_modules' ||
    path.startsWith('node_modules/') ||
    !containedPath(resolve(ownerRoot, ...path.split('/')), ownerRoot)
  );
}

/**
 * Watching an owner, without becoming something that has to be installed.
 *
 * `specs/10-compiler-and-tooling.spec.md` section 13 makes this an explicit foreground process
 * with no daemon, account, service or install hook behind it, and treats filesystem events as
 * hints: startup reconciles fully, content is reread, and an uncertain or overflowed event
 * widens back to a full bounded reconciliation rather than trusting what the platform reported.
 */
export async function watchAtlasProject(
  options: AtlasWatchProjectOptions,
): Promise<AtlasResult<AtlasWatchProjectResult>> {
  const location = await discoverAtlasProject(options);
  if (!location.ok) return location;
  const debounce = Math.max(
    10,
    Math.min(options.debounceMilliseconds ?? 75, 2000),
  );
  let cycles = 0;
  let running = false;
  // Raised and lowered inside the cycle below, which is an assignment the compiler cannot order
  // against a plain read of the variable.
  const isRunning = (): boolean => running;
  let pending = false;
  let stopping = false;
  let watcherError: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  const stop = (): void => {
    stopping = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    watcher?.close();
    watcher = undefined;
    if (!running) resolveDone?.();
  };
  const cycle = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const result = await generateAtlasProject({
        cwd: location.value.ownerRoot,
        project: location.value.ownerRoot,
        ...(options.observability === undefined
          ? {}
          : { observability: options.observability }),
      });
      cycles += 1;
      options.onCycle?.(Object.freeze({ sequence: cycles, result }));
    } catch (error) {
      cycles += 1;
      options.onCycle?.(
        Object.freeze({
          sequence: cycles,
          result: atlasFailure([
            atlasDiagnostic(
              'ATL1703',
              `Atlas watch reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ]),
        }),
      );
    } finally {
      running = false;
      if (stopping || options.signal.aborted) {
        stop();
      } else if (pending) {
        pending = false;
        void cycle();
      }
    }
  };
  try {
    watcher = watchFileSystem(
      location.value.ownerRoot,
      { recursive: true },
      (_event, fileName) => {
        if (watchIgnored(location.value.ownerRoot, fileName)) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void cycle();
        }, debounce);
      },
    );
    watcher.on('error', (error) => {
      watcherError = error;
      stop();
    });
  } catch (error) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1703',
        `Atlas could not start its foreground watcher: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ]);
  }
  options.signal.addEventListener('abort', stop, { once: true });
  await cycle();
  if (options.signal.aborted && !isRunning()) stop();
  await done;
  if (watcherError !== undefined) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1703',
        `Atlas foreground watcher failed: ${watcherError.message}`,
      ),
    ]);
  }
  return atlasSuccess(Object.freeze({ cycles }));
}

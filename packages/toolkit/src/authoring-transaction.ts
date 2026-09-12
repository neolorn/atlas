import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from 'jsonc-parser';

import {
  digestAtlasCanonicalJson,
  stringifyAtlasCanonicalJson,
  type AtlasCanonicalJsonValue,
} from './canonical-json.js';
import {
  atlasDiagnostic,
  atlasFailure,
  atlasSourceSpan,
  atlasSuccess,
  type AtlasResult,
} from './diagnostics.js';
import { digestAtlasBytes } from './output-plan.js';
import {
  ATLAS_TOOLKIT_EVENT_CODES,
  emitAtlasToolkitEvent,
  type AtlasToolkitObservabilityOptions,
} from './observability.js';
import { ATLAS_RESOURCE_LIMITS } from './resource-limits.js';
import { compareCodePoint } from './sorted-records.js';
import { constructJsonValue, duplicateJsonKeys } from './json-tree.js';

/**
 * Whether a plan rewrites authored files by a team's own decision, or to move between versions.
 *
 * A refactor is a rename or a reorganization somebody asked for. A migration moves a project from
 * one version of a format to another. They are applied the same way and recorded apart, so a
 * history says which changes were the team's and which were Atlas's.
 */
export type AtlasAuthoredChangeKind = 'refactor' | 'migration';

/**
 * One file a plan means to change, as it is written down.
 *
 * Both texts are optional, and which are present says what the change is: no `before` creates the
 * file, no `after` deletes it, and both replace it.
 */
export interface AtlasAuthoredFileChangeInput {
  /** Which file, as a path relative to the project root. */
  readonly path: string;
  /** What the file must hold for the change to apply. Absent when the file is being created. */
  readonly before?: string;
  /** What it is to hold afterwards. Absent when the file is being deleted. */
  readonly after?: string;
}

/**
 * One file change with digests of both texts, which is how a plan refuses to apply to the wrong
 * tree.
 *
 * Applying checks the digest rather than the text, so a plan made against a file somebody has since
 * edited is refused rather than overwriting their work.
 */
export interface AtlasAuthoredFileChange extends AtlasAuthoredFileChangeInput {
  /** A digest of the expected content. Absent when the file is being created. */
  readonly beforeDigest?: string;
  /** A digest of the intended content. Absent when the file is being deleted. */
  readonly afterDigest?: string;
}

/**
 * A set of edits to a project's authored files, written down before any of them is made.
 *
 * Producing a change plan and applying it are separate steps on purpose: one can be read, reviewed
 * and committed, and applying it is all or nothing rather than a rewrite that stopped halfway.
 */
export interface AtlasAuthoredChangePlan {
  /** The version stamp of the change-plan shape. */
  readonly profile: 'atlas-authored-change-plan/1';
  /** What this change is, as a stable name a history can be indexed by. */
  readonly id: string;
  /** Whether this is a team's own change or a move between versions. */
  readonly kind: AtlasAuthoredChangeKind;
  /** The files to change, sorted by path. */
  readonly changes: readonly AtlasAuthoredFileChange[];
  /** Whether the generated tree has to be rebuilt afterwards. */
  readonly regenerate: boolean;
  /** A digest of the whole plan, recorded when it is applied so it is not applied twice. */
  readonly digest: string;
}

export interface AtlasAuthoredChangePlanParseOptions {
  readonly sourcePath?: string;
  readonly kind?: AtlasAuthoredChangeKind;
}

/**
 * What to build a migration plan out of: what is moving, between which versions, and what changes.
 *
 * For a tool that knows how to bring a project forward and wants the move recorded the same way
 * every other authored change is.
 */
export interface AtlasMigrationPlanRequest {
  /** What this migration is called, which becomes part of the change plan's identity. */
  readonly id: string;
  /** Which part of the project is moving. */
  readonly domain:
    | 'configuration'
    | 'schema'
    | 'catalog'
    | 'durable-protocol'
    | 'authored-data';
  /** The version being left. Must differ from the one being moved to. */
  readonly fromVersion: string;
  /** The version being moved to. */
  readonly toVersion: string;
  /** The files to change. */
  readonly changes: readonly AtlasAuthoredFileChangeInput[];
}

export interface AtlasApplyAuthoredPlanOptions extends AtlasToolkitObservabilityOptions {
  readonly ownerRoot: string;
  readonly plan: AtlasAuthoredChangePlan;
  readonly dryRun?: boolean;
}

export interface AtlasApplyAuthoredPlanResult {
  readonly changed: boolean;
  readonly files: readonly string[];
  readonly planDigest: string;
}

function validPortablePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 2048 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.includes('\u0000') &&
    path.normalize('NFC') === path &&
    !path
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  );
}

function jsonTreeWithinLimits(root: JsonNode): boolean {
  const pending: Array<{ readonly node: JsonNode; readonly depth: number }> = [
    { node: root, depth: 1 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (
      nodes > ATLAS_RESOURCE_LIMITS.jsonNodes ||
      current.depth > ATLAS_RESOURCE_LIMITS.jsonDepth
    ) {
      return false;
    }
    for (const child of current.node.children ?? []) {
      pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort(compareCodePoint);
  const sortedExpected = [...expected].sort(compareCodePoint);
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256-[A-Za-z0-9_-]{43}$/u.test(value);
}

function invalidPlan(summary: string): AtlasResult<AtlasAuthoredChangePlan> {
  return atlasFailure([atlasDiagnostic('ATL1805', summary)]);
}

function reconstructAtlasAuthoredChangePlan(
  value: unknown,
  expectedKind?: AtlasAuthoredChangeKind,
): AtlasResult<AtlasAuthoredChangePlan> {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'profile',
      'id',
      'kind',
      'changes',
      'regenerate',
      'digest',
    ]) ||
    value['profile'] !== 'atlas-authored-change-plan/1' ||
    typeof value['id'] !== 'string' ||
    (value['kind'] !== 'refactor' && value['kind'] !== 'migration') ||
    (expectedKind !== undefined && value['kind'] !== expectedKind) ||
    !Array.isArray(value['changes']) ||
    value['changes'].length > ATLAS_RESOURCE_LIMITS.authoredChangePlanChanges ||
    value['regenerate'] !== true ||
    !validDigest(value['digest'])
  ) {
    return invalidPlan(
      expectedKind === undefined
        ? 'Atlas authored change plan must exactly match atlas-authored-change-plan/1.'
        : `Atlas authored change plan must exactly match atlas-authored-change-plan/1 with kind ${JSON.stringify(expectedKind)}.`,
    );
  }
  const changes: AtlasAuthoredFileChangeInput[] = [];
  for (const rawChange of value['changes']) {
    if (!isRecord(rawChange)) {
      return invalidPlan(
        'Atlas authored change plan contains an invalid file operation.',
      );
    }
    const hasBefore = Object.hasOwn(rawChange, 'before');
    const hasBeforeDigest = Object.hasOwn(rawChange, 'beforeDigest');
    const hasAfter = Object.hasOwn(rawChange, 'after');
    const hasAfterDigest = Object.hasOwn(rawChange, 'afterDigest');
    const keys = [
      'path',
      ...(hasBefore ? ['before', 'beforeDigest'] : []),
      ...(hasAfter ? ['after', 'afterDigest'] : []),
    ];
    if (
      !exactKeys(rawChange, keys) ||
      typeof rawChange['path'] !== 'string' ||
      hasBefore !== hasBeforeDigest ||
      hasAfter !== hasAfterDigest ||
      (!hasBefore && !hasAfter) ||
      (hasBefore &&
        (typeof rawChange['before'] !== 'string' ||
          !validDigest(rawChange['beforeDigest']))) ||
      (hasAfter &&
        (typeof rawChange['after'] !== 'string' ||
          !validDigest(rawChange['afterDigest'])))
    ) {
      return invalidPlan(
        'Atlas authored change plan contains an invalid file operation.',
      );
    }
    changes.push(
      Object.freeze({
        path: rawChange['path'],
        ...(hasBefore ? { before: rawChange['before'] as string } : {}),
        ...(hasAfter ? { after: rawChange['after'] as string } : {}),
      }),
    );
  }
  const reconstructed = createAtlasAuthoredChangePlan(
    value['id'],
    value['kind'],
    changes,
  );
  if (!reconstructed.ok) return reconstructed;
  try {
    if (
      stringifyAtlasCanonicalJson(value as AtlasCanonicalJsonValue) !==
      stringifyAtlasCanonicalJson(
        reconstructed.value as unknown as AtlasCanonicalJsonValue,
      )
    ) {
      return invalidPlan(
        'Atlas authored change plan content or digest does not match its reconstructed plan.',
      );
    }
  } catch {
    return invalidPlan(
      'Atlas authored change plan contains invalid Unicode or noncanonical content.',
    );
  }
  return reconstructed;
}

export function parseAtlasAuthoredChangePlan(
  source: string,
  options: AtlasAuthoredChangePlanParseOptions = {},
): AtlasResult<AtlasAuthoredChangePlan> {
  if (
    Buffer.byteLength(source, 'utf8') >
    ATLAS_RESOURCE_LIMITS.authoredChangePlanBytes
  ) {
    return invalidPlan(
      `Atlas authored change plan exceeds the ${ATLAS_RESOURCE_LIMITS.authoredChangePlanBytes}-byte implementation ceiling.`,
    );
  }
  const parseErrors: ParseError[] = [];
  const root = parseTree(source, parseErrors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (parseErrors.length > 0 || root === undefined) {
    const diagnostics = parseErrors.map((error) =>
      atlasDiagnostic(
        'ATL1805',
        `Atlas authored change plan contains invalid JSON: ${printParseErrorCode(error.error)}.`,
        {
          span: atlasSourceSpan(
            source,
            error.offset,
            Math.max(1, error.length),
            options.sourcePath,
          ),
        },
      ),
    );
    if (diagnostics.length === 0) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1805',
          'Atlas authored change plan must contain one JSON value.',
        ),
      );
    }
    return atlasFailure(diagnostics);
  }
  if (!jsonTreeWithinLimits(root)) {
    return invalidPlan(
      `Atlas authored change plan exceeds the ${ATLAS_RESOURCE_LIMITS.jsonDepth}-depth or ${ATLAS_RESOURCE_LIMITS.jsonNodes}-node JSON implementation ceiling.`,
    );
  }
  const duplicates = duplicateJsonKeys(source, root, options.sourcePath, {
    code: 'ATL1805',
    summary: (key) =>
      `Atlas authored change plan contains the duplicate key ${JSON.stringify(key)}.`,
  });
  if (duplicates.length > 0) return atlasFailure(duplicates);
  return reconstructAtlasAuthoredChangePlan(
    constructJsonValue(root),
    options.kind,
  );
}

export function createAtlasAuthoredChangePlan(
  id: string,
  kind: AtlasAuthoredChangeKind,
  changes: readonly AtlasAuthoredFileChangeInput[],
): AtlasResult<AtlasAuthoredChangePlan> {
  if (changes.length > ATLAS_RESOURCE_LIMITS.authoredChangePlanChanges) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1805',
        `Authored change plan exceeds the ${ATLAS_RESOURCE_LIMITS.authoredChangePlanChanges}-operation implementation ceiling.`,
      ),
    ]);
  }
  if (!/^[a-z0-9][a-z0-9._/-]{0,127}$/u.test(id)) {
    return atlasFailure([
      atlasDiagnostic('ATL1805', 'Authored change plan identity is invalid.'),
    ]);
  }
  const normalized: AtlasAuthoredFileChange[] = [];
  const paths = new Set<string>();
  for (const change of changes) {
    try {
      if (change.before !== undefined)
        stringifyAtlasCanonicalJson(change.before);
      if (change.after !== undefined) stringifyAtlasCanonicalJson(change.after);
    } catch {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1805',
          'Authored change plan contains invalid Unicode file content.',
        ),
      ]);
    }
    if (
      !validPortablePath(change.path) ||
      paths.has(change.path) ||
      change.before === change.after ||
      (change.before === undefined && change.after === undefined)
    ) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1805',
          'Authored change plan contains an invalid, duplicate, or unchanged file operation.',
        ),
      ]);
    }
    paths.add(change.path);
    normalized.push(
      Object.freeze({
        path: change.path,
        ...(change.before === undefined
          ? {}
          : {
              before: change.before,
              beforeDigest: digestAtlasBytes(change.before),
            }),
        ...(change.after === undefined
          ? {}
          : {
              after: change.after,
              afterDigest: digestAtlasBytes(change.after),
            }),
      }),
    );
  }
  normalized.sort((left, right) => compareCodePoint(left.path, right.path));
  const digest = digestAtlasCanonicalJson('atlas-authored-change-plan/1', {
    id,
    kind,
    changes: normalized.map(({ path, beforeDigest, afterDigest }) => ({
      path,
      ...(beforeDigest === undefined ? {} : { beforeDigest }),
      ...(afterDigest === undefined ? {} : { afterDigest }),
    })),
  });
  const plan = Object.freeze({
    profile: 'atlas-authored-change-plan/1' as const,
    id,
    kind,
    changes: Object.freeze(normalized),
    regenerate: true as const,
    digest,
  });
  if (
    Buffer.byteLength(JSON.stringify(plan), 'utf8') >
    ATLAS_RESOURCE_LIMITS.authoredChangePlanBytes
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1805',
        `Authored change plan exceeds the ${ATLAS_RESOURCE_LIMITS.authoredChangePlanBytes}-byte implementation ceiling.`,
      ),
    ]);
  }
  return atlasSuccess(plan);
}

/**
 * Builds a migration plan from a set of file changes, and writes nothing.
 *
 * Digests each file's expected and intended content, sorts the changes, and names the result after
 * the domain, the two versions and the request's own identity. Returns a change plan, or the reasons it
 * could not be built.
 *
 * Fails for versions that are not bounded identifiers or are the same as each other, and for a
 * change set that is malformed or exceeds the ceilings. Applying a change plan is a separate step.
 */
export function createAtlasMigrationPlan(
  request: AtlasMigrationPlanRequest,
): AtlasResult<AtlasAuthoredChangePlan> {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(request.fromVersion) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(request.toVersion) ||
    request.fromVersion === request.toVersion
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1805',
        'Migration versions must be distinct bounded protocol identifiers.',
      ),
    ]);
  }
  return createAtlasAuthoredChangePlan(
    `${request.domain}/${request.fromVersion}-to-${request.toVersion}/${request.id}`,
    'migration',
    request.changes,
  );
}

function contained(ownerRoot: string, candidate: string): boolean {
  const path = relative(ownerRoot, candidate);
  return (
    path === '' ||
    (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function pathMetadata(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return undefined;
    }
    throw error;
  }
}

async function assertUnlinkedPath(
  ownerRoot: string,
  path: string,
): Promise<void> {
  if (!contained(ownerRoot, path))
    throw new TypeError('Authored path escapes its owner.');
  const relativePath = relative(ownerRoot, path);
  let cursor = ownerRoot;
  for (const segment of relativePath.split(sep)) {
    cursor = resolve(cursor, segment);
    const metadata = await pathMetadata(cursor);
    if (metadata?.isSymbolicLink()) {
      throw new TypeError(
        'Authored transactions refuse symbolic links and reparse aliases.',
      );
    }
  }
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  const handle = await open(path, 'wx');
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface PublicationOperation {
  readonly change: AtlasAuthoredFileChange;
  readonly destination: string;
  readonly temporary?: string;
  readonly backup: string;
  published: boolean;
  backedUp: boolean;
}

async function applyAtlasAuthoredChangePlanCore(
  options: AtlasApplyAuthoredPlanOptions,
): Promise<AtlasResult<AtlasApplyAuthoredPlanResult>> {
  const admitted = reconstructAtlasAuthoredChangePlan(options.plan);
  if (!admitted.ok) return admitted;
  const plan = admitted.value;
  const ownerRoot = resolve(options.ownerRoot);
  const ownerMetadata = await pathMetadata(ownerRoot);
  if (
    ownerMetadata === undefined ||
    !ownerMetadata.isDirectory() ||
    ownerMetadata.isSymbolicLink()
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1602',
        'Authored transaction owner must be an ordinary directory.',
      ),
    ]);
  }
  const pending: Array<{
    readonly change: AtlasAuthoredFileChange;
    readonly destination: string;
  }> = [];
  try {
    for (const change of plan.changes) {
      if (!validPortablePath(change.path))
        throw new TypeError('Plan path is invalid.');
      const destination = resolve(ownerRoot, ...change.path.split('/'));
      await assertUnlinkedPath(ownerRoot, destination);
      const metadata = await pathMetadata(destination);
      if (
        metadata !== undefined &&
        (!metadata.isFile() || metadata.isSymbolicLink())
      ) {
        throw new TypeError(
          'Authored transaction target is not an ordinary file.',
        );
      }
      const current =
        metadata === undefined
          ? undefined
          : await readFile(destination, 'utf8');
      if (current === change.after) continue;
      if (current !== change.before) {
        throw new TypeError(
          `Authored input ${change.path} changed after preview.`,
        );
      }
      pending.push({ change, destination });
    }
  } catch (error) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1602',
        `Atlas refused the authored transaction before mutation: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ]);
  }
  if (options.dryRun === true || pending.length === 0) {
    return atlasSuccess(
      Object.freeze({
        changed: pending.length > 0,
        files: Object.freeze(pending.map(({ change }) => change.path)),
        planDigest: plan.digest,
      }),
    );
  }

  const lockPath = resolve(ownerRoot, '.atlas-authoring.lock');
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  const transactionId = randomBytes(12).toString('hex');
  const operations: PublicationOperation[] = [];
  try {
    lockHandle = await open(lockPath, 'wx');
    for (const item of pending) {
      await mkdir(dirname(item.destination), { recursive: true });
      await assertUnlinkedPath(ownerRoot, item.destination);
      const suffix = `.atlas-${transactionId}`;
      const temporary =
        item.change.after === undefined
          ? undefined
          : `${item.destination}${suffix}.tmp`;
      const backup = `${item.destination}${suffix}.bak`;
      if (temporary !== undefined)
        await writeExclusive(temporary, item.change.after as string);
      operations.push({
        change: item.change,
        destination: item.destination,
        ...(temporary === undefined ? {} : { temporary }),
        backup,
        published: false,
        backedUp: false,
      });
    }
    for (const operation of operations) {
      if (operation.change.before !== undefined) {
        await rename(operation.destination, operation.backup);
        operation.backedUp = true;
      }
      if (operation.temporary !== undefined) {
        await rename(operation.temporary, operation.destination);
      }
      operation.published = true;
    }
    for (const operation of operations) {
      if (operation.backedUp) await unlink(operation.backup);
    }
    return atlasSuccess(
      Object.freeze({
        changed: true,
        files: Object.freeze(pending.map(({ change }) => change.path)),
        planDigest: plan.digest,
      }),
    );
  } catch (error) {
    let recovered = true;
    for (const operation of [...operations].reverse()) {
      try {
        if (operation.published && operation.temporary !== undefined) {
          await rm(operation.destination, { force: true });
        }
        if (
          operation.backedUp &&
          (await pathMetadata(operation.backup)) !== undefined
        ) {
          await rename(operation.backup, operation.destination);
        }
        if (operation.temporary !== undefined)
          await rm(operation.temporary, { force: true });
      } catch {
        recovered = false;
      }
    }
    return atlasFailure([
      atlasDiagnostic(
        'ATL1602',
        recovered
          ? `Atlas authored transaction failed and restored its prior complete state: ${error instanceof Error ? error.message : String(error)}`
          : 'Atlas authored transaction failed and automatic recovery could not be completed safely.',
      ),
    ]);
  } finally {
    if (lockHandle !== undefined) {
      await lockHandle.close();
      await rm(lockPath, { force: true });
    }
  }
}

export async function applyAtlasAuthoredChangePlan(
  options: AtlasApplyAuthoredPlanOptions,
): Promise<AtlasResult<AtlasApplyAuthoredPlanResult>> {
  const sink = options.observability;
  if (sink === undefined) return applyAtlasAuthoredChangePlanCore(options);
  emitAtlasToolkitEvent(sink, {
    code: ATLAS_TOOLKIT_EVENT_CODES.migration,
    phase: 'migration',
    status: 'started',
  });
  let result: AtlasResult<AtlasApplyAuthoredPlanResult>;
  try {
    result = await applyAtlasAuthoredChangePlanCore(options);
  } catch (error) {
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.migration,
      phase: 'migration',
      status: 'failed',
    });
    throw error;
  }
  if (result.ok) {
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.migration,
      phase: 'migration',
      status: result.value.changed ? 'succeeded' : 'unchanged',
      count: result.value.files.length,
    });
  } else {
    const diagnosticCode = result.diagnostics[0]?.code;
    emitAtlasToolkitEvent(sink, {
      code: ATLAS_TOOLKIT_EVENT_CODES.migration,
      phase: 'migration',
      status: 'failed',
      ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
    });
  }
  return result;
}

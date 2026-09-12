import { createHash } from 'node:crypto';

import {
  digestAtlasCanonicalJson,
  type AtlasCanonicalJsonValue,
} from './canonical-json.js';
import {
  atlasDiagnostic,
  atlasFailure,
  atlasSuccess,
  type AtlasDiagnostic,
  type AtlasResult,
} from './diagnostics.js';
import { compareCodePoint } from './sorted-records.js';

/** The version stamp on an output plan, checked before one is compared against a manifest. */
export const ATLAS_OUTPUT_PLAN_PROFILE = 'atlas-output-plan/1' as const;
export const ATLAS_COMPLETION_MANIFEST_PROFILE =
  'atlas-completion-manifest/1' as const;
/**
 * The manifest Atlas writes into the generated root when generation completes, relative to it.
 *
 * It is the record of exactly which files Atlas produced and what each one contained, and it is
 * what makes both `inspectAtlasOutputFreshness` and safe cleanup possible: with it, "is this
 * output current" and "is this file mine to delete" are lookups rather than inferences from a
 * naming convention. Published for the same reason the ownership marker is: a consumer writing
 * its own cleanup or CI freshness step needs to be able to find and read it, and a path hardcoded
 * in that script is a copy of an Atlas decision that will not be told when it changes.
 *
 * Its presence is also the signal that a generation finished. A generated root without it is a
 * generation that was interrupted, which is why cleanup treats those two cases differently.
 */
export const ATLAS_COMPLETION_MANIFEST_PATH = '.atlas-manifest.json' as const;

/** One file a compilation means to produce, before it is measured. */
export interface AtlasOutputFileInput {
  /** Where it goes, as a path relative to the generated root. */
  readonly path: string;
  /** What it holds. */
  readonly contents: string;
}

/**
 * One file in a plan, with its size and a digest of its content.
 *
 * The digest is what lets writing skip a file whose content has not changed, which is what keeps
 * an unchanged build from touching every timestamp in the generated tree.
 */
export interface AtlasPlannedOutputFile extends AtlasOutputFileInput {
  /** How large it is, once encoded. */
  readonly bytes: number;
  /** A digest of its content. */
  readonly digest: string;
}

/**
 * Every file a compilation would write, worked out before anything is written.
 *
 * Writing is a separate step, so a caller can see the whole of what a build intends and decide.
 * Applying it is transactional: either the tree ends up matching it in full or it is left as it was.
 */
export interface AtlasOutputPlan {
  /** The version stamp of the output-plan shape. */
  readonly profile: typeof ATLAS_OUTPUT_PLAN_PROFILE;
  /** A digest of the whole plan, recorded on completion so freshness is a lookup rather than a guess. */
  readonly planDigest: string;
  /** The files, sorted by path. */
  readonly files: readonly AtlasPlannedOutputFile[];
}

export interface AtlasCompletionManifestFile {
  readonly path: string;
  readonly bytes: number;
  readonly digest: string;
}

export interface AtlasCompletionManifest {
  readonly profile: typeof ATLAS_COMPLETION_MANIFEST_PROFILE;
  readonly ownerId: string;
  readonly planDigest: string;
  readonly files: readonly AtlasCompletionManifestFile[];
}

const windowsReservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

/**
 * The content digest Atlas records for a generated file, as `sha256-<base64url>`.
 *
 * Published so a consumer can compute the same value Atlas stores in the completion manifest and
 * compare the two itself: checking a file against its recorded digest without this means
 * reimplementing the hash, the encoding and the prefix, and any of the three getting it wrong
 * produces a mismatch that looks like a stale file.
 *
 * `base64url` rather than hex, so a digest is safe in a filename or a URL without escaping, and the
 * `sha256-` prefix so the algorithm travels with the value: a bare hash in a stored manifest is one
 * whose algorithm cannot be changed later without silently reinterpreting every old record. Both
 * are required by `specs/01-standards-profile.spec.md` section 13, so every fingerprint Atlas
 * writes reads the same way. Recording it in the manifest rather than inside the file it covers is
 * `specs/05-compiled-artifacts-and-trust.spec.md` section 3, because writing it into the file
 * would change the bytes it covers.
 */
export function digestAtlasBytes(contents: string | Uint8Array): string {
  return `sha256-${createHash('sha256').update(contents).digest('base64url')}`;
}

function validateOutputPath(path: string): string | undefined {
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.includes('\\') ||
    path.includes('\u0000') ||
    /^[a-z]:/iu.test(path)
  ) {
    return 'must be a nonempty relative forward-slash path';
  }
  const segments = path.split('/');
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      segment.normalize('NFC') !== segment ||
      windowsReservedName.test(segment)
    ) {
      return `contains unsafe segment ${JSON.stringify(segment)}`;
    }
  }
  return undefined;
}

function planFileJson(file: AtlasPlannedOutputFile): AtlasCanonicalJsonValue {
  return { path: file.path, bytes: file.bytes, digest: file.digest };
}

export function createAtlasOutputPlan(
  inputs: readonly AtlasOutputFileInput[],
): AtlasResult<AtlasOutputPlan> {
  const diagnostics: AtlasDiagnostic[] = [];
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  const files: AtlasPlannedOutputFile[] = [];
  for (const input of inputs) {
    const pathError = validateOutputPath(input.path);
    if (pathError !== undefined) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1503',
          `Generated output path ${JSON.stringify(input.path)} ${pathError}.`,
          { path: ['outputs', input.path] },
        ),
      );
      continue;
    }
    if (input.path === ATLAS_COMPLETION_MANIFEST_PATH) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1503',
          `Generated output cannot replace the reserved completion marker ${ATLAS_COMPLETION_MANIFEST_PATH}.`,
          { path: ['outputs', input.path] },
        ),
      );
      continue;
    }
    const caseFolded = input.path.toLocaleLowerCase('en-US');
    const existing = folded.get(caseFolded);
    if (exact.has(input.path) || existing !== undefined) {
      diagnostics.push(
        atlasDiagnostic(
          'ATL1503',
          `Generated output path ${JSON.stringify(input.path)} collides with ${JSON.stringify(existing ?? input.path)}.`,
          { path: ['outputs', input.path] },
        ),
      );
      continue;
    }
    exact.add(input.path);
    folded.set(caseFolded, input.path);
    files.push(
      Object.freeze({
        path: input.path,
        contents: input.contents,
        bytes: Buffer.byteLength(input.contents, 'utf8'),
        digest: digestAtlasBytes(input.contents),
      }),
    );
  }
  if (diagnostics.length > 0) return atlasFailure(diagnostics);
  files.sort((left, right) => compareCodePoint(left.path, right.path));
  const planDigest = digestAtlasCanonicalJson(
    'atlas-output-plan/1',
    files.map(planFileJson),
  );
  return atlasSuccess(
    Object.freeze({
      profile: ATLAS_OUTPUT_PLAN_PROFILE,
      planDigest,
      files: Object.freeze(files),
    }),
  );
}

export function createAtlasCompletionManifest(
  ownerId: string,
  plan: AtlasOutputPlan,
): AtlasCompletionManifest {
  if (!/^sha256-[A-Za-z0-9_-]{43}$/u.test(ownerId)) {
    throw new TypeError(
      'Atlas output owner identity must be a full SHA-256 fingerprint.',
    );
  }
  return Object.freeze({
    profile: ATLAS_COMPLETION_MANIFEST_PROFILE,
    ownerId,
    planDigest: plan.planDigest,
    files: Object.freeze(
      plan.files.map((file) =>
        Object.freeze({
          path: file.path,
          bytes: file.bytes,
          digest: file.digest,
        }),
      ),
    ),
  });
}

export function formatAtlasCompletionManifest(
  manifest: AtlasCompletionManifest,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function parseAtlasCompletionManifest(
  source: string,
): AtlasResult<AtlasCompletionManifest> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1503',
        'Atlas completion manifest is not valid JSON.',
      ),
    ]);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1503',
        'Atlas completion manifest must be an object.',
      ),
    ]);
  }
  const record = value as Record<string, unknown>;
  const files = record['files'];
  if (
    Object.keys(record).sort().join(',') !==
      'files,ownerId,planDigest,profile' ||
    record['profile'] !== ATLAS_COMPLETION_MANIFEST_PROFILE ||
    typeof record['ownerId'] !== 'string' ||
    !/^sha256-[A-Za-z0-9_-]{43}$/u.test(record['ownerId']) ||
    typeof record['planDigest'] !== 'string' ||
    !/^sha256-[A-Za-z0-9_-]{43}$/u.test(record['planDigest']) ||
    !Array.isArray(files)
  ) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1503',
        'Atlas completion manifest header is invalid.',
      ),
    ]);
  }
  const parsedFiles: AtlasCompletionManifestFile[] = [];
  const seen = new Set<string>();
  for (const item of files) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1503',
          'Atlas completion manifest file entry is invalid.',
        ),
      ]);
    }
    const file = item as Record<string, unknown>;
    if (
      Object.keys(file).sort().join(',') !== 'bytes,digest,path' ||
      typeof file['path'] !== 'string' ||
      validateOutputPath(file['path']) !== undefined ||
      file['path'] === ATLAS_COMPLETION_MANIFEST_PATH ||
      seen.has(file['path']) ||
      typeof file['bytes'] !== 'number' ||
      !Number.isSafeInteger(file['bytes']) ||
      file['bytes'] < 0 ||
      typeof file['digest'] !== 'string' ||
      !/^sha256-[A-Za-z0-9_-]{43}$/u.test(file['digest'])
    ) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1503',
          'Atlas completion manifest file entry is invalid.',
        ),
      ]);
    }
    const foldedPath = file['path'].toLocaleLowerCase('en-US');
    if (
      parsedFiles.some(
        ({ path }) => path.toLocaleLowerCase('en-US') === foldedPath,
      )
    ) {
      return atlasFailure([
        atlasDiagnostic(
          'ATL1503',
          'Atlas completion manifest contains a case-insensitive path collision.',
        ),
      ]);
    }
    seen.add(file['path']);
    parsedFiles.push(
      Object.freeze({
        path: file['path'],
        bytes: file['bytes'],
        digest: file['digest'],
      }),
    );
  }
  parsedFiles.sort((left, right) => compareCodePoint(left.path, right.path));
  const expectedPlanDigest = digestAtlasCanonicalJson(
    'atlas-output-plan/1',
    parsedFiles.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      digest: file.digest,
    })),
  );
  if (expectedPlanDigest !== record['planDigest']) {
    return atlasFailure([
      atlasDiagnostic(
        'ATL1503',
        'Atlas completion manifest plan digest does not match its file inventory.',
      ),
    ]);
  }
  return atlasSuccess(
    Object.freeze({
      profile: ATLAS_COMPLETION_MANIFEST_PROFILE,
      ownerId: record['ownerId'],
      planDigest: record['planDigest'],
      files: Object.freeze(parsedFiles),
    }),
  );
}

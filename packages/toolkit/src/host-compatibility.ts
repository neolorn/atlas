/**
 * The host a consumer actually has, checked before the compiler is asked to do anything.
 *
 * `specs/02-packages-and-platform.spec.md` section 9 requires the toolkit to refuse a host outside
 * the declared ranges with a diagnostic rather than attempt a best-effort compatibility. The
 * check is here rather than in the command layer because every entry into compiler work passes
 * through it, the programmatic API included.
 */
import { VERSION as angularCompilerVersion } from '@angular/compiler';
import ts from 'typescript';

import {
  atlasDiagnostic,
  atlasFailure,
  atlasSuccess,
  type AtlasDiagnostic,
  type AtlasResult,
} from './diagnostics.js';

/**
 * The ranges, written out because this decides at compile time inside a consumer's install and
 * cannot go and read a manifest at that moment.
 *
 * It is the one copy of them that is not the package manifests, which is the exception
 * `specs/02-packages-and-platform.spec.md` section 9 names, and `verify:packages` compares all three
 * values against what the packages declare, so it is a copy that cannot drift silently.
 */
export const ATLAS_HOST_COMPATIBILITY_PROFILE = Object.freeze({
  profile: 'atlas-host-compatibility/1' as const,
  node: '^22.22.3 || ^24.15.0 || ^26.0.0' as const,
  typescript: '>=6.0.2 <6.1.0' as const,
  angularCompiler: '>=22.0.0 <23.0.0' as const,
});

export interface AtlasHostVersions {
  readonly node: string;
  readonly typescript: string;
  readonly angularCompiler: string;
}

export interface AtlasHostCompatibilityAdmission {
  readonly profile: 'atlas-host-compatibility/1';
  readonly versions: AtlasHostVersions;
}

interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

function parseSemanticVersion(value: string): SemanticVersion | undefined {
  const match =
    /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      value,
    );
  if (match === null) return undefined;
  const components = match.slice(1, 4).map(Number);
  if (components.some((component) => !Number.isSafeInteger(component))) {
    return undefined;
  }
  return Object.freeze({
    major: components[0] as number,
    minor: components[1] as number,
    patch: components[2] as number,
    prerelease: match[4] !== undefined,
  });
}

function atLeast(
  version: SemanticVersion,
  major: number,
  minor: number,
  patch: number,
): boolean {
  return (
    version.major > major ||
    (version.major === major &&
      (version.minor > minor ||
        (version.minor === minor && version.patch >= patch)))
  );
}

function supportedNode(version: SemanticVersion): boolean {
  return (
    !version.prerelease &&
    ((version.major === 22 && atLeast(version, 22, 22, 3)) ||
      (version.major === 24 && atLeast(version, 24, 15, 0)) ||
      (version.major === 26 && atLeast(version, 26, 0, 0)))
  );
}

function supportedTypeScript(version: SemanticVersion): boolean {
  return (
    !version.prerelease &&
    version.major === 6 &&
    version.minor === 0 &&
    atLeast(version, 6, 0, 2)
  );
}

function supportedAngularCompiler(version: SemanticVersion): boolean {
  return !version.prerelease && version.major === 22;
}

export function currentAtlasHostVersions(): AtlasHostVersions {
  return Object.freeze({
    node: process.versions.node,
    typescript: ts.version,
    angularCompiler: angularCompilerVersion.full,
  });
}

export function admitAtlasHostCompatibility(
  versions: AtlasHostVersions = currentAtlasHostVersions(),
): AtlasResult<AtlasHostCompatibilityAdmission> {
  const diagnostics: AtlasDiagnostic[] = [];
  const node = parseSemanticVersion(versions.node);
  if (node === undefined || !supportedNode(node)) {
    diagnostics.push(
      atlasDiagnostic(
        'ATL1806',
        `Unsupported Node.js host version ${JSON.stringify(versions.node)}; Atlas requires ${ATLAS_HOST_COMPATIBILITY_PROFILE.node}. Install a supported Node.js version before running Atlas compiler work.`,
        { path: ['host', 'node'] },
      ),
    );
  }
  const typescript = parseSemanticVersion(versions.typescript);
  if (typescript === undefined || !supportedTypeScript(typescript)) {
    diagnostics.push(
      atlasDiagnostic(
        'ATL1806',
        `Unsupported TypeScript host version ${JSON.stringify(versions.typescript)}; Atlas requires ${ATLAS_HOST_COMPATIBILITY_PROFILE.typescript}. Install a supported TypeScript version before running Atlas compiler work.`,
        { path: ['host', 'typescript'] },
      ),
    );
  }
  const angular = parseSemanticVersion(versions.angularCompiler);
  if (angular === undefined || !supportedAngularCompiler(angular)) {
    diagnostics.push(
      atlasDiagnostic(
        'ATL1806',
        `Unsupported Angular compiler host version ${JSON.stringify(versions.angularCompiler)}; Atlas requires ${ATLAS_HOST_COMPATIBILITY_PROFILE.angularCompiler}. Install a supported @angular/compiler version before running Atlas compiler work.`,
        { path: ['host', 'angularCompiler'] },
      ),
    );
  }
  if (diagnostics.length > 0) return atlasFailure(diagnostics);
  return atlasSuccess(
    Object.freeze({
      profile: ATLAS_HOST_COMPATIBILITY_PROFILE.profile,
      versions: Object.freeze({ ...versions }),
    }),
  );
}

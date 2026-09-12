/**
 * What Atlas supports, read from the package manifests.
 *
 * The manifests are the source of truth for this, and the reason is what a consumer does: they run
 * an install, and the install reads the peer ranges and the engines field. Nothing else in this
 * repository is consulted at that moment. A range written anywhere else is a second copy of a claim
 * whose original is already published, and the copy is the one that goes stale.
 *
 * So the matrix rows, the consumer profiles and the reference page all read from here, and never
 * the other way round. Raising a floor is one edit to one manifest, and the row that proves the
 * floor moves with it.
 *
 * The source manifests rather than the built ones, because these are always present and the built
 * ones exist only after a build. `verify:packages` compares what shipped against these, which is
 * the check that the build published what the package declares.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readManifest = (path) =>
  JSON.parse(readFileSync(resolve(workspaceRoot, path), 'utf8'));

export const runtimeManifest = readManifest('packages/runtime/package.json');
export const toolkitManifest = readManifest('packages/toolkit/package.json');

// The names, so that a moved or renamed manifest fails here rather than handing every reader below
// an empty set of ranges to agree about.
assert.equal(
  runtimeManifest.name,
  '@neolorn/atlas',
  'packages/runtime/package.json is not the runtime manifest.',
);
assert.equal(
  toolkitManifest.name,
  '@neolorn/atlas-toolkit',
  'packages/toolkit/package.json is not the toolkit manifest.',
);

/**
 * The lowest version a range admits.
 *
 * Three range shapes appear in these manifests and all three state their floor first: `>=X <Y`,
 * `^X`, and a bare version. Anything else is refused rather than guessed at, because a floor read
 * wrongly becomes a matrix row that proves the wrong thing quietly.
 */
export function floorOf(range) {
  const floor = /^\s*(?:>=|\^|~)?\s*(\d+\.\d+\.\d+)/u.exec(range)?.[1];
  assert.ok(
    floor !== undefined,
    `Could not read a lowest supported version out of the range ${range}.`,
  );
  return floor;
}

/** Two versions ordered by number rather than by text, so 22.9.0 sorts below 22.10.0. */
export function compareVersions(left, right) {
  const [a, b] = [left.split('.').map(Number), right.split('.').map(Number)];
  const differs = a.findIndex((part, index) => part !== b[index]);
  return differs === -1 ? 0 : a[differs] - b[differs];
}

export const nodeRange = runtimeManifest.engines?.node;
assert.ok(
  typeof nodeRange === 'string' && nodeRange.length > 0,
  'The runtime manifest declares no Node range, so every check below would compare nothing.',
);
assert.equal(
  toolkitManifest.engines?.node,
  nodeRange,
  'The two packages declare different Node ranges. A consumer installs both, so one of the two claims is already false.',
);

/**
 * Every Node line the range admits, at the lowest version of each.
 *
 * These are the versions the suites run on. The range is a disjunction of major lines, and the
 * bottom of each line is where a behavior that needs a newer Node fails, so a row per floor is what
 * turns the range from a claim into evidence.
 */
const nodeParts = nodeRange.split('||');
export const nodeFloors = Object.freeze(
  nodeParts.map((part) => floorOf(part.trim())),
);
assert.equal(
  nodeFloors.length,
  nodeParts.length,
  'A part of the Node range produced no floor, so the matrix would run on fewer lines than the range admits.',
);

/** The Node this repository develops on, which is a row of its own. */
export const developmentNode = readFileSync(
  resolve(workspaceRoot, '.node-version'),
  'utf8',
).trim();

export const runtimePeers = Object.freeze({
  ...runtimeManifest.peerDependencies,
});
export const toolkitPeers = Object.freeze({
  ...toolkitManifest.peerDependencies,
});

/** The peers a consumer installs only when they import the entry point that needs one. */
export const optionalPeers = Object.freeze(
  Object.entries(runtimeManifest.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta?.optional === true)
    .map(([name]) => name)
    .sort(),
);

/**
 * The range one package declares for one peer.
 *
 * When both packages declare it, they have to agree before either is handed back. Angular is the
 * case: a consumer installs one copy of it and both packages compile against that copy, so two
 * ranges that differ describe an install nobody has.
 */
export function peerRange(name) {
  const declared = [runtimePeers[name], toolkitPeers[name]].filter(
    (range) => range !== undefined,
  );
  assert.ok(
    declared.length > 0,
    `Neither package declares ${name} as a peer, so there is no supported range to read.`,
  );
  assert.equal(
    new Set(declared).size,
    1,
    `The two packages declare different ranges for ${name}. A consumer installs one copy of it, so one of the two ranges describes an install nobody has.`,
  );
  return declared[0];
}

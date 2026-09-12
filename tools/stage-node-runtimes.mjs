import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareVersions,
  developmentNode,
  nodeFloors,
} from './supported-versions.mjs';

// The same derivation the compatibility rows use, from the same manifests, so what is downloaded
// and what is run cannot describe different sets of Node.
const versions = Object.freeze(
  [...new Set([...nodeFloors, developmentNode])].sort(compareVersions),
);

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeRoot = resolve(
  process.env.ATLAS_NODE_COMPATIBILITY_ROOT ??
    resolve(workspaceRoot, '.runtimes/node'),
);

const archives = new Map([
  ['win32-x64', { suffix: 'win-x64', extension: 'zip' }],
  ['linux-x64', { suffix: 'linux-x64', extension: 'tar.xz' }],
  ['linux-arm64', { suffix: 'linux-arm64', extension: 'tar.xz' }],
  ['darwin-x64', { suffix: 'darwin-x64', extension: 'tar.gz' }],
  ['darwin-arm64', { suffix: 'darwin-arm64', extension: 'tar.gz' }],
]);

const platformKey = `${process.platform}-${process.arch}`;
const archive = archives.get(platformKey);
if (archive === undefined) {
  throw new Error(
    `Unsupported platform for portable Node staging: ${platformKey}`,
  );
}

const fetchOrThrow = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  return response;
};

const expectedDigest = async (version, fileName) => {
  const response = await fetchOrThrow(
    `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
  );
  const line = (await response.text())
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.endsWith(` ${fileName}`));
  if (line === undefined) {
    throw new Error(`No SHASUMS256 entry for ${fileName}`);
  }
  return line.split(/\s+/)[0];
};

// Windows must use the bundled bsdtar, which reads zip archives; a GNU tar
// earlier on PATH cannot. tar also treats a leading drive letter as a remote
// host, so run inside the destination and pass a bare file name.
const tarCommand =
  process.platform === 'win32'
    ? resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe')
    : 'tar';

const extract = (fileName, destination) => {
  const result = spawnSync(tarCommand, ['-xf', fileName], {
    cwd: destination,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `Extraction failed for ${fileName}. tar is required.\n${
        result.error?.message ?? result.stderr ?? ''
      }`,
    );
  }
};

await mkdir(nodeRoot, { recursive: true });
const staged = new Set(await readdir(nodeRoot).catch(() => []));

for (const version of versions) {
  const directoryName = `node-v${version}-${archive.suffix}`;
  if (staged.has(directoryName)) {
    process.stdout.write(`Already staged: ${directoryName}\n`);
    continue;
  }

  const fileName = `${directoryName}.${archive.extension}`;
  const url = `https://nodejs.org/dist/v${version}/${fileName}`;
  process.stdout.write(`Downloading ${fileName}\n`);

  const [digest, response] = await Promise.all([
    expectedDigest(version, fileName),
    fetchOrThrow(url),
  ]);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest) {
    throw new Error(
      `Checksum mismatch for ${fileName}.\nexpected ${digest}\nactual   ${actual}`,
    );
  }

  const archivePath = resolve(nodeRoot, fileName);
  await writeFile(archivePath, bytes);
  try {
    extract(fileName, nodeRoot);
  } finally {
    await rm(archivePath, { force: true });
  }
  process.stdout.write(`Staged ${directoryName}\n`);
}

process.stdout.write(`Portable Node runtimes staged under ${nodeRoot}\n`);

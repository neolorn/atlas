/**
 * Pack a built package and prove the tarball says what the build said.
 *
 * `npm pack` deduplicates by inode: when two files report the same one it writes the second as a
 * hard link to the first, and extraction gives both the first file's bytes. On this filesystem
 * `fs.stat` returns inode values above `Number.MAX_SAFE_INTEGER`, so distinct files collapse onto
 * the same number and the packer links files that were never linked.
 *
 * That is not theoretical. `@neolorn/atlas@1.0.0-alpha.1` was published with
 * `types/neolorn-atlas-router.d.ts` containing the runtime module's JavaScript, byte for byte,
 * because those two paths collided. The build output on disk was correct the whole time; only the
 * tarball was wrong, and nothing in the pipeline looked at the tarball.
 *
 * So this packs from a copy, where the collision does not occur, and then compares every file in
 * the resulting archive against the build it claims to contain. A tarball that disagrees with its
 * own source is not published.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectory = process.argv[2];

assert.ok(
  packageDirectory !== undefined,
  'Usage: node ./tools/pack-verified.mjs <built-package-directory>',
);

const source = resolve(workspaceRoot, packageDirectory);
// `release/` rather than a scratch directory, and outside `dist/` on purpose. A publish takes these
// files after a green gate, and the gate's last stage rebuilds the packages several times with
// faults injected, which cleans `dist/` each time. An archive kept in there would be gone by the
// time anyone reached for it.
//
// One directory per package, because packing the second must not delete the first's verified
// archive: both are published together.
const verifiedRoot = resolve(workspaceRoot, 'release');
const outputRoot = resolve(
  verifiedRoot,
  packageDirectory.split(/[\\/]/).filter(Boolean).at(-1),
);

// This path is removed and recreated below, and it is computed from an argument. An earlier
// version derived it in a way that could resolve to an absolute path, at which point `resolve`
// returned that instead of a directory this tool owns, and the removal deleted the build output
// it was supposed to be packing. Nothing is removed until the target is known to be inside the
// directory this tool owns.
assert.ok(
  outputRoot.startsWith(`${verifiedRoot}${sep}`),
  `Refusing to write outside ${verifiedRoot}: computed ${outputRoot}`,
);

async function filesUnder(root) {
  const found = [];
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else found.push(relative(root, path).split('\\').join('/'));
    }
  };
  await walk(root);
  return found.sort();
}

function run(command, args, cwd) {
  const windows = process.platform === 'win32';
  const result = spawnSync(
    windows ? (process.env.ComSpec ?? 'cmd.exe') : command,
    windows ? ['/d', '/s', '/c', command, ...args] : args,
    { cwd, encoding: 'utf8', maxBuffer: 16_777_216 },
  );
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

const staging = await mkdtemp(join(tmpdir(), 'atlas-pack-'));
try {
  const copied = join(staging, 'package-source');
  // A fresh copy, because the collision is in the inodes the packer reads, not in the bytes.
  await cp(source, copied, { recursive: true });

  // Packed and extracted entirely inside the staging directory, addressed relatively. A Windows
  // path opens with a drive letter and a colon, which tar reads as a remote host specification,
  // and `--force-local` then mangles the destination instead.
  const archives = join(staging, 'archives');
  await mkdir(archives, { recursive: true });
  run('npm', ['pack', '--pack-destination', archives], copied);

  const [tarball] = await readdir(archives);
  assert.ok(tarball !== undefined, 'npm pack produced no tarball.');

  const extracted = join(staging, 'extracted');
  await mkdir(extracted, { recursive: true });
  run('tar', ['-xzf', `../archives/${tarball}`], extracted);

  const packedRoot = join(extracted, 'package');
  const packed = await filesUnder(packedRoot);
  const differences = [];
  for (const entry of packed) {
    const built = join(source, entry);
    const inArchive = await readFile(join(packedRoot, entry));
    let original;
    try {
      original = await readFile(built);
    } catch {
      differences.push(
        `${entry}: present in the archive and absent from the build`,
      );
      continue;
    }
    if (!inArchive.equals(original)) {
      differences.push(
        `${entry}: archive has ${inArchive.length} bytes, the build has ${original.length}`,
      );
    }
  }

  assert.deepEqual(
    differences,
    [],
    `The tarball does not match the build it was made from:\n  ${differences.join('\n  ')}`,
  );

  // Only a tarball that survived the comparison leaves the staging directory. Publishing takes
  // this file, so what is published is the archive that was checked rather than a fresh pack that
  // was not.
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await cp(join(archives, tarball), join(outputRoot, tarball));

  process.stdout.write(
    `${packed.length} files verified against ${packageDirectory}: ${join(outputRoot, tarball)}\n`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}

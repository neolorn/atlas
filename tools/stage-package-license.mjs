/**
 * The license, copied into a built package so the package carries it.
 *
 * MIT requires the notice to travel with every copy of the software, and an installed package is a
 * copy. A license file that exists only in the repository is one nobody who installed Atlas can
 * read, and the repository is not what a consumer received.
 *
 * Copied rather than written twice. One file is the license; a second copy beside each package
 * would be two files that agree until one of them is edited, and the one that stops agreeing is
 * the one that ships.
 */
import { copyFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(workspaceRoot, 'dist');

const requested = process.argv[2];
if (requested === undefined) {
  throw new Error(
    'Name the built package to copy the license into, for example dist/runtime.',
  );
}

const outputRoot = resolve(workspaceRoot, requested);
if (dirname(outputRoot) !== distRoot) {
  throw new Error(`Refusing to write outside dist: ${requested}`);
}

await copyFile(
  resolve(workspaceRoot, 'LICENSE'),
  resolve(outputRoot, 'LICENSE'),
);

process.stdout.write(
  `Atlas license staged into ${relative(workspaceRoot, outputRoot).replaceAll(sep, '/')}.\n`,
);

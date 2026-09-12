/**
 * The published documents, assembled into applications and run.
 *
 * Every fenced block carries its role in the fence's info string, and there are only five:
 *
 * - `” ```ts src/app/app.ts ”`. The block is that file. It is written into the consumer and has to
 *   compile there.
 * - `” ```yaml excerpt i18n/shell/en-US.yaml ”`: the block is part of that file, checked after the
 *   run rather than written. This is how a section quotes part of a file another section owns, and
 *   how a document shows a file `atlas init` writes. "Part of" is a contiguous run of lines, except
 *   for JSON, where it is a structural subset: Prettier owns the document's formatting and reflows
 *   a JSON block, so comparing text there compares Prettier's line breaks against the writing
 *   command's rather than what the block actually claims.
 * - `” ```sh run ”`: the commands are run in the consumer, where they stand.
 * - `” ```sh install ”`, not run, because the packages it names are the ones under test rather
 *   than the ones on the registry. It is checked against the manifest instead: the packages it
 *   installs, and which of them is a dev dependency.
 * - `” ```text ”`: prose or output. Nothing else may be unlabelled.
 *
 * An unlabelled block is a failure, so a sample cannot be skipped by forgetting to label it.
 *
 * **Blocks are executed in document order**, writes and commands interleaved, because that is the
 * order the reader executes them in. A page that runs a command which refuses a directory the next
 * block creates is a page that does not work, and running every write before every command would
 * have hidden it.
 *
 * A document is one of two kinds, and the difference is what a file collision means.
 *
 * The READMEs are one application. They tell one story to a reader who arrives at whichever of
 * them their package led them to, so a path named by two of them with different contents is a
 * contradiction between two pages of the same story, and it is a failure.
 *
 * Every page under `docs/` is its own application, starting from what the tutorial produced. A
 * page writes the file it changes and inherits every file it does not, so the routing page's
 * providers and the server-rendering guide's providers are each the real thing a reader of that
 * guide would have, rather than one configuration carrying every capability that neither reader
 * selected. Two guides may therefore write one path differently. Two blocks on one guide may not.
 *
 * **The tutorial authors the base.** The scaffold is what `ng new` produced with `src/app/` and
 * `i18n/` removed, and the tutorial runs on it from `atlas init` onward, so everything the
 * application is comes from the one document that claims to build it: the catalogs in both locales,
 * the providers, the route table, the switcher, the rich content, and the spec. It ends at that
 * spec, so what this proves is a working application rather than only a build.
 *
 * Every other consumer is built and tested on a copy of that base, which is what a reader who has
 * followed the tutorial already has. A consumer that writes a file has to carry a spec that passes,
 * because a file nothing asserts against is a sample that compiled rather than a sample that
 * works.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scaffoldRoot = resolve(
  workspaceRoot,
  'fixtures/document-consumer-scaffold',
);
const groundRoot = resolve(workspaceRoot, 'tmp/document-blocks');
const baseRoot = resolve(groundRoot, 'base');
const baseTree = resolve(groundRoot, 'base-tree');
const docsRoot = resolve(workspaceRoot, 'docs');

/**
 * The documents that are one application.
 *
 * Declared rather than discovered, because a README that stopped being checked would look exactly
 * like a README that was never in the list.
 */
const README_GROUP = [
  ['atlas', 'README.md'],
  ['@neolorn/atlas', 'packages/runtime/README.md'],
  ['@neolorn/atlas-toolkit', 'packages/toolkit/README.md'],
];

/**
 * The document that authors the base.
 *
 * It runs on the installed scaffold rather than on a base, because it is the one that makes one.
 * Declared here so that a page renamed without this line being changed fails rather than quietly
 * leaving every other consumer without a base.
 */
const BASE_DOCUMENT = ['docs/tutorial.md', 'docs/tutorial.md'];

/** How many consumers are installed and driven at once. */
const SLOTS = 4;

/**
 * What a slot keeps from one document to the next.
 *
 * The install, and the caches a build warms. They belong to the slot rather than to any
 * document, so they are neither reset between documents nor copied in from the base.
 */
const CARRIED_BY_A_SLOT = new Set(['node_modules', '.angular', 'dist']);

const FENCE = /^```(.*)$/u;
const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

/**
 * A path, rather than a language's second word.
 *
 * The test is deliberately shape-based and not a list of known files: a destination is anything
 * with a separator or an extension, so a new file needs no registration here to be checked.
 */
const looksLikePath = (word) =>
  word.includes('/') || /\.[a-z0-9]+$/u.test(word);

function parseBlocks(source, label) {
  const lines = source.split('\n');
  const blocks = [];
  let open;
  lines.forEach((line, index) => {
    const match = FENCE.exec(line);
    if (match === null) {
      if (open !== undefined) open.lines.push(line);
      return;
    }
    if (open === undefined) {
      open = { info: match[1].trim(), line: index + 1, lines: [] };
      return;
    }
    blocks.push({
      ...open,
      document: label,
      body: `${open.lines.join('\n')}\n`,
    });
    open = undefined;
  });
  assert.equal(open, undefined, `${label}: a fenced block is never closed`);
  return blocks;
}

function roleOf(block) {
  const where = `${block.document}:${block.line}`;
  const [language, ...rest] = block.info.split(/\s+/u).filter(Boolean);
  if (language === undefined) {
    fail(
      where,
      'a fenced block with no language. Label it, or fence prose as `text`.',
    );
    return undefined;
  }
  if (rest.length === 0) {
    if (language === 'text') return { kind: 'prose' };
    fail(
      where,
      `a \`${language}\` block with no destination. A block that is code names the file it is, ` +
        'and prose is fenced as `text`.',
    );
    return undefined;
  }
  if (language === 'sh') {
    if (rest.length === 1 && (rest[0] === 'run' || rest[0] === 'install')) {
      return { kind: rest[0] };
    }
    fail(where, 'a shell block is `sh run` or `sh install`.');
    return undefined;
  }
  if (rest.length === 1 && looksLikePath(rest[0])) {
    return { kind: 'file', path: rest[0] };
  }
  if (rest.length === 2 && rest[0] === 'excerpt' && looksLikePath(rest[1])) {
    return { kind: 'excerpt', path: rest[1] };
  }
  fail(
    where,
    `unreadable fence \`${block.info}\`. It is \`<language> <path>\`, ` +
      '`<language> excerpt <path>`, `sh run`, `sh install`, or `text`.',
  );
  return undefined;
}

/**
 * What one set of documents claims, with the one-file-one-block rule applied inside the set.
 *
 * The set is the unit the rule binds, which is what makes the READMEs one story and each guide its
 * own application without a second vocabulary in the fences.
 */
async function collect(documents) {
  const files = new Map();
  const excerpts = [];
  const shell = [];
  const installs = [];
  const steps = [];
  for (const [label, path] of documents) {
    const source = await readFile(resolve(workspaceRoot, path), 'utf8');
    for (const block of parseBlocks(source.replaceAll('\r\n', '\n'), label)) {
      const role = roleOf(block);
      if (role === undefined) continue;
      const where = `${block.document}:${block.line}`;
      if (role.kind === 'file') {
        const existing = files.get(role.path);
        if (existing !== undefined && existing.body !== block.body) {
          fail(
            where,
            `${role.path} is also written at ${existing.where}, with different contents. ` +
              'One file has one block; a second section quotes it with `excerpt`.',
          );
          continue;
        }
        files.set(role.path, { body: block.body, where });
        // A file written twice with the same contents is one step, not two, because the second
        // block is a page repeating itself rather than a reader typing it again.
        if (existing === undefined)
          steps.push({
            kind: 'file',
            path: role.path,
            body: block.body,
            where,
          });
      } else if (role.kind === 'excerpt') {
        excerpts.push({ ...role, body: block.body, where });
      } else if (role.kind === 'run') {
        shell.push({ body: block.body, where });
        steps.push({ kind: 'run', body: block.body, where });
      } else if (role.kind === 'install') {
        installs.push({ body: block.body, where });
      }
    }
  }
  return { files, excerpts, shell, installs, steps };
}

const shellCommand =
  process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';

const runIn = (root, line, what) =>
  new Promise((settle, reject) => {
    const child = spawn(
      shellCommand,
      process.platform === 'win32' ? ['/d', '/s', '/c', line] : ['-c', line],
      { cwd: root, env: { ...process.env, CI: 'true' } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      if (status === 0) {
        settle({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          [`${what}: \`${line}\` failed.`, stdout, stderr]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    });
  });

const assertContained = (root, path) => {
  const resolved = resolve(root, path);
  assert.ok(
    resolved === root || resolved.startsWith(root + sep),
    `A block names a destination outside the consumer: ${path}`,
  );
  return resolved;
};

/**
 * Every member the excerpt states, said the same way by the file.
 *
 * An excerpt is part of a file, so a JSON one is a subset rather than an equal: a document may
 * quote three of a configuration's fields. An array is compared whole, because a subset of a list
 * is not a meaningful claim about it: `["en-US"]` does not describe `["en-US", "ar-EG"]`.
 */
const contains = (whole, part) => {
  if (Array.isArray(part) || Array.isArray(whole)) {
    return JSON.stringify(whole) === JSON.stringify(part);
  }
  if (part === null || typeof part !== 'object') return whole === part;
  if (whole === null || typeof whole !== 'object') return false;
  return Object.entries(part).every(
    ([key, value]) => Object.hasOwn(whole, key) && contains(whole[key], value),
  );
};

/** The manifest, pointed at the distributables the consumer is meant to install from. */
async function pointAtTheDistributables(root) {
  const manifestPath = resolve(root, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const locate = (output) =>
    `file:${relative(root, resolve(workspaceRoot, output)).replaceAll('\\', '/')}`;
  manifest.dependencies['@neolorn/atlas'] = locate('dist/runtime');
  manifest.devDependencies['@neolorn/atlas-toolkit'] = locate('dist/toolkit');
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

/**
 * What the install block claims, against what the manifest declares.
 *
 * The block is not run, because the two packages it names are the ones being verified rather than
 * the ones published.
 */
function checkInstalls(manifest, installs) {
  for (const block of installs) {
    const named = new Map();
    for (const line of block.body.split('\n')) {
      const words = line.trim().split(/\s+/u).filter(Boolean);
      if (words.length === 0) continue;
      assert.equal(
        words[0],
        'npm',
        `${block.where}: an install block is npm install lines.`,
      );
      const development = words.includes('--save-dev') || words.includes('-D');
      for (const word of words.slice(2)) {
        if (word.startsWith('-')) continue;
        named.set(word, development);
      }
    }
    for (const [name, development] of named) {
      const declared = development
        ? manifest.devDependencies
        : manifest.dependencies;
      const other = development
        ? manifest.dependencies
        : manifest.devDependencies;
      assert.ok(
        Object.hasOwn(declared, name),
        `${block.where}: ${name} is installed ${development ? 'as a dev dependency' : 'as a dependency'}, ` +
          `and the assembled consumer declares it ${Object.hasOwn(other, name) ? 'the other way' : 'nowhere'}.`,
      );
    }
  }
}

/** The page, performed: each block done where it stands. */
async function perform(root, steps) {
  for (const step of steps) {
    if (step.kind === 'file') {
      const destination = assertContained(root, step.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, step.body, 'utf8');
      continue;
    }
    for (const line of step.body.split('\n')) {
      if (line.trim() === '') continue;
      await runIn(root, line.trim(), step.where);
    }
  }
}

/** Checked after the run, because the file an excerpt quotes may be one the run wrote. */
async function checkExcerpts(root, excerpts) {
  for (const excerpt of excerpts) {
    const destination = assertContained(root, excerpt.path);
    const actual = await readFile(destination, 'utf8').catch(() => undefined);
    assert.ok(
      actual !== undefined,
      `${excerpt.where}: quotes ${excerpt.path}, which the assembled consumer does not have.`,
    );
    if (excerpt.path.endsWith('.json')) {
      // Structurally, because Prettier owns the document's formatting and reflows JSON inside a
      // fenced block. Comparing the text would compare Prettier's line breaks against the ones the
      // writing command chose, which is not what the block claims: it claims the file says this.
      assert.ok(
        contains(JSON.parse(actual), JSON.parse(excerpt.body)),
        `${excerpt.where}: quotes ${excerpt.path}, and the file does not say that:\n${excerpt.body}\nThe file is:\n${actual}`,
      );
      continue;
    }
    const haystack = actual.replaceAll('\r\n', '\n');
    const needle = excerpt.body.replace(/\n$/u, '');
    assert.ok(
      haystack.includes(needle),
      `${excerpt.where}: quotes ${excerpt.path}, and these lines are not in it:\n${needle}\n\nThe file is:\n${haystack}`,
    );
  }
}

/**
 * The passing cases a run reported.
 *
 * A spec file that stops being collected passes silently, so the count is read rather than the
 * exit status alone. Vitest colours its summary, so the counts come off the plain text rather than
 * off whatever the terminal was told to draw.
 */
function casesPassing(result, what) {
  const output = `${result.stdout}\n${result.stderr}`.replaceAll(
    /\u001B\[[0-9;]*m/gu,
    '',
  );
  const counted = /Tests\s+(\d+) passed\s+\((\d+)\)/u.exec(output);
  assert.ok(
    counted !== null,
    `${what}: the run reported no case count:\n${output}`,
  );
  assert.equal(
    counted[1],
    counted[2],
    `${what}: the run did not pass every case:\n${output}`,
  );
  return Number(counted[1]);
}

/** Everything a slot carries from one document to the next, and nothing else. */
async function resetTo(root, tree) {
  for (const entry of await readdir(root)) {
    if (CARRIED_BY_A_SLOT.has(entry)) continue;
    await rm(join(root, entry), { force: true, recursive: true });
  }
  await cp(tree, root, { recursive: true });
}

/**
 * The pages that start from the installed scaffold rather than from the base.
 *
 * One page is on this list and it is the tutorial, whose first command is `atlas init`. Everything
 * else starts from what the READMEs built, which is what a reader of a guide already has.
 */
const STARTS_FROM_THE_SCAFFOLD = new Set(['docs/tutorial.md']);

/** Every page under `docs/`, in a stable order. */
async function documentPages() {
  const found = await readdir(docsRoot, {
    recursive: true,
    withFileTypes: true,
  }).catch(() => undefined);
  if (found === undefined) return [];
  return found
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) =>
      relative(workspaceRoot, resolve(entry.parentPath, entry.name)).replaceAll(
        '\\',
        '/',
      ),
    )
    .sort()
    .map((path) => [path, path]);
}

const found = await documentPages();

assert.ok(
  found.some(([page]) => page === BASE_DOCUMENT[1]),
  `${BASE_DOCUMENT[1]} authors the base and is not a page under docs/.`,
);
const pages = found.filter(([page]) => page !== BASE_DOCUMENT[1]);

// Every fence in every document, before anything is installed, so a mislabelled block in the last
// page is reported in a second rather than after the base has been built.
const baseBundle = await collect([BASE_DOCUMENT]);
const consumers = [['the READMEs', await collect(README_GROUP)]];
for (const page of pages) consumers.push([page[0], await collect([page])]);

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}

assert.ok(
  baseBundle.files.size > 0,
  `No block in ${BASE_DOCUMENT[1]} names a file.`,
);
assert.ok(
  baseBundle.shell.length > 0,
  `No block in ${BASE_DOCUMENT[1]} is run.`,
);

// The base. Everything the application is comes from the base document's blocks.
await rm(groundRoot, { force: true, recursive: true });
await mkdir(groundRoot, { recursive: true });
await cp(scaffoldRoot, baseRoot, { recursive: true });

const manifest = await pointAtTheDistributables(baseRoot);

// Frozen, so the run installs what was resolved when the scaffold's lockfile was committed rather
// than whatever the registry answers today. `pnpm run refresh:consumer-locks` regenerates it, at
// this depth, because a `file:` locator recorded at another one would not match what installs
// here.
await runIn(baseRoot, 'pnpm install --frozen-lockfile', 'installing the base');

// Copied before the run, so a slot installs the manifest the lockfile was resolved against.
const installedTree = resolve(groundRoot, 'installed-tree');
await cp(baseRoot, installedTree, {
  recursive: true,
  filter: (source) => !source.split(sep).includes('node_modules'),
});

checkInstalls(manifest, baseBundle.installs);
await perform(baseRoot, baseBundle.steps);
await checkExcerpts(baseRoot, baseBundle.excerpts);
await runIn(baseRoot, 'pnpm run build', 'building the base');
const baseCases = casesPassing(
  await runIn(baseRoot, 'pnpm run test', 'running the base'),
  BASE_DOCUMENT[1],
);
assert.ok(
  baseCases >= 4,
  `${BASE_DOCUMENT[1]} ran ${baseCases} case(s); its spec block carries four.`,
);

if (consumers.length === 0) {
  process.stdout.write(
    `Document blocks verified: ${baseBundle.files.size} file(s), ` +
      `${baseBundle.excerpts.length} excerpt(s), ${baseBundle.shell.length} shell block(s), ` +
      `${baseCases} case(s) passing. Nothing else runs on that base.\n`,
  );
  process.exit(0);
}

await cp(baseRoot, baseTree, {
  recursive: true,
  filter: (source) =>
    !source.split(sep).some((part) => CARRIED_BY_A_SLOT.has(part)),
});

const width = Math.min(
  SLOTS,
  consumers.filter(
    ([, bundle]) => bundle.files.size > 0 || bundle.shell.length > 0,
  ).length,
);
const slots = [];
for (let index = 0; index < width; index += 1) {
  const root = resolve(groundRoot, `slot-${index}`);
  await cp(installedTree, root, { recursive: true });
  slots.push(root);
}
await Promise.all(
  slots.map((root) =>
    runIn(root, 'pnpm install --frozen-lockfile', `installing ${root}`),
  ),
);

// A consumer that writes nothing is checked against the base itself. It needs no tree of its own,
// because nothing it says could have changed one, and skipping it outright would have left its
// excerpts unchecked: a page that only quotes is the page most likely to quote something that has
// since moved.
const queue = [];
const reported = [];
for (const [label, bundle] of consumers) {
  if (bundle.files.size > 0 || bundle.shell.length > 0) {
    queue.push([label, bundle]);
    continue;
  }
  checkInstalls(manifest, bundle.installs);
  await checkExcerpts(baseTree, bundle.excerpts);
  reported.push(
    bundle.excerpts.length === 0
      ? `${label}: prose only`
      : `${label}: ${bundle.excerpts.length} excerpt(s) checked against the base`,
  );
}

await Promise.all(
  slots.map(async (root) => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      const [label, bundle] = next;
      // Counting cases would prove nothing here, because every slot inherits the base's
      // spec and would report its four. What a consumer that writes files owes is a spec
      // of its own, which is a claim about it rather than about the base under it.
      assert.ok(
        bundle.files.size === 0 ||
          [...bundle.files.keys()].some((path) => path.endsWith('.spec.ts')),
        `${label} writes ${bundle.files.size} file(s) and no spec. A page that writes a ` +
          'file carries a spec that asserts what the file does.',
      );
      await resetTo(root, baseTree);
      checkInstalls(manifest, bundle.installs);
      await perform(root, bundle.steps);
      await checkExcerpts(root, bundle.excerpts);
      await runIn(root, 'pnpm run build', `building ${label}`);
      const cases = casesPassing(
        await runIn(root, 'pnpm run test', `running ${label}`),
        label,
      );
      assert.ok(
        cases >= 1,
        `${label} writes ${bundle.files.size} file(s) and its run asserted nothing. ` +
          'A page that writes a file carries a spec that passes.',
      );
      reported.push(
        `${label}: ${bundle.files.size} file(s), ${cases} case(s) passing`,
      );
    }
  }),
);

process.stdout.write(
  `Document blocks verified: ${BASE_DOCUMENT[1]} assembles ${baseBundle.files.size} file(s), ` +
    `${baseBundle.excerpts.length} excerpt(s), ${baseBundle.shell.length} shell block(s) and ` +
    `${baseCases} passing case(s); ${consumers.length} consumer(s) run on that base.\n` +
    `${reported.sort().join('\n')}\n`,
);

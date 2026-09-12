/**
 * Every link in a published document arrives somewhere.
 *
 * The documents point at each other constantly: a README sends a reader into `docs/`, a guide sends
 * them to the reference page for a flag, a reference page sends them to the specification that
 * binds it. None of that was checked. A directory that was deleted stayed named in a README for as
 * long as nobody clicked it, and clicking it is something only a reader does, which makes the
 * reader the check.
 *
 * Three things are checked.
 *
 * A relative link resolves to a file the repository tracks. An untracked target is a link that
 * works on the machine that wrote it.
 *
 * A link's anchor names a heading in the file it lands on, slugged the way a forge slugs it. A
 * renamed heading takes its anchor with it, and every link to the previous spelling is a link into
 * the top of a page.
 *
 * A code span that begins with a directory this repository has names something the repository has.
 * A path such as `specs/architecture/` outlives the directory it names when it sits inside a
 * sentence rather than inside a link, where no link check looks. The directories come from what is
 * tracked rather than from a list here, so a span is checked when its first segment is a real
 * top-level directory and left alone otherwise: `schemas/configuration.v1.schema.json` is a path
 * inside the published package and names nothing here, and a document is also where a flag, a field
 * name and an import specifier get written between backticks.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Vendored trees whose documents are somebody else's. */
const SKIPPED_PREFIXES = ['.runtimes/', 'standards/data/'];

const tracked = new Set(
  execFileSync('git', ['ls-files'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean),
);

const directories = new Set();
for (const path of tracked) {
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index += 1) {
    directories.add(`${parts.slice(0, index).join('/')}/`);
  }
}

/** The top-level directories the repository has, which is where a span is a path. */
const ownedPrefixes = [...directories].filter(
  (directory) => directory.split('/').length === 2,
);

const documents = [...tracked].filter(
  (path) =>
    path.endsWith('.md') &&
    !SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix)),
);

const findings = [];
const report = (where, line, message) =>
  findings.push(`${where}:${line}: ${message}`);

/**
 * A heading's anchor, as a forge writes it.
 *
 * Emphasis and code marks are removed before the slug rather than after, because they are not part
 * of what the heading says. Everything else that is neither a letter, a digit, a space nor a hyphen
 * goes, spaces become hyphens, and a repeated slug takes the next number, which is the rule a
 * reader's browser is already following.
 */
function slug(heading, seen) {
  const text = heading
    .replaceAll(/`([^`]*)`/gu, '$1')
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replaceAll(/[*_]/gu, '');
  const base = text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replaceAll(/\s+/gu, '-');
  const taken = seen.get(base) ?? 0;
  seen.set(base, taken + 1);
  return taken === 0 ? base : `${base}-${taken}`;
}

/** Every anchor a document offers, which is one per heading. */
const anchorsOf = (text) => {
  const seen = new Map();
  const anchors = new Set();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^#{1,6}\s+(.*?)\s*$/u.exec(line);
    if (heading !== null) anchors.add(slug(heading[1], seen));
  }
  return anchors;
};

const anchorCache = new Map();
const anchorsFor = (path) => {
  if (!anchorCache.has(path)) {
    anchorCache.set(
      path,
      anchorsOf(readFileSync(resolve(workspaceRoot, path), 'utf8')),
    );
  }
  return anchorCache.get(path);
};

const INLINE_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu;
const REFERENCE_DEFINITION = /^\s*\[[^\]]+\]:\s+(\S+)/u;
const CODE_SPAN = /`([^`\n]+)`/gu;
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

/** The lines that are prose, with fenced blocks folded out. */
function proseLines(text) {
  const lines = text.split('\n');
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/u.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  });
}

function checkTarget(where, number, document, target, spelling) {
  const [path, anchor] = target.split('#');
  if (path === '') {
    if (!anchorsFor(document).has(anchor)) {
      report(
        where,
        number,
        `${spelling} names no heading in this document. It offers ${[...anchorsFor(document)].join(', ') || 'none'}.`,
      );
    }
    return;
  }
  const landing = posix.normalize(posix.join(posix.dirname(document), path));
  if (landing.startsWith('..')) {
    report(where, number, `${spelling} leaves the repository.`);
    return;
  }
  if (path.endsWith('/')) {
    // `landing` already carries the slash the link was written with, and a doubled one matches
    // nothing.
    if (!directories.has(landing.endsWith('/') ? landing : `${landing}/`)) {
      report(
        where,
        number,
        `${spelling} names no directory the repository has.`,
      );
    }
    return;
  }
  if (!tracked.has(landing)) {
    report(
      where,
      number,
      directories.has(`${landing}/`)
        ? `${spelling} names a directory and is written as a file.`
        : `${spelling} names no file the repository tracks.`,
    );
    return;
  }
  if (anchor === undefined || !landing.endsWith('.md')) return;
  if (!anchorsFor(landing).has(anchor)) {
    report(where, number, `${spelling} names no heading in ${landing}.`);
  }
}

let links = 0;
let spans = 0;
for (const document of documents) {
  const text = readFileSync(resolve(workspaceRoot, document), 'utf8');
  proseLines(text).forEach((line, index) => {
    const number = index + 1;
    for (const match of line.matchAll(INLINE_LINK)) {
      if (EXTERNAL.test(match[1])) continue;
      links += 1;
      checkTarget(document, number, document, match[1], `\`${match[1]}\``);
    }
    const definition = REFERENCE_DEFINITION.exec(line);
    if (definition !== null && !EXTERNAL.test(definition[1])) {
      links += 1;
      checkTarget(
        document,
        number,
        document,
        definition[1],
        `\`${definition[1]}\``,
      );
    }
    for (const match of line.matchAll(CODE_SPAN)) {
      const span = match[1];
      if (!ownedPrefixes.some((prefix) => span.startsWith(prefix))) continue;
      spans += 1;
      if (span.endsWith('/')) {
        if (!directories.has(span)) {
          report(
            document,
            number,
            `\`${span}\` names no directory the repository has.`,
          );
        }
        continue;
      }
      if (!tracked.has(span) && !directories.has(`${span}/`)) {
        report(
          document,
          number,
          `\`${span}\` names no file or directory the repository has.`,
        );
      }
    }
  });
}

if (findings.length > 0) {
  process.stderr.write(
    `Atlas document links: ${findings.length} hit(s) across ${documents.length} documents.\n\n` +
      `${findings.map((finding) => `  ${finding}`).join('\n')}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `Atlas document links verified: ${links} relative link(s) and ${spans} path(s) named in prose ` +
    `across ${documents.length} documents all resolve, anchors included.\n`,
);

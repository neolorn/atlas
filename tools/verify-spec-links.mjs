/**
 * Does every citation of a specification point at something that exists, and is every requirement
 * cited from the code that implements it?
 *
 * Two questions, one pass, because they are the two halves of one property: a specification and the
 * source that honors it stay attached to each other. A comment naming a section is the only link
 * between a rule and the code that keeps it, and nothing was checking that the link led anywhere.
 * Three citations in the tree named a line number where a section number belongs, which reads as a
 * precise reference and resolves to nothing.
 *
 * ## The citation form
 *
 * One spelling, so a reference can be found by a machine rather than by reading:
 *
 *     `specs/03-locale-identity-and-resolution.spec.md` section 4
 *     section 4 of `specs/03-locale-identity-and-resolution.spec.md`
 *
 * The path is repository relative and complete. A citation without a section is allowed: some
 * references really are to a whole document.
 *
 * A second spelling is accepted while the pack is being renumbered: a directory and number, or a
 * bare document name. Both resolve to exactly one file today and are checked the same way. They
 * are accepted rather than refused because refusing them would mean rewriting every citation in
 * the tree twice, once onto the documents being replaced and again onto the ones replacing them.
 * The branch that accepts them goes when the last of them does.
 *
 * ## The coverage rule
 *
 * A section that states a requirement and that no source file cites is a requirement nothing is
 * holding. The rule is therefore: every numbered section carrying a conformance keyword is cited
 * at least once from outside `specs/`. Citing it is not the same as proving it, and this does not
 * claim otherwise; what it prevents is a requirement drifting free of the tree entirely, which is
 * the state that lets a specification and an implementation disagree without anyone noticing.
 *
 * The rule applies to the numbered specification set only. A document outside that shape is
 * something else and is checked for citation validity alone.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const tracked = execFileSync('git', ['ls-files'], {
  cwd: workspaceRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((path) => path.length > 0);

/** The keywords that make a sentence normative, from BCP 14. */
const CONFORMANCE_KEYWORD =
  /\b(?:MUST NOT|MUST|SHOULD NOT|SHOULD|MAY|REQUIRED|RECOMMENDED|NOT RECOMMENDED|OPTIONAL)\b/u;

/** A document of the numbered set, which the coverage rule applies to. */
const NUMBERED_SPECIFICATION = /^specs\/\d{2}-[a-z0-9-]+\.spec\.md$/u;

const read = (path) => readFileSync(resolve(workspaceRoot, path), 'utf8');

/**
 * The numbered sections of one specification, and whether each states a requirement.
 *
 * A subsection belongs to its parent for the coverage rule: citing `section 8` covers the
 * requirements in `8.1`, because a reader following the citation arrives at both.
 */
function sectionsOf(text) {
  const sections = new Map();
  let current;
  for (const line of text.split('\n')) {
    const heading = /^##+\s+(\d+(?:\.\d+)*)\.?\s/u.exec(line);
    if (heading !== null) {
      const number = heading[1];
      sections.set(number, { normative: false });
      current = number.split('.')[0];
      if (!sections.has(current)) sections.set(current, { normative: false });
      continue;
    }
    if (current === undefined) continue;
    if (!CONFORMANCE_KEYWORD.test(line)) continue;
    sections.get(current).normative = true;
  }
  return sections;
}

const specifications = new Map();
for (const path of tracked) {
  if (!path.startsWith('specs/') || !path.endsWith('.md')) continue;
  specifications.set(path, sectionsOf(read(path)));
}
assert.ok(
  specifications.size > 0,
  'No specification was found. The scan cannot report agreement when it read nothing.',
);

/**
 * A reference to a specification, in either spelling, with its section where one is given.
 *
 * The section is looked for on both sides because both readings occur in ordinary prose: a
 * sentence names the document and then the section, or names the section and then the document.
 */
const CITATION = new RegExp(
  String.raw`(?:section\s+(\d+(?:\.\d+)*)\s+(?:of|in)\s+)?` +
    String.raw`(?:§(\d+(?:\.\d+)*)\s+of\s+)?` +
    '`(' +
    String.raw`specs/[a-z0-9/-]+\.spec\.md` +
    '|' +
    String.raw`(?:specs/)?(?:architecture|tooling|quality|governance|product)/\d{2}` +
    ')`' +
    String.raw`(?:\s*(?:section\s+|§)(\d+(?:\.\d+)*))?`,
  'giu',
);

/** A document named without its directory, which resolves only because the names are unique. */
const BARE_DOCUMENT = /(?<![a-z0-9/-])(\d{2}-[a-z0-9-]+\.spec\.md)/giu;

/**
 * The one file a reference names, whichever spelling it used.
 *
 * A directory-and-number pair or a bare document name identifies a file only while nothing else
 * answers to it. Two answers is not a near miss to be resolved by preference: it is a reference
 * that has stopped meaning one thing, and it is reported as one.
 */
function resolveDocument(reference) {
  if (specifications.has(reference)) return { path: reference };
  const withPrefix = `specs/${reference}`;
  if (specifications.has(withPrefix)) return { path: withPrefix };
  const stem = reference.replace(/^specs\//u, '');
  const matches = [...specifications.keys()].filter(
    (path) =>
      path.slice('specs/'.length).startsWith(`${stem}-`) ||
      path.slice('specs/'.length).endsWith(`/${stem}`) ||
      path.endsWith(`/${stem}`),
  );
  if (matches.length === 1) return { path: matches[0] };
  if (matches.length > 1) return { ambiguous: matches };
  return {};
}

const failures = [];
const cited = new Map();

for (const path of tracked) {
  if (path.startsWith('specs/')) continue;
  // This file spells out the citation form it accepts, so its examples are shapes rather than
  // references. Holding it to its own rule would mean its documentation could only ever name
  // documents that exist, which is the opposite of what an example is for.
  if (path === 'tools/verify-spec-links.mjs') continue;
  if (!/\.(?:ts|mjs|cjs|js|md|json|ya?ml)$/u.test(path)) continue;
  let text;
  try {
    text = read(path);
  } catch {
    continue;
  }

  const lineOf = (index) => text.slice(0, index).split('\n').length;

  const record = (index, reference, section) => {
    const { path: document, ambiguous } = resolveDocument(reference);
    if (ambiguous !== undefined) {
      failures.push(
        `${path}:${lineOf(index)} refers to \`${reference}\`, which now names more than one ` +
          `specification: ${ambiguous.join(', ')}. Cite the complete repository path.`,
      );
      return;
    }
    if (document === undefined) {
      failures.push(
        `${path}:${lineOf(index)} cites \`${reference}\`, which is not a specification in this repository.`,
      );
      return;
    }
    const sections = specifications.get(document);
    if (section === undefined) return;
    if (!sections.has(section)) {
      const known = [...sections.keys()]
        .filter((number) => !number.includes('.'))
        .join(', ');
      failures.push(
        `${path}:${lineOf(index)} cites \`${reference}\` section ${section}, which does not exist. ` +
          `${document} has sections ${known}.`,
      );
      return;
    }
    cited.set(
      `${document}#${section.split('.')[0]}`,
      (cited.get(`${document}#${section.split('.')[0]}`) ?? 0) + 1,
    );
  };

  for (const match of text.matchAll(CITATION)) {
    record(match.index, match[3], match[1] ?? match[2] ?? match[4]);
  }

  // A bare name carries no directory, so it is looked at only where the backticked form did not
  // already claim that position in the text.
  const claimed = [];
  for (const match of text.matchAll(CITATION)) {
    claimed.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(BARE_DOCUMENT)) {
    if (claimed.some(([from, to]) => match.index >= from && match.index < to))
      continue;
    record(match.index, match[1], undefined);
  }
}

for (const [document, sections] of specifications) {
  if (!NUMBERED_SPECIFICATION.test(document)) continue;
  for (const [number, { normative }] of sections) {
    if (!normative || number.includes('.')) continue;
    if ((cited.get(`${document}#${number}`) ?? 0) > 0) continue;
    failures.push(
      `\`${document}\` section ${number} states a requirement that nothing outside \`specs/\` cites. ` +
        'A requirement no source names is one nothing is holding: cite it from the code that ' +
        'honors it, or from the test that proves it.',
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(`\n${failures.length} specification reference problem(s).`);
  process.exitCode = 1;
} else {
  const numbered = [...specifications.keys()].filter((path) =>
    NUMBERED_SPECIFICATION.test(path),
  ).length;
  const normative = [...specifications]
    .filter(([path]) => NUMBERED_SPECIFICATION.test(path))
    .reduce(
      (total, [, sections]) =>
        total +
        [...sections].filter(
          ([number, s]) => s.normative && !number.includes('.'),
        ).length,
      0,
    );
  const references = [...cited.values()].reduce(
    (total, count) => total + count,
    0,
  );
  console.log(
    `Atlas specification references verified: ${references} citation(s) across ` +
      `${specifications.size} specification(s) resolve, and every one of the ${normative} ` +
      `normative section(s) in the ${numbered} numbered document(s) is cited from the tree.`,
  );
}

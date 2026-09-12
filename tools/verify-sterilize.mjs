/**
 * What the public repository may not contain.
 *
 * Four kinds of residue are refused here. Dashes used as punctuation, because the writing
 * convention is commas, colons, parentheses, or a new sentence. Names of authoring tools and
 * co-author trailers, because the repository says what the code does and never how it was
 * written. References to internal working documents, because a reader of the public repository
 * cannot follow them and a comment is supposed to cite a specification section or state a
 * reason. Names of private projects, because they belong to their owners.
 *
 * The stage exists so the sweep that removed this residue is measured rather than asserted, and
 * it stays afterwards so the residue cannot come back one comment at a time.
 *
 * ## What is scanned
 *
 * Every tracked file, and every commit message from the commit named below onwards. That is the
 * whole of what becomes public. Where the repository this runs in does not carry that commit, the
 * scan widens to every message it has: the two constants below exempt a stretch of one history,
 * and a history that does not contain them has nothing to exempt.
 *
 * One rule starts later than the others. The words a working list writes its criteria in are held
 * against messages from `FIRST_COMMIT_WITHOUT_CRITERIA_VOCABULARY` onwards, and against every file
 * without exception, because no file spells them that way and none should start.
 *
 * ## What is not scanned, and why each one is out
 *
 * - `standards/data/`. Vendored bytes, byte for byte as their publisher issued them, verified by
 *   digest in `verify:standards-sources`. A dash in a schema or a date in a registry is the
 *   publisher's content. Editing one would break the digest, which is the point of vendoring.
 * - `pnpm-lock.yaml`. A generated record of resolved dependencies. Its words are package names.
 * - `*.generated.ts`, for dashes and for dates only. A generated table carries the data it was
 *   generated from, and CLDR spells a range with an en dash. Names of tools and of private
 *   projects are still refused there, because no source of generated data supplies either.
 * - This file. A scanner has to name what it looks for.
 *
 * ## Where a genuine exception goes
 *
 * `EXEMPTIONS` below, one entry per site, each with the reason it is data rather than prose. The
 * case that is expected to arrive is a test expectation asserting a formatted string, where an
 * engine writes a range with an en dash and the test has to spell what the engine produced. An
 * entry that stops matching anything is itself a failure, so the list cannot outlive its reasons.
 *
 * An entry whose matched text is not distinctive on its own carries `within`, a piece of the line
 * it stands on, so the exemption covers one site rather than every occurrence in the file.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The first commit whose message is held to the convention.
 *
 * History before it was written under no convention and is not rewritten, because rewriting it
 * would change every commit identity the record of that history refers to.
 */
const FIRST_CONVENTIONAL_COMMIT = '059116c';

/**
 * The first commit whose message is held to the criteria rule below.
 *
 * Two published messages before it write their criteria as a working list does. They stay as they
 * are: the public repository starts from a fresh history, and this one keeps its own.
 */
const FIRST_COMMIT_WITHOUT_CRITERIA_VOCABULARY = '03a1a14';

const SKIPPED_PATHS = ['tools/verify-sterilize.mjs'];
const SKIPPED_PREFIXES = ['standards/data/'];
const SKIPPED_SUFFIXES = ['pnpm-lock.yaml'];

/** Files whose text is data produced by a generator rather than prose written by a person. */
const isGenerated = (path) => path.endsWith('.generated.ts');

const EXEMPTIONS = [
  {
    where: 'packages/toolkit/src/static-analysis.ts',
    match: '2026-09-08',
    reason:
      'A diagnostic shows the W3C date format by example, so it dates nothing. An author who ' +
      'wrote the wrong shape needs to see the right one.',
  },
  {
    where: 'packages/runtime/core/src/locale-profile.ts',
    match: '--',
    within: '"`og:locale` -- The locale these tags are marked up in.',
    reason:
      "Open Graph's own sentence, quoted. A quotation is reproduced as its author wrote it, and " +
      'the punctuation is part of what is quoted.',
  },
  {
    where: 'packages/runtime/src/formatting.ts',
    match: 'packages/intl-messageformat/core.ts',
    reason:
      'A file in FormatJS, cited as the precedent for hoisting a formatter store. It is a path ' +
      'into their repository and resolving it against this one is meaningless.',
  },
  {
    where: 'packages/runtime/src/formatting.ts',
    match: 'packages/intl/utils.ts',
    reason:
      'The second file in FormatJS cited beside the first, for the same reason.',
  },
  {
    where: 'tools/trace-artefacts.cjs',
    match: 'packages/runtime/node_modules/.cache',
    reason:
      'A directory the build writes and nothing tracks. The comment names it because it is ' +
      'exactly the path this code has to recognize and not report as a write to the source.',
  },
  {
    where: 'tools/verify-doc-links.mjs',
    match: 'specs/architecture',
    reason:
      'A directory that no longer exists, named as the example of the fault that gate catches. ' +
      'It has to be absent for the sentence to mean anything.',
  },
];

/**
 * En dash and em dash.
 *
 * The other dashes in Unicode are left out on purpose. U+2212 MINUS SIGN is what several locales
 * write a negative number with, and a figure dash is a numeral form. Neither is punctuation in
 * prose, and refusing them would refuse data.
 */
const DASHES = /[–—]/gu;

/**
 * A pair of hyphens standing between words.
 *
 * The same rule as the dash, because it is the same punctuation with a keyboard's spelling. It is
 * refused only with whitespace on both sides, which leaves every form where the pair is syntax:
 * `--flag`, a quoted `'--'` in an argument list, an XML comment's `<!--`, a horizontal rule.
 */
const DOUBLE_HYPHEN = /(?<=^|\s)--(?=\s|$)/gu;

/**
 * The two places the pair is syntax rather than punctuation.
 *
 * A runner separates its own flags from the ones it forwards with a bare `--`, and `git` ends a
 * pathspec list with one. Rewriting either would break the command, so a pair inside a code span
 * is accepted, and so is one on a line that starts by running something, which is how a fenced
 * shell block in a document writes it.
 *
 * Mentioning a command is not running one. This codebase writes `node` as the ordinary word for a
 * position in a tree, and accepting any line that contained the word disarmed the rule on every
 * sentence that happened to use it: ten comments spent the pair as punctuation and the gate
 * reported none of them.
 *
 * One shape is still accepted that is not syntax, and it is recorded here rather than closed. A
 * sentence whose first word is a runner's name reads to this rule as a command, so a pair of
 * hyphens later on that line goes unreported. Telling a command from a sentence needs more than the
 * line it sits on, and a sentence that opens with `node` or `git` and then spends the pair as
 * punctuation is rare enough for a reader to catch. The tree carries no instance of it.
 */
const COMMAND_LEADER = /^\s*(?:\/\/|[*#>$-])?\s*/u;
const RUNS_A_COMMAND =
  /^(?:pnpm|npm|npx|yarn|node|git|tsc|vitest|playwright)\s+[\w:@./-]/u;
const beginsWithACommand = (line) =>
  RUNS_A_COMMAND.test(line.replace(COMMAND_LEADER, ''));

/**
 * Whether an offset falls inside a code span on its line.
 *
 * Counting the backticks before it is enough, because a span opens and closes with one. An odd
 * count puts the offset between an opening backtick and the one that closes it.
 */
const insideACodeSpan = (line, index) =>
  (line.slice(0, index).match(/`/gu)?.length ?? 0) % 2 === 1;

/**
 * Authoring tools and their vendors, and the trailer that credits one.
 *
 * `cursor` is deliberately absent. It is the ordinary word for a position in text, used twelve
 * times in the parser and the authoring transaction for exactly that, and a pattern that cannot
 * tell those from a product name would be answered by weakening it rather than by fixing what it
 * found.
 */
const TOOLS =
  /\b(?:anthropic|claude|chatgpt|openai|gpt-[0-9]|copilot|codex|gemini|llama|codeium|tabnine|windsurf|devin|aider)\b|co-authored-by:|\bai[- ]generated\b|\bwritten by an ai\b/giu;

/** A word that names a working document rather than a file the tooling writes. */
const NAMES_A_WORKING_DOCUMENT =
  /\b(?:plans?|audits?|probes?|spikes?|surveys?|notes?)\b/iu;

/**
 * The name of a published standard, which is what turns a section sign into a citation.
 *
 * A standard is always named where it is cited, because a section number means nothing without
 * the document it numbers: `RFC 5646 §2.2.6` and `XLIFF 2.2 Core §3.2.2.6` send a reader
 * somewhere they can go. A section sign standing on its own points into a working list instead,
 * and that is the difference this tells apart.
 */
const NAMES_A_STANDARD =
  /\b(?:RFC|UAX|UTS|UTR|UAX|LDML|CLDR|XLIFF|XML|ECMA|ISO|IETF|Unicode|WHATWG|W3C)\b/u;

/**
 * The internal working documents, and the shapes their items are numbered in.
 *
 * A public reader cannot open any of it. Where one of these named the reason for a decision, the
 * reason is what the comment should say.
 *
 * Two entries carry an `accept` because the plain form is also ordinary English, and the first
 * reading of this stage is what showed it. A decision is refused where a person is credited with
 * it, not where a sentence says what decides something: the passive names a rule, a build or a
 * standard nineteen times across the specifications and the source and never names a person. The
 * working directory is a real path this repository writes into, named in `.gitignore` and in more
 * than forty tool constants, so a path under it is a fact a reader can check; what is refused is a
 * working document under it, which is a `tmp` on a line that also names one.
 */
const PLAN = [
  { pattern: /\b(?:the|this) plan\b/giu },
  { pattern: /\bremediation\b/giu },
  { pattern: /\bthe lead\b/giu },
  {
    pattern:
      /\b(?:decided|ordered|approved|instructed|authorized|requested)\s+by\s+(?:the\s+)?(?:lead|owner|user|reviewer|him|her|them|me|us)\b/giu,
  },
  {
    pattern:
      /\bthe (?:lead|owner)'s (?:decision|instruction|order|call|batch)\b/giu,
  },
  { pattern: /\baudit\s+[a-z]\d+\b/giu },
  { pattern: /\baudit\s+minor\s+\d+\b/giu },
  { pattern: /\bplan sections?\b/giu },
  { pattern: /\bDM-\d+\b/gu },
  // A letter and a digit in parentheses, which is how a working list labels a defect it has
  // enumerated. The label is the only thing saying which defect, and a public reader has no list
  // to look it up in, so what the sentence relies on has to be in the sentence.
  { pattern: /\([A-Za-z]\d+\)/gu },
  { pattern: /\bdecision\s+\u00a7?\s?\d+(?:\.\d+)?\b/giu },
  // A section sign carrying a two part number, where nothing on the line names a document. That is
  // how a working list numbers its own sections, and a public reader cannot open one. A standard's
  // own sections are cited beside its name, and they run to three parts or four more often than
  // not, so the shape and the name together leave the citations alone.
  {
    pattern: /\u00a7\d+\.\d+(?!\.\d)/gu,
    accept: (line) => !NAMES_A_STANDARD.test(line),
  },
  // A dotted number, because "item 42" is something a shopping cart says and a working list
  // numbers its entries as 3.18.
  { pattern: /\bitem\s+\d+\.\d+\b/giu },
  { pattern: /\bsteps?\s+\d+\.\d+\b/giu },
  // A working list numbers a step with a letter after the digit and a standards document never
  // does. `step 8b` sends a public reader to something they cannot open; RFC 4647's step 3 and
  // RFC 6265bis's step 19 send them to something they can, so the letter is what tells the two
  // apart without an allowlist.
  { pattern: /\bsteps?\s+\d+[a-z]\b/giu },
  // A working list numbers its standing rules, and a comment citing one by number sends a
  // public reader to a document they cannot open. What the comment relies on is what it should
  // say, in a clause, where the reader is.
  { pattern: /\b(?:standing\s+)?rules?\s+\d+\b/giu },
  { pattern: /\bspikes?\b/giu },
  // An instruction file for local work. Neither travels, so a public reader cannot open one,
  // and a comment that cited one was citing a rule where it should have stated it.
  { pattern: /\b(?:AGENTS|CLAUDE)\.md\b/gu },
  {
    pattern: /\btmp\b/giu,
    accept: (line) => NAMES_A_WORKING_DOCUMENT.test(line),
  },
];

/**
 * The words a working list writes its criteria in.
 *
 * The hyphenated form only. A sentence saying what a check fails when is ordinary English and is
 * written that way about thirty times across the specifications, the source and the gates, so the
 * spaced form would refuse the language rather than the reference.
 */
const CRITERIA_VOCABULARY = /\b(?:done|fails)-when\b/giu;

/**
 * A date standing on its own in prose.
 *
 * A date is refused where it dates an internal event, such as a survey, a measurement, or a
 * ruling, because a reader of the public repository has no way to look any of them up and the
 * finding is what matters rather than the day it was made. A date that identifies an external
 * artifact is kept, and the words below are what tell the two apart: a registry has a file date
 * and states when an entry was added, a baseline records when it was captured, a browser baseline
 * is dated, a release is released or published on a day.
 *
 * Only a date written as a word in a sentence is read as prose. One that sits against a quote, an
 * angle bracket, a message-format literal or any other delimiter is a value: a `lastmod` in a
 * fixture, a date operand in a test message, a captured field in a baseline file. A date glued to
 * identifier characters, as in a vendored file name or a profile identity, is part of a token.
 */
const PROSE_DATE = /(?<=^|\s)(?:19|20)\d{2}-\d{2}-\d{2}(?=[\s,;.:]|$)/gu;
const DATE_OF_AN_ARTIFACT =
  /\badded:|\b(?:file[- ]?date|captured\s?on|dated|released|published|version|baseline)\b/iu;

// A changelog heading names a version and the day it was released, which Keep a Changelog
// requires and RELEASING carries out. It dates a published artifact anybody can fetch rather
// than an internal event, so it belongs with the accepted dates above. It is spelled out
// separately because the heading states a release without using any of those words, and the
// bracketed version with its separator is what keeps this from accepting a sentence that
// happens to mention a day.
const CHANGELOG_RELEASE_HEADING =
  /^##\s+\[\d+\.\d+\.\d+[^\]]*\]\s+-\s+(?:19|20)\d{2}-\d{2}-\d{2}\s*$/u;

/**
 * Private projects. They are not this repository's to name.
 *
 * The boundary is a letter or a digit in any script rather than `\b`, which counts only ASCII
 * word characters and so ends a word at the cedilla in Curaçao, a region name in the generated
 * endonym table.
 */
const PRIVATE_PROJECTS =
  /(?<![\p{L}\p{N}])(?:cura|nomad|egary|storefront)(?![\p{L}\p{N}])/giu;

const CATEGORIES = ['dash', 'tool', 'plan', 'private', 'path'];

function trackedFiles() {
  return execFileSync('git', ['ls-files'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean)
    .filter(
      (path) =>
        !SKIPPED_PATHS.includes(path) &&
        !SKIPPED_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
        !SKIPPED_SUFFIXES.some((suffix) => path.endsWith(suffix)),
    );
}

/**
 * The range a rule applies over, given the commit it starts at.
 *
 * A commit named above is a commit in one history. Asking git for a range that begins at a
 * revision it cannot resolve fails the stage on the shape of the history rather than on anything
 * in it, and the answer there is not to exempt less carefully but to exempt nothing: every message
 * in a history that starts after the convention did was written under it.
 */
const rangeFrom = (commit, offset) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    });
  } catch {
    return 'HEAD';
  }
  return `${commit}${offset}..HEAD`;
};

function commitMessages() {
  const log = execFileSync(
    'git',
    ['log', '--format=%H%x00%B%x01', rangeFrom(FIRST_CONVENTIONAL_COMMIT, '')],
    { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  const held = new Set(
    execFileSync(
      'git',
      ['rev-list', rangeFrom(FIRST_COMMIT_WITHOUT_CRITERIA_VOCABULARY, '~1')],
      { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 1 << 28 },
    )
      .split('\n')
      .filter(Boolean),
  );
  return log
    .split('\x01')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, body] = entry.split('\x00');
      return {
        hash: hash.slice(0, 7),
        body: body ?? '',
        criteria: held.has(hash),
      };
    });
}

const findings = [];

function record(category, where, line, text, source) {
  if (
    EXEMPTIONS.some(
      (exemption) =>
        exemption.where === where &&
        exemption.match === text &&
        (exemption.within === undefined || source.includes(exemption.within)),
    )
  ) {
    return;
  }
  findings.push({ category, where, line, text });
}

/**
 * A comment's line wrap, folded away.
 *
 * The scan below reads one line at a time, and a reference split by a wrap matches neither
 * half. That is not hypothetical: of the fifty-seven numbered rule references the pattern
 * above was written for, two were written that way, so a line scan alone would have reported
 * fifty-five and read as clean.
 */
const CONTINUATION_LEADER = /^\s*(?:\*|\/\/|#)?\s*/u;

/**
 * Every match that crosses a line ending, reported against the line it starts on.
 *
 * Only a match spanning the join is reported. One lying wholly inside either line is left to
 * the line scan that already finds it, so nothing is reported twice.
 */
function scanAcrossWrap(category, text, pattern, where) {
  const lines = text.split('\n');
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const head = lines[index];
    const joined = `${head} ${lines[index + 1].replace(CONTINUATION_LEADER, '')}`;
    pattern.lastIndex = 0;
    for (const match of joined.matchAll(pattern)) {
      if (
        match.index < head.length &&
        match.index + match[0].length > head.length + 1
      ) {
        record(category, where, index + 1, match[0], joined);
      }
    }
  }
}

/**
 * Every match of one pattern, reported with the line it sits on.
 *
 * An `accept` is handed the whole match rather than its text, because deciding whether a match is
 * data can need where on the line it sits.
 */
function scan(category, text, pattern, where, accept = () => true) {
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    pattern.lastIndex = 0;
    for (const match of line.matchAll(pattern)) {
      if (!accept(line, match)) continue;
      record(category, where, index + 1, match[0], line);
    }
  }
}

/**
 * A path into this repository, as a comment writes one.
 *
 * Only the five top-level directories a comment has any reason to cite. A path of another shape is
 * a consumer's own layout, a fragment of an example, or a directory a build makes, and holding one
 * of those to this tree would report a fault where there is none.
 */
const REPOSITORY_PATH =
  /\b(?:packages|tools|fixtures|specs|docs)\/[A-Za-z0-9._@/-]*[A-Za-z0-9._-]/gu;

/**
 * The comment text of a source file, line by line, with the code blanked out.
 *
 * Block comments are tracked across lines, which is unambiguous. A line comment counts where the
 * `//` opens the line or follows code carrying no quote, because the other `//` a line holds is
 * almost always the one inside a URL.
 */
function commentLines(text) {
  const comments = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    let comment = '';
    let rest = line;
    while (rest !== '') {
      if (inBlock) {
        const close = rest.indexOf('*/');
        if (close === -1) {
          comment += rest;
          break;
        }
        comment += rest.slice(0, close);
        rest = rest.slice(close + 2);
        inBlock = false;
        continue;
      }
      const block = rest.indexOf('/*');
      const trailing = rest.indexOf('//');
      if (block !== -1 && (trailing === -1 || block < trailing)) {
        rest = rest.slice(block + 2);
        inBlock = true;
        continue;
      }
      if (trailing === -1) break;
      const before = rest.slice(0, trailing);
      if (before.trim() === '' || !QUOTE.test(before)) {
        comment += rest.slice(trailing + 2);
      }
      break;
    }
    comments.push(comment);
  }
  return comments;
}

const QUOTE = /['"`]/u;

/** What a path may trail in prose, and the anchor or line a citation may carry. */
function citedPath(match) {
  return match
    .replace(/#.*$/u, '')
    .replace(/:\d+(?:-\d+)?$/u, '')
    .replace(/[.,;:)\]}]+$/u, '');
}

/**
 * Every repository path a comment names, held to the tree.
 *
 * A comment citing a file is the only cross reference the source carries, and a rename leaves it
 * pointing at nothing with nothing anywhere to say so. A path resolves when it is a tracked file or
 * the directory of one, because a comment names a directory as readily as a file.
 */
function scanCommentPaths(text, where, tracked, directories) {
  for (const [index, comment] of commentLines(text).entries()) {
    REPOSITORY_PATH.lastIndex = 0;
    for (const match of comment.matchAll(REPOSITORY_PATH)) {
      const path = citedPath(match[0]);
      if (path === '' || tracked.has(path) || directories.has(path)) continue;
      record('path', where, index + 1, path, comment);
    }
  }
}

function scanText(text, where, { generated = false, criteria = true } = {}) {
  if (criteria) {
    scan('plan', text, CRITERIA_VOCABULARY, where);
  }
  if (!generated) {
    scan('dash', text, DASHES, where);
    scan(
      'dash',
      text,
      DOUBLE_HYPHEN,
      where,
      (line, match) =>
        !insideACodeSpan(line, match.index) && !beginsWithACommand(line),
    );
    scan(
      'plan',
      text,
      PROSE_DATE,
      where,
      (line) =>
        !DATE_OF_AN_ARTIFACT.test(line) &&
        !CHANGELOG_RELEASE_HEADING.test(line.trim()),
    );
  }
  scan('tool', text, TOOLS, where);
  scan('private', text, PRIVATE_PROJECTS, where);
  for (const { pattern, accept } of PLAN) {
    scan('plan', text, pattern, where, accept);
    scanAcrossWrap('plan', text, pattern, where);
  }
}

const files = trackedFiles();

/**
 * Every tracked path, and every directory one lies in.
 *
 * The path check reads all of them, including the paths the prose scan skips. A comment may cite
 * vendored data or an instruction file, and the citation is still either right or wrong.
 */
const allTracked = new Set(
  execFileSync('git', ['ls-files'], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .split('\n')
    .filter(Boolean),
);
const trackedDirectories = new Set();
for (const path of allTracked) {
  const segments = path.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    trackedDirectories.add(segments.slice(0, depth).join('/'));
  }
}

/** Where a comment lives. A path in a data file or a document is another gate's business. */
const SOURCE_SUFFIXES = ['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js'];

for (const path of files) {
  let text;
  try {
    text = readFileSync(resolve(workspaceRoot, path), 'utf8');
  } catch {
    continue;
  }
  // A file that is not text arrives as replacement characters. Nothing in it is prose.
  if (text.includes('�')) continue;
  scanText(text, path, { generated: isGenerated(path) });
  if (SOURCE_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
    scanCommentPaths(text, path, allTracked, trackedDirectories);
  }
}

const messages = commitMessages();
for (const { hash, body, criteria } of messages) {
  scanText(body, `commit ${hash}`, { criteria });
}

const unusedExemptions = EXEMPTIONS.filter(
  (exemption) =>
    !files.includes(exemption.where) ||
    !readFileSync(resolve(workspaceRoot, exemption.where), 'utf8').includes(
      exemption.within ?? exemption.match,
    ),
);

const counts = Object.fromEntries(
  CATEGORIES.map((category) => [
    category,
    findings.filter((finding) => finding.category === category).length,
  ]),
);

if (findings.length > 0 || unusedExemptions.length > 0) {
  const lines = [
    `Atlas sterilization: ${findings.length} hit(s) across ${files.length} files and ${messages.length} commit messages.`,
    '',
    ...CATEGORIES.map(
      (category) => `  ${category.padEnd(10)} ${counts[category]}`,
    ),
    '',
  ];
  const shown = findings.slice(0, 400);
  for (const finding of shown) {
    lines.push(
      `  ${finding.category.padEnd(8)} ${finding.where}:${finding.line}  ${JSON.stringify(finding.text)}`,
    );
  }
  if (findings.length > shown.length) {
    lines.push(`  and ${findings.length - shown.length} more.`);
  }
  for (const exemption of unusedExemptions) {
    lines.push(
      `  exemption ${exemption.where} matches nothing now. Take it out; the list may not outlive its reasons.`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Atlas sterilization verified: ${files.length} files and ${messages.length} commit messages carry no dash used as punctuation, no authoring tool name or co-author trailer, no reference to an internal document, no private project name, and no path into this repository that does not resolve. ${EXEMPTIONS.length} exemption(s), all still matching.\n`,
  );
}

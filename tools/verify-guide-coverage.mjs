/**
 * Is every capability a consumer can compose written about somewhere a reader will find it?
 *
 * A feature that ships with no page is a feature nobody uses. It passes every other gate here: it
 * is exported, it is reachable, it is tested, and it is invisible. The export gate asks whether
 * anything in this repository reaches an export; this asks whether anything a reader opens tells
 * them it exists.
 *
 * The set is read from the built declarations, so a feature added today is uncovered today rather
 * than whenever someone remembers to add it to a list. Naming it in prose is enough: what a page
 * has to say about a feature is a matter of judgment, and a gate that tried to measure that would
 * be measuring length.
 *
 * Only the how-to guides count. A reference page is generated from the surface itself, so
 * satisfying this from one would be the surface confirming its own coverage, and an explanation page
 * discusses a design rather than telling a reader how to reach it.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composableExports } from './published-surface.mjs';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guidesRoot = join(workspaceRoot, 'docs/how-to');

const guides = readdirSync(guidesRoot)
  .filter((file) => file.endsWith('.md'))
  .sort()
  .map((file) => ({
    file,
    text: readFileSync(join(guidesRoot, file), 'utf8'),
  }));

assert.ok(
  guides.length > 0,
  `No how-to guides under ${guidesRoot}, so every capability below would be reported as uncovered.`,
);

const composables = composableExports();

// A word boundary on both ends, so `withRouting` is not covered by a page that only ever writes
// `withRoutingOptions`, and `provideLocalization` does not cover `provideLocalizationSetup`.
const named = (text, name) => new RegExp(`\\b${name}\\b`, 'u').test(text);

const coverage = new Map(
  [...composables.keys()].map((name) => [
    name,
    guides.filter(({ text }) => named(text, name)).map(({ file }) => file),
  ]),
);

const uncovered = [...coverage]
  .filter(([, pages]) => pages.length === 0)
  .map(([name]) => name);

if (uncovered.length > 0) {
  throw new Error(
    [
      `${uncovered.length} composable export(s) are named by no how-to guide:`,
      ...uncovered.map((name) => `  ${name} (${composables.get(name)})`),
      '',
      'A capability with no page is one a reader has no way to discover. Write about it under',
      'docs/how-to/, or withdraw the export.',
    ].join('\n'),
  );
}

process.stdout.write(
  `Atlas guide coverage verified: ${composables.size} composable export(s) across ${new Set([...composables.values()]).size} entry point(s), each named by at least one of ${guides.length} how-to guide(s).\n`,
);

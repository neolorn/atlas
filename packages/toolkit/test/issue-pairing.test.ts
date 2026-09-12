import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { generateAtlasProject } from '../src/index.js';

/**
 * Messages a running program selects, and whether Atlas can see them being selected.
 *
 * A backend failure code pairs with its message by name rather than through a table an
 * application maintains, which means the code that picks the message is a string from a service
 * and nothing in source names the message at all. Read literally, every one of those messages is
 * unreachable: reported unused, and eventually deleted by someone who believed the report.
 *
 * So a reference to the group counts as a reference to every message in it. Not every reference:
 * walking through `messages` on the way to `messages.appTitle` says nothing about the rest of the
 * scope, and neither does importing it. Only where the group is handed to something that could
 * read any part of it.
 */

const temporaryRoots: string[] = [];

async function write(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const absolute = resolve(root, ...path.split('/'));
  await mkdir(resolve(absolute, '..'), { recursive: true });
  await writeFile(absolute, contents, 'utf8');
}

async function project(body: readonly string[]): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'atlas-issue-pairing-'));
  temporaryRoots.push(root);

  await write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        name: '@example/atlas-issue-pairing',
        version: '0.0.0',
        private: true,
        type: 'module',
        imports: {
          '#i18n': './src/generated/i18n/index.ts',
          '#i18n/*': './src/generated/i18n/*.ts',
        },
      },
      null,
      2,
    )}\n`,
  );
  await write(
    root,
    'atlas.config.json',
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceLocale: 'en-US',
        defaultLocale: 'en-US',
        locales: ['en-US'],
      },
      null,
      2,
    )}\n`,
  );
  await write(
    root,
    'tsconfig.app.json',
    `${JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'preserve',
          moduleResolution: 'bundler',
          resolvePackageJsonImports: true,
          skipLibCheck: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );
  await write(
    root,
    'i18n/shell/en-US.yaml',
    [
      'messages:',
      '  app-title: Issue pairing',
      '  issue.insufficient-stock: Not enough left.',
      '  issue.payment-declined: The payment was declined.',
      '  issue.unknown: Something went wrong.',
      '',
    ].join('\n'),
  );
  await write(root, 'src/app.ts', body.join('\n'));

  return root;
}

async function unreachedMessages(
  body: readonly string[],
): Promise<readonly string[]> {
  const generated = await generateAtlasProject({
    project: await project(body),
  });
  expect(generated.ok).toBe(true);
  const advisory = generated.diagnostics.find(({ code }) => code === 'ATL1311');
  if (advisory === undefined) return [];
  return [...advisory.summary.matchAll(/"([^"]+)"/gu)].map(
    ([, name]) => name as string,
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('messages a running program selects', () => {
  it('counts a group handed to a call as a use of every message in it', async () => {
    const unreached = await unreachedMessages([
      "import { messages } from '#i18n/shell';",
      '',
      'declare function present(',
      '  source: { readonly messages: unknown; readonly unknown: unknown },',
      '): string;',
      '',
      'export const title = messages.appTitle.messageId;',
      'export const issue = present({',
      '  messages: messages.issue,',
      '  unknown: messages.issue.unknown,',
      '});',
      '',
    ]);

    expect(unreached).toEqual([]);
  });

  it('does not count walking through a group on the way to one message', async () => {
    // The assertion that keeps the rule honest. If a receiver counted, this advisory could never
    // fire for any scope any file imports, and its absence would look like a clean catalog.
    const unreached = await unreachedMessages([
      "import { messages } from '#i18n/shell';",
      '',
      'export const title = messages.appTitle.messageId;',
      '',
    ]);

    expect(unreached).toEqual([
      'issue.insufficient-stock',
      'issue.payment-declined',
      'issue.unknown',
    ]);
  });

  it('does not count importing the group', async () => {
    const unreached = await unreachedMessages([
      "import { messages } from '#i18n/shell';",
      '',
      'export const title = messages.appTitle.messageId;',
      'export const spare = messages.issue.unknown.messageId;',
      '',
    ]);

    expect(unreached).toEqual([
      'issue.insufficient-stock',
      'issue.payment-declined',
    ]);
  });
});

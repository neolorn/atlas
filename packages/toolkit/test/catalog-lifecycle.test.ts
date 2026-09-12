import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createAtlasMigrationPlan,
  diffAtlasCatalogSets,
  parseAtlasCatalog,
  parseAtlasConfiguration,
  planAtlasMessageRefactor,
  type AtlasAuthoredChangePlan,
  type AtlasCatalog,
  type AtlasCatalogParseOptions,
  type AtlasProjectConfiguration,
} from '../src/index.js';
import {
  applyAtlasAuthoredChangePlan,
  parseAtlasAuthoredChangePlan,
} from '../src/authoring-transaction.js';

const configurationResult = parseAtlasConfiguration(
  JSON.stringify({
    schemaVersion: 1,
    sourceLocale: 'en-US',
    defaultLocale: 'en-US',
    locales: ['en-US', 'ar-EG'],
  }),
);
if (!configurationResult.ok) throw new Error('configuration fixture failed');
const configuration: AtlasProjectConfiguration = configurationResult.value;

function catalog(
  source: string,
  options: AtlasCatalogParseOptions,
): AtlasCatalog {
  const parsed = parseAtlasCatalog(source, options);
  if (!parsed.ok) throw new Error('catalog fixture failed');
  return parsed.value;
}

const options = (
  scopeId: string,
  locale: string,
  role: 'source' | 'target',
): AtlasCatalogParseOptions => ({
  role,
  providerId: '@example/app',
  scopeId,
  locale,
  sourcePath: `i18n/${scopeId}/${locale}.yaml`,
});

describe('semantic catalog diff', () => {
  it('classifies source, translation, stale, fallback, and identity changes deterministically', () => {
    const beforeSource = catalog(
      'messages:\n  title: "Hello"\n  missing: "Source"\n',
      options('shell', 'en-US', 'source'),
    );
    const beforeTarget = catalog(
      'messages:\n  title: "مرحبًا"\n',
      options('shell', 'ar-EG', 'target'),
    );
    const afterSource = catalog(
      'messages:\n  heading: "Welcome"\n  missing: "Changed source"\n',
      options('shell', 'en-US', 'source'),
    );
    const afterTarget = catalog(
      'messages:\n  heading: "مرحبًا"\n',
      options('shell', 'ar-EG', 'target'),
    );
    const result = diffAtlasCatalogSets({
      before: { configuration, catalogs: [beforeSource, beforeTarget] },
      after: { configuration, catalogs: [afterSource, afterTarget] },
      identityMoves: [
        {
          from: '@example/app:shell:title',
          to: '@example/app:shell:heading',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entries.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        'identity-contract-changed',
        'source-changed',
        'stale-source',
        'fallback-impact',
      ]),
    );
    expect(result.value.digest).toMatch(/^sha256-[A-Za-z0-9_-]{43}$/u);
  });
});

describe('semantic refactors and authored migrations', () => {
  it('strictly reconstructs Atlas-authored plans and rejects duplicate, foreign, or tampered content', () => {
    const created = createAtlasMigrationPlan({
      id: 'strict-plan',
      domain: 'configuration',
      fromVersion: '1',
      toVersion: '1.1',
      changes: [
        {
          path: 'atlas.config.json',
          before: '{"schemaVersion":1}\n',
          after: '{"schemaVersion":1,"sourceLocale":"en-US"}\n',
        },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const source = JSON.stringify(created.value);
    expect(parseAtlasAuthoredChangePlan(source, { kind: 'migration' })).toEqual(
      created,
    );
    expect(
      parseAtlasAuthoredChangePlan(
        source.replace('"id":', '"id":"duplicate","id":'),
        { kind: 'migration' },
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseAtlasAuthoredChangePlan(
        JSON.stringify({ ...created.value, unexpected: true }),
        { kind: 'migration' },
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseAtlasAuthoredChangePlan(
        JSON.stringify({
          ...created.value,
          digest: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        }),
        { kind: 'migration' },
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseAtlasAuthoredChangePlan(
        JSON.stringify({ ...created.value, kind: 'refactor' }),
        { kind: 'migration' },
      ),
    ).toMatchObject({ ok: false });
  });

  it('previews a scope move across catalogs and semantically analyzed source', () => {
    const source = catalog(
      'messages:\n  account.title: "Account"\n  keep: "Keep"\n',
      options('shell', 'en-US', 'source'),
    );
    const target = catalog(
      'messages:\n  account.title: "الحساب"\n  keep: "أبقِ"\n',
      options('shell', 'ar-EG', 'target'),
    );
    const code = 'const value = messages.account.title;\n';
    const start = code.indexOf('messages');
    const result = planAtlasMessageRefactor({
      from: {
        providerId: '@example/app',
        scopeId: 'shell',
        messageId: 'account.title',
      },
      to: {
        providerId: '@example/app',
        scopeId: 'account',
        messageId: 'page-title',
      },
      catalogs: [source, target],
      analysis: {
        messageUsages: [
          {
            identity: '@example/app:shell:account.title',
            sourcePath: 'src/app.ts',
            start,
            end: start + 'messages.account.title'.length,
            surface: 'typescript',
          },
        ],
      },
      sources: [{ path: 'src/app.ts', contents: code }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.affectedUsages).toBe(1);
    expect(result.value.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'i18n/account/en-US.yaml' }),
        expect.objectContaining({ path: 'i18n/account/ar-EG.yaml' }),
        expect.objectContaining({
          path: 'src/app.ts',
          after: 'const value = messages.pageTitle;\n',
        }),
      ]),
    );
  });

  it('applies a validated migration transaction idempotently and refuses stale input before mutation', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'atlas-migration-'));
    try {
      const path = resolve(root, 'atlas.config.json');
      await writeFile(path, '{"schemaVersion":1}\n', 'utf8');
      const plan = createAtlasMigrationPlan({
        id: 'canonical-profile',
        domain: 'configuration',
        fromVersion: '1',
        toVersion: '1.1',
        changes: [
          {
            path: 'atlas.config.json',
            before: '{"schemaVersion":1}\n',
            after: '{"schemaVersion":1,"sourceLocale":"en-US"}\n',
          },
        ],
      });
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      const tampered = {
        ...plan.value,
        digest: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      } as AtlasAuthoredChangePlan;
      expect(
        await applyAtlasAuthoredChangePlan({
          ownerRoot: root,
          plan: tampered,
        }),
      ).toMatchObject({ ok: false });
      expect(await readFile(path, 'utf8')).toBe('{"schemaVersion":1}\n');
      const preview = await applyAtlasAuthoredChangePlan({
        ownerRoot: root,
        plan: plan.value,
        dryRun: true,
      });
      expect(preview).toMatchObject({ ok: true, value: { changed: true } });
      const applied = await applyAtlasAuthoredChangePlan({
        ownerRoot: root,
        plan: plan.value,
      });
      expect(applied).toMatchObject({ ok: true, value: { changed: true } });
      expect(await readFile(path, 'utf8')).toContain('"sourceLocale":"en-US"');
      const repeated = await applyAtlasAuthoredChangePlan({
        ownerRoot: root,
        plan: plan.value,
      });
      expect(repeated).toMatchObject({ ok: true, value: { changed: false } });

      const stale = createAtlasMigrationPlan({
        id: 'stale',
        domain: 'configuration',
        fromVersion: '1.1',
        toVersion: '2',
        changes: [
          {
            path: 'atlas.config.json',
            before: 'unexpected',
            after: 'unsafe',
          },
        ],
      });
      if (!stale.ok) throw new Error('stale plan fixture failed');
      expect(
        await applyAtlasAuthoredChangePlan({
          ownerRoot: root,
          plan: stale.value,
        }),
      ).toMatchObject({ ok: false });
      expect(await readFile(path, 'utf8')).toContain('"sourceLocale":"en-US"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

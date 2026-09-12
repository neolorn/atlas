import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATLAS_TOOLKIT_EVENT_CODES,
  ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
  compileAtlasProject,
  createAtlasMigrationPlan,
  exportAtlasXliff22,
  importAtlasXliff22,
  parseAtlasCatalog,
  parseAtlasConfiguration,
  type AtlasCatalog,
  type AtlasCatalogParseOptions,
  type AtlasProjectConfiguration,
  type AtlasToolkitObservabilityEvent,
  type AtlasToolkitObservabilitySink,
} from '../src/index.js';
import { applyAtlasAuthoredChangePlan } from '../src/authoring-transaction.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function catalog(
  source: string,
  options: AtlasCatalogParseOptions,
): AtlasCatalog {
  const result = parseAtlasCatalog(source, options);
  if (!result.ok) throw new Error('Catalog fixture failed.');
  return result.value;
}

function configuration(): AtlasProjectConfiguration {
  const result = parseAtlasConfiguration(
    JSON.stringify({
      schemaVersion: 1,
      sourceLocale: 'en-US',
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
    }),
  );
  if (!result.ok) throw new Error('Configuration fixture failed.');
  return result.value;
}

const source = catalog(
  [
    'messages:',
    '  private-message: SOURCE PRIVATE PAYLOAD 7f8f',
    '  recovery.unavailable: SOURCE RECOVERY PAYLOAD 1a2b',
    '',
  ].join('\n'),
  {
    role: 'source',
    providerId: '@example/app',
    scopeId: 'shell',
    locale: 'en-US',
    sourcePath: 'i18n/shell/private-source.yaml',
  },
);

const target = catalog(
  [
    'messages:',
    '  private-message: TARGET PRIVATE PAYLOAD 9c0d',
    '  recovery.unavailable: TARGET RECOVERY PAYLOAD 3e4f',
    '',
  ].join('\n'),
  {
    role: 'target',
    providerId: '@example/app',
    scopeId: 'shell',
    locale: 'ar-EG',
    sourcePath: 'i18n/shell/private-target.yaml',
  },
);

function recordingSink(events: AtlasToolkitObservabilityEvent[]) {
  return Object.freeze({
    emit(event: AtlasToolkitObservabilityEvent): void {
      events.push(event);
    },
  }) satisfies AtlasToolkitObservabilitySink;
}

describe('Atlas toolkit observability', () => {
  it('emits exact content-free interchange and compiler events', () => {
    const interchangeEvents: AtlasToolkitObservabilityEvent[] = [];
    const exported = exportAtlasXliff22({
      source,
      target,
      observability: recordingSink(interchangeEvents),
    });
    expect(exported.ok).toBe(true);
    expect(interchangeEvents).toEqual([
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.interchange,
        phase: 'interchange',
        status: 'started',
        providerId: '@example/app',
        scopeId: 'shell',
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.interchange,
        phase: 'interchange',
        status: 'succeeded',
        providerId: '@example/app',
        scopeId: 'shell',
        locale: 'ar-EG',
        count: 2,
      },
    ]);

    const compilerEvents: AtlasToolkitObservabilityEvent[] = [];
    const compiled = compileAtlasProject({
      owner: {
        providerId: '@atlas/test-owner',
        generatedRootPath: 'src/generated/i18n',
      },
      configuration: configuration(),
      catalogs: [source, target],
      recoveryMessageIdentities: ['@example/app:shell:recovery.unavailable'],
      observability: recordingSink(compilerEvents),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compilerEvents).toEqual([
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
        phase: 'compilation',
        status: 'started',
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.compilation,
        phase: 'compilation',
        status: 'succeeded',
        count: compiled.value.artifacts.outputPlan.files.length,
      },
    ]);

    const serialized = JSON.stringify([
      ...interchangeEvents,
      ...compilerEvents,
    ]);
    expect(serialized).not.toContain('PRIVATE PAYLOAD');
    expect(serialized).not.toContain('private-source.yaml');
    expect(serialized).not.toContain('private-target.yaml');
  });

  it('contains thrown sinks without changing the interchange result', () => {
    const expected = exportAtlasXliff22({ source, target });
    const actual = exportAtlasXliff22({
      source,
      target,
      observability: {
        emit(): void {
          throw new Error('sink unavailable');
        },
      },
    });
    expect(actual).toEqual(expected);
  });

  it('suppresses duplicate failures for the same sink and safe context', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const events: AtlasToolkitObservabilityEvent[] = [];
    const observability = recordingSink(events);
    const request = {
      document: '<not-xliff/>',
      source,
      observability,
    } as const;

    expect(importAtlasXliff22(request).ok).toBe(false);
    expect(importAtlasXliff22(request).ok).toBe(false);
    expect(events).toEqual([
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.interchange,
        phase: 'interchange',
        status: 'started',
        providerId: '@example/app',
        scopeId: 'shell',
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.interchange,
        phase: 'interchange',
        status: 'failed',
        diagnosticCode: 'ATL1802',
        providerId: '@example/app',
        scopeId: 'shell',
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.interchange,
        phase: 'interchange',
        status: 'started',
        providerId: '@example/app',
        scopeId: 'shell',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(request.document);
  });

  it('reports migration completion and unchanged replay without plan content', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'atlas-observability-'));
    temporaryRoots.push(root);
    const path = resolve(root, 'atlas.config.json');
    const before = '{"schemaVersion":1}\n';
    const after = '{"schemaVersion":1,"sourceLocale":"en-US"}\n';
    await writeFile(path, before, 'utf8');
    const plan = createAtlasMigrationPlan({
      id: 'observability-migration',
      domain: 'configuration',
      fromVersion: '1',
      toVersion: '1.1',
      changes: [{ path: 'atlas.config.json', before, after }],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const events: AtlasToolkitObservabilityEvent[] = [];
    const observability = recordingSink(events);

    const applied = await applyAtlasAuthoredChangePlan({
      ownerRoot: root,
      plan: plan.value,
      observability,
    });
    const replayed = await applyAtlasAuthoredChangePlan({
      ownerRoot: root,
      plan: plan.value,
      observability,
    });
    expect(applied).toMatchObject({ ok: true, value: { changed: true } });
    expect(replayed).toMatchObject({ ok: true, value: { changed: false } });
    expect(events).toEqual([
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.migration,
        phase: 'migration',
        status: 'started',
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.migration,
        phase: 'migration',
        status: 'succeeded',
        count: 1,
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.migration,
        phase: 'migration',
        status: 'started',
      },
      {
        profile: ATLAS_TOOLKIT_OBSERVABILITY_PROFILE,
        code: ATLAS_TOOLKIT_EVENT_CODES.migration,
        phase: 'migration',
        status: 'unchanged',
        count: 0,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(root);
    expect(JSON.stringify(events)).not.toContain(after);
  });
});

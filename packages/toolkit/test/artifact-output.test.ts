/**
 * The same inputs compiled twice, and the two results compared field for field.
 *
 * Every identity in `specs/05-compiled-artifacts-and-trust.spec.md` section 3 rests on
 * determinism, because a digest over output that varies between runs identifies the run rather
 * than the content. The address and set-identity shapes are section 5 of
 * `specs/05-compiled-artifacts-and-trust.spec.md`, and the emitted module is read here to confirm
 * that no authored prose travelled into it.
 */
import {
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  compileAtlasProject,
  parseAtlasCatalog,
  parseAtlasConfiguration,
  type AtlasCatalog,
  type AtlasProjectConfiguration,
} from '../src/index.js';
import { stringifyAtlasCanonicalJson } from '../src/canonical-json.js';
import { compileAtlasLocalArtifacts } from '../src/compiled-artifacts.js';
import { generateAtlasContracts } from '../src/generated-contracts.js';
import { parseAtlasMessage } from '../src/message-format.js';
import { applyAtlasOutputPlan } from '../src/output-host.js';
import {
  createAtlasCompletionManifest,
  createAtlasOutputPlan,
  formatAtlasCompletionManifest,
  parseAtlasCompletionManifest,
} from '../src/output-plan.js';
import { ATLAS_RESOURCE_LIMITS } from '../src/resource-limits.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

function configuration(): AtlasProjectConfiguration {
  const result = parseAtlasConfiguration(
    JSON.stringify({
      schemaVersion: 1,
      sourceLocale: 'en-US',
      defaultLocale: 'en-US',
      locales: ['en-US', 'ar-EG'],
    }),
  );
  if (!result.ok) throw new Error('Configuration fixture failed');
  return result.value;
}

function catalog(
  role: 'source' | 'target',
  locale: string,
  contents: string,
): AtlasCatalog {
  const result = parseAtlasCatalog(contents, {
    role,
    providerId: '@neolorn/artifact-lab',
    scopeId: 'shell',
    locale,
    sourcePath: `i18n/shell/${locale}.yaml`,
  });
  if (!result.ok) throw new Error('Catalog fixture failed');
  return result.value;
}

function compiledFixture() {
  const source = catalog(
    'source',
    'en-US',
    [
      'messages:',
      '  title: Artifact lab',
      '  welcome: "Welcome {$name}!"',
      '  count: |-',
      '    .input {$value :number}',
      '    .match $value',
      '    1 {{One}}',
      '    * {{Other: {$value}}}',
      '  rich: "Read the {#strong}guide{/strong}."',
      '  recovery.unavailable: Localization is temporarily unavailable.',
      '',
    ].join('\n'),
  );
  const target = catalog(
    'target',
    'ar-EG',
    [
      'messages:',
      '  title: مختبر المخرجات',
      '  welcome: "مرحبًا {$name}!"',
      '  count: |-',
      '    .input {$value :number}',
      '    .match $value',
      '    1 {{واحد}}',
      '    * {{أخرى: {$value}}}',
      '  rich: "اقرأ {#strong}الدليل{/strong}."',
      '  recovery.unavailable: الترجمة غير متاحة مؤقتًا.',
      '',
    ].join('\n'),
  );
  const graph = analyzeAtlasCatalogSet({
    configuration: configuration(),
    catalogs: [source, target],
  });
  if (!graph.ok) throw new Error(JSON.stringify(graph.diagnostics));
  const recovery = '@neolorn/artifact-lab:shell:recovery.unavailable';
  const contracts = generateAtlasContracts(graph.value, {
    recoveryMessageIdentities: [recovery],
  });
  if (!contracts.ok) throw new Error(JSON.stringify(contracts.diagnostics));
  const compiled = compileAtlasLocalArtifacts({
    owner: {
      providerId: '@atlas/test-owner',
      generatedRootPath: 'src/generated/i18n',
    },
    graph: graph.value,
    catalogs: [target, source],
    contractFiles: contracts.value,
    recoveryMessageIdentities: [recovery],
  });
  return { compiled, source, target };
}

describe('Atlas deterministic compiled artifacts', () => {
  it('emits inert IR, full identities, resource summaries, recovery data, and one deterministic output plan', () => {
    const first = compiledFixture().compiled;
    const second = compiledFixture().compiled;
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(second.value).toEqual(first.value);
    expect(first.value.ownerId).toMatch(/^sha256-[\w-]{43}$/u);
    expect(first.value.outputPlan.planDigest).toMatch(/^sha256-[\w-]{43}$/u);
    expect(first.value.catalogs).toHaveLength(2);
    expect(first.value.recovery).toHaveLength(2);
    expect(first.value.descriptor.providers[0]?.catalogSetId).toMatch(
      /^sha256-[\w-]{43}$/u,
    );
    const artifact = first.value.descriptor.providers[0]?.artifacts[0];
    expect(artifact?.address.contentDigest).toMatch(/^sha256-[\w-]{43}$/u);
    expect(artifact?.resources.irNodes).toBeGreaterThan(0);
    expect(artifact?.resources.maximumMessage.variants).toBe(2);
    expect(artifact?.modulePath).toMatch(
      /^catalogs\/[\w-]{43}\/shell\/(?:ar-EG|en-US)\.ts$/u,
    );

    const paths = first.value.outputPlan.files.map(({ path }) => path);
    expect(paths).toContain('catalog-set.json');
    expect(paths).toContain('catalog-loaders.ts');
    expect(paths).toContain('recovery-payload.ts');
    expect(paths).toContain('resource-summary.json');
    const catalogSet = first.value.outputPlan.files.find(
      ({ path }) => path === 'catalog-set.json',
    );
    expect(catalogSet).toBeDefined();
    const parsed = JSON.parse(catalogSet?.contents ?? 'null');
    expect(stringifyAtlasCanonicalJson(parsed)).toBe(catalogSet?.contents);
    const compiledModule = first.value.outputPlan.files.find(({ path }) =>
      path.startsWith('catalogs/'),
    );
    expect(compiledModule?.contents).not.toContain('Welcome {$name}!');
    expect(compiledModule?.contents).not.toContain('canonicalSource');
  });

  it('runs one pure compiler pipeline with deterministic bootstrap contracts and incremental invalidation decisions', () => {
    const { source, target } = compiledFixture();
    const recovery = '@neolorn/artifact-lab:shell:recovery.unavailable';
    const initial = compileAtlasProject({
      owner: {
        providerId: '@atlas/test-owner',
        generatedRootPath: 'src/generated/i18n',
      },
      configuration: configuration(),
      catalogs: [source, target],
      recoveryMessageIdentities: [recovery],
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.value.invalidation.kind).toBe('initial');
    expect(initial.value.invalidation.affectedOutputs.length).toBeGreaterThan(
      0,
    );

    const repeated = compileAtlasProject({
      owner: {
        providerId: '@atlas/test-owner',
        generatedRootPath: 'src/generated/i18n',
      },
      configuration: configuration(),
      catalogs: [source, target],
      recoveryMessageIdentities: [recovery],
      previousState: initial.value.state,
    });
    expect(repeated.ok).toBe(true);
    if (!repeated.ok) return;
    expect(repeated.value.state).toEqual(initial.value.state);
    expect(repeated.value.invalidation).toEqual({
      kind: 'none',
      changedInputs: [],
      affectedOutputs: [],
    });
  });

  it('rejects unsafe output paths and bounds excessive MessageFormat input before parsing', () => {
    const traversal = createAtlasOutputPlan([
      { path: '../escape.ts', contents: 'unsafe' },
    ]);
    expect(traversal.ok).toBe(false);
    expect(traversal.diagnostics[0]?.code).toBe('ATL1503');

    const collision = createAtlasOutputPlan([
      { path: 'Scope.ts', contents: 'a' },
      { path: 'scope.ts', contents: 'b' },
    ]);
    expect(collision.ok).toBe(false);

    const excessive = parseAtlasMessage(
      'x'.repeat(ATLAS_RESOURCE_LIMITS.messageBytes + 1),
    );
    expect(excessive.ok).toBe(false);
    expect(excessive.diagnostics[0]?.code).toBe('ATL1201');
    expect(() => stringifyAtlasCanonicalJson('\ud800')).toThrow(
      /unpaired high surrogate/u,
    );
  });

  it('rejects completion-manifest extensions and case-insensitive inventory collisions', () => {
    const plan = createAtlasOutputPlan([
      { path: 'scope.ts', contents: 'ok\n' },
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const ownerId = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const manifest = createAtlasCompletionManifest(ownerId, plan.value);
    const extended = { ...manifest, consumerField: true };
    expect(
      parseAtlasCompletionManifest(`${JSON.stringify(extended)}\n`).ok,
    ).toBe(false);

    const collision = {
      ...manifest,
      files: [manifest.files[0], { ...manifest.files[0], path: 'SCOPE.ts' }],
    };
    expect(
      parseAtlasCompletionManifest(`${JSON.stringify(collision)}\n`).ok,
    ).toBe(false);
    expect(
      parseAtlasCompletionManifest(formatAtlasCompletionManifest(manifest)).ok,
    ).toBe(true);
  });
});

describe('Atlas owned output publication', () => {
  it('publishes once, preserves unchanged mtimes, removes only manifest-owned stale files, and recovers an interrupted replacement', async () => {
    const ownerRoot = await mkdtemp(resolve(tmpdir(), 'atlas-output-test-'));
    temporaryRoots.push(ownerRoot);
    const generatedRoot = resolve(ownerRoot, 'src/generated/i18n');
    const workRoot = resolve(ownerRoot, '.atlas');
    const ownerId = `sha256-${'a'.repeat(43)}`;
    const firstPlan = createAtlasOutputPlan([
      { path: 'a.txt', contents: 'alpha\n' },
      { path: 'nested/b.txt', contents: 'bravo\n' },
    ]);
    expect(firstPlan.ok).toBe(true);
    if (!firstPlan.ok) return;
    const request = {
      ownerRoot,
      generatedRoot,
      workRoot,
      ownerId,
      plan: firstPlan.value,
    };
    const first = await applyAtlasOutputPlan(request);
    expect(first).toMatchObject({ ok: true, value: { changed: true } });
    const before = await stat(resolve(generatedRoot, 'a.txt'));
    const unchanged = await applyAtlasOutputPlan(request);
    const after = await stat(resolve(generatedRoot, 'a.txt'));
    expect(unchanged).toMatchObject({ ok: true, value: { changed: false } });
    expect(after.mtimeMs).toBe(before.mtimeMs);

    const backup = resolve(generatedRoot, '.a.txt.atlas-crash.bak');
    await rename(resolve(generatedRoot, 'a.txt'), backup);
    await writeFile(resolve(generatedRoot, 'a.txt'), 'interrupted\n');
    await writeFile(
      resolve(workRoot, 'transaction.json'),
      `${JSON.stringify(
        {
          profile: 'atlas-output-transaction/1',
          ownerId,
          operations: [
            {
              path: 'a.txt',
              backup: '.a.txt.atlas-crash.bak',
              hadOriginal: true,
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const recovered = await applyAtlasOutputPlan(request);
    expect(recovered).toMatchObject({ ok: true, value: { changed: false } });
    expect(await readFile(resolve(generatedRoot, 'a.txt'), 'utf8')).toBe(
      'alpha\n',
    );

    const secondPlan = createAtlasOutputPlan([
      { path: 'nested/b.txt', contents: 'bravo two\n' },
      { path: 'c.txt', contents: 'charlie\n' },
    ]);
    expect(secondPlan.ok).toBe(true);
    if (!secondPlan.ok) return;
    const second = await applyAtlasOutputPlan({
      ...request,
      plan: secondPlan.value,
    });
    expect(second).toMatchObject({
      ok: true,
      value: { changed: true, removed: ['a.txt'] },
    });
    await expect(
      readFile(resolve(generatedRoot, 'a.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses mixed ownership and revalidates inputs before publishing changes', async () => {
    const ownerRoot = await mkdtemp(resolve(tmpdir(), 'atlas-output-guard-'));
    temporaryRoots.push(ownerRoot);
    const generatedRoot = resolve(ownerRoot, 'generated');
    const workRoot = resolve(ownerRoot, '.atlas');
    const ownerId = `sha256-${'b'.repeat(43)}`;
    const firstPlan = createAtlasOutputPlan([
      { path: 'owned.txt', contents: 'owned\n' },
    ]);
    if (!firstPlan.ok) return;
    const base = { ownerRoot, generatedRoot, workRoot, ownerId };
    expect(
      await applyAtlasOutputPlan({ ...base, plan: firstPlan.value }),
    ).toMatchObject({ ok: true });

    const changedPlan = createAtlasOutputPlan([
      { path: 'owned.txt', contents: 'changed\n' },
    ]);
    if (!changedPlan.ok) return;
    const staleInput = await applyAtlasOutputPlan({
      ...base,
      plan: changedPlan.value,
      expectedInputFingerprint: 'before',
      revalidateInputFingerprint: () => Promise.resolve('after'),
    });
    expect(staleInput.ok).toBe(false);
    expect(await readFile(resolve(generatedRoot, 'owned.txt'), 'utf8')).toBe(
      'owned\n',
    );

    await writeFile(resolve(generatedRoot, 'consumer-owned.txt'), 'preserve');
    const mixed = await applyAtlasOutputPlan({
      ...base,
      plan: changedPlan.value,
    });
    expect(mixed.ok).toBe(false);
    expect(mixed.diagnostics[0]?.code).toBe('ATL1601');
    expect(
      await readFile(resolve(generatedRoot, 'consumer-owned.txt'), 'utf8'),
    ).toBe('preserve');
  });

  it('keeps dry-run publication read-only for an absent generated root', async () => {
    const ownerRoot = await mkdtemp(resolve(tmpdir(), 'atlas-output-dry-'));
    temporaryRoots.push(ownerRoot);
    const generatedRoot = resolve(ownerRoot, 'generated');
    const workRoot = resolve(ownerRoot, '.atlas');
    const plan = createAtlasOutputPlan([{ path: 'file.txt', contents: 'x' }]);
    if (!plan.ok) return;
    const result = await applyAtlasOutputPlan({
      ownerRoot,
      generatedRoot,
      workRoot,
      ownerId: `sha256-${'c'.repeat(43)}`,
      plan: plan.value,
      dryRun: true,
    });
    expect(result).toMatchObject({ ok: true, value: { changed: true } });
    await expect(stat(generatedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(workRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

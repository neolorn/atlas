import { describe, expect, it } from 'vitest';

import {
  defineAtlasExtensionRegistry,
  exportAtlasXliff22,
  importAtlasXliff22,
  parseAtlasCatalog,
  parseAtlasConfiguration,
  type AtlasCatalog,
  type AtlasCatalogParseOptions,
  type AtlasExtensionDescriptorInput,
} from '../src/index.js';
import { ATLAS_RESOURCE_LIMITS } from '../src/resource-limits.js';
import { atlasDiagnostic, atlasFailure } from '../src/diagnostics.js';

const sourceOptions: AtlasCatalogParseOptions = {
  role: 'source',
  providerId: '@example/app',
  scopeId: 'shell',
  locale: 'en-US',
};

function catalog(
  source: string,
  options: AtlasCatalogParseOptions = sourceOptions,
): AtlasCatalog {
  const result = parseAtlasCatalog(source, options);
  if (!result.ok) throw new Error('The catalog fixture below is invalid.');
  return result.value;
}

describe('bounded authored inputs', () => {
  it('bounds diagnostic count, text, path depth, and spoofing controls', () => {
    const diagnostic = atlasDiagnostic(
      'ATL1701',
      `${'x'.repeat(3_000)}\u202e`,
      { path: Array.from({ length: 100 }, (_, index) => `segment-${index}`) },
    );
    expect([...diagnostic.summary]).toHaveLength(
      ATLAS_RESOURCE_LIMITS.diagnosticSummaryCharacters,
    );
    expect(diagnostic.summary).not.toContain('\u202e');
    expect(diagnostic.path).toHaveLength(
      ATLAS_RESOURCE_LIMITS.diagnosticPathSegments,
    );
    expect(
      atlasFailure(
        Array.from(
          { length: ATLAS_RESOURCE_LIMITS.diagnostics + 10 },
          () => diagnostic,
        ),
      ).diagnostics,
    ).toHaveLength(ATLAS_RESOURCE_LIMITS.diagnostics);
  });

  it('rejects over-deep JSON before recursive construction', () => {
    const nested = `${'{"unknown":'.repeat(70)}null${'}'.repeat(70)}`;
    const result = parseAtlasConfiguration(nested);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({ code: 'ATL1001' });
    expect(result.diagnostics[0]?.summary).toContain('depth ceiling');
  });

  it('rejects structural bidi controls and noncharacters without rejecting ordinary message Unicode', () => {
    const structural = parseAtlasCatalog(
      'messages:\n  unsafe\u202e-id: "Text"\n',
      sourceOptions,
    );
    expect(structural.ok).toBe(false);
    const noncharacter = parseAtlasCatalog(
      'messages:\n  title: "Unsafe \ufdd0"\n',
      sourceOptions,
    );
    expect(noncharacter.ok).toBe(false);
    expect(
      parseAtlasCatalog(
        'messages:\n  title: "Arabic مرحبًا and emoji 🧭"\n',
        sourceOptions,
      ).ok,
    ).toBe(true);
  });

  it('snapshots programmatic extension descriptors without invoking accessors or accepting cycles', () => {
    const accessor = {
      kind: 'identifier-segment',
      id: 'example:sku',
      syntax: 'ascii-token',
      maximumLength: 32,
    } as Record<string, unknown>;
    Object.defineProperty(accessor, 'trap', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute');
      },
    });
    expect(
      defineAtlasExtensionRegistry([
        accessor as unknown as AtlasExtensionDescriptorInput,
      ]).ok,
    ).toBe(false);

    const cyclicOptions: Record<string, unknown> = {};
    cyclicOptions['cycle'] = cyclicOptions;
    expect(
      defineAtlasExtensionRegistry([
        {
          kind: 'rich-slot-kind',
          id: 'example:badge',
          shape: 'paired',
          interactive: false,
          textProjection: 'children',
          options: cyclicOptions,
        } as unknown as AtlasExtensionDescriptorInput,
      ]).ok,
    ).toBe(false);
  });
});

describe('XLIFF parser safety', () => {
  const source = catalog('messages:\n  title: "Rock & Roll"\n');
  const target = catalog('messages:\n  title: "روك & رول"\n', {
    ...sourceOptions,
    role: 'target',
    locale: 'ar-EG',
  });

  it('round-trips escaped ampersands without treating decoded text as an entity', () => {
    const exported = exportAtlasXliff22({ source, target });
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value).toContain('&amp;');
    const imported = importAtlasXliff22({
      document: exported.value,
      source,
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.messages['title']).toMatchObject({
      message: 'روك & رول',
    });
  });

  it('rejects processing instructions, repeated declarations, and unsafe CDATA', () => {
    const exported = exportAtlasXliff22({ source, target });
    if (!exported.ok) throw new Error('XLIFF fixture export failed.');
    expect(
      importAtlasXliff22({
        document: exported.value.replace(
          '<xliff ',
          '<?xml-stylesheet href="unsafe"?><xliff ',
        ),
        source,
      }).ok,
    ).toBe(false);
    expect(
      importAtlasXliff22({
        document: exported.value.replace(
          '<xliff ',
          '<?xml version="1.0"?><xliff ',
        ),
        source,
      }).ok,
    ).toBe(false);
    expect(
      importAtlasXliff22({
        document: exported.value.replace(
          'روك &amp; رول',
          '<![CDATA[unsafe\u0001]]>',
        ),
        source,
      }).ok,
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  ATLAS_HOST_COMPATIBILITY_PROFILE,
  type AtlasHostVersions,
  admitAtlasHostCompatibility,
  currentAtlasHostVersions,
} from '../src/host-compatibility.js';

const supported: AtlasHostVersions = Object.freeze({
  node: '24.15.0',
  typescript: '6.0.2',
  angularCompiler: '22.0.0',
});

describe('Atlas compiler-host compatibility admission', () => {
  it('admits the actual locked development host through the public contract', () => {
    const current = currentAtlasHostVersions();
    const result = admitAtlasHostCompatibility();
    expect(result.ok, JSON.stringify(result.diagnostics, null, 2)).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      profile: 'atlas-host-compatibility/1',
      versions: current,
    });
    expect(ATLAS_HOST_COMPATIBILITY_PROFILE).toEqual({
      profile: 'atlas-host-compatibility/1',
      node: '^22.22.3 || ^24.15.0 || ^26.0.0',
      typescript: '>=6.0.2 <6.1.0',
      angularCompiler: '>=22.0.0 <23.0.0',
    });
  });

  it.each([
    ['22.22.2', false],
    ['22.22.3', true],
    ['22.99.99', true],
    ['23.0.0', false],
    ['24.14.99', false],
    ['24.15.0', true],
    ['24.99.99', true],
    ['25.0.0', false],
    ['26.0.0-rc.1', false],
    ['26.0.0', true],
    ['26.99.99', true],
    ['27.0.0', false],
  ] as const)('checks the exact Node boundary at %s', (node, accepted) => {
    const result = admitAtlasHostCompatibility({ ...supported, node });
    expect(result.ok).toBe(accepted);
    if (!accepted) {
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          code: 'ATL1806',
          path: ['host', 'node'],
        }),
      ]);
    }
  });

  it.each([
    ['5.9.99', false],
    ['6.0.0-beta.1', false],
    ['6.0.0', false],
    ['6.0.1', false],
    ['6.0.2', true],
    ['6.0.99', true],
    ['6.1.0', false],
  ] as const)(
    'checks the exact TypeScript boundary at %s',
    (typescript, accepted) => {
      const result = admitAtlasHostCompatibility({
        ...supported,
        typescript,
      });
      expect(result.ok).toBe(accepted);
      if (!accepted) {
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            code: 'ATL1806',
            path: ['host', 'typescript'],
          }),
        ]);
      }
    },
  );

  it.each([
    ['21.99.99', false],
    ['22.0.0-next.0', false],
    ['22.0.0', true],
    ['22.99.99', true],
    ['23.0.0', false],
  ] as const)(
    'checks the exact Angular compiler boundary at %s',
    (angularCompiler, accepted) => {
      const result = admitAtlasHostCompatibility({
        ...supported,
        angularCompiler,
      });
      expect(result.ok).toBe(accepted);
      if (!accepted) {
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            code: 'ATL1806',
            path: ['host', 'angularCompiler'],
          }),
        ]);
      }
    },
  );

  it('reports every unsupported host component deterministically', () => {
    const result = admitAtlasHostCompatibility({
      node: '23.0.0',
      typescript: '6.1.0',
      angularCompiler: '23.0.0',
    });
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.map(({ code, path }) => ({ code, path })),
    ).toEqual([
      { code: 'ATL1806', path: ['host', 'node'] },
      { code: 'ATL1806', path: ['host', 'typescript'] },
      { code: 'ATL1806', path: ['host', 'angularCompiler'] },
    ]);
  });
});

import { describe, expect, it } from 'vitest';

import { parseAtlasCatalog } from '../src/index.js';
import { generateAtlasContracts } from '../src/generated-contracts.js';
import { analyzeAtlasCatalogSet } from '../src/semantic-model.js';
import { testProjectConfiguration } from './fixtures.js';

/**
 * An unknown route table and an empty one are different answers.
 *
 * The analysis pass reads an overlay of the generated modules rather than the files on disk, and it
 * is the pass that discovers the routes, so the overlay it starts from cannot contain them. Emitted
 * as an empty table written `as const`, that overlay types `routes` as `readonly []`, every field
 * read on a member of it resolves against `never`, and the resulting TypeScript errors are
 * forwarded as ATL1401 against the consumer's own lines. An application whose route table really is
 * empty is a different case and still gets a table.
 */

function catalog(role: 'source' | 'target', locale: string, body: string) {
  const parsed = parseAtlasCatalog(body, {
    role,
    providerId: 'home',
    scopeId: 'shell',
    locale,
    sourcePath: `i18n/shell/${locale}.yaml`,
  });
  if (!parsed.ok) throw new Error(`fixture ${locale} failed to parse`);
  return parsed.value;
}

const graphOf = () => {
  const graph = analyzeAtlasCatalogSet({
    configuration: testProjectConfiguration(['en-US']),
    catalogs: [catalog('source', 'en-US', 'messages:\n  nav.home: Home\n')],
  });
  if (!graph.ok) throw new Error(JSON.stringify(graph.diagnostics));
  return graph.value;
};

const routesModule = (
  options: Parameters<typeof generateAtlasContracts>[1],
): string => {
  const contracts = generateAtlasContracts(graphOf(), options);
  if (!contracts.ok) throw new Error(JSON.stringify(contracts.diagnostics));
  const file = contracts.value.find(({ path }) => path === 'routes.ts');
  if (file === undefined) throw new Error('no routes.ts was generated');
  return file.contents;
};

describe('the route table the analysis overlay starts from', () => {
  it('states what a route table is rather than that there are no routes', () => {
    const contents = routesModule({});

    expect(contents).toContain(
      "import type { GeneratedRouteProjection } from '@neolorn/atlas';",
    );
    expect(contents).toContain(
      'export declare const routeProjection: GeneratedRouteProjection;',
    );
  });

  it('carries no empty table for a reader to resolve a field against', () => {
    // The shape that produced the defect. `Object.freeze([])` closed with `as const` is
    // `readonly []`, and every field read on a member of one is an error about `never`.
    const contents = routesModule({});

    expect(contents).not.toContain('routes: Object.freeze([');
    expect(contents).not.toContain('as const');
  });
});

describe('the route table a generation writes', () => {
  it('is a real table when the application declares routes', () => {
    const contents = routesModule({
      routes: [
        { id: 'route:_index', path: '', parameterNames: [] },
        { id: 'route:second', path: 'second', parameterNames: [] },
      ],
    });

    expect(contents).toContain(
      'export const routeProjection = Object.freeze({',
    );
    expect(contents).toContain('id: "route:_index"');
    expect(contents).toContain('id: "route:second"');
    expect(contents).toContain('as const');
  });

  it('is an empty table when the application declares none', () => {
    // Distinct from the overlay above, and the reason the two cases cannot share one spelling: an
    // application with no routes has a route table, and it has nothing in it.
    const contents = routesModule({ routes: [] });

    expect(contents).toContain(
      'export const routeProjection = Object.freeze({',
    );
    expect(contents).toContain('routes: Object.freeze([');
    expect(contents).not.toContain('declare const');
  });
});

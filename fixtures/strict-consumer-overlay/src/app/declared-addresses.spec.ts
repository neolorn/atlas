import { routeProjection } from '#i18n/routes';

import {
  declaredPathOf,
  declaredRouteCount,
  indexableRouteIds,
} from './declared-addresses';

/**
 * A fixture nothing asserts against is a sample that compiled rather than one that works. What
 * this row exists to prove is that the source above compiles at all, and these keep it honest
 * about what it reads out of the table while it does.
 */
describe('the generated route table read as data', () => {
  it('counts the routes this build declares', () => {
    expect(declaredRouteCount).toBe(routeProjection.routes.length);
    expect(declaredRouteCount).toBeGreaterThan(1);
  });

  it('gives a declared path for the index route', () => {
    expect(declaredPathOf('route:_index')).toBe('/');
  });

  it('reads the indexing class off each member', () => {
    const indexable = indexableRouteIds();

    expect(indexable.length).toBeGreaterThan(0);
    expect(indexable).toEqual(
      routeProjection.routes
        .filter((route) => route.indexing === 'indexable')
        .map((route) => route.id),
    );
  });
});

import type { RouteIdOf } from '@neolorn/atlas';
import { routeProjection } from '#i18n/routes';

import { appRouteProjection } from './localization.routes';

/**
 * The route table, read as data by the application that declared it.
 *
 * An application large enough to have a site map, a navigation tree or a link checker reads the
 * generated table rather than repeating its contents, which is the point of generating it. That is
 * ordinary, and it is the one shape no other consumer row here performs: the rows read routes
 * through `buildLocalizedRoute` and the projection object, and none of them reads a field off a
 * member of the table itself.
 *
 * It belongs in application source rather than in a spec because analysis compiles the program the
 * application's own configuration describes, and that configuration excludes specs. A spec reading
 * this table is never in the program Atlas checks.
 */
type AppRouteId = RouteIdOf<typeof appRouteProjection>;

const canonicalPathById = new Map<AppRouteId, string>(
  routeProjection.routes.map((route) => [
    route.id as AppRouteId,
    `/${route.path}`.replace(/\/$/u, '') || '/',
  ]),
);

/** The path a route was declared at, with its parameters still in it. */
export function declaredPathOf(id: AppRouteId): string | undefined {
  return canonicalPathById.get(id);
}

/** How many routes this build declares. */
export const declaredRouteCount: number = routeProjection.routes.length;

/** The routes this build tells a crawler to index. */
export function indexableRouteIds(): readonly AppRouteId[] {
  return routeProjection.routes
    .filter((route) => route.indexing === 'indexable')
    .map((route) => route.id as AppRouteId);
}

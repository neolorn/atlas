import { Injectable } from '@angular/core';

/**
 * A record whose address in each language is stored with it rather than derived from it.
 *
 * This is the case `RouteParameterCodec` cannot answer. A codec is synchronous and pure, so it can
 * translate a slug that is a function of its value (an integer, an identifier, a word from a
 * fixed table) and it cannot translate one that an editor typed into a database. The article
 * route beside this one has the first shape; this has the second, and the difference is the whole
 * reason `LocalizedRouteParameters` exists.
 *
 * Deliberately keyed by every spelling, because that is what a real store does: the address is the
 * lookup key, and `/ar-eg/dossiers/ملف-أطلس` has to find the same record as
 * `/en-us/dossiers/atlas-dossier`.
 */
export interface FeatureDossier {
  readonly entityId: string;
  /** Locale to slug. What the codec cannot produce and this store can. */
  readonly slugs: Readonly<Record<string, string>>;
}

const DOSSIER: FeatureDossier = Object.freeze({
  entityId: 'atlas-dossier',
  slugs: Object.freeze({
    'en-US': 'atlas-dossier',
    'ar-EG': 'ملف-أطلس',
  }),
});

const BY_SLUG: ReadonlyMap<string, FeatureDossier> = new Map(
  Object.values(DOSSIER.slugs).map((slug) => [slug, DOSSIER]),
);

@Injectable({ providedIn: 'root' })
export class DossierStore {
  /**
   * Asynchronous on purpose, and not as a simulation.
   *
   * The reason a codec cannot answer for these slugs is that the answer is a fetch, so a store
   * that answered synchronously would remove the very constraint this fixture exists to hold. A
   * resolved promise is the shortest fetch there is and it still lands after `NavigationEnd`,
   * which is the position a declaration actually arrives in.
   */
  load(slug: string): Promise<FeatureDossier | undefined> {
    return Promise.resolve(BY_SLUG.get(slug));
  }
}

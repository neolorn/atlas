/**
 * A slug spelled differently in each locale, and the two rules that keep it from leaking.
 *
 * `specs/07-routing-rendering-and-seo.spec.md` section 2 takes a spelling no pure function can
 * produce as a declaration from the page that loaded the record, and stamps it with the
 * navigation that made it. Both halves are tested here because either alone still serves one
 * page's spellings on another: two routes sharing a parameter name, visited in sequence, would
 * otherwise put the first page's slug in the second page's alternate links, where a crawler is
 * told the two are translations of each other.
 *
 * The asymmetry between the two validations is here as well. A codec's own output must read back
 * as the same text; a declared spelling must only be a safe segment the codec can parse, because
 * in another locale it parses to that locale's value rather than to the one the page was
 * addressed with.
 */

import { describe, expect, it } from 'vitest';

import {
  buildLocalizedRoute,
  projectRouteSeo,
  resolveLocalizedRoute,
  type GeneratedConfiguration,
  type LocaleUrlPolicy,
  type RouteParameterCodec,
  type RouteRuntimeProjection,
} from '@neolorn/atlas/core';

/**
 * A parameter spelling the codec cannot produce, supplied by whoever loaded the record.
 *
 * `RouteParameterCodec.serialize` is synchronous and pure, so it answers for a slug that is a
 * function of its value and cannot answer for one held in a database. A declared spelling is that
 * missing half. These cases are about the half of it that lives below Angular: what
 * `buildLocalizedRoute` and `projectRouteSeo` do with a declaration, and, the part that matters
 * most, what they refuse to do with a bad one.
 *
 * The codec here is identity in both directions, which is what an application with a stored slug
 * actually writes. That makes the control exact: with nothing declared, the Arabic address is the
 * English slug, so every assertion that reads a declaration is distinguishable from one that fell
 * back to the codec.
 */

const IDENTITY: RouteParameterCodec<string> = {
  parse: (segment: string) =>
    segment.length > 0 && !segment.startsWith('.')
      ? { ok: true, value: segment }
      : { ok: false },
  serialize: (value: string) => value,
};

/** Reads only what it wrote. Used to prove a declaration is checked rather than trusted. */
const ENGLISH_ONLY: RouteParameterCodec<string> = {
  parse: (segment: string) =>
    segment === 'atlas-dossier' ? { ok: true, value: segment } : { ok: false },
  serialize: (value: string) => value,
};

const POLICY: LocaleUrlPolicy = {
  kind: 'path-prefix',
  defaultLocale: 'en-US',
  locales: { 'en-US': 'en-us', 'ar-EG': 'ar-eg' },
  prefixes: { 'en-us': 'en-US', 'ar-eg': 'ar-EG' },
  aliases: {},
  localeNeutralRoots: [],
  omitDefaultPrefix: false,
};

function projectionWith(codec: RouteParameterCodec): RouteRuntimeProjection {
  return {
    generated: {
      profile: 'atlas-route-projection/1',
      identity: 'sha256-AtlasDeclaredParameterSpellingsFixture01234',
      routes: [
        {
          id: 'dossier',
          path: 'dossiers/:slug',
          parameterNames: ['slug'],
          indexing: 'indexable',
        },
      ],
    },
    parameters: { dossier: { slug: codec } },
  };
}

const PROJECTION = projectionWith(IDENTITY);

const CONFIGURATION: GeneratedConfiguration = {
  generatedAbi: 'atlas-generated/1',
  sourceLocale: 'en-US',
  defaultLocale: 'en-US',
  locales: ['en-US', 'ar-EG'],
  aliases: {},
  applicationContractFingerprint: 'sha256-application-contract-fixture',
  semanticRegistryFingerprint: 'sha256-semantic-registry-fixture',
  scopes: [],
};

const ARABIC_SLUG = 'ملف-أطلس';
const DECLARED = { slug: { 'ar-EG': ARABIC_SLUG } };

describe('a declared route parameter spelling', () => {
  it('replaces what the codec would have written, for that locale only', () => {
    // The control, in the same call shape as the assertion under it.
    expect(
      buildLocalizedRoute(POLICY, PROJECTION, 'dossier', 'ar-EG', {
        slug: 'atlas-dossier',
      }),
    ).toBe('/ar-eg/dossiers/atlas-dossier');

    expect(
      buildLocalizedRoute(
        POLICY,
        PROJECTION,
        'dossier',
        'ar-EG',
        { slug: 'atlas-dossier' },
        [],
        undefined,
        DECLARED,
      ),
    ).toBe(`/ar-eg/dossiers/${encodeURIComponent(ARABIC_SLUG)}`);

    // And a locale the declaration says nothing about is untouched, which is what lets an
    // application declare the two locales it has slugs for and leave the rest to the codec.
    expect(
      buildLocalizedRoute(
        POLICY,
        PROJECTION,
        'dossier',
        'en-US',
        { slug: 'atlas-dossier' },
        [],
        undefined,
        DECLARED,
      ),
    ).toBe('/en-us/dossiers/atlas-dossier');
  });

  it('refuses a declared spelling the codec cannot read back', () => {
    // The declaration is checked, not trusted. An address Atlas emits and cannot resolve is worse
    // than one it never emitted: it becomes an `hreflang` link to a 404, or a locale switch that
    // lands the reader on nothing. The codec here reads only the English slug, so the Arabic
    // declaration is one this application could not serve.
    expect(() =>
      buildLocalizedRoute(
        POLICY,
        projectionWith(ENGLISH_ONLY),
        'dossier',
        'ar-EG',
        { slug: 'atlas-dossier' },
        [],
        undefined,
        DECLARED,
      ),
    ).toThrow(/cannot read its own ar-EG spelling back/u);

    // The same codec and the same route build normally without the declaration, so the refusal
    // above is about the declared spelling rather than about this fixture being unbuildable.
    expect(
      buildLocalizedRoute(
        POLICY,
        projectionWith(ENGLISH_ONLY),
        'dossier',
        'ar-EG',
        {
          slug: 'atlas-dossier',
        },
      ),
    ).toBe('/ar-eg/dossiers/atlas-dossier');
  });

  it('refuses a declared spelling that is not a safe segment', () => {
    // A declaration comes from application data, a slug column an editor can type into, so it
    // is checked the way a codec's own output is. `..` would climb out of the route it belongs to.
    expect(() =>
      buildLocalizedRoute(
        POLICY,
        PROJECTION,
        'dossier',
        'ar-EG',
        { slug: 'atlas-dossier' },
        [],
        undefined,
        { slug: { 'ar-EG': '../etc' } },
      ),
    ).toThrow(/unsafe parameter/u);
  });

  it('spells the canonical and the alternates from one declaration', () => {
    const resolution = resolveLocalizedRoute(
      '/en-us/dossiers/atlas-dossier',
      POLICY,
      PROJECTION,
    );
    expect(resolution.status).toBe('success');
    if (resolution.status !== 'success') return;

    const seo = projectRouteSeo(
      resolution,
      POLICY,
      PROJECTION,
      CONFIGURATION,
      'https://atlas.example',
      DECLARED,
    );
    // The canonical is this page's own locale, which the declaration says nothing about, and the
    // alternate is the one it does. Both from the same call, so a declaration cannot reach one of
    // them and miss the other.
    expect(seo.canonical).toBe(
      'https://atlas.example/en-us/dossiers/atlas-dossier',
    );
    expect(seo.alternates.map(({ locale, url }) => `${locale} ${url}`)).toEqual(
      [
        'en-US https://atlas.example/en-us/dossiers/atlas-dossier',
        `ar-EG https://atlas.example/ar-eg/dossiers/${encodeURIComponent(ARABIC_SLUG)}`,
      ],
    );
  });
});

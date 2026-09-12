# How to serve localized assets

An image with words in it, a logo with a wordmark, a document: those are content, and they change
with the locale.

## Before you begin

You need a composed localization runtime, which is the [tutorial](../tutorial.md).

## Declare the asset

`localizedAsset` lists a source per locale. `resolveLocalizedAsset` picks the one for the locale a
page is in, and reports which locale supplied it.

```ts src/app/assets.spec.ts
import { describe, expect, it } from 'vitest';

import {
  localizedAsset,
  neutralAsset,
  resolveLocalizedAsset,
} from '@neolorn/atlas';

const wordmark = localizedAsset('wordmark', [
  { locale: 'en-US', source: '/assets/wordmark-en.svg' },
  { locale: 'ar-EG', source: '/assets/wordmark-ar.svg' },
]);

const chart = neutralAsset('quarterly-chart', '/assets/chart.svg');

describe('an asset with words in it', () => {
  it('resolves the variant for the locale the page is in', () => {
    const resolved = resolveLocalizedAsset(wordmark, { targetLocale: 'ar-EG' });

    expect(resolved.status).toBe('ready');
    expect(
      resolved.status === 'ready' && resolved.representation,
    ).toMatchObject({
      kind: 'locale-bound',
      source: '/assets/wordmark-ar.svg',
      supplyingLocale: 'ar-EG',
      direction: 'rtl',
    });
  });

  it('reports that it has nothing rather than picking something', () => {
    const resolved = resolveLocalizedAsset(wordmark, { targetLocale: 'fr-FR' });

    expect(resolved.status).toBe('unavailable');
  });

  it('follows a fallback chain, and only one the application wrote', () => {
    const resolved = resolveLocalizedAsset(wordmark, {
      targetLocale: 'fr-FR',
      fallbackLocales: ['en-US'],
    });

    expect(resolved.status === 'ready' && resolved.fallback).toBe(true);
    expect(
      resolved.status === 'ready' &&
        resolved.representation.kind === 'locale-bound' &&
        resolved.representation.supplyingLocale,
    ).toBe('en-US');
  });
});

describe('an asset that does not change', () => {
  it('is the same file in every locale', () => {
    const resolved = resolveLocalizedAsset(chart, { targetLocale: 'ar-EG' });

    expect(resolved.status === 'ready' && resolved.representation.kind).toBe(
      'language-independent',
    );
  });
});
```

Atlas never guesses a fallback chain. A locale with no variant and no `fallbackLocales` resolves to
`unavailable`, and the page decides what to show.

`neutralAsset` declares an asset that does not change with the locale. It is declared rather than
assumed, so an asset carrying words is never treated as neutral by omission.

`fixedLanguageAsset` is for an asset that is in one language on purpose, whatever the page is in. It
resolves with the language and direction you gave it, so a page can mark the region as being in
another language.

## Write the alt text

The alt text is a message like any other, authored in the catalog beside everything else the visitor
reads:

```html excerpt src/app/hero.html
<div [localizedLabel]="messages.asset.alt"></div>
```

`localizedLabel` writes the attribute the element takes, which is
[How to render a message](render-messages.md).

## Related

- [How to render a message](render-messages.md)
- [How to write a message](write-messages.md)
- [About the trust model for translated content](../explanation/about-trusted-content.md)

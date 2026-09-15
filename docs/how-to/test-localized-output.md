# How to test localized output

`@neolorn/atlas/testing` composes the runtime from the generated `localizationSetup` your application
composes, with the same features, so a test and the application cannot drift apart. Three properties
of the test environment decide what a test actually asserts.

## Give the test an address

A localized address is a real address, and nothing under `TestBed` reaches `window.location`, so an
assertion taken from there reads an address bar that never moves. Angular's
`MOCK_PLATFORM_LOCATION_CONFIG` provides a `PlatformLocation` that does move:

```ts excerpt src/app/app.spec.ts
      {
        provide: MOCK_PLATFORM_LOCATION_CONFIG,
        useValue: { startUrl: 'http://localhost:4200/' },
      },
```

A component created by hand is not a component the Router reached. Nothing has an address until a
route is activated, so navigate to the route you mean to be on before reading anything.

## Await the transaction

Catalogs are fetched, participants prepare, and nothing on the page moves until all of it has
succeeded. An assertion made straight after a click reads a switcher that has not moved yet.

Await `changeLocale(locale)`. Do not await a click: the DOM event leaves the test no handle on the
transaction the directive started. Assert the switcher by what it renders, its `href`, `lang`, `dir`
and `aria-current`, and drive the switch through the facade.

## Reset the environment between files

Angular's unit-test builder reuses one DOM across the spec files that land in one worker, so the
address bar, the cookie jar and both web storages are shared. Atlas reads the address for the locale
when routing is configured, and a persistence store when one is composed.

A file that leaves the address at `/ar-eg/second` hands the next file an Arabic page to make English
assertions about. How many files share a DOM depends on how many cores the machine has, so the
failure appears on one machine and not another.

```ts excerpt src/app/app.spec.ts
afterEach(resetLocalizationTestEnvironment);
```

One global `afterEach` rather than a call in each file that navigates, because a file that forgets
fails a different file.

## Hold an arriving catalog open

`LocalizationTestingController` defers the next catalog for a scope and locale, which is how a switch
that is otherwise too fast to observe gets asserted. That is worked through in
[How to add a locale switcher](add-a-locale-switcher.md).

## Assert what an address was answered with

A status, a `Cache-Control`, a canonical link and an `hreflang` cluster are decided by the request
handler and by the head, not by a component, so no `TestBed` assertion reaches them. The seat answers
an address through `createLocaleRequestHandler`, the same handler the deployment installs, and hands
back what was answered:

```text
const seat = createLocalizedServerSeat({ ...serverOptions, origin: 'https://example.com' });

const answered = await seat.request('/en-us/articles/atlas-handbook');

expect(answered.status).toBe(200);
expect(answered.headers.get('content-language')).toBe('en-US');
expect(answered.head.canonical).toBe('https://example.com/en-us/articles/atlas-handbook');
expect(answered.head.alternates.map((link) => link.hreflang)).toContain('ar-EG');
```

Pass the options object your server already builds. The cache lifetimes and the cookie policy decide
every response's cacheability, so a seat configured with different ones answers differently from the
server it stands for.

The head is read from the response body rather than from a DOM, so this needs no browser and no
document. `head.title`, `head.description`, `head.robots`, `head.canonical` and `head.alternates` are
derived; `head.meta`, `head.properties` and `head.links` carry everything the head contained, which
is where a second canonical link or a missing `og:url` shows up.

The address travels as written, so `/en-us/%2e%2e/%2e%2e/etc/passwd` arrives as a target to refuse
rather than as the address it repairs to.

`answered.pageOutcome` is the one thing a response cannot tell you. A page that declared its entity
absent and an address that reaches no route both answer 404, and `declared` says which was asked
while `carried` says whether the declaration decided the response.

The renderer is yours. Give the seat the one your server uses, or a function that returns a document
you wrote, depending on whether the head is what the test is about.

## What else the entry point carries

`ControllableLocalizationParticipant`, for a participant that has to be held open the same way.

`createInMemoryCatalogLoaders`, for catalogs a test builds itself rather than compiling.

`renderedText`, for comparing rendered output without whitespace getting in the way.

## What to assert

Assert what a reader would see: the heading's text, the switcher's attributes, the document's `lang`
and `dir`, and the address. The snapshot's `primaryLocale` says the runtime committed; the heading
says the page rendered.

Two browsers can format the same date differently in the same locale, because the data behind `Intl`
varies, so assert on what your application does with the result rather than on the exact string.

## Related

- [How to negotiate a locale on your own server](negotiate-on-your-own-server.md)
- [How to add a locale switcher](add-a-locale-switcher.md)
- [How to format a value](format-values.md)
- [Compatibility](../reference/compatibility.md)

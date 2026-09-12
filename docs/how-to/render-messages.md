# How to render a message

Four ways to put a message on the page, chosen by what the message is made of.

## Before you begin

You need a compiled scope, which is [How to write a message](write-messages.md).

## Render text in a template

`LocalizePipe` renders a message that is text:

```ts excerpt src/app/app.ts
    <h1>{{ messages.appTitle | localize }}</h1>
```

The pipe is imported by the component that uses it, the way every standalone pipe is. A message that
takes inputs takes them here, and the handle's type refuses a call that leaves one out.

## Render text in an attribute

An `alt`, a `title` and an `aria-label` have to be text and cannot hold markup. `LocalizedLabel`
puts a message there:

```html excerpt src/app/hero.html
<div [localizedLabel]="messages.asset.alt"></div>
```

## Render a message with structure in it

`Read the {#strong}guide{/strong}.` is a message with a slot, not text with tags in it.
`LocalizedMessage` renders it:

```html excerpt src/app/hero.html
<localized-message [handle]="messages.learnMore" />

<localized-message [handle]="messages.helpLink" [slots]="helpBindings" />
```

A slot with no binding renders as the element the message named. A slot you bind becomes what the
binding names:

```ts excerpt src/app/hero.ts
  protected readonly helpBindings = {
    link: {
      kind: 'link' as const,
      destination: internalDestination('/second'),
    },
  };
```

A link's destination comes from your application, wrapped so the two kinds cannot be confused:
`internalDestination` is an address inside your application and `externalDestination` is one outside
it. The wrapper decides what the rendered anchor is allowed to do, which is
[About the trust model for translated content](../explanation/about-trusted-content.md).

Authoring the message this way is what lets a translator move the emphasis to where their language
puts it.

## Render a slot your application defined

`strong`, `emphasis` and `code` render as themselves, `link` takes a link binding and `action` takes
an action binding. Every other slot is a kind your application registered, which is
[How to extend Atlas](extend-atlas.md), and it takes one of two bindings.

A `template` binding puts your own markup around what the translator wrote:

```text
<ng-template #badge let-part>
  <span class="badge" [attr.data-tone]="tone(part)">{{ inner(part) }}</span>
</ng-template>

<localized-message
  [handle]="messages.extension.badge"
  [slots]="{ badge: { kind: 'template', template: badge } }"
/>
```

The context the template receives is the slot part itself. Its `children` are the content the
message carries, its `options` are what the catalog declared on the slot, and its `language` and
`direction` are the supplying catalog's rather than the page's.

A `text` binding replaces the slot's content with text your application supplies:

```text
[slots]="{ badge: { kind: 'text', projection: 'BADGE' } }"
```

The difference is what happens to the translator's words: a template binding wraps them and a text
binding stands in for them. A slot with no binding at all is refused rather than rendered, naming
the slot and the locale that supplied it.

## Render from code

`injectLocalization()` returns the facade:

```ts excerpt src/app/app.ts
  protected readonly localization = injectLocalization();
```

`text(handle)` renders a plain message once. `textSignal(handle)` is the same message as a signal,
for the places a template is not what renders it. `parts(handle)` and `partsSignal(handle)` return
the pieces rather than a string, so you can render them into something a template cannot express.

`changeLocale(locale)` moves the whole application, which is
[How to add a locale switcher](add-a-locale-switcher.md).

## Import what you use

Each of these is a standalone pipe, directive or component, imported by whatever uses it:

```ts excerpt src/app/hero.ts
  imports: [LocalizePipe, LocalizedLabel, LocalizedMessage],
```

Nothing is registered globally, so a component that renders no messages pulls none of it into the
bundle.

## Render into a document you do not own

Atlas sets the document's `lang` and `dir` from the committed locale. A widget rendered inside a host
page that maintains its own should compose `withoutDocumentLocale()`, which leaves the document
alone. It is named for the withdrawal rather than taking a flag, so the default behavior has no
spelling of its own.

## Related

- [How to write a message](write-messages.md)
- [How to serve localized assets](serve-localized-assets.md)
- [About the trust model for translated content](../explanation/about-trusted-content.md)

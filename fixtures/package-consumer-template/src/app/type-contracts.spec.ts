import { describe, expect, it } from 'vitest';

import { RenderMode, type ServerRoute } from '@angular/ssr';
import {
  buildLocalizedRoute,
  issueMessage,
  localizedServerRoutes,
  resolveLocalizedRoute,
  type Localization,
  type PlainMessageHandle,
} from '@neolorn/atlas';
import { configuration } from '#i18n';
import { messages } from '#i18n/shell';

import { routePolicy, appRouteProjection } from './localization.routes';

/**
 * Contracts that are proven by compiling, not by running.
 *
 * Both defects here were type-level and both were invisible to every runtime assertion: the code
 * ran correctly and could not be written. A test that only executes cannot see that, which is why
 * the assertions that matter in this file are the ones the compiler makes before it starts.
 *
 * The negative halves live in `src/negative-message-handle.negative.ts`, compiled one file at a
 * time by the consumer verifier and required to fail. A positive case alone cannot tell a fixed
 * contract from a contract that stopped checking anything, which is precisely the loosening each
 * of these fixes could have been, and was warned against before either was written.
 */

declare const localization: Localization;

describe('type contracts', () => {
  it('a plain handle is callable with no inputs, in both directions', () => {
    // The defect: `PlainMessageHandle` instantiated its inputs as
    // `Readonly<Record<string, unknown>>`, whose `keyof` is `string` rather than `never`, so
    // `MessageInputArguments` made the inputs argument mandatory and `text(handle)` failed with
    // `TS2554: Expected 2 arguments, but got 1`. Two consumers independently wrote the same
    // replacement type to work around it.
    const callableWithNothing: (handle: PlainMessageHandle) => string = (
      handle,
    ) => localization.text(handle);

    // And the other direction, which is the one that actually matters: a generated handle that
    // declares inputs must still be assignable to `PlainMessageHandle`, because that is the
    // declared type of `IssueMessageBinding.message`, `IssueMessageSource.unknown`,
    // `presentExternalValue`'s bindings and `issueMessage`'s return. A fix that narrowed the
    // inputs to make the call compile would have broken every one of those.
    const declaresInputs: PlainMessageHandle = messages.welcome;
    const declaresNone: PlainMessageHandle = messages.appTitle;

    expect(typeof callableWithNothing).toBe('function');
    expect(declaresInputs.messageId).toBeTypeOf('string');
    expect(declaresNone.messageId).toBeTypeOf('string');
  });

  it('issueMessage returns something callable without a cast', () => {
    // The return type is `PlainMessageHandle | undefined`, and the whole point is to hand it
    // straight to `text()`. A wider return type makes this line need an argument nobody has.
    const found = issueMessage(messages, 'SOURCE_ONLY');
    if (found !== undefined) {
      const rendered: string = localization.text(found);
      expect(rendered).toBeTypeOf('string');
    }
    expect(found === undefined || typeof found === 'object').toBe(true);
  });

  it('a resolution feeds back into the builder with no cast', () => {
    // The defect: `resolveLocalizedRoute` returned `routeId: string` and
    // `parameters: Readonly<Record<string, unknown>>`, so everything the generated projection knows
    // about itself was discarded on the way out. `buildLocalizedRoute` is generic and does keep the
    // literals, so the join between them needed a cast: at the one place a mistyped route
    // identity would otherwise be caught, which is what the builder is for.
    const resolved = resolveLocalizedRoute(
      '/en-us/items/42',
      routePolicy,
      appRouteProjection,
    );

    expect(resolved.status).toBe('success');
    if (resolved.status !== 'success') return;

    // No `as` anywhere on this line. `resolved.routeId` is the union of declared identities and
    // `resolved.parameters` is that identity's own parameter shape, so the builder accepts them
    // as they are.
    const rebuilt = buildLocalizedRoute(
      routePolicy,
      appRouteProjection,
      resolved.routeId,
      resolved.locale,
      resolved.parameters,
    );

    expect(rebuilt).toBe(resolved.canonicalPath);
  });

  it('the identity is a literal union rather than string', () => {
    const resolved = resolveLocalizedRoute(
      '/en-us',
      routePolicy,
      appRouteProjection,
    );
    if (resolved.status !== 'success') {
      expect(resolved.status).toBe('success');
      return;
    }
    // Narrowness is proven without listing the union. Writing the members out would pin this test
    // to the lab's route table, so adding a route to the fixture would fail it for no reason,
    // and the pinned copy would be the thing maintained, not the contract. A declared identity is
    // assignable to the resolution's own type; an undeclared one is refused, which
    // `negative-message-handle.negative.ts` asserts. `string` satisfies neither claim, so the pair
    // is what rules it out.
    const declared: typeof resolved.routeId = 'item';
    expect(typeof declared).toBe('string');
  });

  it("The server table is Angular's own ServerRoute[], with no cast", () => {
    // The assertion is the annotation, and it is the whole point of the test: this line did
    // not compile before, so every consumer wrote `as ServerRoute[]` over the entire table.
    // A cast that wide silences far more than the thing it was added for (a wrong render
    // mode, a missing `getPrerenderParams`, a misspelled field) and it sat on the one file
    // where a mistake produces a page that exists in one language and 404s in the other.
    //
    // Three things forced it, each measured on its own: the returned array was `readonly`,
    // `getPrerenderParams` promised a `readonly` array, and one object type carrying a union
    // `renderMode` matches no member of a discriminated union. `Readonly<Record<...>>` on the
    // entries was never at fault and still stands.
    const table: ServerRoute[] = localizedServerRoutes(
      routePolicy,
      appRouteProjection,
      configuration,
      [{ routeId: 'route:second', renderMode: RenderMode.Prerender }],
      { canonicalRenderMode: RenderMode.Server, fallback: RenderMode.Server },
    );

    // And the array itself is the caller's to hand on, which `withRoutes` requires.
    expect(Object.isFrozen(table)).toBe(false);
    expect(table.at(-1)).toEqual({ path: '**', renderMode: RenderMode.Server });
  });
});

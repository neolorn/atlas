/**
 * What a spec file leaves behind, undone once here rather than in forty-three places.
 *
 * `@angular/build:unit-test` runs Vitest with `isolate: false`, to match the Karma experience it
 * replaced, so every spec file that lands in the same worker shares one jsdom: one `history`, one
 * `document.cookie`, one `localStorage`. How many workers there are is a property of the machine,
 * not of this application: a 32-thread developer machine gives most files one each and this is
 * invisible, a two-core CI runner gives them two and it is not.
 *
 * The address bar is the surface that matters, and it matters because of what this application is:
 * Atlas resolves the locale from the address, so a file that navigates to `/ar-eg/second` and does
 * not come back hands the next file an Arabic page to make English assertions about. Measured, on
 * one commit with nothing else changed: four assertions fail in two files when the whole suite runs
 * in a single worker, and seven fail in four different files on a two-core runner. Different
 * victims, one cause, and neither list means anything about the code under test.
 *
 * The undoing itself is `@neolorn/atlas/testing`'s, not this fixture's. Every consumer inherits the
 * same two halves, Angular's shared DOM and Atlas's address-bar locale source, so a copy here
 * would be a copy of the thing the package exports for exactly this.
 */
import { afterEach } from 'vitest';

import { resetLocalizationTestEnvironment } from '@neolorn/atlas/testing';

afterEach(resetLocalizationTestEnvironment);

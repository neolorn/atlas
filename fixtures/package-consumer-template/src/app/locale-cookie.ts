import type { CookieStoreOptions } from '@neolorn/atlas';
import type { LocaleCookiePolicy } from '@neolorn/atlas/http';

/**
 * One cookie, declared once, read by both halves of this application.
 *
 * The server writes it on the first response and the browser rewrites it after hydration, and until
 * `b8fc087` those two were configured separately: `server.ts` left Atlas's `Secure` default on,
 * `app.config.ts` turned it off. Chromium and Firefox treat `http://127.0.0.1` as a secure context,
 * so the browser's write replaced the server's and nothing showed. WebKit does not, so the write
 * was refused, a non-secure origin may not overwrite a `Secure` cookie, `document.cookie` read
 * empty, and the locale switch was never remembered. One engine of three, on one platform of two,
 * from two lines that were each defensible where they stood.
 *
 * Putting them back is the failing half: two declarations, and the WebKit row goes red on Linux.
 *
 * `secure: false` states what this lab is: served over `http` on loopback, by a gate, and nowhere
 * else. A deployment leaves Atlas's default on, and `locale-cookie-defaults.test.ts` in the runtime
 * asserts that both halves of Atlas agree about what that default is.
 *
 * `satisfies` both option types rather than one: the two halves take separately declared shapes,
 * and this is where a consumer finds out if they stop accepting the same thing.
 */
export const localeCookie = {
  name: 'atlas-locale',
  secure: false,
} as const satisfies CookieStoreOptions & Exclude<LocaleCookiePolicy, false>;

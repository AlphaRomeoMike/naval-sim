// Deployment settings, read at build time from .env files (see README "Going live").
// Nothing here is secret: it all ships to the browser.
const env = import.meta.env;

/** Base URL of the entitlement worker. */
export const API: string = env.VITE_API_BASE || (env.DEV ? 'http://127.0.0.1:8787' : ''); // '' = a hosted build with no store yet

export interface Pack { id: string; name: string; price: string; grants: string[]; blurb: string; checkout: string }

/**
 * The store's catalogue. Names and text use designations only, never manufacturer trademarks.
 * `checkout` is the merchant of record's hosted checkout link for that product; empty = not for sale yet.
 */
export const PACKS: Pack[] = [
  {
    id: 'us-late', name: 'Late Cold War US Navy', price: '$2.99', grants: ['us-late'], checkout: env.VITE_CHECKOUT_US_LATE || '',
    blurb: 'FFG-7 long hull and the FFG Upgrade fit, SH-60B, F-14A, F/A-18C, Los Angeles class Flight II and 688i, with their weapons and the VLAD buoy.',
  },
  {
    id: 'ussr-late', name: 'Late Cold War Soviet Navy', price: '$2.99', grants: ['ussr-late'], checkout: env.VITE_CHECKOUT_USSR_LATE || '',
    blurb: 'Sovremenny, Slava, Akula and the Tu-22M3 with AS-4, with their weapons.',
  },
  {
    id: 'full', name: 'Full Fleet', price: '$4.99', grants: ['us-late', 'ussr-late'], checkout: env.VITE_CHECKOUT_FULL || '',
    blurb: 'Both late Cold War packs.',
  },
];

/**
 * The link the game opens to hand the buyer to the merchant of record. Provider-specific: this is Lemon
 * Squeezy's custom-data syntax, which comes back to the worker in the webhook as meta.custom_data.
 * `nonce` identifies this checkout once; `device` is this installation's id.
 */
export function checkoutUrl(pack: Pack, nonce: string, device: string): string {
  const u = new URL(pack.checkout);
  u.searchParams.set('checkout[custom][cid]', nonce);
  u.searchParams.set('checkout[custom][dev]', device);
  return u.toString();
}

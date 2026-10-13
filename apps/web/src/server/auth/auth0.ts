import { Auth0Client } from "@auth0/nextjs-auth0/server";

import { missingAuth0Config } from "./access";

let client: Auth0Client | null = null;

/**
 * The Auth0 client, configured from `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`,
 * `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET` (cookie encryption) and
 * `APP_BASE_URL` (comma-separated when the Studio has several hostnames).
 * Throws when one is missing, so a misconfigured Studio refuses requests.
 */
export function auth0(): Auth0Client {
  if (client) return client;
  const missing = missingAuth0Config();
  if (missing.length) throw new Error(`sign-in is not configured: set ${missing.join(", ")}`);
  client = new Auth0Client({
    // a session lasts at most 7 days and ends after a day without use
    session: { rolling: true, absoluteDuration: 7 * 24 * 60 * 60, inactivityDuration: 24 * 60 * 60 },
  });
  return client;
}

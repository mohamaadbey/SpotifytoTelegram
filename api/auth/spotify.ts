import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAuthorizationUrl } from "../../src/lib/spotify.js";

/**
 * Initiates Spotify OAuth flow.
 * Redirects the user's browser to Spotify's authorization page.
 *
 * Query params:
 *   - state: base64url-encoded Telegram chat ID
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const state = req.query.state as string;

  if (!state) {
    return res.status(400).send("Missing state parameter.");
  }

  const authUrl = getAuthorizationUrl(state);
  return res.redirect(302, authUrl);
}

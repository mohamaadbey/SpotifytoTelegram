import type { SpotifyTokens, SpotifyPlaylist } from "../types/index.js";
import type { User } from "@prisma/client";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_URL = "https://api.spotify.com/v1";

const SCOPES = "playlist-read-private playlist-read-collaborative";

function getCredentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Missing Spotify credentials in environment variables");
  }

  return { clientId, clientSecret, redirectUri };
}

/**
 * Build the Spotify OAuth authorization URL.
 * The `state` parameter carries the Telegram chat ID (base64-encoded)
 * so we can link the callback back to the correct user.
 */
export function getAuthorizationUrl(state: string): string {
  const { clientId, redirectUri } = getCredentials();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUri,
    state,
    show_dialog: "true",
  });

  return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange an authorization code for access + refresh tokens.
 */
export async function exchangeCode(code: string): Promise<SpotifyTokens> {
  const { clientId, clientSecret, redirectUri } = getCredentials();

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${error}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresIn: data.expires_in as number,
  };
}

/**
 * Refresh an expired access token using the refresh token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<SpotifyTokens> {
  const { clientId, clientSecret } = getCredentials();

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${error}`);
  }

  const data = (await res.json()) as Record<string, unknown>;

  return {
    accessToken: data.access_token as string,
    // Spotify may or may not return a new refresh token
    refreshToken: (data.refresh_token as string) || refreshToken,
    expiresIn: data.expires_in as number,
  };
}

/**
 * Get a valid access token for a user, refreshing if expired.
 * Returns the token and whether it was refreshed (so caller can update DB).
 */
export async function getValidAccessToken(
  user: Pick<User, "spotifyAccessToken" | "spotifyRefreshToken" | "spotifyTokenExpiry">
): Promise<{ accessToken: string; tokens?: SpotifyTokens }> {
  if (!user.spotifyAccessToken || !user.spotifyRefreshToken) {
    throw new Error("SPOTIFY_NOT_CONNECTED");
  }

  // Refresh if token expires within the next 60 seconds
  const bufferMs = 60 * 1000;
  const isExpired = !user.spotifyTokenExpiry || user.spotifyTokenExpiry.getTime() - bufferMs < Date.now();

  if (!isExpired) {
    return { accessToken: user.spotifyAccessToken };
  }

  const tokens = await refreshAccessToken(user.spotifyRefreshToken);
  return { accessToken: tokens.accessToken, tokens };
}

/**
 * Fetch the current user's Spotify profile.
 */
export async function getSpotifyUserId(accessToken: string): Promise<string> {
  const res = await fetch(`${SPOTIFY_API_URL}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Spotify profile: ${res.status}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return data.id as string;
}

/**
 * Fetch ALL playlists the user owns or follows.
 * Handles pagination automatically (50 per page).
 */
export async function getUserPlaylists(accessToken: string): Promise<SpotifyPlaylist[]> {
  const playlists: SpotifyPlaylist[] = [];
  let url: string | null = `${SPOTIFY_API_URL}/me/playlists?limit=50`;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      if (res.status === 401) {
        throw new Error("SPOTIFY_TOKEN_EXPIRED");
      }
      if (res.status === 429) {
        throw new Error("SPOTIFY_RATE_LIMITED");
      }
      throw new Error(`Spotify API error: ${res.status}`);
    }

    const data = (await res.json()) as {
      items: Array<{
        id: string;
        name: string;
        external_urls?: { spotify: string };
        owner?: { display_name: string };
      } | null>;
      next: string | null;
    };

    for (const item of data.items) {
      // Skip null items (can happen if a playlist was deleted)
      if (!item) continue;

      playlists.push({
        id: item.id,
        name: item.name,
        url: item.external_urls?.spotify || `https://open.spotify.com/playlist/${item.id}`,
        owner: item.owner?.display_name || "Unknown",
      });
    }

    url = data.next; // null when no more pages
  }

  return playlists;
}

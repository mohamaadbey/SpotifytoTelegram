import type { VercelRequest, VercelResponse } from "@vercel/node";
import { prisma } from "../../src/lib/prisma.js";
import { sendMessage } from "../../src/lib/telegram.js";
import {
  exchangeCode,
  getSpotifyUserId,
  getUserPlaylists,
} from "../../src/lib/spotify.js";

/**
 * Handles Spotify OAuth callback.
 * Exchanges authorization code for tokens, seeds existing playlists,
 * and notifies the user on Telegram.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const error = req.query.error as string | undefined;

  // User denied authorization
  if (error) {
    return res.status(200).send(htmlPage(
      "Authorization Denied",
      "You denied the Spotify authorization request. You can try again with /connect in the bot."
    ));
  }

  if (!code || !state) {
    return res.status(400).send(htmlPage(
      "Invalid Request",
      "Missing authorization code or state parameter."
    ));
  }

  // Decode the Telegram chat ID from the state parameter
  let chatId: string;
  try {
    chatId = Buffer.from(state, "base64url").toString("utf-8");
  } catch {
    return res.status(400).send(htmlPage("Invalid Request", "Invalid state parameter."));
  }

  try {
    // 1. Exchange authorization code for tokens
    const tokens = await exchangeCode(code);

    // 2. Fetch Spotify user profile
    const spotifyUserId = await getSpotifyUserId(tokens.accessToken);

    // 3. Calculate token expiry
    const tokenExpiry = new Date(Date.now() + tokens.expiresIn * 1000);

    // 4. Update user with Spotify credentials
    const user = await prisma.user.upsert({
      where: { telegramChatId: chatId },
      update: {
        spotifyAccessToken: tokens.accessToken,
        spotifyRefreshToken: tokens.refreshToken,
        spotifyTokenExpiry: tokenExpiry,
        spotifyUserId,
        isActive: true,
      },
      create: {
        telegramChatId: chatId,
        spotifyAccessToken: tokens.accessToken,
        spotifyRefreshToken: tokens.refreshToken,
        spotifyTokenExpiry: tokenExpiry,
        spotifyUserId,
      },
    });

    // 5. Seed existing playlists so user doesn't get spammed with old ones
    const playlists = await getUserPlaylists(tokens.accessToken);

    if (playlists.length > 0) {
      // Delete any previously tracked playlists (in case of reconnection)
      await prisma.notifiedPlaylist.deleteMany({ where: { userId: user.id } });

      // Insert all current playlists as "already notified"
      await prisma.notifiedPlaylist.createMany({
        data: playlists.map((p) => ({
          userId: user.id,
          spotifyPlaylistId: p.id,
          playlistName: p.name,
        })),
        skipDuplicates: true,
      });
    }

    // 6. Notify user on Telegram
    await sendMessage(
      chatId,
      `✅ <b>Spotify connected successfully!</b>\n\n` +
        `👤 Logged in as: <b>${spotifyUserId}</b>\n` +
        `📋 Currently tracking ${playlists.length} playlist(s)\n\n` +
        `I'll now send you a message whenever you save or follow a new playlist. 🎶`
    );

    // 7. Show success page in the browser
    return res.status(200).send(htmlPage(
      "Connected! ✅",
      `Your Spotify account (${spotifyUserId}) has been linked. You can close this page and return to Telegram.`
    ));
  } catch (err) {
    console.error("OAuth callback error:", err);

    // Try to notify the user about the failure
    try {
      await sendMessage(chatId, "❌ Failed to connect Spotify. Please try again with /connect.");
    } catch {
      // Ignore notification errors
    }

    return res.status(500).send(htmlPage(
      "Connection Failed",
      "Something went wrong while connecting your Spotify account. Please try again with /connect in the bot."
    ));
  }
}

/** Simple HTML response page */
function htmlPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #1a1a2e;
      color: #e0e0e0;
    }
    .card {
      background: #16213e;
      border-radius: 16px;
      padding: 40px;
      max-width: 420px;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 { color: #1DB954; margin-bottom: 16px; }
    p { line-height: 1.6; color: #b0b0b0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

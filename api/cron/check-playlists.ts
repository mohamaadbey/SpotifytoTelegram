import type { VercelRequest, VercelResponse } from "@vercel/node";
import { prisma } from "../../src/lib/prisma.js";
import { sendMessage } from "../../src/lib/telegram.js";
import { getValidAccessToken, getUserPlaylists } from "../../src/lib/spotify.js";

/**
 * Cron job: checks all active users' Spotify playlists for new additions.
 * Triggered by Vercel Cron every 5 minutes.
 *
 * Security: Validates the CRON_SECRET header that Vercel sends automatically.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const results = { checked: 0, notified: 0, errors: 0 };

  try {
    // Fetch all active users with Spotify tokens
    const users = await prisma.user.findMany({
      where: {
        isActive: true,
        spotifyRefreshToken: { not: null },
      },
      include: {
        notifiedPlaylists: {
          select: { spotifyPlaylistId: true },
        },
      },
    });

    results.checked = users.length;

    for (const user of users) {
      try {
        await checkUserPlaylists(user);
      } catch (error) {
        results.errors++;
        console.error(`Error checking user ${user.telegramChatId}:`, error);

        await handleUserError(user, error);
      }
    }
  } catch (error) {
    console.error("Cron job fatal error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }

  console.log(`Cron complete: ${JSON.stringify(results)}`);
  return res.status(200).json({ ok: true, ...results });
}

type UserWithPlaylists = Awaited<ReturnType<typeof prisma.user.findMany>>[number] & {
  notifiedPlaylists: { spotifyPlaylistId: string }[];
};

async function checkUserPlaylists(user: UserWithPlaylists) {
  // 1. Get valid access token (auto-refresh if expired)
  const { accessToken, tokens } = await getValidAccessToken(user);

  // 2. If tokens were refreshed, update the DB
  if (tokens) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        spotifyAccessToken: tokens.accessToken,
        spotifyRefreshToken: tokens.refreshToken,
        spotifyTokenExpiry: new Date(Date.now() + tokens.expiresIn * 1000),
      },
    });
  }

  // 3. Fetch current playlists from Spotify
  const currentPlaylists = await getUserPlaylists(accessToken);

  // 4. Find new playlists (not yet in notified_playlists)
  const notifiedIds = new Set(user.notifiedPlaylists.map((p) => p.spotifyPlaylistId));
  const newPlaylists = currentPlaylists.filter((p) => !notifiedIds.has(p.id));

  if (newPlaylists.length === 0) return;

  // 5. Send notifications and record them
  for (const playlist of newPlaylists) {
    try {
      await sendMessage(
        user.telegramChatId,
        `🎵 <b>New playlist detected!</b>\n\n` +
          `📋 <b>${escapeHtml(playlist.name)}</b>\n` +
          `👤 by ${escapeHtml(playlist.owner)}\n\n` +
          `🔗 <a href="${playlist.url}">Open on Spotify</a>`
      );

      await prisma.notifiedPlaylist.create({
        data: {
          userId: user.id,
          spotifyPlaylistId: playlist.id,
          playlistName: playlist.name,
        },
      });
    } catch (error) {
      console.error(`Failed to notify playlist ${playlist.id} for user ${user.telegramChatId}:`, error);

      // If the user blocked the bot, stop processing
      if (error instanceof Error && error.message === "TELEGRAM_USER_BLOCKED") {
        await prisma.user.update({
          where: { id: user.id },
          data: { isActive: false },
        });
        return;
      }
    }
  }
}

/**
 * Handle user-level errors: deactivate on token revocation, log otherwise.
 */
async function handleUserError(user: UserWithPlaylists, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  // Refresh token revoked or invalid
  if (message.includes("Token refresh failed") || message.includes("SPOTIFY_NOT_CONNECTED")) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        isActive: false,
        spotifyAccessToken: null,
        spotifyRefreshToken: null,
        spotifyTokenExpiry: null,
      },
    });

    try {
      await sendMessage(
        user.telegramChatId,
        `⚠️ <b>Spotify connection lost</b>\n\n` +
          `Your Spotify authorization has expired or been revoked.\n` +
          `Please reconnect with /connect.`
      );
    } catch {
      // Ignore — user may have also blocked the bot
    }
  }

  // Rate limited — skip silently, will retry next cycle
  if (message === "SPOTIFY_RATE_LIMITED") {
    console.warn(`Rate limited for user ${user.telegramChatId}, will retry next cycle`);
  }
}

/** Escape HTML special characters to prevent injection in Telegram messages */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

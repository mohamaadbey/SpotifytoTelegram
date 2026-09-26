import type { VercelRequest, VercelResponse } from "@vercel/node";
import type { TelegramUpdate } from "../../src/types/index.js";
import { prisma } from "../../src/lib/prisma.js";
import { sendMessage } from "../../src/lib/telegram.js";
import { getAuthorizationUrl } from "../../src/lib/spotify.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Always respond 200 to Telegram to prevent retries
  try {
    const update: TelegramUpdate = req.body;

    if (!update.message?.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = update.message.chat.id.toString();
    const text = update.message.text.trim();
    const firstName = update.message.from.first_name;

    switch (text) {
      case "/start":
        await handleStart(chatId, firstName);
        break;
      case "/connect":
        await handleConnect(chatId);
        break;
      case "/status":
        await handleStatus(chatId);
        break;
      case "/disconnect":
        await handleDisconnect(chatId);
        break;
      case "/help":
        await handleHelp(chatId);
        break;
      default:
        await sendMessage(chatId, "Unknown command. Use /help to see available commands.");
    }
  } catch (error) {
    console.error("Webhook error:", error);
  }

  return res.status(200).json({ ok: true });
}

async function handleStart(chatId: string, firstName: string) {
  // Upsert user — create if new, do nothing if exists
  await prisma.user.upsert({
    where: { telegramChatId: chatId },
    update: {},
    create: { telegramChatId: chatId },
  });

  await sendMessage(
    chatId,
    `👋 Welcome, <b>${firstName}</b>!\n\n` +
      `I can monitor your Spotify playlists and notify you whenever you save or follow a new one.\n\n` +
      `To get started, connect your Spotify account:\n` +
      `👉 /connect — Link your Spotify account\n\n` +
      `<b>Other commands:</b>\n` +
      `/status — Check connection status\n` +
      `/disconnect — Unlink Spotify\n` +
      `/help — Show this help message`
  );
}

async function handleConnect(chatId: string) {
  // Upsert user in case they skipped /start
  await prisma.user.upsert({
    where: { telegramChatId: chatId },
    update: {},
    create: { telegramChatId: chatId },
  });

  // Encode chatId in state parameter for OAuth callback
  const state = Buffer.from(chatId).toString("base64url");
  const appUrl = process.env.APP_URL;

  if (!appUrl) {
    await sendMessage(chatId, "❌ Bot is not configured correctly. Please contact the admin.");
    return;
  }

  const authUrl = `${appUrl}/api/auth/spotify?state=${state}`;

  await sendMessage(
    chatId,
    `🔗 <b>Connect your Spotify account</b>\n\n` +
      `Click the link below to authorize access to your playlists:\n\n` +
      `<a href="${authUrl}">Connect Spotify</a>\n\n` +
      `<i>This will only access your playlist information — nothing else.</i>`
  );
}

async function handleStatus(chatId: string) {
  const user = await prisma.user.findUnique({
    where: { telegramChatId: chatId },
    include: { _count: { select: { notifiedPlaylists: true } } },
  });

  if (!user) {
    await sendMessage(chatId, "You haven't started the bot yet. Use /start first.");
    return;
  }

  if (!user.spotifyRefreshToken) {
    await sendMessage(chatId, "❌ Spotify is <b>not connected</b>.\n\nUse /connect to link your account.");
    return;
  }

  await sendMessage(
    chatId,
    `✅ Spotify is <b>connected</b>\n\n` +
      `👤 Spotify ID: <code>${user.spotifyUserId}</code>\n` +
      `📋 Tracked playlists: ${user._count.notifiedPlaylists}\n` +
      `🔄 Checking for new playlists every 5 minutes`
  );
}

async function handleDisconnect(chatId: string) {
  const user = await prisma.user.findUnique({
    where: { telegramChatId: chatId },
  });

  if (!user || !user.spotifyRefreshToken) {
    await sendMessage(chatId, "You don't have a Spotify account connected.");
    return;
  }

  // Clear Spotify tokens and tracked playlists
  await prisma.notifiedPlaylist.deleteMany({ where: { userId: user.id } });
  await prisma.user.update({
    where: { id: user.id },
    data: {
      spotifyAccessToken: null,
      spotifyRefreshToken: null,
      spotifyTokenExpiry: null,
      spotifyUserId: null,
    },
  });

  await sendMessage(
    chatId,
    `🔓 Spotify account has been <b>disconnected</b>.\n\n` +
      `You will no longer receive playlist notifications.\n` +
      `Use /connect to link a new account anytime.`
  );
}

async function handleHelp(chatId: string) {
  await sendMessage(
    chatId,
    `📖 <b>Available Commands</b>\n\n` +
      `/start — Start the bot\n` +
      `/connect — Connect your Spotify account\n` +
      `/status — Check connection status\n` +
      `/disconnect — Unlink Spotify account\n` +
      `/help — Show this help message\n\n` +
      `<i>Once connected, I'll automatically notify you when you save or follow a new playlist on Spotify.</i>`
  );
}

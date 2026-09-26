const getTelegramApi = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  return `https://api.telegram.org/bot${token}`;
};

export async function sendMessage(chatId: string, text: string): Promise<void> {
  const res = await fetch(`${getTelegramApi()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    console.error(`Telegram sendMessage failed: ${res.status}`, error);

    // User blocked the bot
    if (res.status === 403) {
      throw new Error("TELEGRAM_USER_BLOCKED");
    }

    throw new Error(`Telegram API error: ${res.status} ${error}`);
  }
}

export async function setWebhook(url: string): Promise<void> {
  const res = await fetch(`${getTelegramApi()}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Failed to set webhook: ${res.status} ${error}`);
  }

  console.log(`Webhook set to: ${url}`);
}

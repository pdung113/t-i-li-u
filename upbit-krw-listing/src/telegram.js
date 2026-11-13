import { chainById } from "./networks.js";

export function resultText(info) {
  const lines = [`DEX ${info.market || ""}`.trim()];
  if (info.dry) {
    lines.push("Chưa mua: đang ở chế độ xem thử, không gửi giao dịch.");
  } else if (info.ok) {
    lines.push("Mua được.");
  } else {
    lines.push("Không mua được.");
  }
  if (info.chain) lines.push(`Mạng: ${info.chain}`);
  if (info.contract) lines.push(`Contract: ${info.contract}`);
  if (info.venue) lines.push(`Sàn: ${info.venue}`);
  if (info.tx) lines.push(`Tx: ${info.tx}`);
  if (info.gasMultiple) lines.push(`Gas x${info.gasMultiple}`);
  if (info.reason) lines.push(`Lý do: ${info.reason}`);
  if (info.url) lines.push(info.url);
  return lines.join("\n");
}

export function armedText(listing, config) {
  const chain = chainById(listing.chain);
  const symbol = chain?.symbol || "native";
  const amount = config?.amount ?? "";
  return [
    `Upbit báo listing mới ${listing.market}.`,
    `Mua ngay trên DEX ${listing.chain || "chưa rõ mạng"}, contract ${listing.contract || "chưa có"}.`,
    `Số lượng ${amount} ${symbol}, gas x${config?.gasMultiple ?? 2}.`,
  ].join(" ");
}

export async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return { skipped: true };
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok && json.ok === true, description: json.description || "" };
}

export async function discoverChatId(token) {
  const response = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`);
  const json = await response.json().catch(() => ({}));
  if (!json.ok) {
    return { error: json.description || "Không đọc được tin nhắn của bot." };
  }
  const updates = Array.isArray(json.result) ? json.result : [];
  for (let i = updates.length - 1; i >= 0; i -= 1) {
    const chat = updates[i].message?.chat || updates[i].edited_message?.chat || updates[i].my_chat_member?.chat;
    if (chat?.id != null) return { chatId: String(chat.id) };
  }
  return { error: "Bot chưa thấy tin nhắn. Mở bot, bấm Start, gửi một dòng bất kỳ, rồi lấy lại." };
}

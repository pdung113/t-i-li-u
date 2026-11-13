import { formatKst } from "./notice.js";

export function resultText(info) {
  const lines = [`Upbit ${info.market}`];
  if (info.dry) {
    lines.push("Chưa mua: đang ở chế độ xem thử, không gửi lệnh.");
  } else if (info.ok) {
    lines.push("Mua được.");
  } else {
    lines.push("Không mua được.");
  }
  if (info.kind === "limit") lines.push(`Loại: giới hạn, giá ${info.price} KRW, số lượng ${info.volume}`);
  if (info.kind === "market") lines.push(`Loại: thị trường, tổng ${info.price} KRW`);
  if (info.orderUuid) lines.push(`Mã lệnh: ${info.orderUuid}`);
  if (info.when) lines.push(`Giờ mua dự kiến: ${formatKst(info.when)}`);
  if (info.reason) lines.push(`Lý do: ${info.reason}`);
  if (info.url) lines.push(info.url);
  return lines.join("\n");
}

export function armedText(listing, plan) {
  const when = listing.openAt == null ? "khi cặp KRW mở" : formatKst(listing.openAt + listing.buyBanMs);
  const price = plan?.params?.ord_type === "limit"
    ? `, giá trần ${plan.params.price} KRW`
    : plan?.params?.ord_type === "price"
      ? `, mua thị trường ${plan.params.price} KRW`
      : "";
  return `Upbit: thấy listing mới ${listing.market}. Sẽ mua lúc ${when}${price}.`;
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

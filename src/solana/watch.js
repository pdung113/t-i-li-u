import WebSocket from "ws";
import { fromNotification, fromRpcTransaction } from "./detect.js";
import { sleep } from "./swap.js";

export function transactionSubscribeRequest(target, { tokenAccounts = true } = {}) {
  const filter = {
    failed: false,
    vote: false,
    accountInclude: [target],
  };
  if (tokenAccounts) filter.tokenAccounts = "balanceChanged";
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "transactionSubscribe",
    params: [
      filter,
      {
        commitment: "processed",
        encoding: "jsonParsed",
        transactionDetails: "full",
        showRewards: false,
        maxSupportedTransactionVersion: 1,
      },
    ],
  };
}

export function logsSubscribeRequest(target) {
  return {
    jsonrpc: "2.0",
    id: 2,
    method: "logsSubscribe",
    params: [{ mentions: [target] }, { commitment: "processed" }],
  };
}

async function fetchProcessedTransaction(rpcUrl, signature) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [signature, { commitment: "processed", encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }],
      }),
      signal: AbortSignal.timeout(2500),
    });
    const body = await response.json();
    const parsed = fromRpcTransaction(signature, body.result);
    if (parsed) return parsed;
    await sleep(80 * (attempt + 1));
  }
  return null;
}

export function watchWallet({ wsUrl, rpcUrl, target, onTransaction, log }) {
  let stopped = false;
  let socket;
  let ping;
  let retryMs = 1000;
  let mode = "transaction";
  const seenLogs = new Set();

  const sendSubscribe = () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (mode === "logs") {
      socket.send(JSON.stringify(logsSubscribeRequest(target)));
      log("Đang nghe bằng logsSubscribe ở mức processed.");
      return;
    }
    socket.send(JSON.stringify(transactionSubscribeRequest(target, { tokenAccounts: mode === "transaction" })));
    log(mode === "transaction" ? "Đang nghe transactionSubscribe ở mức processed." : "Đang nghe transactionSubscribe, không mở rộng token account.");
  };

  const handleMessage = async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.id === 1 && message.error) {
      const text = message.error.message || JSON.stringify(message.error);
      if (mode === "transaction" && /tokenAccounts|invalid/i.test(text)) {
        mode = "plain";
        sendSubscribe();
        return;
      }
      mode = "logs";
      log(`transactionSubscribe không dùng được (${text}).`);
      sendSubscribe();
      return;
    }
    if (message.method === "transactionNotification") {
      const tx = fromNotification(message.params?.result);
      if (tx) await onTransaction(tx);
      return;
    }
    if (message.method === "logsNotification") {
      const value = message.params?.result?.value;
      if (!value?.signature || value.err || seenLogs.has(value.signature)) return;
      seenLogs.add(value.signature);
      const tx = await fetchProcessedTransaction(rpcUrl, value.signature);
      if (tx) await onTransaction(tx);
    }
  };

  const connect = () => {
    socket = new WebSocket(wsUrl);
    socket.on("open", () => {
      retryMs = 1000;
      sendSubscribe();
      clearInterval(ping);
      ping = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.ping();
      }, 25_000);
      ping.unref?.();
    });
    socket.on("message", (data) => {
      handleMessage(data).catch((error) => log(`Lỗi khi đọc giao dịch: ${error.message}`));
    });
    socket.on("close", () => {
      clearInterval(ping);
      if (stopped) return;
      log("Mất kết nối. Đang nghe lại.");
      setTimeout(connect, retryMs).unref?.();
      retryMs = Math.min(retryMs * 2, 15_000);
    });
    socket.on("error", () => {});
  };

  connect();
  return () => {
    stopped = true;
    clearInterval(ping);
    socket?.close();
  };
}

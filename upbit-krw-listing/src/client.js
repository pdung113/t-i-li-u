import WebSocket from "ws";
import { queryString, signJwt } from "./auth.js";
import { extractNotices, noticeIdFromUrl } from "./notice.js";

const API = "https://api.upbit.com";
const NOTICES = "https://api-manager.upbit.com/api/v1/announcements";

const publicHeaders = {
  Accept: "application/json",
  "Accept-Language": "ko-KR,ko;q=0.9",
  "User-Agent": "Mozilla/5.0",
};

export function createClient({ accessKey, secretKey }) {
  async function publicGet(url) {
    const response = await fetch(url, { headers: publicHeaders });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, date: response.headers.get("date") };
  }

  async function exchange(method, path, params) {
    const query = params ? queryString(params) : "";
    const headers = {
      Authorization: `Bearer ${signJwt(accessKey, secretKey, query)}`,
      Accept: "application/json",
    };
    let url = `${API}${path}`;
    const init = { method, headers };
    if (method === "GET" || method === "DELETE") {
      if (query) url += `?${query}`;
    } else if (query) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(params);
    }
    const response = await fetch(url, init);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: { name: "bad_response", message: text.slice(0, 180) } };
    }
    return { status: response.status, json };
  }

  return {
    async krwBalance() {
      const { status, json } = await exchange("GET", "/v1/accounts");
      if (status !== 200 || !Array.isArray(json)) {
        const name = json?.error?.name || `HTTP ${status}`;
        const message = json?.error?.message || "";
        const error = new Error(`${name}${message ? `: ${message}` : ""}`);
        error.code = name;
        throw error;
      }
      const row = json.find((item) => item.currency === "KRW");
      return row ? Number(row.balance) : 0;
    },

    async listNotices() {
      const { status, json } = await publicGet(`${NOTICES}?os=web&page=1&per_page=20&category=trade&cb=${Date.now()}`);
      if (status !== 200) {
        const error = new Error(`Danh sách thông báo HTTP ${status}`);
        error.status = status;
        throw error;
      }
      return extractNotices(json);
    },

    async fetchNotice(idOrUrl) {
      const id = noticeIdFromUrl(idOrUrl);
      if (!id) return null;
      const { status, json } = await publicGet(`${NOTICES}/${encodeURIComponent(id)}`);
      if (status !== 200) return null;
      return extractNotices(json)[0] || null;
    },

    listenAnnouncements(onNotice, { onStatus } = {}) {
      let socket = null;
      let stopped = false;
      let retryMs = 1000;
      let ping = null;

      const connect = () => {
        if (stopped) return;
        const token = signJwt(accessKey, secretKey);
        socket = new WebSocket("wss://api.upbit.com/websocket/v1/private", {
          headers: { Authorization: `Bearer ${token}` },
          perMessageDeflate: false,
        });
        socket.on("open", () => {
          retryMs = 1000;
          onStatus?.("connected");
          socket.send(JSON.stringify([
            { ticket: "krw-listing" },
            { type: "announcement", categories: ["trade"], include_body: true },
            { format: "DEFAULT" },
          ]));
          clearInterval(ping);
          ping = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.ping();
          }, 30_000);
        });
        socket.on("message", (data) => {
          const receivedAt = Date.now();
          const text = typeof data === "string" ? data : data.toString("utf8");
          let message = null;
          try {
            message = JSON.parse(text);
          } catch {
            return;
          }
          if (message?.error) {
            onStatus?.(`error:${message.error.name || "ws"}`);
            return;
          }
          if ((message?.type || message?.ty) === "announcement") onNotice({ ...message, receivedAt });
        });
        socket.on("close", () => {
          clearInterval(ping);
          onStatus?.("closed");
          if (stopped) return;
          setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 15_000);
        });
        socket.on("error", () => {
          onStatus?.("error");
        });
      };

      connect();
      return () => {
        stopped = true;
        clearInterval(ping);
        socket?.close();
      };
    },
  };
}

const ADDRESS_RE = /(?<![a-fA-F0-9])0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g;

// fxtwitter trả timeline rỗng (HTTP 404) với user-agent lạ. Mozilla/5.0 thì đọc được.
const HEADERS = {
  accept: "application/json",
  "user-agent": "Mozilla/5.0 (compatible; x-snipe/1.0)",
};

const RESERVED = new Set([
  "home",
  "explore",
  "search",
  "settings",
  "messages",
  "notifications",
  "i",
  "intent",
  "share",
  "hashtag",
  "compose",
]);

/**
 * @param {string} input
 * @returns {{ handle: string | null, statusId: string | null }}
 */
export function parseTwitterTarget(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Thiếu link X");

  const at = raw.match(/^@([A-Za-z0-9_]{1,15})$/);
  if (at) return { handle: at[1], statusId: null };

  let url;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Link X không đọc được: ${raw}`);
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const allowed = new Set([
    "x.com",
    "twitter.com",
    "mobile.twitter.com",
    "mobile.x.com",
    "fxtwitter.com",
    "fixupx.com",
    "vxtwitter.com",
  ]);
  if (!allowed.has(host)) {
    throw new Error(`Không phải link X: ${url.hostname}`);
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const statusIdx = parts.findIndex((part) => part === "status" || part === "statuses");
  const statusId =
    statusIdx >= 0 && parts[statusIdx + 1] && /^\d+$/.test(parts[statusIdx + 1]) ? parts[statusIdx + 1] : null;

  // https://x.com/i/web/status/<id> không có username. Handle lấy từ API sau.
  if (parts[0] === "i") {
    if (statusId) return { handle: null, statusId };
    throw new Error("Link X này không phải trang dự án");
  }

  const handle = parts[0]?.replace(/^@/, "");
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || RESERVED.has(handle.toLowerCase())) {
    throw new Error(`Không lấy được username từ: ${raw}`);
  }
  return { handle, statusId };
}

export function authorHandle(tweet) {
  const raw = tweet?.author?.screen_name || tweet?.user?.screen_name || tweet?.author?.handle;
  if (typeof raw !== "string") return null;
  const handle = raw.replace(/^@/, "");
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
}

export function collectStrings(value, skipKeys = new Set(["author", "reposted_by"])) {
  const out = [];
  const walk = (node, key) => {
    if (node == null) return;
    if (typeof node === "string") {
      out.push(node);
      return;
    }
    if (typeof node === "number" || typeof node === "boolean") return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (skipKeys.has(k)) continue;
        walk(v, k);
      }
    }
  };
  walk(value, "");
  return out;
}

/** @param {unknown} tweet */
export function extractAddresses(tweet) {
  const text = collectStrings(tweet).join("\n");
  const found = text.match(ADDRESS_RE) || [];
  const unique = [];
  const seen = new Set();
  for (const addr of found) {
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(addr);
  }
  return unique;
}

export function tweetTimestamp(tweet) {
  const ts = Number(tweet?.created_timestamp);
  return Number.isFinite(ts) ? ts : 0;
}

function readJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {string} handle
 * @param {number} status
 * @param {unknown} body
 */
export function readTimelineBody(handle, status, body) {
  if (status === 204) return [];
  if (status === 429) {
    const err = new Error("X đang giới hạn tốc độ (429)");
    err.code = 429;
    throw err;
  }
  const results = Array.isArray(body?.results) ? body.results : null;
  // API này dùng 404 + results rỗng cho username sai, hết tweet, và cả lúc bị giới hạn.
  if (status === 404 && results) {
    const err = new Error(`Timeline @${handle} trống, thử lại.`);
    err.code = 404;
    err.empty = true;
    throw err;
  }
  if (status < 200 || status >= 300) {
    const err = new Error(`Không đọc được timeline @${handle} (HTTP ${status})`);
    err.code = status;
    throw err;
  }
  if (!results) {
    const err = new Error(`Không đọc được timeline @${handle} (thiếu results)`);
    err.code = status;
    throw err;
  }
  return results.filter((item) => item && (item.type === "status" || item.text || item.raw_text));
}

/**
 * @param {string} handle
 * @param {{ since?: number, signal?: AbortSignal }} [opts]
 * `since` là timestamp tweet đã thấy (giây). API exclusive nên trừ 1, khỏi bỏ sót tweet cùng giây.
 */
export async function fetchStatuses(handle, opts = {}) {
  const url = new URL(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}/statuses`);
  url.searchParams.set("count", "8");
  url.searchParams.set("with_replies", "1");
  if (opts.since) {
    const since = Number(opts.since);
    if (Number.isFinite(since) && since > 0) {
      url.searchParams.set("since", String(Math.max(0, Math.floor(since) - 1)));
    }
  }

  const res = await fetch(url, { signal: opts.signal, headers: HEADERS });
  const body = readJson(await res.text());
  try {
    return readTimelineBody(handle, res.status, body);
  } catch (error) {
    if (error?.code === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 120) {
        error.retryAfterMs = Math.round(retryAfter * 1000);
      }
    }
    throw error;
  }
}

/** @param {string} statusId */
export async function fetchStatus(statusId, opts = {}) {
  const url = `https://api.fxtwitter.com/2/status/${statusId}`;
  const res = await fetch(url, { signal: opts.signal, headers: HEADERS });
  if (res.status === 429) {
    const err = new Error(`X đang giới hạn tốc độ khi đọc tweet ${statusId}`);
    err.code = 429;
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 120) {
      err.retryAfterMs = Math.round(retryAfter * 1000);
    }
    throw err;
  }
  const body = readJson(await res.text());
  if (!res.ok) {
    throw new Error(`Không đọc được tweet ${statusId} (HTTP ${res.status})`);
  }
  return body?.status || body?.tweet || body?.result || null;
}

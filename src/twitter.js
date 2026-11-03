const ADDRESS_RE = /0x[a-fA-F0-9]{40}/g;

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
 * @returns {{ handle: string, statusId: string | null }}
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
  if (parts[0] === "i") {
    throw new Error("Link X này không phải trang dự án");
  }
  const handle = parts[0]?.replace(/^@/, "");
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle) || RESERVED.has(handle.toLowerCase())) {
    throw new Error(`Không lấy được username từ: ${raw}`);
  }

  let statusId = null;
  const statusIdx = parts.findIndex((p) => p === "status" || p === "statuses");
  if (statusIdx >= 0 && parts[statusIdx + 1] && /^\d+$/.test(parts[statusIdx + 1])) {
    statusId = parts[statusIdx + 1];
  }
  return { handle, statusId };
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

/**
 * @param {string} handle
 * @param {{ since?: number, signal?: AbortSignal }} [opts]
 */
async function fetchStatusesOnce(handle, opts = {}) {
  const url = new URL(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}/statuses`);
  url.searchParams.set("count", "8");
  url.searchParams.set("with_replies", "1");
  if (opts.since) url.searchParams.set("since", String(opts.since));

  const res = await fetch(url, {
    signal: opts.signal,
    headers: {
      accept: "application/json",
      "user-agent": "x-snipe/1.0",
    },
  });

  if (res.status === 204) return [];
  const bodyText = await res.text();
  let body = null;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = null;
    }
  }
  if (res.status === 429) {
    const err = new Error("X đang giới hạn tốc độ (429)");
    err.code = 429;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Không đọc được timeline @${handle} (HTTP ${res.status})`);
    err.code = res.status;
    throw err;
  }
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.filter((item) => item && (item.type === "status" || item.text || item.raw_text));
}

export async function fetchStatuses(handle, opts = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetchStatusesOnce(handle, opts);
    } catch (error) {
      lastError = error;
      if (error.code !== 404 || attempt === 2 || opts.signal?.aborted) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

/** @param {string} statusId */
export async function fetchStatus(statusId, opts = {}) {
  const url = `https://api.fxtwitter.com/2/status/${statusId}`;
  const res = await fetch(url, {
    signal: opts.signal,
    headers: {
      accept: "application/json",
      "user-agent": "x-snipe/1.0",
    },
  });
  if (!res.ok) {
    throw new Error(`Không đọc được tweet ${statusId} (HTTP ${res.status})`);
  }
  const body = await res.json();
  return body.status || body.tweet || body.result || null;
}

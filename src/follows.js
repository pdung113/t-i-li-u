import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const API = "https://api.fxtwitter.com";
const USER_AGENT = "x-snipe/1.0";

export class FollowError extends Error {
  /**
   * @param {string} message
   * @param {"not_found" | "private" | "rate" | "unavailable" | "telegram"} code
   */
  constructor(message, code) {
    super(message);
    this.name = "FollowError";
    this.code = code;
  }
}

export function freshState() {
  return { bootstrapped: false, emptyOk: false, seen: new Set(), corrupt: false };
}

/**
 * @param {unknown} raw
 */
export function normalizeUser(raw) {
  if (!raw || typeof raw !== "object") return null;
  const record = /** @type {Record<string, unknown>} */ (raw);
  if (record.type && record.type !== "profile") return null;
  const handle = String(record.screen_name || "").replace(/^@/, "");
  const id = record.id == null ? "" : String(record.id);
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || !/^\d+$/.test(id)) return null;
  const following = Number(record.following);
  const name = String(record.name || handle).replace(/[\r\n\t]+/g, " ").trim() || handle;
  const givenUrl = typeof record.url === "string" ? record.url : "";
  return {
    id,
    handle,
    name,
    protected: record.protected === true,
    following: Number.isFinite(following) ? following : null,
    url: /^https:\/\/(x|twitter)\.com\//i.test(givenUrl) ? givenUrl : `https://x.com/${handle}`,
  };
}

/**
 * Danh sách API xếp follow mới nhất lên đầu.
 * Gặp id đã biết thì dừng. Follow mới được trả về theo thứ tự cũ → mới.
 * @param {Set<string>} seen
 * @param {{ id: string }[]} usersNewestFirst
 */
export function newFollows(seen, usersNewestFirst) {
  /** @type {{ id: string }[]} */
  const fresh = [];
  const local = new Set();
  let hitKnown = usersNewestFirst.length === 0;
  for (const user of usersNewestFirst) {
    if (seen.has(user.id)) {
      hitKnown = true;
      break;
    }
    if (local.has(user.id)) continue;
    local.add(user.id);
    fresh.push(user);
  }
  fresh.reverse();
  return { fresh, hitKnown };
}

/**
 * @param {string} target
 * @param {{ handle: string, name?: string, url: string }} user
 */
export function formatFollowAlert(target, user) {
  const who = user.name && user.name !== user.handle ? `${user.name} (@${user.handle})` : `@${user.handle}`;
  return `@${target} vừa follow ${who}\n${user.url}`;
}

function effectiveStatus(http, body) {
  const code = Number(body?.code);
  if (Number.isFinite(code) && code >= 100) return code;
  return http;
}

export function parseProfile(http, body, requestedHandle) {
  const code = effectiveStatus(http, body);
  if (code === 429) throw new FollowError("X đang giới hạn tốc độ", "rate");
  const user = normalizeUser(body?.user);
  if (user && code >= 200 && code < 300) return user;
  if (code === 404) throw new FollowError(`Không thấy @${requestedHandle} trên X`, "not_found");
  throw new FollowError(`Không đọc được hồ sơ @${requestedHandle}`, "unavailable");
}

export function parseFollowing(http, body, { allowEmpty = false } = {}) {
  const code = effectiveStatus(http, body);
  if (code === 429) throw new FollowError("X đang giới hạn tốc độ", "rate");
  const results = Array.isArray(body?.results) ? body.results : null;
  if (code === 404 && results && results.length === 0) {
    if (allowEmpty) return { users: [], cursor: null };
    const detail = body?.message ? `: ${body.message}` : "";
    throw new FollowError(`Danh sách follow chưa tải được (${code}${detail})`, "unavailable");
  }
  if (results && code >= 200 && code < 300) {
    const users = [];
    for (const raw of results) {
      const user = normalizeUser(raw);
      if (user) users.push(user);
    }
    if (results.length > 0 && users.length === 0) {
      throw new FollowError(`API X trả về follow không đọc được (${code})`, "unavailable");
    }
    const bottom = body?.cursor?.bottom;
    const cursor = typeof bottom === "string" && bottom ? bottom : null;
    return { users, cursor };
  }
  if (code === 404) throw new FollowError("Không thấy tài khoản trên X", "not_found");
  const detail = body?.message ? `: ${body.message}` : "";
  throw new FollowError(`Danh sách follow chưa tải được (${code}${detail})`, "unavailable");
}

function retryable(error) {
  return error instanceof FollowError && (error.code === "unavailable" || error.code === "rate" || error.code === "not_found");
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function withRetry(fn, { retries, sleep, signal }) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!retryable(error) || attempt === retries) break;
      const wait = error.code === "rate" ? 15_000 : Math.min(400 * 2 ** attempt, 5_000);
      await sleep(wait, signal);
    }
  }
  throw last;
}

async function requestJson(url, { fetchImpl, signal }) {
  const timeout = AbortSignal.timeout(12_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(url, {
      signal: combined,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
  } catch (error) {
    if (error instanceof FollowError) throw error;
    if (error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new FollowError("Hết thời gian chờ API X", "unavailable");
    }
    const detail = String(error?.message || "").replace(/\s+/g, " ").slice(0, 180);
    throw new FollowError(detail ? `Không gọi được API X: ${detail}` : "Không gọi được API X", "unavailable");
  }
  const text = await response.text();
  if (!text) return { http: response.status, body: null };
  try {
    return { http: response.status, body: JSON.parse(text) };
  } catch {
    throw new FollowError("API X trả về dữ liệu không đọc được", "unavailable");
  }
}

export function createXClient({ fetchImpl = globalThis.fetch, sleep = delay, retries = 3 } = {}) {
  const profile = (handle, opts = {}) =>
    withRetry(
      async () => {
        const url = `${API}/2/profile/${encodeURIComponent(handle)}`;
        const { http, body } = await requestJson(url, { fetchImpl, signal: opts.signal });
        return parseProfile(http, body, handle);
      },
      { retries: opts.retries ?? retries, sleep, signal: opts.signal },
    );

  const following = (handle, opts = {}) =>
    withRetry(
      async () => {
        const url = new URL(`${API}/2/profile/${encodeURIComponent(handle)}/following`);
        url.searchParams.set("count", String(opts.count || 100));
        if (opts.cursor) url.searchParams.set("cursor", opts.cursor);
        const { http, body } = await requestJson(url, { fetchImpl, signal: opts.signal });
        return parseFollowing(http, body, { allowEmpty: opts.allowEmpty === true });
      },
      { retries: opts.retries ?? retries, sleep, signal: opts.signal },
    );

  return { profile, following };
}

/**
 * @param {{
 *   client: { profile: Function, following: Function },
 *   handle: string,
 *   state: ReturnType<typeof freshState>,
 *   maxPages?: number,
 * }} opts
 */
export async function pollFollows({ client, handle, state, maxPages = 8 }) {
  const profile = await client.profile(handle);
  if (profile.protected) {
    throw new FollowError(`@${profile.handle} đang khoá. Danh sách follow không công khai.`, "private");
  }
  const canonical = profile.handle;
  const allowEmpty = profile.following === 0;

  const loadPage = (cursor) =>
    client.following(canonical, {
      count: 100,
      cursor,
      allowEmpty,
      retries: allowEmpty ? 1 : undefined,
    });

  if (!state.bootstrapped) {
    const page = await loadPage();
    if (page.users.length === 0 && profile.following > 0) {
      throw new FollowError("Danh sách follow đang trống tạm thời. Thử lại.", "unavailable");
    }
    for (const user of page.users) state.seen.add(user.id);
    state.bootstrapped = true;
    state.emptyOk = page.users.length === 0;
    return { kind: "baseline", handle: canonical, seeded: page.users.length, alerts: [], truncated: false };
  }

  const collected = [];
  let cursor;
  for (let i = 0; i < maxPages; i++) {
    const page = await loadPage(i === 0 ? undefined : cursor);
    if (i === 0 && page.users.length === 0 && profile.following > 0) {
      throw new FollowError("Danh sách follow đang trống tạm thời. Thử lại.", "unavailable");
    }
    // Bản ghi nhớ rỗng nhưng tài khoản đang follow nhiều hơn một trang:
    // nhớ lại trang mới nhất, không gửi hàng loạt follow cũ.
    if (i === 0 && state.seen.size === 0 && profile.following > page.users.length) {
      for (const user of page.users) state.seen.add(user.id);
      state.emptyOk = false;
      return { kind: "baseline", handle: canonical, seeded: page.users.length, alerts: [], truncated: false };
    }
    collected.push(...page.users);
    const diff = newFollows(state.seen, collected);
    if (diff.hitKnown || !page.cursor) {
      return { kind: "diff", handle: canonical, seeded: 0, alerts: diff.fresh, truncated: false };
    }
    if (i === maxPages - 1) {
      return { kind: "diff", handle: canonical, seeded: 0, alerts: diff.fresh, truncated: true };
    }
    cursor = page.cursor;
  }
  return { kind: "diff", handle: canonical, seeded: 0, alerts: [], truncated: true };
}

export function serializeState(state) {
  return {
    version: 1,
    bootstrapped: state.bootstrapped === true,
    emptyOk: state.emptyOk === true,
    seen: [...state.seen],
  };
}

export function parseState(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ...freshState(), corrupt: true };
  }
  if (!json || json.version !== 1 || typeof json.bootstrapped !== "boolean" || !Array.isArray(json.seen)) {
    return { ...freshState(), corrupt: true };
  }
  const seen = new Set();
  for (const id of json.seen) {
    const value = String(id);
    if (/^\d+$/.test(value)) seen.add(value);
  }
  if (json.bootstrapped && seen.size === 0 && json.emptyOk !== true) {
    return { ...freshState(), corrupt: true };
  }
  return { bootstrapped: json.bootstrapped, emptyOk: json.emptyOk === true, seen, corrupt: false };
}

export function statePath(handle, dir = join("data", "follows")) {
  const safe = String(handle || "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(safe)) throw new Error("Username không hợp lệ");
  return join(dir, `${safe}.json`);
}

export function fileStore(file) {
  return {
    async load() {
      try {
        return parseState(await readFile(file, "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return freshState();
        throw error;
      }
    },
    async save(state) {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(serializeState(state))}\n`);
      await rename(tmp, file);
    },
  };
}

export async function sendTelegram({ token, chatId, text, fetchImpl = globalThis.fetch, signal }) {
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        link_preview_options: { is_disabled: true },
      }),
    });
  } catch (error) {
    let message = String(error?.message || "Không gọi được Telegram");
    if (token) message = message.replaceAll(token, "[token]");
    throw new FollowError(message, "telegram");
  }
  let body = null;
  const raw = await response.text();
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }
  if (!response.ok || body?.ok === false) {
    let description = String(body?.description || `HTTP ${response.status}`).replace(/\s+/g, " ").slice(0, 300);
    if (token && description.includes(token)) description = description.replaceAll(token, "[token]");
    throw new FollowError(
      `Telegram từ chối tin nhắn: ${description}`,
      response.status === 429 ? "rate" : "telegram",
    );
  }
  return body;
}

/**
 * @param {{
 *   handle: string,
 *   client: { profile: Function, following: Function },
 *   store: { load: Function, save: Function },
 *   notify: (text: string) => Promise<void>,
 *   pollMs?: number,
 *   sleep?: typeof delay,
 *   log?: (message: string) => void,
 *   maxCycles?: number,
 *   maxPages?: number,
 * }} opts
 */
export async function watch(opts) {
  const log = opts.log || (() => {});
  const sleep = opts.sleep || delay;
  const pollMs = opts.pollMs ?? 3000;
  const maxCycles = opts.maxCycles ?? Infinity;
  let state = await opts.store.load();
  if (state.corrupt) {
    log("File trạng thái hỏng. Nhớ lại follow hiện tại, không báo follow cũ.");
    state = freshState();
  }
  let canonical = opts.handle;
  let lastBeat = Date.now();
  let cycles = 0;

  while (cycles < maxCycles) {
    cycles += 1;
    try {
      const wasReady = state.bootstrapped;
      const result = await pollFollows({
        client: opts.client,
        handle: canonical,
        state,
        maxPages: opts.maxPages,
      });
      canonical = result.handle;
      if (!wasReady || result.kind === "baseline") {
        await opts.store.save(state);
        log(`Đã nhớ ${result.seeded} follow gần nhất của @${canonical}. Follow mới sẽ báo qua Telegram.`);
      }
      for (const user of result.alerts) {
        await opts.notify(formatFollowAlert(canonical, user));
        state.seen.add(user.id);
        state.emptyOk = false;
        await opts.store.save(state);
        log(`@${canonical} follow @${user.handle}`);
      }
      if (result.truncated) {
        log(`@${canonical} follow quá nhiều người trong một lúc. Một số follow cũ hơn trong khoảng trống có thể chưa được báo.`);
      }
    } catch (error) {
      const blocked = error?.code === "private" || (error?.code === "not_found" && !state.bootstrapped);
      if (blocked) throw error;
      log(error?.message || String(error));
    }
    if (cycles >= maxCycles) break;
    if (Date.now() - lastBeat > 60_000) {
      log(`Vẫn đang theo dõi @${canonical}.`);
      lastBeat = Date.now();
    }
    await sleep(pollMs);
  }
}

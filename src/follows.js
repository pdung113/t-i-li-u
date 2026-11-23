import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const API = "https://api.fxtwitter.com";
const USER_AGENT = "x-snipe/1.0";
const ALLOWED_API_HOSTS = new Set(["api.fxtwitter.com", "api.telegram.org"]);

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
  return {
    bootstrapped: false,
    emptyOk: false,
    synced: false,
    followingCount: null,
    crawledAt: null,
    seen: new Set(),
    people: [],
    corrupt: false,
  };
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
  const fromRaw =
    record.raw_description && typeof record.raw_description === "object"
      ? String(record.raw_description.text || "")
      : "";
  const fromField = String(record.description || "");
  const description = (fromRaw.length > fromField.length ? fromRaw : fromField).replace(/[\r\n\t]+/g, " ").trim();
  return {
    id,
    handle,
    name,
    description,
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

function knownId(state, id) {
  if (state.seen.has(id)) return true;
  return Array.isArray(state.people) && state.people.some((item) => item && item.id === id);
}

/**
 * Chỉ chọn prefix mới nhất. Danh sách xáo trộn hoặc dài hơn số follow tăng thêm
 * được coi là follow cũ, không gửi.
 * `prefix` xếp người mới nhất trước.
 * Số follow không tăng thì không báo. Đó là danh sách cũ bị xáo, không phải follow mới.
 * @param {{ id: string }[]} prefix
 * @param {{ hitKnown?: boolean, delta?: number | null }} opts
 */
export function chooseAlerts(prefix, { hitKnown = false, delta = null } = {}) {
  const count = prefix.length;
  if (count === 0 || !Number.isFinite(delta) || delta <= 0) return [];
  if (!hitKnown && count > 3) return [];
  return prefix.slice(0, Math.min(count, delta));
}

/**
 * @param {string} target
 * @param {{ handle: string, name?: string, url: string, contracts?: string[], contractTweet?: string | null }} user
 */
export function formatFollowAlert(target, user) {
  const who = user.name && user.name !== user.handle ? `${user.name} (@${user.handle})` : `@${user.handle}`;
  const lines = [`@${target} vừa follow ${who}`, user.url];
  for (const addr of user.contracts || []) lines.push(`Contract: ${addr}`);
  if (user.contractTweet && user.contracts?.length) lines.push(user.contractTweet);
  return lines.join("\n");
}

/** Địa chỉ contract EVM. Bỏ qua hash dài hơn 40 ký tự hex. */
export function extractContracts(...parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (typeof part !== "string" || !part) continue;
    for (const match of part.matchAll(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/gi)) {
      const addr = match[0];
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(addr);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

function tweetContractText(tweet) {
  return [tweet?.text, tweet?.raw_text?.text, tweet?.embed_card?.title, tweet?.embed_card?.description]
    .filter((part) => typeof part === "string")
    .join("\n");
}

/**
 * Đọc bio và bài mới của người vừa được follow. Lỗi mạng không chặn tin báo.
 * @param {{ profile?: Function, statuses?: Function }} client
 * @param {{ id: string, handle: string, name?: string, url: string, description?: string }} user
 */
export async function enrichFollowed(client, user) {
  let description = user.description || "";
  if (typeof client.profile === "function") {
    try {
      const fresh = await client.profile(user.handle, { retries: 1 });
      if (fresh?.description) description = fresh.description;
    } catch {
      // Vẫn báo follow kèm link dù không đọc được bio.
    }
  }

  let tweets = [];
  if (typeof client.statuses === "function") {
    try {
      tweets = await client.statuses(user.handle, { count: 20, retries: 2 });
    } catch {
      tweets = [];
    }
  }

  const contracts = extractContracts(description);
  let contractTweet = null;
  for (const tweet of tweets) {
    const author = tweet?.author?.screen_name;
    if (author && author.toLowerCase() !== user.handle.toLowerCase()) continue;
    const found = extractContracts(tweetContractText(tweet));
    if (!found.length) continue;
    if (!contractTweet) {
      contractTweet =
        typeof tweet.url === "string" && /^https:\/\/(x|twitter)\.com\//i.test(tweet.url)
          ? tweet.url
          : `https://x.com/${user.handle}/status/${tweet.id}`;
    }
    for (const addr of found) {
      if (!contracts.some((item) => item.toLowerCase() === addr.toLowerCase())) contracts.push(addr);
    }
  }

  return {
    ...user,
    description,
    contracts: contracts.slice(0, 8),
    contractTweet: contracts.length ? contractTweet : null,
  };
}

export function rememberPerson(state, user, at = new Date().toISOString()) {
  if (!Array.isArray(state.people)) state.people = [];
  const record = {
    id: String(user.id),
    handle: user.handle,
    name: user.name || user.handle,
    url: user.url,
    contracts: [...(user.contracts || [])],
    contractTweet: user.contractTweet || null,
    at,
  };
  const index = state.people.findIndex((item) => item.id === record.id);
  if (index >= 0) state.people[index] = record;
  else state.people.push(record);
  return record;
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

export function assertAllowedApiUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new FollowError("Tool chỉ gọi HTTPS tới API X và Telegram", "blocked");
  }
  if (!ALLOWED_API_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new FollowError("Tool chỉ gọi API X và Telegram", "blocked");
  }
  if (parsed.username || parsed.password) {
    throw new FollowError("URL API không được kèm mật khẩu", "blocked");
  }
}

async function requestJson(url, { fetchImpl, signal }) {
  assertAllowedApiUrl(url);
  const timeout = AbortSignal.timeout(12_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(url, {
      signal: combined,
      redirect: "error",
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

  const statuses = (handle, opts = {}) =>
    withRetry(
      async () => {
        const url = new URL(`${API}/2/profile/${encodeURIComponent(handle)}/statuses`);
        url.searchParams.set("count", String(opts.count || 20));
        const { http, body } = await requestJson(url, { fetchImpl, signal: opts.signal });
        return parseStatuses(http, body);
      },
      { retries: opts.retries ?? retries, sleep, signal: opts.signal },
    );

  return { profile, following, statuses };
}

export function parseStatuses(http, body) {
  const code = effectiveStatus(http, body);
  if (code === 429) throw new FollowError("X đang giới hạn tốc độ", "rate");
  const results = Array.isArray(body?.results) ? body.results : null;
  if (results && code >= 200 && code < 300) {
    return results.filter((item) => item && (item.text || item.raw_text || item.id));
  }
  if (code === 404 && results && results.length === 0) {
    throw new FollowError("Bài viết chưa tải được", "unavailable");
  }
  if (code === 404) throw new FollowError("Không thấy tài khoản trên X", "not_found");
  throw new FollowError("Bài viết chưa tải được", "unavailable");
}

const BACKFILL_WAIT_MS = 10 * 60 * 1000;

function listCovered(seenSize, following) {
  return typeof following === "number" && (seenSize >= following || following - seenSize <= 15);
}

async function crawlFollowing(loadPage, { maxPages, stopWhen }) {
  const users = [];
  const seenIds = new Set();
  const cursors = new Set();
  let cursor;
  let done = false;
  let truncated = false;
  for (let i = 0; i < maxPages; i++) {
    let page;
    try {
      page = await loadPage(i === 0 ? undefined : cursor);
    } catch (error) {
      if (i === 0) throw error;
      return { users, done: false, truncated: true };
    }
    if (page.users.length === 0) {
      done = !page.cursor;
      break;
    }
    let added = 0;
    for (const user of page.users) {
      if (seenIds.has(user.id)) continue;
      seenIds.add(user.id);
      users.push(user);
      added += 1;
    }
    if (typeof stopWhen === "function" && stopWhen(users)) {
      return { users, done: true, truncated: false };
    }
    if (!page.cursor || cursors.has(page.cursor) || added === 0) {
      done = !page.cursor;
      break;
    }
    cursors.add(page.cursor);
    cursor = page.cursor;
    if (i === maxPages - 1) truncated = true;
  }
  return { users, done, truncated };
}

function rememberUsers(state, users) {
  let added = 0;
  for (const user of users) {
    if (!user?.id || state.seen.has(user.id)) continue;
    state.seen.add(user.id);
    added += 1;
  }
  return added;
}

/**
 * @param {{
 *   client: { profile: Function, following: Function },
 *   handle: string,
 *   state: ReturnType<typeof freshState>,
 *   maxPages?: number,
 *   baselinePages?: number,
 * }} opts
 */
export async function pollFollows({ client, handle, state, maxPages = 8, baselinePages = 30 }) {
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

  const crawledAt = Date.parse(state.crawledAt || "");
  const throttled = Number.isFinite(crawledAt) && Date.now() - crawledAt < BACKFILL_WAIT_MS;

  if (!state.bootstrapped || (state.synced !== true && typeof state.followingCount !== "number" && !throttled)) {
    const crawled = await crawlFollowing(loadPage, {
      maxPages: baselinePages,
      stopWhen:
        typeof profile.following === "number" && profile.following > 0
          ? (users) => users.length >= profile.following
          : undefined,
    });
    if (crawled.users.length === 0 && profile.following > 0) {
      throw new FollowError("Danh sách follow đang trống tạm thời. Thử lại.", "unavailable");
    }
    const absorbed = rememberUsers(state, crawled.users);
    for (const person of state.people || []) {
      if (person?.id) state.seen.add(String(person.id));
    }
    state.bootstrapped = true;
    state.emptyOk = state.seen.size === 0;
    state.crawledAt = new Date().toISOString();
    state.synced = crawled.done || listCovered(state.seen.size, profile.following) || profile.following === 0;
    if (typeof profile.following === "number") state.followingCount = profile.following;
    return {
      kind: "baseline",
      handle: canonical,
      seeded: state.seen.size,
      alerts: [],
      truncated: !state.synced,
      dirty: true,
      announce: true,
      absorbed,
      nextFollowingCount: profile.following,
    };
  }

  const crawled = await crawlFollowing(loadPage, {
    maxPages,
    stopWhen: (users) => users.some((user) => knownId(state, user.id)),
  });
  if (crawled.users.length === 0 && profile.following > 0) {
    throw new FollowError("Danh sách follow đang trống tạm thời. Thử lại.", "unavailable");
  }

  const prefix = [];
  let hitKnown = false;
  for (const user of crawled.users) {
    if (knownId(state, user.id)) {
      hitKnown = true;
      break;
    }
    prefix.push(user);
  }
  const delta =
    typeof state.followingCount === "number" && typeof profile.following === "number"
      ? profile.following - state.followingCount
      : null;
  const chosen = chooseAlerts(prefix, { hitKnown, delta });
  const chosenIds = new Set(chosen.map((user) => user.id));
  const holdQuietPrefix = chosen.length === 0 && prefix.length > 0 && prefix.length <= 2 && !(Number.isFinite(delta) && delta > 0);
  const absorb = [];
  let passedKnown = false;
  for (const user of crawled.users) {
    if (chosenIds.has(user.id)) continue;
    if (!passedKnown && !knownId(state, user.id)) {
      if (holdQuietPrefix) continue;
      absorb.push(user);
      continue;
    }
    passedKnown = true;
    absorb.push(user);
  }
  const absorbed = rememberUsers(state, absorb);
  let dirty = absorbed > 0;
  if (chosen.length === 0 && typeof profile.following === "number" && state.followingCount !== profile.following) {
    state.followingCount = profile.following;
    dirty = true;
  }

  let backfillTruncated = false;
  if (chosen.length === 0 && state.synced !== true && !throttled) {
    const heldIds = new Set(holdQuietPrefix ? prefix.map((user) => user.id) : []);
    const extra = await crawlFollowing(loadPage, { maxPages: baselinePages });
    const extraAbsorbed = rememberUsers(
      state,
      extra.users.filter((user) => !chosenIds.has(user.id) && !heldIds.has(user.id)),
    );
    state.crawledAt = new Date().toISOString();
    state.synced = extra.done || listCovered(state.seen.size, profile.following) || profile.following === 0;
    if (extraAbsorbed > 0) dirty = true;
    backfillTruncated = !state.synced;
  }

  return {
    kind: "diff",
    handle: canonical,
    seeded: 0,
    alerts: chosen.slice().reverse(),
    truncated: (!hitKnown && (crawled.truncated || !crawled.done)) || backfillTruncated,
    dirty,
    announce: false,
    absorbed,
    nextFollowingCount: typeof profile.following === "number" ? profile.following : null,
  };
}

export function serializeState(state) {
  const out = {
    version: 1,
    bootstrapped: state.bootstrapped === true,
    emptyOk: state.emptyOk === true,
    synced: state.synced === true,
    seen: [...state.seen],
    people: Array.isArray(state.people) ? state.people : [],
  };
  if (typeof state.followingCount === "number" && Number.isFinite(state.followingCount)) {
    out.followingCount = state.followingCount;
  }
  if (typeof state.crawledAt === "string" && state.crawledAt) out.crawledAt = state.crawledAt;
  return out;
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
  const people = [];
  if (Array.isArray(json.people)) {
    for (const item of json.people) {
      if (!item || typeof item !== "object") continue;
      const id = String(item.id || "");
      const handle = String(item.handle || "");
      if (!/^\d+$/.test(id) || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) continue;
      const contracts = Array.isArray(item.contracts)
        ? item.contracts.filter((addr) => typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr)).slice(0, 8)
        : [];
      people.push({
        id,
        handle,
        name: String(item.name || handle),
        url: typeof item.url === "string" && item.url.startsWith("https://") ? item.url : `https://x.com/${handle}`,
        contracts,
        contractTweet: typeof item.contractTweet === "string" ? item.contractTweet : null,
        at: typeof item.at === "string" ? item.at : null,
      });
    }
  }
  const followingCount = Number.isFinite(json.followingCount) ? json.followingCount : null;
  const crawledAt = typeof json.crawledAt === "string" ? json.crawledAt : null;
  return {
    bootstrapped: json.bootstrapped,
    emptyOk: json.emptyOk === true,
    synced: json.synced === true,
    followingCount,
    crawledAt,
    seen,
    people,
    corrupt: false,
  };
}

export function statePath(handle, dir = join("data", "follows")) {
  const safe = String(handle || "").toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(safe)) throw new Error("Username không hợp lệ");
  return join(dir, `${safe}.json`);
}

function cannotReplace(error) {
  return error?.code === "EEXIST" || error?.code === "EPERM" || error?.code === "EBUSY";
}

/** Ghi đè file trạng thái. Windows không cho rename đè file có sẵn. */
export async function replaceFile(file, contents, io = {}) {
  const write = io.writeFile || writeFile;
  const renameImpl = io.rename || rename;
  const remove = io.rm || rm;
  const read = io.readFile || readFile;
  const tmp = io.tmp || `${file}.${process.pid}.tmp`;
  await write(tmp, contents);
  try {
    await renameImpl(tmp, file);
    return;
  } catch (error) {
    if (!cannotReplace(error)) throw error;
  }
  await remove(file, { force: true }).catch(() => {});
  try {
    await renameImpl(tmp, file);
  } catch (error) {
    if (!cannotReplace(error)) throw error;
    await write(file, await read(tmp));
    await remove(tmp, { force: true }).catch(() => {});
  }
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
      await replaceFile(file, `${JSON.stringify(serializeState(state))}\n`);
    },
  };
}

export async function sendTelegram({ token, chatId, text, fetchImpl = globalThis.fetch, signal }) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  assertAllowedApiUrl(url);
  const safeText = String(text || "").slice(0, 4000);
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      signal,
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: safeText,
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
export async function runCycle(opts) {
  const log = opts.log || (() => {});
  if (!opts.state.bootstrapped || (opts.state.synced !== true && typeof opts.state.followingCount !== "number")) {
    log(`Đang nhớ hết follow hiện tại của @${opts.handle}. Chưa gửi tin cũ.`);
  }
  const result = await pollFollows({
    client: opts.client,
    handle: opts.handle,
    state: opts.state,
    maxPages: opts.maxPages,
    baselinePages: opts.baselinePages,
  });
  if (result.dirty || result.announce) await opts.store.save(opts.state);
  if (result.announce) {
    log(`Đã nhớ ${result.seeded} follow hiện tại của @${result.handle}. Follow cũ không gửi lại. Follow mới sẽ báo qua Telegram.`);
  } else if (result.absorbed > 0) {
    log(`Đã nhớ thêm ${result.absorbed} follow cũ của @${result.handle}, không gửi lại.`);
  }
  if (!result.announce && result.alerts.length === 0) {
    log(`@${result.handle} chưa follow ai mới. Đang nhớ ${opts.state.seen.size} người.`);
  }
  for (const user of result.alerts) {
    if (knownId(opts.state, user.id)) continue;
    const enriched = await enrichFollowed(opts.client, user);
    await opts.notify(formatFollowAlert(result.handle, enriched));
    opts.state.seen.add(user.id);
    opts.state.emptyOk = false;
    if (typeof result.nextFollowingCount === "number") opts.state.followingCount = result.nextFollowingCount;
    rememberPerson(opts.state, enriched);
    await opts.store.save(opts.state);
    const contractNote = enriched.contracts.length ? ` | ${enriched.contracts.join(", ")}` : "";
    log(`@${result.handle} follow @${enriched.handle}${contractNote}`);
  }
  if (result.truncated && result.alerts.length > 0) {
    log(`@${result.handle} follow quá nhiều người trong một lúc. Một số follow cũ hơn trong khoảng trống có thể chưa được báo.`);
  }
  return result.handle;
}

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
  log(`Đang theo dõi @${opts.handle}. Hỏi mỗi ${Math.round(pollMs / 1000)} giây. Cửa sổ này phải để mở.`);

  while (cycles < maxCycles) {
    cycles += 1;
    try {
      canonical = await runCycle({ ...opts, handle: canonical, state, log });
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

/**
 * @param {{
 *   loadHandles: () => Promise<{ handles: string[], errors?: string[] } | string[]>,
 *   storeFor: (handle: string) => { load: Function, save: Function },
 *   client: { profile: Function, following: Function },
 *   notify: (text: string) => Promise<void>,
 *   pollMs?: number,
 *   sleep?: typeof delay,
 *   log?: (message: string) => void,
 *   maxCycles?: number,
 *   maxPages?: number,
 * }} opts
 */
export async function watchAll(opts) {
  const log = opts.log || (() => {});
  const sleep = opts.sleep || delay;
  const pollMs = opts.pollMs ?? 3000;
  const maxCycles = opts.maxCycles ?? Infinity;
  /** @type {Map<string, { store: { load: Function, save: Function }, state: ReturnType<typeof freshState>, handle: string, complained: boolean }>} */
  const slots = new Map();
  const loggedErrors = new Set();
  let lastBeat = Date.now();
  let cycles = 0;
  let loggedEmpty = false;

  while (cycles < maxCycles) {
    cycles += 1;
    const loaded = await opts.loadHandles();
    const handles = Array.isArray(loaded) ? loaded : loaded.handles;
    const errors = Array.isArray(loaded) ? [] : loaded.errors || [];
    for (const message of errors) {
      if (loggedErrors.has(message)) continue;
      loggedErrors.add(message);
      log(message);
    }
    if (handles.length === 0) {
      if (!loggedEmpty) {
        log("File theo-doi.txt chưa có tài khoản. Thêm mỗi người một dòng rồi lưu.");
        loggedEmpty = true;
      }
    } else {
      loggedEmpty = false;
      if (cycles === 1) {
        log(
          `Đang theo dõi ${handles.map((handle) => `@${handle}`).join(", ")}. Hỏi mỗi ${Math.round(pollMs / 1000)} giây. Cửa sổ này phải để mở.`,
        );
      }
    }

    for (const handle of handles) {
      const key = handle.toLowerCase();
      let slot = slots.get(key);
      if (!slot) {
        const store = opts.storeFor(handle);
        let state = await store.load();
        if (state.corrupt) {
          log(`File trạng thái của @${handle} hỏng. Nhớ lại follow hiện tại, không báo follow cũ.`);
          state = freshState();
        }
        slot = { store, state, handle, complained: false };
        slots.set(key, slot);
      }
      try {
        slot.handle = await runCycle({
          client: opts.client,
          handle: slot.handle,
          state: slot.state,
          store: slot.store,
          notify: opts.notify,
          log,
          maxPages: opts.maxPages,
        });
        slot.complained = false;
      } catch (error) {
        const blocked = error?.code === "private" || (error?.code === "not_found" && !slot.state.bootstrapped);
        if (blocked && !slot.complained) {
          log(error.message);
          slot.complained = true;
          continue;
        }
        if (!blocked) log(error?.message || String(error));
      }
    }

    if (cycles >= maxCycles) break;
    if (handles.length > 0 && Date.now() - lastBeat > 60_000) {
      log(`Vẫn đang theo dõi ${handles.map((handle) => `@${handle}`).join(", ")}.`);
      lastBeat = Date.now();
    }
    await sleep(pollMs);
  }
}

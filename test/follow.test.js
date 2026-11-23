import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAlertConfig, loadRuntimeEnv, main, parseWatchList, readFollowEnv } from "../src/follow-alert.js";
import {
  FollowError,
  assertAllowedApiUrl,
  createXClient,
  enrichFollowed,
  extractContracts,
  fileStore,
  formatFollowAlert,
  chooseAlerts,
  freshState,
  newFollows,
  parseState,
  replaceFile,
  pollFollows,
  sendTelegram,
  serializeState,
  watch,
  watchAll,
} from "../src/follows.js";

function user(id, handle, extra = {}) {
  return {
    id: String(id),
    handle,
    name: extra.name || handle,
    description: extra.description || "",
    protected: extra.protected === true,
    following: extra.following ?? null,
    url: `https://x.com/${handle}`,
  };
}

function profile(handle, extra = {}) {
  return user(extra.id || 1, handle, { name: extra.name || handle, following: extra.following ?? 10, ...extra });
}

function memoryStore(initial = freshState()) {
  let state = initial;
  return {
    async load() {
      return state;
    },
    async save(next) {
      state = {
        bootstrapped: next.bootstrapped === true,
        emptyOk: next.emptyOk === true,
        synced: next.synced === true,
        followingCount: Number.isFinite(next.followingCount) ? next.followingCount : null,
        crawledAt: typeof next.crawledAt === "string" ? next.crawledAt : null,
        seen: new Set(next.seen),
        people: Array.isArray(next.people) ? next.people.map((item) => ({ ...item, contracts: [...(item.contracts || [])] })) : [],
        corrupt: false,
      };
    },
    get() {
      return state;
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("file notepad đọc link, @username, và bỏ dòng ghi chú", () => {
  const parsed = parseWatchList(
    "\uFEFF# ghi chú\r\n\r\nhttps://x.com/vladtenev\r\n@VladTenev\n@someone\nkhông phải link\n",
  );
  assert.deepEqual(parsed.handles, ["vladtenev", "someone"]);
  assert.equal(parsed.errors.length, 1);
});

test("thêm người vào notepad ở vòng sau thì được theo dõi", async () => {
  let text = "https://x.com/vladtenev\n";
  const notes = [];
  const stores = new Map();
  await watchAll({
    loadHandles: async () => parseWatchList(text),
    storeFor(handle) {
      const key = handle.toLowerCase();
      if (!stores.has(key)) stores.set(key, memoryStore());
      return stores.get(key);
    },
    client: {
      async profile(handle) {
        return profile(handle, { id: handle === "other" ? 8 : 9, following: 1, name: handle });
      },
      async following(handle) {
        return { users: [user(handle === "other" ? 80 : 90, `${handle}pal`)], cursor: null };
      },
    },
    notify: async () => {
      throw new Error("không được báo follow cũ");
    },
    log: (message) => notes.push(message),
    sleep: async () => {
      text = "# thêm người\nhttps://x.com/vladtenev\nhttps://x.com/other\n";
    },
    maxCycles: 2,
  });
  assert.match(notes[0], /@vladtenev/);
  assert.match(notes.join("\n"), /@other/);
  assert.equal(stores.get("vladtenev").get().bootstrapped, true);
  assert.equal(stores.get("other").get().bootstrapped, true);
  assert.equal(stores.get("vladtenev").get().seen.has("90"), true);
});

test("tin Telegram ghi tên và link", () => {
  assert.equal(
    formatFollowAlert("github", user(2, "octocat", { name: "The Octocat" })),
    "@github vừa follow The Octocat (@octocat)\nhttps://x.com/octocat",
  );
  assert.equal(formatFollowAlert("github", user(2, "octocat")), "@github vừa follow @octocat\nhttps://x.com/octocat");
  const ca = "0x1111111111111111111111111111111111111111";
  assert.equal(
    formatFollowAlert("vladtenev", {
      ...user(2, "proj", { name: "Proj" }),
      contracts: [ca],
      contractTweet: "https://x.com/proj/status/99",
    }),
    `@vladtenev vừa follow Proj (@proj)\nhttps://x.com/proj\nContract: ${ca}\nhttps://x.com/proj/status/99`,
  );
});

test("lấy contract trong bio và bài của chính dự án", () => {
  const ca = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const other = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const hash = `0x${"ab".repeat(32)}`;
  assert.deepEqual(extractContracts(`CA: ${ca}`, `again ${ca}`, hash), [ca]);
  assert.deepEqual(extractContracts(`tx ${hash} end`), []);
  assert.deepEqual(extractContracts(`pair ${ca} ${other}`), [ca, other]);
});

test("follow một dự án thì tin có link X và contract, rồi được nhớ lại", async () => {
  const bioCa = "0x1111111111111111111111111111111111111111";
  const postCa = "0x2222222222222222222222222222222222222222";
  const strangerCa = "0x3333333333333333333333333333333333333333";
  const state = freshState();
  state.bootstrapped = true;
  state.synced = true;
  state.followingCount = 1;
  state.seen.add("1");
  const store = memoryStore(state);
  const sent = [];
  await watch({
    handle: "vladtenev",
    client: {
      async profile(handle) {
        if (handle === "proj") {
          return profile("proj", { id: 2, name: "Proj", description: `CA: ${bioCa}`, following: 1 });
        }
        return profile("vladtenev", { id: 9, following: 893 });
      },
      async following() {
        return {
          users: [user(2, "proj", { name: "Proj" }), user(1, "old")],
          cursor: null,
        };
      },
      async statuses(handle) {
        assert.equal(handle, "proj");
        return [
          {
            id: "99",
            text: `live ${postCa}`,
            url: "https://x.com/proj/status/99",
            author: { screen_name: "proj" },
          },
          {
            id: "100",
            text: `ignore ${strangerCa}`,
            author: { screen_name: "someoneelse" },
          },
        ];
      },
    },
    store,
    maxCycles: 1,
    sleep: async () => {},
    log() {},
    notify: async (text) => sent.push(text),
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /@vladtenev vừa follow Proj \(@proj\)/);
  assert.match(sent[0], /https:\/\/x\.com\/proj\n/);
  assert.match(sent[0], new RegExp(`Contract: ${bioCa}`));
  assert.match(sent[0], new RegExp(`Contract: ${postCa}`));
  assert.equal(sent[0].includes(strangerCa), false);
  assert.match(sent[0], /https:\/\/x\.com\/proj\/status\/99/);
  const remembered = store.get().people[0];
  assert.equal(remembered.handle, "proj");
  assert.equal(remembered.url, "https://x.com/proj");
  assert.deepEqual(remembered.contracts, [bioCa, postCa]);
  const restored = parseState(JSON.stringify(serializeState(store.get())));
  assert.equal(restored.people[0].url, "https://x.com/proj");
  assert.deepEqual(restored.people[0].contracts, [bioCa, postCa]);
});

test("không đọc được bài viết thì vẫn báo link", async () => {
  const person = user(4, "quiet", { name: "Quiet" });
  const enriched = await enrichFollowed(
    {
      async profile() {
        throw new FollowError("@quiet đang khoá. Danh sách follow không công khai.", "private");
      },
      async statuses() {
        throw new FollowError("Bài viết chưa tải được", "unavailable");
      },
    },
    person,
  );
  assert.deepEqual(enriched.contracts, []);
  assert.equal(formatFollowAlert("vladtenev", enriched), "@vladtenev vừa follow Quiet (@quiet)\nhttps://x.com/quiet");
});

test("chỉ lấy follow mới đứng trước id đã biết, theo thứ tự cũ đến mới", () => {
  const seen = new Set(["1"]);
  const diff = newFollows(seen, [user(4, "d"), user(3, "c"), user(1, "a"), user(9, "old")]);
  assert.equal(diff.hitKnown, true);
  assert.deepEqual(diff.fresh.map((item) => item.handle), ["c", "d"]);
  assert.deepEqual(newFollows(new Set(), []).hitKnown, true);
  const dupes = newFollows(new Set(["1"]), [user(2, "b"), user(2, "b"), user(1, "a")]);
  assert.deepEqual(dupes.fresh.map((item) => item.id), ["2"]);
});

test("trạng thái hỏng thì nhớ lại, không giữ mốc rỗng giả", () => {
  const state = freshState();
  state.bootstrapped = true;
  state.seen.add("10");
  const back = parseState(JSON.stringify(serializeState(state)));
  assert.equal(back.corrupt, false);
  assert.equal(back.seen.has("10"), true);

  assert.equal(parseState("{").corrupt, true);
  assert.equal(parseState(JSON.stringify({ version: 1, bootstrapped: true, seen: [] })).corrupt, true);
  const empty = parseState(JSON.stringify({ version: 1, bootstrapped: true, emptyOk: true, seen: [] }));
  assert.equal(empty.corrupt, false);
  assert.equal(empty.emptyOk, true);
});

test("ghi file trạng thái rồi đọc lại", async () => {
  const dir = await mkdtemp(join(tmpdir(), "follows-"));
  const store = fileStore(join(dir, "github.json"));
  assert.equal((await store.load()).bootstrapped, false);
  const state = freshState();
  state.bootstrapped = true;
  state.seen.add("42");
  await store.save(state);
  const loaded = await store.load();
  assert.equal(loaded.seen.has("42"), true);
  assert.equal(await readFile(join(dir, "github.json"), "utf8").then((text) => text.endsWith("\n")), true);
});

test("lần đầu chỉ nhớ, không báo", async () => {
  const seenFollowing = [];
  const client = {
    async profile() {
      return profile("GitHub", { following: 2 });
    },
    async following() {
      seenFollowing.push("called");
      return { users: [user(2, "a"), user(1, "b")], cursor: null };
    },
  };
  const state = freshState();
  const result = await pollFollows({ client, handle: "github", state });
  assert.equal(result.kind, "baseline");
  assert.equal(result.seeded, 2);
  assert.deepEqual(result.alerts, []);
  assert.equal(state.seen.has("2"), true);
  assert.equal(seenFollowing.length, 1);
});

test("follow mới được báo, follow cũ thì không", async () => {
  const state = freshState();
  state.bootstrapped = true;
  state.synced = true;
  state.followingCount = 1;
  state.seen.add("1");
  const client = {
    async profile() {
      return profile("GitHub", { following: 3 });
    },
    async following(_handle, opts) {
      if (!opts.cursor) return { users: [user(3, "c"), user(2, "b")], cursor: "next" };
      return { users: [user(1, "a")], cursor: null };
    },
  };
  const result = await pollFollows({ client, handle: "github", state });
  assert.deepEqual(result.alerts.map((item) => item.handle), ["b", "c"]);
  assert.equal(result.truncated, false);
  assert.equal(state.seen.has("3"), false);
});

test("quá một trang follow mới thì cảnh báo còn sót", async () => {
  const state = freshState();
  state.bootstrapped = true;
  state.synced = true;
  state.followingCount = 1;
  state.seen.add("9");
  let pages = 0;
  const client = {
    async profile() {
      return profile("GitHub", { following: 500 });
    },
    async following() {
      pages += 1;
      return { users: [user(pages, `p${pages}`)], cursor: `c${pages}` };
    },
  };
  const result = await pollFollows({ client, handle: "github", state, maxPages: 2 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.alerts.map((item) => item.handle), ["p2", "p1"]);
  assert.equal(pages, 2);
});

test("tài khoản khoá không đọc follow", async () => {
  let followingCalls = 0;
  const client = {
    async profile() {
      return profile("secret", { protected: true, following: 4 });
    },
    async following() {
      followingCalls += 1;
      return { users: [], cursor: null };
    },
  };
  await assert.rejects(pollFollows({ client, handle: "secret", state: freshState() }), (error) => {
    assert.equal(error.code, "private");
    assert.match(error.message, /không công khai/);
    return true;
  });
  assert.equal(followingCalls, 0);
});

test("trang rỗng khi họ vẫn đang follow thì không lập mốc", async () => {
  const state = freshState();
  const client = {
    async profile() {
      return profile("GitHub", { following: 20 });
    },
    async following() {
      return { users: [], cursor: null };
    },
  };
  await assert.rejects(pollFollows({ client, handle: "github", state }), /trống tạm thời/);
  assert.equal(state.bootstrapped, false);
});

test("tài khoản chưa follow ai thì lập mốc rỗng, follow đầu được báo", async () => {
  const state = freshState();
  let phase = "empty";
  const client = {
    async profile() {
      return profile("newbie", { following: phase === "empty" ? 0 : 1 });
    },
    async following(_handle, opts) {
      assert.equal(opts.allowEmpty, phase === "empty");
      if (phase === "empty") return { users: [], cursor: null };
      return { users: [user(7, "first", { name: "First" })], cursor: null };
    },
  };
  const first = await pollFollows({ client, handle: "newbie", state });
  assert.equal(first.kind, "baseline");
  assert.equal(first.seeded, 0);
  phase = "one";
  const second = await pollFollows({ client, handle: "newbie", state });
  assert.deepEqual(second.alerts.map((item) => item.handle), ["first"]);
});

test("mốc rỗng nhưng họ follow cả một danh sách dài thì nhớ lại, không xả tin", async () => {
  const state = freshState();
  state.bootstrapped = true;
  state.emptyOk = true;
  const client = {
    async profile() {
      return profile("GitHub", { following: 300 });
    },
    async following() {
      return { users: [user(2, "a"), user(1, "b")], cursor: "more" };
    },
  };
  const result = await pollFollows({ client, handle: "github", state });
  assert.equal(result.kind, "baseline");
  assert.deepEqual(result.alerts, []);
  assert.equal(state.seen.has("2"), true);
});

test("Telegram lỗi thì lần sau báo lại đúng người đó", async () => {
  const state = freshState();
  state.bootstrapped = true;
  state.synced = true;
  state.followingCount = 1;
  state.seen.add("1");
  const store = memoryStore(state);
  const sent = [];
  let fail = true;
  const client = {
    async profile() {
      return profile("GitHub", { following: 2 });
    },
    async following() {
      return { users: [user(2, "new", { name: "New" }), user(1, "old")], cursor: null };
    },
  };
  await watch({
    handle: "github",
    client,
    store,
    maxCycles: 2,
    sleep: async () => {},
    log() {},
    async notify(text) {
      if (fail) {
        fail = false;
        throw new Error("telegram down");
      }
      sent.push(text);
    },
  });
  assert.deepEqual(sent, ["@GitHub vừa follow New (@new)\nhttps://x.com/new"]);
  assert.equal(store.get().seen.has("2"), true);
});

test("API follow hay 404 vẫn đọc được sau khi thử lại", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    calls.push(href);
    assert.equal(init.headers["user-agent"], "x-snipe/1.0");
    assert.equal(init.redirect, "error");
    if (calls.length === 1) {
      return jsonResponse({ code: 404, message: "User not found" }, 404);
    }
    if (href.endsWith("/github")) {
      return jsonResponse({
        code: 200,
        user: {
          type: "profile",
          id: "13334762",
          screen_name: "github",
          name: "GitHub",
          protected: false,
          following: 335,
          url: "https://x.com/github",
        },
      });
    }
    if (calls.filter((item) => item.includes("/following")).length === 1) {
      return jsonResponse({ code: 404, results: [], cursor: { top: null, bottom: null } }, 404);
    }
    const parsed = new URL(href);
    assert.equal(parsed.searchParams.get("count"), "100");
    assert.equal(parsed.searchParams.get("cursor"), "cursor token");
    return jsonResponse({
      code: 200,
      results: [
        { type: "profile", id: "5", screen_name: "octocat", name: "The\nOctocat", protected: false, url: "https://x.com/octocat" },
        { type: "not-user", id: "6", screen_name: "skip" },
      ],
      cursor: { bottom: null },
    });
  };
  const client = createXClient({ fetchImpl, sleep: async () => {}, retries: 3 });
  const loaded = await client.profile("github");
  assert.equal(loaded.handle, "github");
  assert.equal(loaded.protected, false);
  const page = await client.following("github", { cursor: "cursor token" });
  assert.equal(page.users.length, 1);
  assert.equal(page.users[0].name, "The Octocat");
  assert.equal(page.cursor, null);
});

test("hết lần thử thì báo không thấy tài khoản", async () => {
  const fetchImpl = async () => jsonResponse({ code: 404, message: "User not found" }, 404);
  const client = createXClient({ fetchImpl, sleep: async () => {}, retries: 1 });
  await assert.rejects(client.profile("missing"), (error) => {
    assert.ok(error instanceof FollowError);
    assert.equal(error.code, "not_found");
    return true;
  });
});

test("Telegram nhận đúng chat và không lộ token khi lỗi", async () => {
  const token = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef";
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, body: JSON.parse(init.body), redirect: init.redirect };
    return jsonResponse({ ok: false, description: `bad ${token}` }, 401);
  };
  await assert.rejects(sendTelegram({ token, chatId: "-100", text: "ping", fetchImpl }), (error) => {
    assert.match(error.message, /Telegram từ chối/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(sent.url, `https://api.telegram.org/bot${token}/sendMessage`);
  assert.equal(sent.body.chat_id, "-100");
  assert.equal(sent.body.text, "ping");
  assert.equal(sent.body.disable_web_page_preview, true);
  assert.equal(sent.redirect, "error");

  await assert.rejects(
    sendTelegram({
      token,
      chatId: "1",
      text: "ping",
      fetchImpl: async () => {
        throw new Error(`connect failed ${token}`);
      },
    }),
    (error) => {
      assert.equal(error.message.includes(token), false);
      assert.match(error.message, /connect failed \[token\]/);
      return true;
    },
  );
});

test("tiến trình follow không nhận khóa ví", async () => {
  process.env.PRIVATE_KEY = "0xsecret";
  const env = await loadRuntimeEnv({
    fileText: "PRIVATE_KEY=0xfromfile\nTELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_CHAT_ID=5\nOTHER=no\n",
  });
  assert.equal(env.TELEGRAM_BOT_TOKEN, "123:abc");
  assert.equal(env.TELEGRAM_CHAT_ID, "5");
  assert.equal(env.PRIVATE_KEY, undefined);
  assert.equal(env.OTHER, undefined);
  assert.equal(process.env.PRIVATE_KEY, undefined);
  assert.deepEqual(readFollowEnv("TELEGRAM_BOT_TOKEN=\"123:abc\"\n"), { TELEGRAM_BOT_TOKEN: "123:abc" });
});

test("không gọi trang web lạ", () => {
  assert.throws(() => assertAllowedApiUrl("http://api.fxtwitter.com/2/profile/a"), /HTTPS/);
  assert.throws(() => assertAllowedApiUrl("https://evil.example/steal"), /Telegram/);
  assert.throws(() => assertAllowedApiUrl("https://user:pass@api.telegram.org/bot"), /mật khẩu/);
  assertAllowedApiUrl("https://api.fxtwitter.com/2/profile/vladtenev");
  assertAllowedApiUrl("https://api.telegram.org/bot123:abc/sendMessage");
});

test("thiếu token hoặc chat id thì không chạy", () => {
  assert.throws(() => loadAlertConfig({}), /TELEGRAM_BOT_TOKEN/);
  assert.throws(() => loadAlertConfig({ TELEGRAM_BOT_TOKEN: "nope", TELEGRAM_CHAT_ID: "1" }), /định dạng/);
  assert.throws(
    () => loadAlertConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "hello" }),
    /TELEGRAM_CHAT_ID/,
  );
  assert.throws(
    () => loadAlertConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "5", FOLLOW_POLL_MS: "50" }),
    /FOLLOW_POLL_MS/,
  );
  const config = loadAlertConfig({ TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "@channel" });
  assert.equal(config.pollMs, 3000);
  assert.equal(config.chatId, "@channel");
});

test("lệnh chạy một vòng với link X và không gửi follow cũ", async () => {
  const previous = process.exitCode;
  const notes = [];
  const sent = [];
  await main(["--help"]);
  await main(["https://x.com/github"], { env: {} });
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;

  await main(["--once", "https://x.com/GitHub"], {
    env: { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42", FOLLOW_POLL_MS: "1000" },
    log: (message) => notes.push(message),
    notify: async (text) => sent.push(text),
    sleep: async () => {},
    client: {
      async profile() {
        return profile("GitHub", { following: 1, name: "GitHub" });
      },
      async following() {
        return { users: [user(9, "kept")], cursor: null };
      },
    },
    store: memoryStore(),
  });
  assert.deepEqual(sent, []);
  assert.match(notes.join("\n"), /Đã nhớ 1 follow/);
  assert.match(notes[0], /Cửa sổ này phải để mở/);

  let testText = "";
  await main(["--test-telegram"], {
    env: { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" },
    log() {},
    notify: async (text) => {
      testText = text;
    },
  });
  assert.match(testText, /Kết nối Telegram/);

  let onlineText = "";
  await main(["--online"], {
    env: { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" },
    log() {},
    notify: async (text) => {
      onlineText = text;
    },
  });
  assert.match(onlineText, /Tắt máy tính vẫn nhận tin/);
});

test("số follow không tăng thì người lạ chen vào không được báo", () => {
  const crowd = Array.from({ length: 8 }, (_item, index) => user(100 + index, `old${index}`));
  assert.deepEqual(chooseAlerts(crowd, { hitKnown: true, delta: 0 }), []);
  assert.deepEqual(chooseAlerts([user(3, "c"), user(2, "b")], { hitKnown: true, delta: 2 }).map((item) => item.id), ["3", "2"]);
  assert.deepEqual(chooseAlerts([user(4, "d")], { hitKnown: true, delta: 1 }).map((item) => item.handle), ["d"]);
  assert.deepEqual(chooseAlerts(crowd, { hitKnown: false, delta: 1 }), []);
});

test("trang đầu đã có người quen thì follow cũ nằm giữa không bị báo", async () => {
  const state = freshState();
  state.bootstrapped = true;
  state.synced = true;
  state.followingCount = 58;
  for (const id of ["1", "2", "3"]) state.seen.add(id);
  const result = await pollFollows({
    client: {
      async profile() {
        return profile("vladtenev", { following: 58 });
      },
      async following() {
        return {
          users: [user(1, "known"), user(99, "already"), user(2, "also")],
          cursor: null,
        };
      },
    },
    handle: "vladtenev",
    state,
  });
  assert.deepEqual(result.alerts, []);
  assert.equal(state.seen.has("99"), true);
});

test("nhớ gần hết danh sách thì thôi không đọc lại và không báo", async () => {
  const state = freshState();
  state.bootstrapped = true;
  const users = Array.from({ length: 8 }, (_item, index) => user(index + 1, `u${index}`));
  let calls = 0;
  const result = await pollFollows({
    client: {
      async profile() {
        return profile("vladtenev", { following: 20 });
      },
      async following() {
        calls += 1;
        return { users, cursor: "more" };
      },
    },
    handle: "vladtenev",
    state,
    baselinePages: 1,
  });
  assert.equal(result.alerts.length, 0);
  assert.equal(state.synced, true);
  assert.equal(state.seen.size, 8);
  const again = await pollFollows({
    client: {
      async profile() {
        return profile("vladtenev", { following: 20 });
      },
      async following() {
        calls += 1;
        return { users: [user(1, "u0"), user(99, "old")], cursor: null };
      },
    },
    handle: "vladtenev",
    state,
  });
  assert.deepEqual(again.alerts, []);
  assert.equal(state.seen.has("99"), true);
  assert.equal(calls, 2);
});

test("file cũ chỉ nhớ một phần thì nhớ nốt, không gửi lại", async () => {
  const raw = JSON.stringify({ version: 1, bootstrapped: true, emptyOk: false, seen: ["1"] });
  const state = parseState(raw);
  assert.equal(state.synced, false);
  assert.equal(state.followingCount, null);
  const result = await pollFollows({
    client: {
      async profile() {
        return profile("vladtenev", { following: 4 });
      },
      async following(_handle, opts) {
        if (!opts.cursor) return { users: [user(1, "known"), user(9, "old")], cursor: "next" };
        return { users: [user(8, "older"), user(7, "rest")], cursor: null };
      },
    },
    handle: "vladtenev",
    state,
    baselinePages: 5,
  });
  assert.deepEqual(result.alerts, []);
  for (const id of ["1", "9", "8", "7"]) assert.equal(state.seen.has(id), true, id);
  assert.equal(state.synced, true);
  assert.equal(state.followingCount, 4);
});

test("mở lại nhiều lần chỉ báo đúng một follow mới", async () => {
  const store = memoryStore();
  let users = [user(1, "old")];
  let count = 1;
  const sent = [];
  const client = {
    async profile() {
      return profile("vladtenev", { following: count });
    },
    async following() {
      return { users, cursor: null };
    },
  };
  const run = (cycles) =>
    watch({
      handle: "vladtenev",
      client,
      store,
      maxCycles: cycles,
      sleep: async () => {},
      log() {},
      notify: async (text) => sent.push(text),
    });

  await run(1);
  assert.deepEqual(sent, []);
  users = [user(2, "fresh", { name: "Fresh" }), user(1, "old")];
  count = 2;
  await run(1);
  assert.deepEqual(sent, ["@vladtenev vừa follow Fresh (@fresh)\nhttps://x.com/fresh"]);
  for (let i = 0; i < 20; i++) await run(1);
  users = [user(1, "old"), user(2, "fresh")];
  await run(5);
  users = [user(3, "already"), user(2, "fresh"), user(1, "old")];
  await run(5);
  assert.equal(sent.length, 1);
  assert.equal(store.get().seen.has("3"), false);
  count = 3;
  users = [user(4, "real", { name: "Real" }), user(3, "already"), user(2, "fresh"), user(1, "old")];
  await run(1);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /@real/);
  await run(10);
  assert.equal(sent.length, 2);
  assert.equal(store.get().seen.has("3"), true);
  assert.equal(store.get().people.some((item) => item.handle === "real"), true);
});

test("người đã báo một lần thì xoá khỏi seen cũng không báo lại", async () => {
  const state = freshState();
  state.bootstrapped = true;
  state.synced = true;
  state.followingCount = 2;
  state.seen.add("1");
  state.people.push({
    id: "2",
    handle: "fresh",
    name: "Fresh",
    url: "https://x.com/fresh",
    contracts: [],
    contractTweet: null,
    at: "2026-11-07T00:00:00.000Z",
  });
  const sent = [];
  await watch({
    handle: "vladtenev",
    client: {
      async profile() {
        return profile("vladtenev", { following: 2 });
      },
      async following() {
        return { users: [user(2, "fresh"), user(1, "old")], cursor: null };
      },
    },
    store: memoryStore(state),
    maxCycles: 4,
    sleep: async () => {},
    log() {},
    notify: async (text) => sent.push(text),
  });
  assert.deepEqual(sent, []);
});

test("ghi đè file trạng thái khi Windows không cho rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "follows-win-"));
  const target = join(dir, "a.json");
  const tmp = join(dir, "a.tmp");
  let attempts = 0;
  await replaceFile(target, "{\"ok\":1}\n", {
    tmp,
    async rename() {
      attempts += 1;
      const error = new Error("exists");
      error.code = attempts === 1 ? "EEXIST" : "EPERM";
      throw error;
    },
  });
  assert.equal(await readFile(target, "utf8"), "{\"ok\":1}\n");
  assert.equal(attempts, 2);

  const store = fileStore(join(dir, "vladtenev.json"));
  const state = freshState();
  state.bootstrapped = true;
  state.synced = true;
  state.followingCount = 58;
  state.seen.add("42");
  await store.save(state);
  state.seen.add("43");
  state.followingCount = 59;
  await store.save(state);
  const loaded = await store.load();
  assert.equal(loaded.synced, true);
  assert.equal(loaded.followingCount, 59);
  assert.equal(loaded.seen.has("42"), true);
  assert.equal(loaded.seen.has("43"), true);
});

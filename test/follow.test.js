import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/follow-alert.js";
import { loadAlertConfig } from "../src/follow-alert.js";
import {
  FollowError,
  createXClient,
  fileStore,
  formatFollowAlert,
  freshState,
  newFollows,
  parseState,
  pollFollows,
  sendTelegram,
  serializeState,
  watch,
} from "../src/follows.js";

function user(id, handle, extra = {}) {
  return {
    id: String(id),
    handle,
    name: extra.name || handle,
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
        bootstrapped: next.bootstrapped,
        emptyOk: next.emptyOk,
        seen: new Set(next.seen),
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

test("tin Telegram ghi tên và link", () => {
  assert.equal(
    formatFollowAlert("github", user(2, "octocat", { name: "The Octocat" })),
    "@github vừa follow The Octocat (@octocat)\nhttps://x.com/octocat",
  );
  assert.equal(formatFollowAlert("github", user(2, "octocat")), "@github vừa follow @octocat\nhttps://x.com/octocat");
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
    sent = { url, body: JSON.parse(init.body) };
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
  assert.match(notes[0], /Đã nhớ 1 follow/);

  let testText = "";
  await main(["--test-telegram"], {
    env: { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "42" },
    log() {},
    notify: async (text) => {
      testText = text;
    },
  });
  assert.match(testText, /Kết nối Telegram/);
});

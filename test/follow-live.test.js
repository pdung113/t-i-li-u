import assert from "node:assert/strict";
import test from "node:test";
import { createXClient, freshState, pollFollows, sendTelegram } from "../src/follows.js";

test("đọc follow công khai của @github và chỉ báo người chưa có trong mốc", { timeout: 60_000 }, async () => {
  const client = createXClient({ retries: 6 });
  const profile = await client.profile("github");
  assert.equal(profile.protected, false);
  assert.equal(profile.handle.toLowerCase(), "github");
  assert.ok(profile.following > 20);

  const page = await client.following(profile.handle, { count: 100 });
  assert.ok(page.users.length > 10);
  assert.ok(page.users.every((user) => user.id && user.handle && user.url.startsWith("https://x.com/")));
  if (page.cursor) {
    const older = await client.following(profile.handle, { count: 100, cursor: page.cursor });
    const newestIds = new Set(page.users.map((user) => user.id));
    const overlap = older.users.filter((user) => newestIds.has(user.id)).length;
    assert.ok(older.users.length === 0 || overlap < older.users.length);
  }

  const state = freshState();
  const baseline = await pollFollows({ client, handle: "github", state });
  assert.equal(baseline.kind, "baseline");
  assert.ok(baseline.seeded > 10);
  const known = new Set(state.seen);
  const next = await pollFollows({ client, handle: "github", state });
  assert.equal(next.kind, "diff");
  assert.ok(next.alerts.length < 5);
  for (const user of next.alerts) {
    assert.equal(known.has(user.id), false);
  }
});

test("@vladtenev là tài khoản công khai, đọc được bài viết", { timeout: 45_000 }, async () => {
  const client = createXClient({ retries: 6 });
  const profile = await client.profile("vladtenev");
  assert.equal(profile.protected, false);
  assert.equal(profile.handle.toLowerCase(), "vladtenev");
  assert.equal(profile.url, "https://x.com/vladtenev");
  assert.ok(profile.following > 0);
  const tweets = await client.statuses(profile.handle, { count: 5 });
  assert.ok(Array.isArray(tweets));
  assert.ok(tweets.length > 0);
  assert.ok(tweets.some((tweet) => typeof tweet.text === "string" && tweet.text.length > 0));
});

test("Telegram từ chối token giả", { timeout: 20_000 }, async () => {
  await assert.rejects(
    sendTelegram({
      token: "123456789:AAFakeTokenForFollowAlertTestOnly",
      chatId: "1",
      text: "ping",
    }),
    /Telegram từ chối/,
  );
});

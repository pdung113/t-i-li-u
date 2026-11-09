import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ethers } from "ethers";
import { startApp } from "../app/server.js";
import { parseNotepad } from "../src/nft/notepad.js";
import { decryptKeys, encryptKeys, lockNotepad } from "../src/nft/vault.js";

test("mật khẩu khóa private key và mở lại được", () => {
  const key = ethers.Wallet.createRandom().privateKey;
  const payload = encryptKeys([key], "mat-khau-dai");
  assert.equal(payload.includes(key.slice(2)), false);
  assert.deepEqual(decryptKeys(payload, "mat-khau-dai"), [key]);
  assert.throws(() => decryptKeys(payload, "sai-mat-khau-1"), /Mật khẩu không đúng/);
  const locked = lockNotepad(`chain=base\nlink=https://a.example\nkey=${key}\n`, "mat-khau-dai");
  assert.equal(locked.includes(key.slice(2)), false);
  const config = parseNotepad(locked);
  assert.equal(config.keys.length, 0);
  assert.equal(config.keyCount, 1);
  assert.deepEqual(decryptKeys(config.keysEnc, "mat-khau-dai"), [key]);
});

test("app không trả private key và từ chối trang khác", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nft-"));
  const file = join(dir, "nft.txt");
  const key = ethers.Wallet.createRandom().privateKey;
  const { server, url } = await startApp({
    port: 0,
    file,
    env: {},
    fetch: async () => ({ ok: true, text: async () => "<html>mint</html>" }),
    providerFactory: () => ({
      async getCode() {
        return "0x";
      },
      async destroy() {},
    }),
  });
  try {
    const saved = await fetch(`${url}/api/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `chain=base\ndry_run=true\nlink=https://one.example/drop\nkey=${key}\n`,
        password: "mat-khau-dai",
      }),
    });
    assert.equal(saved.status, 200);
    const disk = readFileSync(file, "utf8");
    assert.equal(disk.includes(key.slice(2)), false);
    const view = await (await fetch(`${url}/api/notepad`)).json();
    assert.equal(view.locked, true);
    assert.equal(view.keyCount, 1);
    assert.equal(JSON.stringify(view).includes(key.slice(2)), false);
    const refused = await fetch(`${url}/api/save`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ text: "chain=base\n", password: "mat-khau-dai" }),
    });
    assert.equal(refused.status, 403);
    const started = await fetch(`${url}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "chain=base\ndry_run=true\nlink=https://one.example/drop\n",
        password: "mat-khau-dai",
      }),
    });
    assert.equal(started.status, 200);
    let state = { running: true, logs: [], error: "" };
    for (let attempt = 0; attempt < 50 && state.running; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await (await fetch(`${url}/api/state`)).json();
    }
    assert.equal(state.running, false);
    assert.equal(JSON.stringify(state).includes(key.slice(2)), false);
    assert.ok(state.logs.some((line) => line.startsWith("one.example |")));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

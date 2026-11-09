import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { startApp } from "../app/server.js";

test("app local chạy nhiều dự án trên máy mình", async () => {
  const key = ethers.Wallet.createRandom().privateKey;
  const { server, url } = await startApp({
    port: 0,
    persist: false,
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
    const home = await fetch(url);
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Mint NFT/);
    assert.equal(html.includes(key), false);
    const meta = await (await fetch(`${url}/api/meta`)).json();
    assert.ok(meta.chains.includes("elysium"));
    assert.equal(new URL(url).hostname, "127.0.0.1");

    const bad = await fetch(`${url}/api/run`, { method: "POST", body: "chain=base\n" });
    assert.equal(bad.status, 400);

    const started = await fetch(`${url}/api/run`, {
      method: "POST",
      body: ["chain=base", "dry_run=true", "link=https://one.example/drop", "link=https://two.example/drop", `key=${key}`].join("\n"),
    });
    assert.equal(started.status, 200);
    let state = { running: true, logs: [] };
    for (let attempt = 0; attempt < 50 && state.running; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = await (await fetch(`${url}/api/state`)).json();
    }
    assert.equal(state.running, false);
    assert.ok(state.logs.some((line) => line.startsWith("1 one.example |")));
    assert.ok(state.logs.some((line) => line.startsWith("2 two.example |")));
    assert.equal(JSON.stringify(state).includes(key), false);

    const imported = await fetch(`${url}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: JSON.stringify({
          projects: [{ chain: "base", mintUrl: "https://one.example/drop", contract: "0x1111111111111111111111111111111111111111" }],
        }),
      }),
    });
    const importedBody = await imported.json();
    assert.equal(imported.status, 200);
    assert.equal(importedBody.count, 1);
    assert.equal(importedBody.links[0], "base https://one.example/drop");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

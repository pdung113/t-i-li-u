import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NFT_CHAINS } from "../src/nft/chains.js";
import { runProjects } from "../src/nft/index.js";
import { parseNotepad, redactNotepad } from "../src/nft/notepad.js";
import { projectLink, projectsFromJson } from "../src/nft/projects.js";
import { lockNotepad } from "../src/nft/vault.js";

const appDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(appDir, "..");
function pageHtml() {
  return readFileSync(new URL("./index.html", import.meta.url), "utf8");
}

function fromHere(req) {
  const host = String(req.headers.host || "");
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(origin));
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(JSON.stringify(body));
}

function readPayload(raw) {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("{")) return { text: raw, password: "" };
  try {
    const body = JSON.parse(raw);
    return { text: String(body.text || ""), password: String(body.password || "") };
  } catch {
    return { text: raw, password: "" };
  }
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 3_000_000) {
        reject(new Error("Nội dung quá dài."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createApp(deps = {}) {
  const cwd = deps.cwd || root;
  const file = deps.file || resolve(cwd, "nft.txt");
  const job = {
    running: false,
    logs: [],
    reports: null,
    error: "",
    stopFlag: false,
    clients: new Set(),
  };

  function publish(event) {
    const packet = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of job.clients) client.write(packet);
  }

  function resetJob() {
    job.running = true;
    job.logs = [];
    job.reports = null;
    job.error = "";
    job.stopFlag = false;
  }

  function writePrivate(text) {
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows không đặt quyền kiểu Unix.
    }
  }

  function prepare(text, password) {
    let config = parseNotepad(text, { allowEmptyKeys: true });
    if (!config.chain) throw new Error("Chưa điền chain. Ví dụ: chain=base");
    if (!config.links.length) throw new Error("Chưa điền link.");
    if (config.keys.length) {
      if (deps.persist !== false && String(password || "").length < 8) {
        throw new Error("Nhập mật khẩu ít nhất 8 ký tự để khóa private key.");
      }
      if (password) {
        const stored = lockNotepad(text, password);
        if (deps.persist !== false) writePrivate(stored);
        config = parseNotepad(stored);
      }
    } else if (!config.keysEnc && existsSync(file)) {
      const disk = parseNotepad(readFileSync(file, "utf8"), { allowEmptyKeys: true });
      config.keysEnc = disk.keysEnc;
      config.keyCount = disk.keyCount;
      if (config.keysEnc && deps.persist !== false) {
        writePrivate(`${text.replace(/\s*$/, "")}\nkey_count=${config.keyCount || 0}\nkeys_enc=${config.keysEnc}\n`);
      }
    }
    if (!config.keys.length && !config.keysEnc) throw new Error("Chưa điền private key.");
    return config;
  }

  async function handle(req, res) {
    if (!fromHere(req)) {
      sendJson(res, { error: "App chỉ nhận kết nối từ máy này." }, 403);
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      res.end(pageHtml());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/meta") {
      sendJson(res, { chains: Object.keys(NFT_CHAINS), file });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/notepad") {
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      let locked = false;
      let keyCount = 0;
      try {
        const config = parseNotepad(text, { allowEmptyKeys: true });
        locked = Boolean(config.keysEnc);
        keyCount = locked ? config.keyCount || 0 : config.keys.length;
      } catch {
        locked = false;
      }
      sendJson(res, { text: redactNotepad(text), locked, keyCount });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      sendJson(res, {
        running: job.running,
        logs: job.logs,
        reports: job.reports,
        error: job.error,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      job.clients.add(res);
      for (const line of job.logs) res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`);
      if (!job.running && (job.reports || job.error)) {
        res.write(`data: ${JSON.stringify({ type: "done", reports: job.reports, error: job.error })}\n\n`);
      }
      req.on("close", () => job.clients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/import") {
      const raw = await readBody(req);
      let source = raw;
      try {
        const body = JSON.parse(raw);
        source = body.json ?? body;
      } catch {
        source = raw;
      }
      try {
        const projects = projectsFromJson(source);
        sendJson(res, { ok: true, count: projects.length, links: projects.map(projectLink) });
      } catch (error) {
        sendJson(res, { error: error.message || String(error) }, 400);
      }
      return;
    }
    if (req.method === "POST" && (url.pathname === "/api/run" || url.pathname === "/api/save")) {
      const { text, password } = readPayload(await readBody(req));
      let config;
      try {
        config = prepare(text, password);
      } catch (error) {
        sendJson(res, { error: error.message || String(error) }, 400);
        return;
      }
      const wallets = config.keys.length || config.keyCount || 0;
      if (url.pathname === "/api/save") {
        sendJson(res, { ok: true, projects: config.links.length, wallets, locked: Boolean(config.keysEnc) });
        return;
      }
      if (job.running) {
        sendJson(res, { error: "Đang mint. Bấm Dừng trước khi chạy đợt mới." }, 409);
        return;
      }
      resetJob();
      publish({ type: "start" });
      sendJson(res, { ok: true, projects: config.links.length, wallets, locked: Boolean(config.keysEnc) });
      runProjects(config, {
        ...deps,
        listen: false,
        env: deps.env || {},
        password,
        shouldStop: () => job.stopFlag,
        log: (message) => {
          const line = String(message);
          job.logs.push(line);
          publish({ type: "log", line });
        },
      })
        .then((reports) => {
          job.running = false;
          job.reports = reports.map((item) => ({ chain: item.chain, text: item.text }));
          publish({ type: "done", reports: job.reports, error: "" });
        })
        .catch((error) => {
          job.running = false;
          job.error = error.message || String(error);
          publish({ type: "done", reports: null, error: job.error });
        });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/stop") {
      job.stopFlag = true;
      publish({ type: "log", line: "Đã nhận lệnh dừng. Lượt gọi mint hiện tại sẽ dừng." });
      sendJson(res, { ok: true });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Không thấy.");
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) sendJson(res, { error: error.message || String(error) }, 500);
    });
  });
}

export function startApp(deps = {}) {
  const server = createApp(deps);
  const port = deps.port != null ? Number(deps.port) : Number(process.env.NFT_APP_PORT || 4173);
  const host = "127.0.0.1";
  return new Promise((resolveListen) => {
    server.listen(port, host, () => {
      const address = server.address();
      resolveListen({ server, url: `http://${host}:${address.port}` });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { url } = await startApp();
  console.log(`Mở app: ${url}`);
  console.log("App chỉ nghe trên máy này. Private key không rời máy.");
}

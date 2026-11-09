import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NFT_CHAINS } from "../src/nft/chains.js";
import { runProjects } from "../src/nft/index.js";
import { parseNotepad } from "../src/nft/notepad.js";

const appDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(appDir, "..");
function pageHtml() {
  return readFileSync(new URL("./index.html", import.meta.url), "utf8");
}

function sendJson(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
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

  async function handle(req, res) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(pageHtml());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/meta") {
      sendJson(res, { chains: Object.keys(NFT_CHAINS), file });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/notepad") {
      const text = existsSync(file) ? readFileSync(file, "utf8") : "";
      sendJson(res, { text });
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
    if (req.method === "POST" && (url.pathname === "/api/run" || url.pathname === "/api/save")) {
      const text = await readBody(req);
      let config;
      try {
        config = parseNotepad(text);
      } catch (error) {
        sendJson(res, { error: error.message || String(error) }, 400);
        return;
      }
      if (deps.persist !== false) writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
      if (url.pathname === "/api/save") {
        sendJson(res, { ok: true, projects: config.links.length, wallets: config.keys.length });
        return;
      }
      if (job.running) {
        sendJson(res, { error: "Đang mint. Bấm Dừng trước khi chạy đợt mới." }, 409);
        return;
      }
      resetJob();
      publish({ type: "start" });
      sendJson(res, { ok: true, projects: config.links.length, wallets: config.keys.length });
      runProjects(config, {
        ...deps,
        listen: false,
        env: deps.env || {},
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

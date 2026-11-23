import { ethers } from "ethers";
import { resolveNftChain } from "./chains.js";

const NAMES = {
  chain: "chain",
  gas: "gas",
  gas_x: "gasX",
  gasx: "gasX",
  nhan_gas: "gasX",
  gas_limit: "gasLimit",
  gaslimit: "gasLimit",
  qty: "qty",
  so_luong: "qty",
  soluong: "qty",
  max_price: "maxPrice",
  maxprice: "maxPrice",
  gia_tran: "maxPrice",
  giatran: "maxPrice",
  dry_run: "dryRun",
  dryrun: "dryRun",
  link: "link",
  rpc: "rpc",
  rpc_url: "rpc",
  rpcurl: "rpc",
  key: "key",
  vi: "key",
  private_key: "key",
  privatekey: "key",
  keys_enc: "keysEnc",
  keysenc: "keysEnc",
  key_count: "keyCount",
};

export function parseLinkValue(value) {
  const text = String(value || "").trim();
  const parts = text.split(/\s+/);
  if (parts.length === 2 && /^https?:\/\//i.test(parts[1])) {
    return { url: parts[1], chain: resolveNftChain(parts[0]).name };
  }
  if (parts.length === 2 && /^https?:\/\//i.test(parts[0]) && /^chain=/i.test(parts[1])) {
    return { url: parts[0], chain: resolveNftChain(parts[1].slice("chain=".length)).name };
  }
  if (parts.length !== 1 || !/^https?:\/\//i.test(text)) throw new Error(`Link không hợp lệ: ${value}`);
  return { url: text, chain: null };
}

function field(line) {
  const eq = line.indexOf("=");
  if (eq === -1) return null;
  const name = NAMES[line.slice(0, eq).trim().toLowerCase()];
  if (!name) return null;
  return { name, value: line.slice(eq + 1).trim() };
}

export function parseGasX(value, lineNo = 0) {
  const text = String(value || "").trim().toLowerCase().replace("×", "x");
  const match = text.match(/^(?:x)?(\d+(?:\.\d+)?)(?:x)?$/);
  const where = lineNo ? ` dòng ${lineNo}` : "";
  if (!match) throw new Error(`gas_x${where} không hợp lệ. Ví dụ: 2 hoặc 3.`);
  const factor = Number(match[1]);
  if (!(factor >= 1) || factor > 10) throw new Error(`gas_x${where} từ 1 đến 10. Ví dụ 2 hoặc 3.`);
  return factor;
}

export function multiplyGas(gasGwei, factor = 1) {
  const times = Number(factor || 1);
  const wei = ethers.parseUnits(String(gasGwei), "gwei");
  const milli = BigInt(Math.round(times * 1000));
  const scaled = (wei * milli) / 1000n;
  if (scaled <= 0n) throw new Error("gas sau khi nhân phải lớn hơn 0.");
  return ethers.formatUnits(scaled, "gwei").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function normalizeKey(value, lineNo) {
  let key = value.replace(/^["']|["']$/g, "");
  if (!key) return null;
  if (!key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) throw new Error(`Private key dòng ${lineNo} không đúng định dạng.`);
  return key.toLowerCase();
}

export function redactNotepad(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (/^(0x)?[a-fA-F0-9]{64}$/.test(trimmed)) return "key=***";
      const eq = trimmed.indexOf("=");
      if (eq === -1) return line;
      const name = trimmed.slice(0, eq).trim().toLowerCase();
      if (["key", "vi", "private_key", "privatekey"].includes(name)) return `${name}=***`;
      return line;
    })
    .join("\n");
}

export function parseNotepad(text, options = {}) {
  const config = {
    chain: null,
    gas: null,
    gasX: null,
    gasLimit: null,
    qty: null,
    maxPrice: null,
    dryRun: null,
    links: [],
    rpc: null,
    keys: [],
    keysEnc: null,
    keyCount: 0,
  };
  const seen = new Set();
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const item = field(line);
    if (!item) {
      if (/https?:\/\//i.test(line)) {
        config.links.push(parseLinkValue(line));
        continue;
      }
      else if (/^(0x)?[a-fA-F0-9]{64}$/.test(line)) {
        const key = normalizeKey(line, lineNo);
        if (seen.has(key)) throw new Error(`Trùng ví ${shortAddress(new ethers.Wallet(key).address)}.`);
        seen.add(key);
        config.keys.push(key);
      } else throw new Error(`Dòng ${lineNo} không hiểu. Dùng chain, gas, qty, link hoặc key.`);
      continue;
    }
    if (!item.value) continue;
    if (item.name === "chain") config.chain = resolveNftChain(item.value).name;
    else if (item.name === "gas") config.gas = item.value;
    else if (item.name === "gasX") config.gasX = parseGasX(item.value, lineNo);
    else if (item.name === "gasLimit") {
      if (!/^\d+$/.test(item.value) || Number(item.value) < 21_000) throw new Error(`gas_limit dòng ${lineNo} quá thấp.`);
      config.gasLimit = Number(item.value);
    } else if (item.name === "qty") {
      if (!/^\d+$/.test(item.value) || Number(item.value) < 1) throw new Error(`qty dòng ${lineNo} phải là số nguyên từ 1.`);
      config.qty = Number(item.value);
    } else if (item.name === "maxPrice") {
      try {
        ethers.parseEther(item.value);
      } catch {
        throw new Error(`max_price dòng ${lineNo} không hợp lệ.`);
      }
      config.maxPrice = item.value;
    } else if (item.name === "dryRun") {
      config.dryRun = ["1", "true", "yes", "on"].includes(item.value.toLowerCase());
    } else if (item.name === "link") config.links.push(parseLinkValue(item.value));
    else if (item.name === "rpc") {
      if (!/^https?:\/\//i.test(item.value)) throw new Error(`rpc dòng ${lineNo} phải là link http hoặc https.`);
      config.rpc = item.value;
    } else if (item.name === "key") {
      const key = normalizeKey(item.value, lineNo);
      if (!key) continue;
      if (seen.has(key)) throw new Error(`Trùng ví ${shortAddress(new ethers.Wallet(key).address)}.`);
      seen.add(key);
      config.keys.push(key);
    } else if (item.name === "keysEnc") config.keysEnc = item.value;
    else if (item.name === "keyCount") config.keyCount = Number(item.value) || 0;
  }
  if (!config.chain) throw new Error("Chưa điền chain. Ví dụ: chain=base");
  if (!config.links.length) throw new Error("Chưa điền link.");
  for (const link of config.links) {
    if (!/^https?:\/\//i.test(link.url)) throw new Error(`Link không hợp lệ: ${link.url}`);
  }
  if (!config.keys.length && !config.keysEnc && !options.allowEmptyKeys) throw new Error("Chưa điền private key.");
  if (config.gas != null) {
    let gas;
    try {
      gas = ethers.parseUnits(String(config.gas), "gwei");
    } catch {
      throw new Error("gas không hợp lệ.");
    }
    if (gas <= 0n) throw new Error("gas phải lớn hơn 0.");
  }
  return config;
}

export function shortAddress(address) {
  const value = String(address || "");
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) return "ví ?";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function safeReason(message) {
  return String(message || "lỗi").replace(/0x[a-fA-F0-9]{64}/gi, "0x…");
}

export function formatReport(rows, chainName) {
  const lines = [`Kết quả | chain ${chainName}`];
  let sentWallets = 0;
  let sentNfts = 0;
  let readyWallets = 0;
  let readyNfts = 0;
  rows.forEach((row, index) => {
    const name = shortAddress(row.wallet);
    if (row.sent) {
      sentWallets += 1;
      sentNfts += Number(row.quantity) || 0;
      const extra = row.reason ? ` | ${safeReason(row.reason)}` : "";
      lines.push(`${index + 1}. ${name} | chain ${chainName} | thành công | ${row.quantity} NFT${extra}`);
    } else if (row.ok) {
      readyWallets += 1;
      readyNfts += Number(row.quantity) || 0;
      lines.push(`${index + 1}. ${name} | chain ${chainName} | chưa gửi | sẽ mint ${row.quantity} NFT`);
    } else {
      lines.push(`${index + 1}. ${name} | chain ${chainName} | thất bại | 0 NFT | ${safeReason(row.reason)}`);
    }
  });
  if (rows.some((row) => row.sent)) {
    lines.push(`Thành công ${sentWallets}/${rows.length} ví, tổng ${sentNfts} NFT.`);
  } else if (rows.some((row) => row.ok)) {
    lines.push(`Sẵn sàng ${readyWallets}/${rows.length} ví, tổng sẽ mint ${readyNfts} NFT. Chưa gửi giao dịch.`);
  } else {
    lines.push(`Thành công 0/${rows.length} ví, tổng 0 NFT.`);
  }
  return lines.join("\n");
}

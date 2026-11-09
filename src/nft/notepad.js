import { ethers } from "ethers";
import { resolveNftChain } from "./chains.js";

const NAMES = {
  chain: "chain",
  gas: "gas",
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
};

function field(line) {
  const eq = line.indexOf("=");
  if (eq === -1) return null;
  const name = NAMES[line.slice(0, eq).trim().toLowerCase()];
  if (!name) return null;
  return { name, value: line.slice(eq + 1).trim() };
}

function normalizeKey(value, lineNo) {
  let key = value.replace(/^["']|["']$/g, "");
  if (!key) return null;
  if (!key.startsWith("0x")) key = `0x${key}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(key)) throw new Error(`Private key dòng ${lineNo} không đúng định dạng.`);
  return key.toLowerCase();
}

export function parseNotepad(text) {
  const config = {
    chain: null,
    gas: null,
    gasLimit: null,
    qty: null,
    maxPrice: null,
    dryRun: null,
    links: [],
    rpc: null,
    keys: [],
  };
  const seen = new Set();
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const line = lines[index].trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const item = field(line);
    if (!item) {
      if (/^https?:\/\//i.test(line)) config.links.push(line);
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
    } else if (item.name === "link") config.links.push(item.value);
    else if (item.name === "rpc") {
      if (!/^https?:\/\//i.test(item.value)) throw new Error(`rpc dòng ${lineNo} phải là link http hoặc https.`);
      config.rpc = item.value;
    } else if (item.name === "key") {
      const key = normalizeKey(item.value, lineNo);
      if (!key) continue;
      if (seen.has(key)) throw new Error(`Trùng ví ${shortAddress(new ethers.Wallet(key).address)}.`);
      seen.add(key);
      config.keys.push(key);
    }
  }
  if (!config.chain) throw new Error("Chưa điền chain. Ví dụ: chain=base");
  if (!config.links.length) throw new Error("Chưa điền link.");
  for (const link of config.links) {
    if (!/^https?:\/\//i.test(link)) throw new Error(`Link không hợp lệ: ${link}`);
  }
  if (!config.keys.length) throw new Error("Chưa điền private key.");
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
      lines.push(`${index + 1}. ${name} | chain ${chainName} | thành công | ${row.quantity} NFT`);
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

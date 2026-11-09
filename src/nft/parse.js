import { ethers } from "ethers";
import { chainFromId } from "./chains.js";

const ADDR = /0x[a-fA-F0-9]{40}/g;
const NAMED_ADDRESS = /["']?[A-Za-z0-9_]*address[A-Za-z0-9_]*["']?\s*[:=]\s*["'](0x[a-fA-F0-9]{40})["']/gi;
const IGNORE_ADDRESS = new Set([
  "0xca11bde05977b3631167028862be2a173976ca11",
  "0x00000000000000000000000000000000deadbeef",
]);
const KEY = /["']?(?:contractAddress|contract_address|nftAddress|nftContract|collectionAddress|tokenAddress|mintContract|dropContract|contract|collection)["']?\s*[:=]\s*["'](0x[a-fA-F0-9]{40})["']/gi;
const CHAIN_WORD = {
  ethereum: "eth",
  eth: "eth",
  mainnet: "eth",
  base: "base",
  polygon: "polygon",
  matic: "polygon",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  optimism: "optimism",
  op: "optimism",
  bsc: "bsc",
  bnb: "bsc",
  elysium: "elysium",
  elys: "elysium",
  kinetiq: "elysium",
};

function checksum(address) {
  return ethers.getAddress(address);
}

function repeatingAddress(address) {
  const hex = address.slice(2).toLowerCase();
  return /^(f|e)\1+$/.test(hex);
}

export function keepAddress(address) {
  try {
    const key = checksum(address);
    if (key === ethers.ZeroAddress || repeatingAddress(key) || IGNORE_ADDRESS.has(key.toLowerCase())) return null;
    return key;
  } catch {
    return null;
  }
}

export function collectionSlug(pageUrl) {
  try {
    const parts = new URL(pageUrl).pathname.split("/").filter(Boolean);
    return [...parts].reverse().find((part) => !/^(mint|launchpad|drop|nft|launch|sale)$/i.test(part)) || "";
  } catch {
    return "";
  }
}

export function addressesNearSlug(text, slug) {
  const needle = String(slug || "").toLowerCase();
  if (needle.length < 3) return [];
  const source = String(text || "");
  const lower = source.toLowerCase();
  const out = [];
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    const window = source.slice(Math.max(0, at - 700), at + 1000);
    for (const match of window.matchAll(ADDR)) {
      const key = keepAddress(match[0]);
      if (key && !out.includes(key)) out.push(key);
    }
    from = at + needle.length;
  }
  return out;
}

export function parseMarketUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Link không hợp lệ. Dán link http hoặc https của trang mint.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Chỉ nhận link http hoặc https.");
  }
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const addresses = parts
    .map((part) => {
      const match = part.match(/0x[a-fA-F0-9]{40}/);
      return match ? checksum(match[0]) : null;
    })
    .filter(Boolean);
  const chain = parts.map((part) => CHAIN_WORD[part.toLowerCase()]).find(Boolean) || null;
  const addressIndex = parts.findIndex((part) => /0x[a-fA-F0-9]{40}/.test(part));
  const tokenPart = addressIndex >= 0 && /^\d+$/.test(parts[addressIndex + 1] || "") ? parts[addressIndex + 1] : null;

  if (host === "kalos.fun" && (parts[0] === "mint" || parts[0] === "drops") && parts[1]) {
    return { kind: "kalos", slug: parts[1], chain: "elysium", contract: null, tokenId: null, href: url.href };
  }

  if (host === "opensea.io" || host.endsWith(".opensea.io")) {
    if (parts[0] === "collection" && parts[1]) {
      return { kind: "collection", slug: parts[1], chain, contract: addresses[0] || null, tokenId: null, href: url.href };
    }
    if ((parts[0] === "item" || parts[0] === "assets") && addresses[0]) {
      return {
        kind: "item",
        slug: null,
        chain,
        contract: addresses[0],
        tokenId: tokenPart || null,
        href: url.href,
      };
    }
  }

  if (addresses[0]) {
    return { kind: "contract", slug: null, chain, contract: addresses[0], tokenId: tokenPart || null, href: url.href };
  }
  return { kind: "page", slug: null, chain, contract: null, tokenId: null, href: url.href };
}

export function extractCandidates(html) {
  const scores = new Map();
  const add = (address, score) => {
    let key;
    try {
      key = checksum(address);
    } catch {
      return;
    }
    if (!keepAddress(key)) return;
    scores.set(key, Math.max(scores.get(key) || 0, score));
  };

  for (const match of String(html || "").matchAll(KEY)) add(match[1], 100);
  for (const match of String(html || "").matchAll(NAMED_ADDRESS)) add(match[1], 90);

  const text = String(html || "");
  for (const match of text.matchAll(ADDR)) {
    const index = match.index ?? 0;
    const window = text.slice(Math.max(0, index - 80), index + 80).toLowerCase();
    const nearMint = /mint|drop|nft|contract/.test(window);
    add(match[0], nearMint ? 20 : 1);
  }

  return [...scores.entries()]
    .map(([address, score]) => ({ address, score }))
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
}

export function chainHintsFromText(text) {
  const hints = [];
  const push = (name) => {
    if (name && !hints.includes(name)) hints.push(name);
  };
  for (const match of String(text || "").matchAll(/chain(?:Id|_id)?["'\s:=]+(\d{1,8})/gi)) {
    const chain = chainFromId(match[1]);
    if (chain) push(chain.name);
  }
  for (const match of String(text || "").matchAll(/["']chain["']\s*:\s*["']([a-zA-Z]+)["']/g)) {
    const name = CHAIN_WORD[match[1].toLowerCase()];
    if (name) push(name);
  }
  const counts = new Map();
  for (const [word, name] of Object.entries(CHAIN_WORD)) {
    if (word.length < 6) continue;
    const found = String(text || "").match(new RegExp(`\\b${word}\\b`, "gi"));
    if (found) counts.set(name, (counts.get(name) || 0) + found.length);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked[0] && ranked[0][1] >= 8 && ranked[0][1] >= (ranked[1]?.[1] || 0) * 1.5) {
    const name = ranked[0][0];
    const rest = hints.filter((item) => item !== name);
    hints.splice(0, hints.length, name, ...rest);
  }
  return hints;
}

export function contractUnpublished(text) {
  const source = String(text || "");
  const empty = /["']?(?:contract|contractAddress|nftAddress|collection)["']?\s*:\s*(?:void 0|undefined|null|""|'')/.test(source);
  if (!empty) return false;
  return /mint/i.test(source);
}

export function scriptChunks(text, pageUrl) {
  const links = [];
  let base;
  try {
    base = new URL(pageUrl);
  } catch {
    return links;
  }
  const push = (raw) => {
    try {
      let url;
      if (raw.startsWith("./") || raw.startsWith("../")) url = new URL(raw, base);
      else if (raw.startsWith("http://") || raw.startsWith("https://")) url = new URL(raw);
      else url = new URL(raw.startsWith("/") ? raw : `/${raw}`, `${base.origin}/`);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      if (!url.pathname.endsWith(".js")) return;
      if (url.origin !== base.origin && !/mint|drop|nft|launch/i.test(url.href)) return;
      if (links.includes(url.href)) return;
      links.push(url.href);
    } catch {
      // đường js hỏng
    }
  };
  for (const match of String(text || "").matchAll(/["'`]([^"'`]+\.js)["'`]/g)) push(match[1]);
  return links;
}

function asAddress(value) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) return null;
  try {
    return checksum(value);
  } catch {
    return null;
  }
}

function asBytes32List(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(item)) return null;
    out.push(item);
  }
  return out;
}

function num(value) {
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.floor(value));
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function bool(value) {
  if (typeof value === "boolean") return value;
  return null;
}

function walk(value, wallet, out, depth, state) {
  if (state.nodes > 8000 || depth > 8 || value == null) return;
  state.nodes += 1;
  if (Array.isArray(value)) {
    if (value.length >= 2 && value.every((item) => typeof item === "string" && /^0x[a-fA-F0-9]{40}$/.test(item))) {
      out.lists.push(value.map((item) => asAddress(item)).filter(Boolean).map((item) => item.toLowerCase()));
    }
    for (const item of value) walk(item, wallet, out, depth + 1, state);
    return;
  }
  if (typeof value !== "object") return;

  const address = asAddress(value.address || value.wallet || value.account || value.minter || value.owner);
  const proof = asBytes32List(value.proof || value.merkleProof || value.proofs);
  if (address && proof && (!wallet || address.toLowerCase() === wallet.toLowerCase())) {
    out.entries.push({
      address: address.toLowerCase(),
      proof,
      mintPrice: num(value.mintPrice ?? value.price ?? value.pricePerToken),
      maxTotalMintableByWallet: num(value.maxTotalMintableByWallet ?? value.maxPerWallet ?? value.quantityLimitPerWallet ?? value.limit),
      startTime: num(value.startTime ?? value.startTimestamp ?? value.start),
      endTime: num(value.endTime ?? value.endTimestamp ?? value.end),
      dropStageIndex: num(value.dropStageIndex ?? value.stage ?? value.dropStage),
      maxTokenSupplyForStage: num(value.maxTokenSupplyForStage ?? value.maxSupply ?? value.maxClaimableSupply),
      feeBps: num(value.feeBps ?? value.fee),
      restrictFeeRecipients: bool(value.restrictFeeRecipients),
      currency: asAddress(value.currency),
    });
  }
  for (const child of Object.values(value)) walk(child, wallet, out, depth + 1, state);
}

export function parseEmbeddedJson(html) {
  const blobs = [];
  const text = String(html || "");
  const scripts = text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const body = match[1].trim();
    if (!body) continue;
    if (body.startsWith("{") || body.startsWith("[")) {
      try {
        blobs.push(JSON.parse(body));
        continue;
      } catch {
        // not json
      }
    }
    const assigned = body.match(/=\s*(\{[\s\S]*\}|\[[\s\S]*\])\s;?$/);
    if (assigned) {
      try {
        blobs.push(JSON.parse(assigned[1]));
      } catch {
        // ignore broken assignment
      }
    }
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      blobs.push(JSON.parse(trimmed));
    } catch {
      // page is not json
    }
  }
  return blobs;
}

export function collectAllowInfo(html, wallet) {
  const out = { entries: [], lists: [] };
  const state = { nodes: 0 };
  for (const blob of parseEmbeddedJson(html)) walk(blob, wallet, out, 0, state);
  return out;
}

export function linkedResources(html, pageUrl) {
  const links = [];
  const base = new URL(pageUrl);
  const push = (raw) => {
    try {
      const url = new URL(raw, base);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      if (links.includes(url.href)) return;
      links.push(url.href);
    } catch {
      // bad url
    }
  };
  for (const match of String(html || "").matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) push(match[1]);
  for (const match of String(html || "").matchAll(/<link[^>]+href=["']([^"']+\.js)["']/gi)) push(match[1]);
  for (const match of String(html || "").matchAll(/https?:\/\/[^"'\s>]+\.json/gi)) push(match[0]);
  return links.slice(0, 8);
}

import { ethers } from "ethers";
import { chainFromId, resolveNftChain } from "./chains.js";

const URL_KEYS = new Set([
  "url",
  "link",
  "href",
  "minturl",
  "mint_url",
  "mintlink",
  "mint_link",
  "website",
  "page",
  "mintpage",
  "mint_page",
  "site",
  "mint",
  "drop",
]);
const CONTRACT_KEYS = new Set([
  "contract",
  "contractaddress",
  "contract_address",
  "address",
  "nft",
  "nftaddress",
  "nft_address",
  "collection",
  "collectionaddress",
  "tokenaddress",
  "token_address",
  "nftcontract",
  "dropcontract",
]);
const CHAIN_KEYS = new Set(["chain", "network", "blockchain", "chainid", "chain_id"]);
const SKIP_URL_KEYS = new Set([
  "image",
  "imageurl",
  "image_url",
  "img",
  "logo",
  "icon",
  "banner",
  "thumbnail",
  "avatar",
  "twitter",
  "discord",
  "telegram",
]);

function keyName(key) {
  return String(key || "").toLowerCase().replace(/[\s-]/g, "");
}

function asUrl(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return null;
  if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(text)) return null;
  return text;
}

function asContract(value) {
  const text = String(value || "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(text)) return null;
  try {
    return ethers.getAddress(text);
  } catch {
    return null;
  }
}

function asChain(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) return chainFromId(value)?.name || null;
  try {
    return resolveNftChain(value).name;
  } catch {
    return null;
  }
}

function walk(node, chain, found) {
  if (typeof node === "string") {
    const url = asUrl(node);
    if (url) found.push({ url, contract: null, chain });
    return;
  }
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, chain, found);
    return;
  }
  let nextChain = chain;
  for (const [key, value] of Object.entries(node)) {
    if (!CHAIN_KEYS.has(keyName(key))) continue;
    const parsed = asChain(value);
    if (parsed) nextChain = parsed;
  }
  let url = null;
  let contract = null;
  for (const [key, value] of Object.entries(node)) {
    const name = keyName(key);
    if (SKIP_URL_KEYS.has(name)) continue;
    if (!url && (URL_KEYS.has(name) || name.includes("mint"))) url = asUrl(value);
    if (!contract && CONTRACT_KEYS.has(name)) contract = asContract(value);
  }
  if (url || contract) found.push({ url, contract, chain: nextChain });
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walk(value, nextChain, found);
  }
}

export function projectsFromJson(input) {
  let data = input;
  if (typeof input === "string") {
    try {
      data = JSON.parse(input);
    } catch {
      throw new Error("File JSON không đọc được.");
    }
  }
  if (!data || typeof data !== "object") throw new Error("File JSON không có danh sách dự án.");
  const found = [];
  walk(data, null, found);
  const kept = new Map();
  for (const item of found) {
    const key = item.contract
      ? `${item.chain || ""}|${item.contract.toLowerCase()}`
      : `url|${item.chain || ""}|${String(item.url).toLowerCase()}`;
    const previous = kept.get(key);
    if (!previous || (!previous.url && item.url)) kept.set(key, item);
  }
  const projects = [...kept.values()].slice(0, 100);
  if (!projects.length) throw new Error("JSON không có link mint hoặc địa chỉ contract.");
  return projects;
}

export function projectLink(project) {
  if (project.url) return project.chain ? `${project.chain} ${project.url}` : project.url;
  const chain = project.chain || "base";
  return `${chain} https://nft.local/${chain}/${project.contract}`;
}

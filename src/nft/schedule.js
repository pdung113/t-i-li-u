import { ethers } from "ethers";
import { chainFromId } from "./chains.js";

function sliceObject(text, start) {
  let depth = 0;
  let quote = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function asAddress(value) {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(value)) return null;
  try {
    return ethers.getAddress(value);
  } catch {
    return null;
  }
}

function phaseStart(raw) {
  const value = raw?.starts ?? raw?.start ?? raw?.startTime ?? raw?.start_time ?? raw?.opens;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const number = Number(value);
    if (number > 1e12) return Math.floor(number / 1000);
    if (number > 1e9) return Math.floor(number);
  }
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function priceOf(raw) {
  const value = raw?.price ?? raw?.priceWei ?? raw?.mintPrice ?? 0;
  if (typeof value === "string" && value.includes(".")) {
    try {
      return ethers.parseEther(value);
    } catch {
      return 0n;
    }
  }
  try {
    return BigInt(value || 0);
  } catch {
    return 0n;
  }
}

function phaseOf(raw) {
  const start = phaseStart(raw);
  if (!start) return null;
  const perWallet = Number(raw.per_wallet ?? raw.perWallet ?? raw.maxPerWallet ?? 1);
  const label = String(raw.key || raw.name || "phase");
  const text = label.toLowerCase();
  const allow = raw.allowlist === true || raw.whitelist === true || /allow|white|tier|guaranteed|fcfs|^[ab]$/.test(text);
  return {
    key: label,
    name: String(raw.name || raw.key || "phase"),
    price: priceOf(raw),
    perWallet: Number.isFinite(perWallet) && perWallet > 0 ? perWallet : 1,
    start,
    extraFor: Array.isArray(raw.extra_for) ? raw.extra_for.map(String) : [],
    public: /public|open mint|everyone/.test(text) || !allow,
  };
}

export function scheduleFromData(data, pageUrl = "") {
  const collection = asAddress(data?.collection || data?.contract || data?.nft || data?.nftAddress || data?.tokenAddress);
  const list = data?.phases || data?.stages || data?.rounds;
  const phases = (Array.isArray(list) ? list : []).map(phaseOf).filter(Boolean);
  if (!collection || !phases.length) return null;
  phases.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  const chain = chainFromId(data.chainId || data.chain_id);
  return {
    collection,
    chain: chain?.name || null,
    chainId: chain?.chainId || null,
    name: data.name || "",
    phases,
    pageUrl,
  };
}

export function scheduleFromText(text, pageUrl = "") {
  const source = String(text || "");
  const mark = /"(?:collection|contract|nftAddress|nft_address|tokenAddress)"\s*:\s*"0x[a-fA-F0-9]{40}"/gi;
  for (const match of source.matchAll(mark)) {
    let start = source.lastIndexOf("{", match.index);
    let steps = 0;
    while (start >= 0 && steps < 6 && match.index - start < 8_000) {
      const slice = sliceObject(source, start);
      if (slice) {
        try {
          const found = scheduleFromData(JSON.parse(slice), pageUrl);
          if (found) return found;
        } catch {
          // không phải JSON của lịch mint
        }
      }
      start = source.lastIndexOf("{", start - 1);
      steps += 1;
    }
  }
  return null;
}

const API_PATHS = ["/api/mint", "/api/drop", "/api/launch", "/api/config", "/api/collection"];

function contractOf(data) {
  if (!data || typeof data !== "object") return null;
  const nested = data.data && typeof data.data === "object" ? data.data : null;
  const address = asAddress(
    data.collection || data.contract || data.nft || data.nftAddress || data.tokenAddress || data.address || nested?.collection || nested?.contract || nested?.nft || nested?.nftAddress || nested?.address,
  );
  if (!address) return null;
  const chain = chainFromId(data.chainId || data.chain_id || nested?.chainId || nested?.chain_id);
  return { address, chain: chain?.name || null };
}

async function readApi(pageUrl, path, fetchImpl) {
  let apiUrl;
  try {
    apiUrl = new URL(path, pageUrl).href;
  } catch {
    return null;
  }
  try {
    const response = await fetchImpl(apiUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(4_000),
      headers: { accept: "application/json", "user-agent": "nft-mint/1.0" },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    if (error?.message === "Dừng.") throw error;
    return null;
  }
}

export async function scheduleFromPage(pageUrl, html, fetchImpl) {
  const embedded = scheduleFromText(html, pageUrl);
  if (embedded) return { schedule: embedded, contracts: [{ address: embedded.collection, chain: embedded.chain }] };
  const bodies = await Promise.all(API_PATHS.map((path) => readApi(pageUrl, path, fetchImpl)));
  const contracts = [];
  let schedule = null;
  for (const body of bodies) {
    if (!body) continue;
    const found = scheduleFromData(body, pageUrl) || scheduleFromText(JSON.stringify(body), pageUrl);
    if (found && !schedule) schedule = found;
    const contract = contractOf(body) || (found ? { address: found.collection, chain: found.chain } : null);
    if (contract && !contracts.some((item) => item.address.toLowerCase() === contract.address.toLowerCase())) contracts.push(contract);
  }
  return { schedule, contracts };
}

export function proofUrls(schedule, wallet) {
  const address = ethers.getAddress(schedule.collection);
  const who = ethers.getAddress(wallet);
  const base = schedule.pageUrl || "https://mint.local/";
  const paths = [
    `/api/proof/${address}/${who}`,
    `/api/proof/${address.toLowerCase()}/${who.toLowerCase()}`,
    `/api/mint/proof/${address}/${who}`,
    `/api/allowlist/${address}/${who}`,
    `/api/mint/check?a=${who}`,
  ];
  return paths.map((path) => new URL(path, base).href);
}

export function proofCovers(phase, proof) {
  if (!proof?.proof?.length || phase.public) return false;
  const tier = String(proof.tier || "");
  if (!tier) return true;
  return phase.key === tier || phase.extraFor.includes(tier);
}

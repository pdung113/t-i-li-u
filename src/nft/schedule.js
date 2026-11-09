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

function phaseOf(raw) {
  const starts = Date.parse(raw?.starts || raw?.start || "");
  if (!Number.isFinite(starts)) return null;
  const price = BigInt(raw.price ?? raw.priceWei ?? 0);
  const perWallet = Number(raw.per_wallet ?? raw.perWallet ?? raw.maxPerWallet ?? 1);
  return {
    key: String(raw.key || raw.name || "phase"),
    name: String(raw.name || raw.key || "phase"),
    price,
    perWallet: Number.isFinite(perWallet) && perWallet > 0 ? perWallet : 1,
    start: Math.floor(starts / 1000),
    extraFor: Array.isArray(raw.extra_for) ? raw.extra_for.map(String) : [],
    public: String(raw.key || raw.name || "").toLowerCase() === "public",
  };
}

export function scheduleFromData(data, pageUrl = "") {
  const collection = asAddress(data?.collection || data?.contract || data?.address);
  const phases = (Array.isArray(data?.phases) ? data.phases : []).map(phaseOf).filter(Boolean);
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
  const mark = /"collection"\s*:\s*"0x[a-fA-F0-9]{40}"/g;
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

export async function scheduleFromPage(pageUrl, html, fetchImpl) {
  const embedded = scheduleFromText(html, pageUrl);
  if (embedded) return embedded;
  let apiUrl;
  try {
    apiUrl = new URL("/api/mint", pageUrl).href;
  } catch {
    return null;
  }
  try {
    const response = await fetchImpl(apiUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: { accept: "application/json", "user-agent": "nft-mint/1.0" },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return scheduleFromData(body, pageUrl);
  } catch {
    return null;
  }
}

export function proofCovers(phase, proof) {
  if (!proof?.proof?.length || phase.public) return false;
  const tier = String(proof.tier || "");
  if (!tier) return true;
  return phase.key === tier || phase.extraFor.includes(tier);
}

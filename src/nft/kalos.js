import { ethers } from "ethers";

const API = "https://api.kalos.fun";

function bigintOf(value, fallback = 0n) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return fallback;
}

async function readJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
    headers: { accept: "application/json", "user-agent": "nft-mint/1.0" },
  });
  if (!response.ok) throw new Error(`Kalos không trả dữ liệu (${response.status}).`);
  return response.json();
}

export async function fetchKalosDrop(slug, fetchImpl) {
  const body = await readJson(`${API}/v2/launch/drops/${encodeURIComponent(slug)}`, fetchImpl);
  let address;
  let seaDrop;
  try {
    address = ethers.getAddress(body.address);
    seaDrop = ethers.getAddress(body.seaDrop);
  } catch {
    throw new Error(`Kalos không có contract cho ${slug}.`);
  }
  return { slug: body.slug || slug, name: body.name || slug, address, seaDrop };
}

export function kalosAllowEntries(body) {
  if (!body || body.published !== true || body.rootIsKalos !== true || !Array.isArray(body.entries)) return [];
  const entries = [];
  for (const item of body.entries) {
    const params = item?.mintParams || item;
    if (!params || !Array.isArray(item.proof)) continue;
    entries.push({
      name: item.stageName || "allowlist",
      stageIndex: Number(item.stageIndex ?? params.dropStageIndex ?? entries.length + 1),
      proof: item.proof,
      mintPrice: bigintOf(params.mintPrice),
      maxTotalMintableByWallet: bigintOf(params.maxTotalMintableByWallet),
      startTime: bigintOf(params.startTime),
      endTime: bigintOf(params.endTime),
      dropStageIndex: bigintOf(params.dropStageIndex ?? item.stageIndex ?? 1),
      maxTokenSupplyForStage: bigintOf(params.maxTokenSupplyForStage),
      feeBps: bigintOf(params.feeBps),
      restrictFeeRecipients: params.restrictFeeRecipients === true || params.restrictFeeRecipients === "true",
    });
  }
  return entries;
}

export async function fetchKalosEligibility(slug, wallet, fetchImpl) {
  const url = `${API}/v2/launch/drops/${encodeURIComponent(slug)}/eligibility/${ethers.getAddress(wallet)}`;
  try {
    return kalosAllowEntries(await readJson(url, fetchImpl));
  } catch {
    return [];
  }
}

export async function loadKalosPage(parsed, fetchImpl) {
  const drop = await fetchKalosDrop(parsed.slug, fetchImpl);
  return {
    parsed,
    html: "",
    candidates: [{ address: drop.address, score: 300, chain: "elysium" }],
    hints: ["elysium"],
    kalos: drop,
  };
}

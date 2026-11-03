import { ethers } from "ethers";

const erc20Iface = new ethers.Interface([
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const pairIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
]);

const factoryIface = new ethers.Interface([
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
]);

const feedIface = new ethers.Interface([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

const coder = ethers.AbiCoder.defaultAbiCoder();

const priceCache = new Map();

export function fdvUsd(supply, tokenReserve, nativeReserve, nativePriceE8) {
  if (supply <= 0n || tokenReserve <= 0n || nativeReserve <= 0n || nativePriceE8 <= 0n) return null;
  const cents = (supply * nativeReserve * nativePriceE8) / tokenReserve / 10n ** 24n;
  return Number(cents) / 100;
}

export function mcapDecision(usd, maxUsd) {
  if (!maxUsd || maxUsd <= 0) return { ok: true, reason: "no_limit" };
  if (usd == null) return { ok: false, retry: true, reason: "unknown" };
  if (usd > maxUsd) return { ok: false, retry: false, reason: "too_high" };
  return { ok: true, reason: "ok" };
}

export function formatUsd(value) {
  if (value == null || Number.isNaN(value)) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(0);
}

async function callUint(provider, to, data, type) {
  const raw = await provider.call({ to, data });
  const [value] = coder.decode([type], raw);
  return value;
}

async function nativePriceE8(provider, chain) {
  const cached = priceCache.get(chain.chainId);
  if (cached && Date.now() - cached.at < 30_000) return cached.price;

  let price;
  if (chain.priceFeed) {
    const round = await provider.call({
      to: chain.priceFeed,
      data: feedIface.encodeFunctionData("latestRoundData"),
    });
    const decoded = coder.decode(["uint80", "int256", "uint256", "uint256", "uint80"], round);
    const answer = decoded[1];
    if (answer <= 0n) throw new Error("giá native không hợp lệ");
    price = BigInt(answer);
  } else if (chain.stable) {
    const pairRaw = await provider.call({
      to: chain.factory,
      data: factoryIface.encodeFunctionData("getPair", [chain.weth, chain.stable.address]),
    });
    const [pair] = coder.decode(["address"], pairRaw);
    if (pair === ethers.ZeroAddress) throw new Error("không có pool giá ETH");
    const [token0, reservesRaw] = await Promise.all([
      callUint(provider, pair, pairIface.encodeFunctionData("token0"), "address").then((value) => value),
      provider.call({ to: pair, data: pairIface.encodeFunctionData("getReserves") }),
    ]);
    const [reserve0, reserve1] = coder.decode(["uint112", "uint112", "uint32"], reservesRaw);
    const wethIs0 = String(token0).toLowerCase() === chain.weth.toLowerCase();
    const wethReserve = wethIs0 ? reserve0 : reserve1;
    const stableReserve = wethIs0 ? reserve1 : reserve0;
    const scale = 10n ** BigInt(18 - chain.stable.decimals + 8);
    price = (stableReserve * scale) / wethReserve;
  } else {
    throw new Error("chain chưa có nguồn giá USD");
  }

  priceCache.set(chain.chainId, { at: Date.now(), price });
  return price;
}

export async function marketCapUsd(provider, chain, token) {
  const [supply, pairRaw] = await Promise.all([
    callUint(provider, token, erc20Iface.encodeFunctionData("totalSupply"), "uint256"),
    provider.call({
      to: chain.factory,
      data: factoryIface.encodeFunctionData("getPair", [token, chain.weth]),
    }),
  ]);
  const [pair] = coder.decode(["address"], pairRaw);
  if (pair === ethers.ZeroAddress) return { usd: null, reason: "no_pair" };

  const [token0, reservesRaw, price] = await Promise.all([
    callUint(provider, pair, pairIface.encodeFunctionData("token0"), "address"),
    provider.call({ to: pair, data: pairIface.encodeFunctionData("getReserves") }),
    nativePriceE8(provider, chain),
  ]);
  const [reserve0, reserve1] = coder.decode(["uint112", "uint112", "uint32"], reservesRaw);
  const tokenIs0 = String(token0).toLowerCase() === token.toLowerCase();
  const tokenReserve = tokenIs0 ? reserve0 : reserve1;
  const nativeReserve = tokenIs0 ? reserve1 : reserve0;
  const usd = fdvUsd(supply, tokenReserve, nativeReserve, price);
  return { usd, reason: usd == null ? "empty" : "ok" };
}

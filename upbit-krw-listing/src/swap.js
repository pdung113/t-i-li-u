import { ethers } from "ethers";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { chainById, minOut, priorityLamports, scaleUnits, SOL_MINT } from "./networks.js";
import { amountFor, fdvAllows, fdvUsd, liquidityAllows, poolSidesUsd, solanaLiquidityAllows } from "./limits.js";

const V2_IFACE = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const V3_ROUTER_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

const V3_ROUTER_DEADLINE_IFACE = new ethers.Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

const V3_QUOTER_IFACE = new ethers.Interface([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint256 gasEstimate, uint32 initializedTicksCrossed, uint160 sqrtPriceX96After)",
]);

const SUPPLY_IFACE = new ethers.Interface([
  "function totalSupply() view returns (uint256)",
]);

const RESERVE_IFACE = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function balanceOf(address) view returns (uint256)",
]);

const JUPITER_ORDER = "https://api.jup.ag/swap/v2/order";
const JUPITER_TOKEN = "https://api.jup.ag/tokens/v2/search";
const PRICE_CHAIN = { ETH: "ethereum", BNB: "bsc", SOL: "solana", POL: "polygon" };
export const MULTICALL = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MC_IFACE = new ethers.Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

function usdFromRaw(amount, decimals) {
  const scale = 10n ** BigInt(decimals);
  return Number(amount / scale) + Number(amount % scale) / Number(scale);
}

export function walletFromEvmKey(secret) {
  const text = String(secret || "").trim();
  if (!text) return null;
  return new ethers.Wallet(text.startsWith("0x") ? text : `0x${text}`);
}

export function walletFromSolanaKey(secret) {
  const text = String(secret || "").trim();
  if (!text) return null;
  if (text.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(text)));
  const bytes = bs58.decode(text);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error("Private key Solana phải là chuỗi base58 của ví.");
}

function rpcFor(chain, config) {
  return config.rpc?.[chain.id] || chain.rpc;
}

function feeFields(chain, feeData, multiple) {
  if (chain.eip1559) {
    const maxFee = scaleUnits(feeData.maxFeePerGas ?? feeData.gasPrice ?? 1n, multiple);
    const tip = scaleUnits(feeData.maxPriorityFeePerGas ?? feeData.gasPrice ?? 1n, multiple);
    return {
      type: 2,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip > maxFee ? maxFee : tip,
    };
  }
  return { type: 0, gasPrice: scaleUnits(feeData.gasPrice ?? 1n, multiple) };
}

async function quoteV2(provider, chain, token, value) {
  if (!chain.v2Router) return null;
  try {
    const amounts = await provider.call({
      to: chain.v2Router,
      data: V2_IFACE.encodeFunctionData("getAmountsOut", [value, [chain.wrapped, token]]),
    });
    return V2_IFACE.decodeFunctionResult("getAmountsOut", amounts)[0][1];
  } catch {
    return null;
  }
}

async function quoteV3Fee(provider, chain, token, value, fee) {
  try {
    const data = V3_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [[
      chain.wrapped,
      token,
      value,
      fee,
      0,
    ]]);
    const raw = await provider.call({ to: chain.v3Quoter, data });
    const out = V3_QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", raw)[0];
    return out > 0n ? { fee, out } : null;
  } catch {
    return null;
  }
}

async function readSupply(provider, token) {
  const raw = await provider.call({ to: token, data: SUPPLY_IFACE.encodeFunctionData("totalSupply") });
  return SUPPLY_IFACE.decodeFunctionResult("totalSupply", raw)[0];
}

export function choosePool(v2Out, v3Choices) {
  const v2 = typeof v2Out === "bigint" && v2Out > 0n ? v2Out : null;
  const best = (v3Choices || [])
    .filter((item) => item && typeof item.out === "bigint" && item.out > 0n)
    .sort((a, b) => (a.out > b.out ? -1 : 1))[0] || null;
  if (v2 && best) {
    if (best.out > (v2 * 120n) / 100n) return { ok: true, version: 3, quoted: best.out, feeTier: best.fee };
    if (v2 > (best.out * 120n) / 100n) return { ok: false, reason: "Pool V2 lệch giá so với pool chính, không mua." };
    return { ok: true, version: 2, quoted: v2, feeTier: 0 };
  }
  if (v2) return { ok: true, version: 2, quoted: v2, feeTier: 0 };
  if (best) return { ok: true, version: 3, quoted: best.out, feeTier: best.fee };
  return { ok: false, reason: "NO_POOL" };
}

function sameAsset(left, right) {
  if (!left || !right) return false;
  if (left.startsWith("0x") || left.startsWith("0X") || right.startsWith("0x") || right.startsWith("0X")) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

export function isBaseAsset(chain, contract) {
  const items = [chain?.wrapped, chain?.stable, chain?.kind === "solana" ? SOL_MINT : ""];
  return items.some((item) => sameAsset(item, contract));
}

function sortTokens(left, right) {
  const first = ethers.getAddress(left);
  const second = ethers.getAddress(right);
  return first.toLowerCase() < second.toLowerCase() ? [first, second] : [second, first];
}

export function v2PairAddress(chain, token) {
  if (!chain?.v2Factory || !chain?.v2InitCodeHash || !chain?.wrapped || !token) return null;
  const [token0, token1] = sortTokens(chain.wrapped, token);
  const salt = ethers.keccak256(ethers.solidityPacked(["address", "address"], [token0, token1]));
  return {
    pair: ethers.getCreate2Address(chain.v2Factory, salt, chain.v2InitCodeHash),
    wrappedIs0: token0.toLowerCase() === ethers.getAddress(chain.wrapped).toLowerCase(),
  };
}

export function v3PoolAddress(chain, token, fee) {
  if (!chain?.v3Deployer || !chain?.v3InitCodeHash || !chain?.wrapped || !token) return null;
  const [token0, token1] = sortTokens(chain.wrapped, token);
  const salt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24"],
    [token0, token1, fee],
  ));
  return ethers.getCreate2Address(chain.v3Deployer, salt, chain.v3InitCodeHash);
}

export function quoteCalls(chain, token, value, needSupply) {
  const plan = [];
  if (chain.v2Router) {
    plan.push({
      kind: "v2",
      target: chain.v2Router,
      data: V2_IFACE.encodeFunctionData("getAmountsOut", [value, [chain.wrapped, token]]),
    });
  }
  if (chain.v3Quoter) {
    for (const fee of chain.v3Fees) {
      plan.push({
        kind: "v3",
        fee,
        target: chain.v3Quoter,
        data: V3_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [[chain.wrapped, token, value, fee, 0]]),
      });
    }
  }
  const pair = v2PairAddress(chain, token);
  if (pair) {
    plan.push({
      kind: "v2reserves",
      target: pair.pair,
      wrappedIs0: pair.wrappedIs0,
      data: RESERVE_IFACE.encodeFunctionData("getReserves"),
    });
  }
  if (chain.v3Deployer && chain.v3InitCodeHash) {
    for (const fee of chain.v3Fees) {
      const pool = v3PoolAddress(chain, token, fee);
      if (!pool) continue;
      plan.push({
        kind: "v3native",
        fee,
        target: chain.wrapped,
        data: RESERVE_IFACE.encodeFunctionData("balanceOf", [pool]),
      });
      plan.push({
        kind: "v3token",
        fee,
        target: token,
        data: RESERVE_IFACE.encodeFunctionData("balanceOf", [pool]),
      });
    }
  }
  if (needSupply) {
    plan.push({ kind: "supply", target: token, data: SUPPLY_IFACE.encodeFunctionData("totalSupply") });
  }
  return plan;
}

export function decodeQuote(plan, raw) {
  const rows = MC_IFACE.decodeFunctionResult("aggregate3", raw)[0];
  let v2 = null;
  let supply = null;
  let v2Reserves = null;
  const v3 = [];
  const v3Partial = new Map();
  plan.forEach((step, index) => {
    const row = rows[index];
    if (!row?.success || !row.returnData || row.returnData === "0x") return;
    try {
      if (step.kind === "v2") {
        const out = V2_IFACE.decodeFunctionResult("getAmountsOut", row.returnData)[0][1];
        if (out > 0n) v2 = out;
      } else if (step.kind === "v3") {
        const out = V3_QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", row.returnData)[0];
        if (out > 0n) v3.push({ fee: step.fee, out });
      } else if (step.kind === "supply") {
        const out = SUPPLY_IFACE.decodeFunctionResult("totalSupply", row.returnData)[0];
        if (out > 0n) supply = out;
      } else if (step.kind === "v2reserves") {
        const [reserve0, reserve1] = RESERVE_IFACE.decodeFunctionResult("getReserves", row.returnData);
        v2Reserves = step.wrappedIs0
          ? { native: reserve0, token: reserve1 }
          : { native: reserve1, token: reserve0 };
      } else if (step.kind === "v3native" || step.kind === "v3token") {
        const amount = RESERVE_IFACE.decodeFunctionResult("balanceOf", row.returnData)[0];
        const slot = v3Partial.get(step.fee) || {};
        if (step.kind === "v3native") slot.native = amount;
        else slot.token = amount;
        v3Partial.set(step.fee, slot);
      }
    } catch {
      // Một pool lỗi không được làm hỏng các pool còn lại.
    }
  });
  const v3Balances = {};
  for (const [fee, slot] of v3Partial) {
    if (slot.native != null && slot.token != null) v3Balances[fee] = slot;
  }
  return { v2, v3, supply, v2Reserves, v3Balances };
}

export async function quoteOnProvider(provider, chain, token, value, needSupply) {
  const plan = quoteCalls(chain, token, value, needSupply);
  if (!plan.length) return { v2: null, v3: [], supply: null, v2Reserves: null, v3Balances: {} };
  const data = MC_IFACE.encodeFunctionData("aggregate3", [plan.map((step) => ({
    target: step.target,
    allowFailure: true,
    callData: step.data,
  }))]);
  try {
    const raw = await provider.call({ to: MULTICALL, data });
    return decodeQuote(plan, raw);
  } catch {
    const [v2, v3, supply] = await Promise.all([
      quoteV2(provider, chain, token, value),
      chain.v3Quoter ? Promise.all(chain.v3Fees.map((fee) => quoteV3Fee(provider, chain, token, value, fee))) : [],
      needSupply ? readSupply(provider, token).catch(() => null) : null,
    ]);
    return {
      v2,
      v3: (v3 || []).filter(Boolean),
      supply,
      v2Reserves: await readV2Reserves(provider, chain, token),
      v3Balances: await readV3Balances(provider, chain, token),
    };
  }
}

async function readV2Reserves(provider, chain, token) {
  const pair = v2PairAddress(chain, token);
  if (!pair) return null;
  try {
    const raw = await provider.call({ to: pair.pair, data: RESERVE_IFACE.encodeFunctionData("getReserves") });
    const [reserve0, reserve1] = RESERVE_IFACE.decodeFunctionResult("getReserves", raw);
    return pair.wrappedIs0
      ? { native: reserve0, token: reserve1 }
      : { native: reserve1, token: reserve0 };
  } catch {
    return null;
  }
}

async function readV3Balances(provider, chain, token) {
  const out = {};
  if (!chain.v3Deployer || !chain.v3Fees) return out;
  await Promise.all(chain.v3Fees.map(async (fee) => {
    const pool = v3PoolAddress(chain, token, fee);
    if (!pool) return;
    try {
      const [nativeRaw, tokenRaw] = await Promise.all([
        provider.call({ to: chain.wrapped, data: RESERVE_IFACE.encodeFunctionData("balanceOf", [pool]) }),
        provider.call({ to: token, data: RESERVE_IFACE.encodeFunctionData("balanceOf", [pool]) }),
      ]);
      out[fee] = {
        native: RESERVE_IFACE.decodeFunctionResult("balanceOf", nativeRaw)[0],
        token: RESERVE_IFACE.decodeFunctionResult("balanceOf", tokenRaw)[0],
      };
    } catch {
      // Pool này không đọc được thì bước sau sẽ từ chối nếu đang bật mức sàn.
    }
  }));
  return out;
}

function venueName(chain, version) {
  if (chain.id === "bsc") return version === 2 ? "PancakeSwap V2" : "PancakeSwap V3";
  if (chain.kind === "solana") return "Jupiter";
  return version === 2 ? "Uniswap V2" : "Uniswap V3";
}

export function createBuyer(config) {
  let evmWallet = null;
  let solanaKey = null;
  try {
    evmWallet = walletFromEvmKey(config.evmPrivateKey);
  } catch {
    evmWallet = null;
  }
  try {
    solanaKey = walletFromSolanaKey(config.solanaPrivateKey);
  } catch {
    solanaKey = null;
  }
  const providers = new Map();
  const fees = new Map();
  const nonces = new Map();
  const prices = new Map(
    Object.entries(config.prices || {})
      .filter(([, value]) => Number(value) > 0)
      .map(([symbol, value]) => [symbol, Number(value)]),
  );
  const wsFailed = new Set();
  let priorityLamport = 5_000;
  let solana = null;
  let timer = null;
  let stopped = false;

  function providerUrl(chain) {
    const custom = config.rpc?.[chain.id] || "";
    if (custom) return custom;
    if (!wsFailed.has(chain.id) && chain.ws) return chain.ws;
    return chain.rpc;
  }

  function providerFor(chain) {
    if (config.providerFor) {
      const given = config.providerFor(chain);
      if (given) return given;
    }
    let provider = providers.get(chain.id);
    if (!provider) {
      const url = providerUrl(chain);
      const network = ethers.Network.from(chain.chainId);
      provider = String(url).startsWith("ws")
        ? new ethers.WebSocketProvider(url, network, { staticNetwork: network })
        : new ethers.JsonRpcProvider(url, network, { staticNetwork: network });
      provider.on?.("error", () => {});
      providers.set(chain.id, provider);
    }
    return provider;
  }

  function dropProvider(chain) {
    providers.get(chain.id)?.destroy?.();
    providers.delete(chain.id);
  }

  function solanaConnection() {
    if (!solana) {
      const chain = chainById("solana");
      solana = new Connection(rpcFor(chain, config), { commitment: "confirmed", disableRetryOnRateLimit: true });
    }
    return solana;
  }

  async function nativeUsd(chain) {
    if (!chain?.stable) return 0;
    if (chain.kind === "solana") {
      const params = new URLSearchParams({
        inputMint: SOL_MINT,
        outputMint: chain.stable,
        amount: (10n ** 9n).toString(),
        slippageBps: "50",
        maxSupportedTransactionVersion: "0",
      });
      const response = await fetch(`${JUPITER_ORDER}?${params}`, { signal: AbortSignal.timeout(1500) });
      const order = await response.json().catch(() => ({}));
      const out = BigInt(order.outAmount || 0);
      return response.ok && out > 0n ? usdFromRaw(out, chain.stableDecimals) : 0;
    }
    const provider = providerFor(chain);
    const one = 10n ** BigInt(chain.nativeDecimals);
    const bundle = await quoteOnProvider(provider, chain, chain.stable, one, false);
    const choice = choosePool(bundle.v2, bundle.v3);
    return choice.ok ? usdFromRaw(choice.quoted, chain.stableDecimals) : 0;
  }

  async function refreshPrices() {
    const symbols = new Set(
      Object.entries(config.amounts || {})
        .filter(([, amount]) => Number(amount) > 0)
        .map(([id]) => chainById(id)?.symbol)
        .filter((symbol) => PRICE_CHAIN[symbol]),
    );
    await Promise.all([...symbols].map(async (symbol) => {
      try {
        const usd = await nativeUsd(chainById(PRICE_CHAIN[symbol]));
        if (usd > 0 && !(Number(config.prices?.[symbol]) > 0)) prices.set(symbol, usd);
      } catch {
        // Giữ giá gần nhất. Không có giá thì trần FDV chặn lệnh.
      }
    }));
  }

  async function warm() {
    if (stopped) return;
    const active = Object.entries(config.amounts || {})
      .filter(([, amount]) => Number(amount) > 0)
      .map(([id]) => chainById(id))
      .filter(Boolean);
    async function warmEvm(chain, allowFallback) {
      const provider = providerFor(chain);
      try {
        const [fee, nonce] = await Promise.all([
          provider.getFeeData(),
          provider.getTransactionCount(evmWallet.address, "pending"),
        ]);
        fees.set(chain.id, fee);
        const cached = nonces.get(chain.id);
        nonces.set(chain.id, cached == null ? nonce : (nonce > cached ? nonce : cached));
      } catch {
        const custom = config.rpc?.[chain.id] || config.providerFor;
        if (allowFallback && !custom && chain.ws && !wsFailed.has(chain.id)) {
          wsFailed.add(chain.id);
          dropProvider(chain);
          await warmEvm(chain, false);
        }
      }
    }

    await Promise.all(active.map(async (chain) => {
      if (chain.kind === "solana") {
        try {
          const connection = solanaConnection();
          const samples = await connection.getRecentPrioritizationFees();
          priorityLamport = priorityLamports(samples.map((item) => item.prioritizationFee), config.gasMultiple);
        } catch {
          priorityLamport = Math.max(priorityLamport, 5_000);
        }
        return;
      }
      if (!evmWallet) return;
      await warmEvm(chain, true);
    }));
    if (Number(config.maxFdv) > 0 || Number(config.minLiquidity) > 0) await refreshPrices();
    if (active.some((chain) => chain.kind === "solana")) {
      fetch(JUPITER_ORDER, { signal: AbortSignal.timeout(1200) }).catch(() => {});
    }
  }

  function start() {
    timer = setInterval(() => {
      warm().catch(() => {});
    }, 2000);
    if (timer.unref) timer.unref();
  }

  function stop() {
    stopped = true;
    clearInterval(timer);
    for (const provider of providers.values()) provider.destroy?.();
    providers.clear();
  }

  function takeNonce(chainId) {
    const nonce = nonces.get(chainId);
    if (nonce == null) return null;
    nonces.set(chainId, nonce + 1);
    return nonce;
  }

  function gateFdv(chain, amountIn, amountOut, totalSupply, nativeUsd) {
    if (!(Number(config.maxFdv) > 0)) return { ok: true };
    const fdv = fdvUsd({
      amountIn,
      amountOut,
      totalSupply,
      nativeUsd,
      nativeDecimals: chain.nativeDecimals,
    });
    const decision = fdvAllows(fdv, config.maxFdv);
    return decision.ok ? { ok: true, fdv } : decision;
  }

  function gateLiquidity(chain, amountIn, amountOut, reserves, nativeUsd) {
    const min = Number(config.minLiquidity);
    if (!(min > 0)) return { ok: true };
    const sides = reserves
      ? poolSidesUsd({
        nativeReserve: reserves.native,
        tokenReserve: reserves.token,
        amountIn,
        amountOut,
        nativeUsd,
        nativeDecimals: chain.nativeDecimals,
      })
      : null;
    return liquidityAllows(sides, min, chain.symbol);
  }

  async function buyEvm(listing, chain, started) {
    if (!evmWallet) return { ok: false, reason: "Thiếu private key ví ERC." };
    const needCap = Number(config.maxFdv) > 0;
    const needLiquidity = Number(config.minLiquidity) > 0;
    const cachedUsd = prices.get(chain.symbol) || 0;
    if ((needCap || needLiquidity) && !(cachedUsd > 0)) return { ok: false, reason: "Chưa có giá USD nên không mua." };
    const provider = providerFor(chain);
    const token = ethers.getAddress(listing.contract);
    const value = ethers.parseEther(String(amountFor(chain.id, config.amounts)));
    const feePromise = fees.get(chain.id) ? Promise.resolve(fees.get(chain.id)) : provider.getFeeData();
    const quotePromise = quoteOnProvider(provider, chain, token, value, needCap);
    const [feeData, bundle] = await Promise.all([feePromise, quotePromise]);
    fees.set(chain.id, feeData);
    const choice = choosePool(bundle.v2, bundle.v3);
    if (!choice.ok) {
      return {
        ok: false,
        reason: choice.reason === "NO_POOL" ? `Không thấy pool DEX cho ${token} trên ${chain.id}.` : choice.reason,
      };
    }
    const { version, quoted, feeTier } = choice;
    const gate = gateFdv(chain, value, quoted, bundle.supply, cachedUsd);
    if (!gate.ok) return { ok: false, reason: gate.reason, fdv: gate.fdv };
    const reserves = version === 2 ? bundle.v2Reserves : bundle.v3Balances?.[feeTier];
    const liquidity = gateLiquidity(chain, value, quoted, reserves, cachedUsd);
    if (!liquidity.ok) {
      return { ok: false, reason: liquidity.reason, nativeLiquidity: liquidity.native, tokenLiquidity: liquidity.token };
    }
    let nonce = takeNonce(chain.id);
    if (nonce == null) nonce = await provider.getTransactionCount(evmWallet.address, "pending");
    const gas = feeFields(chain, feeData, config.gasMultiple);
    const floor = minOut(quoted, config.slippagePercent);
    const venue = venueName(chain, version);
    const tx = version === 2
      ? {
        chainId: chain.chainId,
        to: chain.v2Router,
        data: V2_IFACE.encodeFunctionData("swapExactETHForTokensSupportingFeeOnTransferTokens", [
          floor,
          [chain.wrapped, token],
          evmWallet.address,
          Math.floor(Date.now() / 1000) + 120,
        ]),
        value,
        nonce,
        gasLimit: 450_000n,
        ...gas,
      }
      : {
        chainId: chain.chainId,
        to: chain.v3Router,
        data: (chain.v3Deadline ? V3_ROUTER_DEADLINE_IFACE : V3_ROUTER_IFACE).encodeFunctionData("exactInputSingle", [
          chain.v3Deadline
            ? [chain.wrapped, token, feeTier, evmWallet.address, Math.floor(Date.now() / 1000) + 120, value, floor, 0]
            : [chain.wrapped, token, feeTier, evmWallet.address, value, floor, 0],
        ]),
        value,
        nonce,
        gasLimit: 550_000n,
        ...gas,
      };
    let sent;
    try {
      const signed = await evmWallet.signTransaction(tx);
      sent = await provider.broadcastTransaction(signed);
    } catch (error) {
      nonces.delete(chain.id);
      return { ok: false, reason: error.shortMessage || error.message || "Không gửi được giao dịch.", venue };
    }
    const lagMs = Date.now() - started;
    try {
      const receipt = await sent.wait();
      if (!receipt || receipt.status === 0) {
        return { ok: false, reason: `Giao dịch revert trên ${venue}.`, tx: sent.hash, venue, lagMs, fdv: gate.fdv, nativeLiquidity: liquidity.native, tokenLiquidity: liquidity.token };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `Đã gửi giao dịch nhưng chưa xác nhận: ${error.shortMessage || error.message}`,
        tx: sent.hash,
        venue,
        lagMs,
        fdv: gate.fdv,
        nativeLiquidity: liquidity.native,
        tokenLiquidity: liquidity.token,
      };
    }
    return { ok: true, tx: sent.hash, venue, wallet: evmWallet.address, lagMs, fdv: gate.fdv, nativeLiquidity: liquidity.native, tokenLiquidity: liquidity.token };
  }

  async function buySolana(listing, chain, started) {
    if (!solanaKey) return { ok: false, reason: "Thiếu private key ví Solana." };
    const connection = solanaConnection();
    const lamports = priorityLamport;
    const amount = ethers.parseUnits(String(amountFor(chain.id, config.amounts)), 9);
    const params = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint: listing.contract,
      amount: amount.toString(),
      taker: solanaKey.publicKey.toBase58(),
      slippageBps: String(Math.round(config.slippagePercent * 100)),
      priorityFeeLamports: String(lamports),
      broadcastFeeType: "exactFee",
      maxSupportedTransactionVersion: "0",
    });
    const headers = { Accept: "application/json" };
    if (config.jupiterApiKey) headers["x-api-key"] = config.jupiterApiKey;
    const needCap = Number(config.maxFdv) > 0;
    const cachedUsd = prices.get(chain.symbol) || 0;
    if (needCap && !(cachedUsd > 0)) return { ok: false, reason: "Chưa có giá USD nên không mua." };
    const supplyPromise = needCap
      ? connection.getTokenSupply(new PublicKey(listing.contract)).catch(() => null)
      : Promise.resolve(null);
    const liquidityPromise = Number(config.minLiquidity) > 0
      ? fetch(`${JUPITER_TOKEN}?query=${encodeURIComponent(listing.contract)}`, { signal: AbortSignal.timeout(1000) })
        .then((result) => (result.ok ? result.json() : null))
        .catch(() => null)
      : Promise.resolve(null);
    const response = await fetch(`${JUPITER_ORDER}?${params}`, { headers, signal: AbortSignal.timeout(1200) });
    const order = await response.json().catch(() => ({}));
    const encoded = order.transaction || order.swapTransaction;
    if (!response.ok || !encoded) {
      return { ok: false, reason: order.errorMessage || order.error || `Jupiter HTTP ${response.status}` };
    }
    const [supply, rows] = await Promise.all([supplyPromise, liquidityPromise]);
    const outAmount = BigInt(order.outAmount || 0);
    const inAmount = BigInt(order.inAmount || amount);
    const gate = gateFdv(
      chain,
      inAmount,
      outAmount,
      supply?.value?.amount ? BigInt(supply.value.amount) : null,
      cachedUsd,
    );
    if (!gate.ok) return { ok: false, reason: gate.reason };
    const match = Array.isArray(rows) ? rows.find((item) => item?.id === listing.contract) : null;
    const poolLiquidity = match && Number.isFinite(Number(match.liquidity)) ? Number(match.liquidity) : null;
    const liquidity = solanaLiquidityAllows(poolLiquidity, config.minLiquidity);
    if (!liquidity.ok) return { ok: false, reason: liquidity.reason, poolLiquidity: liquidity.poolLiquidity };
    const transaction = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
    transaction.sign([solanaKey]);
    let signature;
    try {
      signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 2, skipPreflight: true });
    } catch (error) {
      return { ok: false, reason: error.message || "Không gửi được giao dịch Solana.", venue: "Jupiter" };
    }
    const lagMs = Date.now() - started;
    try {
      const confirmation = order.lastValidBlockHeight
        ? await connection.confirmTransaction({
          signature,
          blockhash: transaction.message.recentBlockhash,
          lastValidBlockHeight: Number(order.lastValidBlockHeight),
        }, "confirmed")
        : await connection.confirmTransaction(signature, "confirmed");
      if (confirmation.value?.err) {
        return { ok: false, reason: "Giao dịch Solana không thành công.", tx: signature, venue: "Jupiter", lagMs, fdv: gate.fdv, poolLiquidity: liquidity.poolLiquidity };
      }
    } catch (error) {
      return { ok: false, reason: `Đã gửi giao dịch nhưng chưa xác nhận: ${error.message}`, tx: signature, venue: "Jupiter", lagMs, fdv: gate.fdv, poolLiquidity: liquidity.poolLiquidity };
    }
    return { ok: true, tx: signature, venue: "Jupiter", wallet: solanaKey.publicKey.toBase58(), lagMs, fdv: gate.fdv, poolLiquidity: liquidity.poolLiquidity };
  }

  async function buy(listing) {
    const started = listing.receivedAt || Date.now();
    const chain = chainById(listing.chain);
    if (!chain) return { ok: false, reason: listing.chain ? `Chưa hỗ trợ DEX trên mạng ${listing.chain}.` : "Thông báo không ghi mạng." };
    if (!listing.contract) return { ok: false, reason: "Thông báo không có địa chỉ contract." };
    if (!(amountFor(chain.id, config.amounts) > 0)) return { ok: false, reason: `Chưa nhập số lượng cho ${chain.id}.` };
    if (isBaseAsset(chain, listing.contract)) return { ok: false, reason: "Contract là token nền hoặc stablecoin, không mua." };
    if (chain.kind === "solana") {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(listing.contract)) return { ok: false, reason: "Contract Solana không đúng." };
      return buySolana(listing, chain, started);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(listing.contract)) return { ok: false, reason: "Contract ERC không đúng." };
    return buyEvm(listing, chain, started);
  }

  return {
    warm,
    start,
    stop,
    buy,
    prices: () => Object.fromEntries(prices),
  };
}

export async function buyOnDex(listing, config) {
  const buyer = createBuyer(config);
  try {
    return await buyer.buy(listing);
  } finally {
    buyer.stop();
  }
}

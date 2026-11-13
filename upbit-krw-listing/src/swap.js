import { ethers } from "ethers";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { chainById, minOut, priorityLamports, scaleUnits, SOL_MINT } from "./networks.js";
import { amountFor, fdvAllows, fdvUsd } from "./limits.js";

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

const JUPITER_ORDER = "https://api.jup.ag/swap/v2/order";
const PRICE_CHAIN = { ETH: "ethereum", BNB: "bsc", SOL: "solana", POL: "polygon" };

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

function within(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const signers = new Map();
  const fees = new Map();
  const nonces = new Map();
  const prices = new Map();
  let priorityLamport = 5_000;
  let solana = null;
  let timer = null;
  let stopped = false;

  function providerFor(chain) {
    let provider = providers.get(chain.id);
    if (!provider) {
      const network = ethers.Network.from(chain.chainId);
      provider = new ethers.JsonRpcProvider(rpcFor(chain, config), network, { staticNetwork: network });
      providers.set(chain.id, provider);
      if (evmWallet) signers.set(chain.id, evmWallet.connect(provider));
    }
    return provider;
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
    let out = await quoteV2(provider, chain, chain.stable, one);
    if ((out == null || out <= 0n) && chain.v3Quoter) {
      const choices = (await Promise.all(chain.v3Fees.map((fee) => quoteV3Fee(provider, chain, chain.stable, one, fee)))).filter(Boolean);
      out = choices.sort((a, b) => (a.out > b.out ? -1 : 1))[0]?.out ?? null;
    }
    return out != null && out > 0n ? usdFromRaw(out, chain.stableDecimals) : 0;
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
        if (usd > 0) prices.set(symbol, usd);
      } catch {
        // Giữ giá gần nhất. Không có giá thì trần FDV chặn lệnh.
      }
    }));
  }

  async function priceFor(symbol) {
    if (prices.get(symbol) > 0) return prices.get(symbol);
    await refreshPrices();
    return prices.get(symbol) || 0;
  }

  async function warm() {
    if (stopped) return;
    const active = Object.entries(config.amounts || {})
      .filter(([, amount]) => Number(amount) > 0)
      .map(([id]) => chainById(id))
      .filter(Boolean);
    await Promise.all(active.map(async (chain) => {
      try {
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
      const provider = providerFor(chain);
      const [fee, nonce] = await Promise.all([
        provider.getFeeData(),
        provider.getTransactionCount(evmWallet.address, "pending"),
      ]);
      fees.set(chain.id, fee);
      const cached = nonces.get(chain.id);
      nonces.set(chain.id, cached == null ? nonce : (nonce > cached ? nonce : cached));
      } catch {
        // Cache trống thì lượt mua tự đọc RPC.
      }
    }));
    if (config.maxFdv) await refreshPrices();
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

  async function buyEvm(listing, chain, started) {
    if (!evmWallet) return { ok: false, reason: "Thiếu private key ví ERC." };
    const provider = providerFor(chain);
    const signer = signers.get(chain.id);
    const token = ethers.getAddress(listing.contract);
    const value = ethers.parseEther(String(amountFor(chain.id, config.amounts)));
    const feePromise = fees.get(chain.id) ? Promise.resolve(fees.get(chain.id)) : provider.getFeeData();
    const v2Promise = quoteV2(provider, chain, token, value);
    const v3Promise = chain.v3Quoter
      ? Promise.all(chain.v3Fees.map((fee) => quoteV3Fee(provider, chain, token, value, fee)))
      : Promise.resolve([]);
    const supplyPromise = Number(config.maxFdv) > 0 ? readSupply(provider, token).catch(() => null) : Promise.resolve(null);
    const pricePromise = Number(config.maxFdv) > 0 ? priceFor(chain.symbol) : Promise.resolve(0);
    const [feeData, v2Out, supply, nativeUsd] = await Promise.all([feePromise, v2Promise, supplyPromise, pricePromise]);
    fees.set(chain.id, feeData);
    const v3Choices = v2Out != null && v2Out > 0n ? ((await within(v3Promise, 150)) || []) : await v3Promise;
    const choice = choosePool(v2Out, v3Choices);
    if (!choice.ok) {
      return {
        ok: false,
        reason: choice.reason === "NO_POOL" ? `Không thấy pool DEX cho ${token} trên ${chain.id}.` : choice.reason,
      };
    }
    const { version, quoted, feeTier } = choice;
    const gate = gateFdv(chain, value, quoted, supply, nativeUsd);
    if (!gate.ok) return { ok: false, reason: gate.reason, fdv: gate.fdv };
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
      sent = await signer.sendTransaction(tx);
    } catch (error) {
      nonces.delete(chain.id);
      return { ok: false, reason: error.shortMessage || error.message || "Không gửi được giao dịch.", venue };
    }
    const lagMs = Date.now() - started;
    try {
      const receipt = await sent.wait();
      if (!receipt || receipt.status === 0) {
        return { ok: false, reason: `Giao dịch revert trên ${venue}.`, tx: sent.hash, venue, lagMs, fdv: gate.fdv };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `Đã gửi giao dịch nhưng chưa xác nhận: ${error.shortMessage || error.message}`,
        tx: sent.hash,
        venue,
        lagMs,
        fdv: gate.fdv,
      };
    }
    return { ok: true, tx: sent.hash, venue, wallet: evmWallet.address, lagMs, fdv: gate.fdv };
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
    const supplyPromise = Number(config.maxFdv) > 0
      ? connection.getTokenSupply(new PublicKey(listing.contract)).catch(() => null)
      : Promise.resolve(null);
    const pricePromise = Number(config.maxFdv) > 0 ? priceFor(chain.symbol) : Promise.resolve(0);
    const response = await fetch(`${JUPITER_ORDER}?${params}`, { headers });
    const order = await response.json().catch(() => ({}));
    const encoded = order.transaction || order.swapTransaction;
    if (!response.ok || !encoded) {
      return { ok: false, reason: order.errorMessage || order.error || `Jupiter HTTP ${response.status}` };
    }
    const [supply, nativeUsd] = await Promise.all([supplyPromise, pricePromise]);
    const outAmount = BigInt(order.outAmount || 0);
    const inAmount = BigInt(order.inAmount || amount);
    const gate = gateFdv(
      chain,
      inAmount,
      outAmount,
      supply?.value?.amount ? BigInt(supply.value.amount) : null,
      nativeUsd,
    );
    if (!gate.ok) return { ok: false, reason: gate.reason };
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
        return { ok: false, reason: "Giao dịch Solana không thành công.", tx: signature, venue: "Jupiter", lagMs, fdv: gate.fdv };
      }
    } catch (error) {
      return { ok: false, reason: `Đã gửi giao dịch nhưng chưa xác nhận: ${error.message}`, tx: signature, venue: "Jupiter", lagMs, fdv: gate.fdv };
    }
    return { ok: true, tx: signature, venue: "Jupiter", wallet: solanaKey.publicKey.toBase58(), lagMs, fdv: gate.fdv };
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

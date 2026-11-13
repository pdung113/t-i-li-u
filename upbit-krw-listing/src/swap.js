import { ethers } from "ethers";
import bs58 from "bs58";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { chainById, minOut, priorityLamports, scaleUnits, SOL_MINT } from "./networks.js";

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

const JUPITER_ORDER = "https://api.jup.ag/swap/v2/order";

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
    const decoded = V2_IFACE.decodeFunctionResult("getAmountsOut", amounts);
    return decoded[0][1];
  } catch {
    return null;
  }
}

async function quoteV3(provider, chain, token, value) {
  if (!chain.v3Quoter) return null;
  let best = null;
  for (const fee of chain.v3Fees) {
    try {
      const data = V3_QUOTER_IFACE.encodeFunctionData("quoteExactInputSingle", [[
        chain.wrapped,
        token,
        value,
        fee,
        0,
      ]]);
      const raw = await provider.call({ to: chain.v3Quoter, data });
      const decoded = V3_QUOTER_IFACE.decodeFunctionResult("quoteExactInputSingle", raw);
      const out = decoded[0];
      if (!best || out > best.out) best = { fee, out };
    } catch {
      // Phí pool này không có thanh khoản.
    }
  }
  return best;
}

async function buyEvm(listing, chain, config) {
  const wallet = walletFromEvmKey(config.evmPrivateKey);
  if (!wallet) return { ok: false, reason: `Thiếu private key ví EVM để mua trên ${chain.symbol}.` };
  const provider = new ethers.JsonRpcProvider(rpcFor(chain, config), chain.chainId);
  const signer = wallet.connect(provider);
  const token = ethers.getAddress(listing.contract);
  const value = ethers.parseEther(String(config.amount));
  const [feeData, nonce, v2Out] = await Promise.all([
    provider.getFeeData(),
    provider.getTransactionCount(wallet.address, "pending"),
    quoteV2(provider, chain, token, value),
  ]);
  const gas = feeFields(chain, feeData, config.gasMultiple);
  let tx;
  let venue = "Uniswap V2";
  if (chain.id === "bsc") venue = "PancakeSwap V2";
  if (v2Out && v2Out > 0n) {
    const out = minOut(v2Out, config.slippagePercent);
    tx = {
      chainId: chain.chainId,
      to: chain.v2Router,
      data: V2_IFACE.encodeFunctionData("swapExactETHForTokensSupportingFeeOnTransferTokens", [
        out,
        [chain.wrapped, token],
        wallet.address,
        Math.floor(Date.now() / 1000) + 120,
      ]),
      value,
      nonce,
      gasLimit: 450_000n,
      ...gas,
    };
  } else {
    const v3 = await quoteV3(provider, chain, token, value);
    if (!v3) return { ok: false, reason: `Không thấy pool DEX cho ${token} trên ${chain.id}.` };
    venue = chain.id === "bsc" ? "PancakeSwap V3" : "Uniswap V3";
    const floor = minOut(v3.out, config.slippagePercent);
    const v3Args = chain.v3Deadline
      ? [chain.wrapped, token, v3.fee, wallet.address, Math.floor(Date.now() / 1000) + 120, value, floor, 0]
      : [chain.wrapped, token, v3.fee, wallet.address, value, floor, 0];
    tx = {
      chainId: chain.chainId,
      to: chain.v3Router,
      data: (chain.v3Deadline ? V3_ROUTER_DEADLINE_IFACE : V3_ROUTER_IFACE).encodeFunctionData("exactInputSingle", [v3Args]),
      value,
      nonce,
      gasLimit: 550_000n,
      ...gas,
    };
  }
  let sent;
  try {
    sent = await signer.sendTransaction(tx);
  } catch (error) {
    return { ok: false, reason: error.shortMessage || error.message || "Không gửi được giao dịch.", venue };
  }
  try {
    const receipt = await sent.wait();
    if (!receipt || receipt.status === 0) {
      return { ok: false, reason: `Giao dịch revert trên ${venue}.`, tx: sent.hash, venue };
    }
  } catch (error) {
    return { ok: false, reason: `Đã gửi giao dịch nhưng chưa xác nhận: ${error.shortMessage || error.message}`, tx: sent.hash, venue };
  }
  return { ok: true, tx: sent.hash, venue, wallet: wallet.address };
}

async function buySolana(listing, chain, config) {
  let keypair;
  try {
    keypair = walletFromSolanaKey(config.solanaPrivateKey);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  if (!keypair) return { ok: false, reason: "Thiếu private key ví Solana." };
  const connection = new Connection(rpcFor(chain, config), "confirmed");
  let samples = [];
  try {
    const fees = await connection.getRecentPrioritizationFees();
    samples = fees.map((item) => item.prioritizationFee);
  } catch {
    samples = [];
  }
  const lamports = priorityLamports(samples, config.gasMultiple);
  const params = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: listing.contract,
    amount: ethers.parseUnits(String(config.amount), 9).toString(),
    taker: keypair.publicKey.toBase58(),
    slippageBps: String(Math.round(config.slippagePercent * 100)),
    priorityFeeLamports: String(lamports),
    broadcastFeeType: "exactFee",
    maxSupportedTransactionVersion: "0",
  });
  const headers = { Accept: "application/json" };
  if (config.jupiterApiKey) headers["x-api-key"] = config.jupiterApiKey;
  const response = await fetch(`${JUPITER_ORDER}?${params}`, { headers });
  const order = await response.json().catch(() => ({}));
  const encoded = order.transaction || order.swapTransaction;
  if (!response.ok || !encoded) {
    return { ok: false, reason: order.errorMessage || order.error || `Jupiter HTTP ${response.status}` };
  }
  const transaction = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
  transaction.sign([keypair]);
  let signature;
  try {
    signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3 });
  } catch (error) {
    return { ok: false, reason: error.message || "Không gửi được giao dịch Solana.", venue: "Jupiter" };
  }
  try {
    const confirmation = order.lastValidBlockHeight
      ? await connection.confirmTransaction({
        signature,
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: Number(order.lastValidBlockHeight),
      }, "confirmed")
      : await connection.confirmTransaction(signature, "confirmed");
    if (confirmation.value?.err) {
      return { ok: false, reason: "Giao dịch Solana không thành công.", tx: signature, venue: "Jupiter" };
    }
  } catch (error) {
    return { ok: false, reason: `Đã gửi giao dịch nhưng chưa xác nhận: ${error.message}`, tx: signature, venue: "Jupiter" };
  }
  return { ok: true, tx: signature, venue: `Jupiter ${order.router || ""}`.trim(), wallet: keypair.publicKey.toBase58() };
}

export async function buyOnDex(listing, config) {
  const chain = chainById(listing.chain);
  if (!chain) return { ok: false, reason: listing.chain ? `Chưa hỗ trợ DEX trên mạng ${listing.chain}.` : "Thông báo không ghi mạng." };
  if (!listing.contract) return { ok: false, reason: "Thông báo không có địa chỉ contract." };
  if (chain.kind === "solana") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(listing.contract)) {
      return { ok: false, reason: "Contract Solana không đúng." };
    }
    return buySolana(listing, chain, config);
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(listing.contract)) {
    return { ok: false, reason: "Contract EVM không đúng." };
  }
  return buyEvm(listing, chain, config);
}

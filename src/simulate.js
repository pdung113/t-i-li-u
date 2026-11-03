import { ethers } from "ethers";
import { taxBps } from "./decide.js";
import { eoaSellAbi, eoaSellBytecode } from "./generated/eoaSell.js";

const routerIface = new ethers.Interface([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
]);

const erc20Iface = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

const pairIface = new ethers.Interface([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);

const factoryIface = new ethers.Interface([
  "function getPair(address tokenA, address tokenB) view returns (address pair)",
]);

const sellIface = new ethers.Interface(eoaSellAbi);
const coder = ethers.AbiCoder.defaultAbiCoder();

export const SIM_EOA = "0xA11CE0000000000000000000000000000000A11C";

const SIM_GAS = 4_000_000;

function callOk(call) {
  if (!call?.status) return false;
  try {
    return BigInt(call.status) === 1n;
  } catch {
    return false;
  }
}

export function revertReason(call) {
  const data = call?.returnData;
  if (typeof data !== "string" || !data.startsWith("0x08c379a0") || data.length < 10) return "";
  try {
    const [message] = coder.decode(["string"], `0x${data.slice(10)}`);
    return String(message);
  } catch {
    return "";
  }
}

function decodeUint(call) {
  if (!callOk(call) || !call.returnData || call.returnData === "0x") return null;
  try {
    const [value] = coder.decode(["uint256"], call.returnData);
    return value;
  } catch {
    return null;
  }
}

export function parseSimulateResult(result, { withSell }) {
  const blocks = Array.isArray(result) ? result : [];
  const buyCalls = blocks[0]?.calls ?? [];
  const quote = buyCalls[0];
  const before = buyCalls[1];
  const buy = buyCalls[2];
  const after = buyCalls[3];

  let expectedBuy = null;
  if (callOk(quote) && quote.returnData && quote.returnData !== "0x") {
    try {
      const [amounts] = coder.decode(["uint256[]"], quote.returnData);
      expectedBuy = amounts[amounts.length - 1];
    } catch {
      expectedBuy = null;
    }
  }

  const beforeBal = decodeUint(before) ?? 0n;
  const afterBal = decodeUint(after);
  const gotTokens = afterBal == null || afterBal <= beforeBal ? 0n : afterBal - beforeBal;
  const buyFailed = !callOk(buy);
  let expectedSell = null;
  let gotEth = null;
  let sellFailed = true;

  if (withSell) {
    const sellCall = blocks[1]?.calls?.[0];
    if (callOk(sellCall) && sellCall.returnData && sellCall.returnData !== "0x") {
      try {
        const decoded = coder.decode(["uint256", "uint256", "uint256"], sellCall.returnData);
        expectedSell = decoded[0];
        gotEth = decoded[1];
        sellFailed = decoded[2] === 0n;
      } catch {
        sellFailed = true;
      }
    }
  }

  return {
    buyFailed,
    sellFailed: withSell ? sellFailed : false,
    sellChecked: withSell,
    expectedBuy,
    gotTokens,
    expectedSell,
    gotEth,
    buyTaxBps: buyFailed ? null : taxBps(expectedBuy, gotTokens),
    sellTaxBps: withSell && !sellFailed ? taxBps(expectedSell, gotEth) : null,
    buyRevert: revertReason(buy),
    sellRevert: withSell ? revertReason(blocks[1]?.calls?.[0]) : "",
  };
}

function hexAddr(value) {
  return ethers.getAddress(value);
}

export async function simulateSwap(provider, {
  chain,
  token,
  valueWei,
  withSell = true,
  nowSec = Math.floor(Date.now() / 1000),
  eoa = SIM_EOA,
}) {
  const trader = hexAddr(eoa);
  const tokenAddr = hexAddr(token);
  const router = hexAddr(chain.router);
  const weth = hexAddr(chain.weth);
  const deadline = BigInt(nowSec + 600);
  const path = [weth, tokenAddr];
  const gas = ethers.toQuantity(SIM_GAS);
  const balanceOf = erc20Iface.encodeFunctionData("balanceOf", [trader]);
  const buyBlock = {
    stateOverrides: {
      [trader]: { balance: ethers.toQuantity(valueWei + ethers.parseEther("1")) },
    },
    calls: [
      {
        from: trader,
        to: router,
        gas,
        data: routerIface.encodeFunctionData("getAmountsOut", [valueWei, path]),
      },
      { from: trader, to: tokenAddr, gas, data: balanceOf },
      {
        from: trader,
        to: router,
        gas,
        value: ethers.toQuantity(valueWei),
        data: routerIface.encodeFunctionData("swapExactETHForTokensSupportingFeeOnTransferTokens", [
          0,
          path,
          trader,
          deadline,
        ]),
      },
      { from: trader, to: tokenAddr, gas, data: balanceOf },
    ],
  };

  const blocks = [buyBlock];
  if (withSell) {
    blocks.push({
      blockOverrides: {
        time: ethers.toQuantity(nowSec + 180),
      },
      stateOverrides: {
        [trader]: { code: eoaSellBytecode },
      },
      calls: [
        {
          from: trader,
          to: trader,
          gas,
          data: sellIface.encodeFunctionData("sell", [router, weth, tokenAddr]),
        },
      ],
    });
  }

  const started = Date.now();
  const result = await provider.send("eth_simulateV1", [
    {
      blockStateCalls: blocks,
      validation: false,
      traceTransfers: false,
      returnFullTransactions: false,
    },
    "latest",
  ]);

  return {
    ...parseSimulateResult(result, { withSell }),
    ms: Date.now() - started,
  };
}

/** Nếu address là pair V2 của factory thì trả về token còn lại (không phải WETH). */
export async function underlyingToken(provider, chain, address) {
  try {
    const [raw0, raw1] = await Promise.all([
      provider.call({ to: address, data: pairIface.encodeFunctionData("token0") }),
      provider.call({ to: address, data: pairIface.encodeFunctionData("token1") }),
    ]);
    const [token0] = coder.decode(["address"], raw0);
    const [token1] = coder.decode(["address"], raw1);
    const rawPair = await provider.call({
      to: chain.factory,
      data: factoryIface.encodeFunctionData("getPair", [token0, token1]),
    });
    const [pair] = coder.decode(["address"], rawPair);
    if (pair.toLowerCase() !== address.toLowerCase()) return null;
    return tokenFromPair({ token0, token1 }, chain.weth);
  } catch {
    return null;
  }
}

export function tokenFromPair(pair, weth) {
  if (!pair) return null;
  const wrapped = weth.toLowerCase();
  if (pair.token0.toLowerCase() === wrapped) return pair.token1;
  if (pair.token1.toLowerCase() === wrapped) return pair.token0;
  return null;
}

async function reservesReady(provider, pair) {
  const reservesRaw = await provider.call({
    to: pair,
    data: pairIface.encodeFunctionData("getReserves"),
  });
  const [reserve0, reserve1] = coder.decode(["uint112", "uint112", "uint32"], reservesRaw);
  return reserve0 > 0n && reserve1 > 0n;
}

export async function hasBuyLiquidity(provider, chain, token) {
  try {
    const raw = await provider.call({
      to: chain.factory,
      data: factoryIface.encodeFunctionData("getPair", [token, chain.weth]),
    });
    const [pair] = coder.decode(["address"], raw);
    if (pair !== ethers.ZeroAddress) return await reservesReady(provider, pair);
    const reservesRaw = await provider
      .call({ to: token, data: pairIface.encodeFunctionData("getReserves") })
      .catch(() => null);
    if (!reservesRaw) return false;
    const [reserve0, reserve1] = coder.decode(["uint112", "uint112", "uint32"], reservesRaw);
    if (reserve0 === 0n || reserve1 === 0n) return false;
    return Boolean(await underlyingToken(provider, chain, token));
  } catch {
    return false;
  }
}

export async function describePool(provider, chain, token) {
  try {
    const raw = await provider.call({
      to: chain.factory,
      data: factoryIface.encodeFunctionData("getPair", [token, chain.weth]),
    });
    const [pair] = coder.decode(["address"], raw);
    if (pair === ethers.ZeroAddress) return "chưa có pair V2";
    const reservesRaw = await provider.call({
      to: pair,
      data: pairIface.encodeFunctionData("getReserves"),
    });
    const [reserve0, reserve1] = coder.decode(["uint112", "uint112", "uint32"], reservesRaw);
    if (reserve0 === 0n || reserve1 === 0n) return "pair chưa có thanh khoản";
    return "đã có thanh khoản nhưng lệnh swap bị revert";
  } catch {
    return "không đọc được pool";
  }
}

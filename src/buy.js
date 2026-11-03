import { ethers } from "ethers";

const routerIface = new ethers.Interface([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
]);

export function minOutFromReceived(gotTokens, slippagePercent) {
  const keepBps = BigInt(Math.round((100 - Number(slippagePercent)) * 100));
  if (keepBps <= 0n) return 0n;
  return (gotTokens * keepBps) / 10000n;
}

export function scaleGas(wei, multiplier) {
  const factor = Math.round(Number(multiplier) * 1000);
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("GAS_X phải lớn hơn 0");
  return (BigInt(wei) * BigInt(factor) + 999n) / 1000n;
}

export function formatGwei(wei) {
  const n = Number(ethers.formatUnits(wei, "gwei"));
  if (!Number.isFinite(n)) return "? gwei";
  const digits = n >= 100 ? 1 : n >= 1 ? 2 : 4;
  const text = n.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `${text} gwei`;
}

export function pricedGas(chain, fee, multiplier) {
  if (chain.eip1559) {
    const base = fee?.maxFeePerGas ?? fee?.gasPrice;
    if (base == null || base <= 0n) throw new Error("RPC không trả giá gas");
    let tip = fee?.maxPriorityFeePerGas ?? base;
    if (tip <= 0n) tip = base;
    const maxFeePerGas = scaleGas(base, multiplier);
    let maxPriorityFeePerGas = scaleGas(tip, multiplier);
    if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
    return { maxFeePerGas, maxPriorityFeePerGas };
  }
  const price = fee?.gasPrice ?? fee?.maxFeePerGas;
  if (price == null || price <= 0n) throw new Error("RPC không trả giá gas");
  return { gasPrice: scaleGas(price, multiplier) };
}

export function fixedGas(chain, gasGwei) {
  const gas = ethers.parseUnits(String(gasGwei), "gwei");
  if (chain.eip1559) return { maxFeePerGas: gas, maxPriorityFeePerGas: gas };
  return { gasPrice: gas };
}

export function describeGas(config, quoted) {
  const shown = formatGwei(quoted.gasPrice ?? quoted.maxFeePerGas);
  if (config.gasX == null) return shown;
  return `x${config.gasX} giá hiện tại (${shown})`;
}

export function buildBuyTx({
  chain,
  token,
  walletAddress,
  valueWei,
  minOut,
  gasGwei,
  gas,
  gasLimit,
  nonce,
  deadline,
}) {
  const priced = gas || fixedGas(chain, gasGwei);
  const tx = {
    chainId: chain.chainId,
    to: ethers.getAddress(chain.router),
    data: routerIface.encodeFunctionData("swapExactETHForTokensSupportingFeeOnTransferTokens", [
      minOut,
      [ethers.getAddress(chain.weth), ethers.getAddress(token)],
      ethers.getAddress(walletAddress),
      deadline,
    ]),
    value: valueWei,
    nonce,
    gasLimit,
  };

  if (chain.eip1559) {
    tx.type = 2;
    tx.maxFeePerGas = priced.maxFeePerGas;
    tx.maxPriorityFeePerGas = priced.maxPriorityFeePerGas;
  } else {
    tx.type = 0;
    tx.gasPrice = priced.gasPrice;
  }
  return tx;
}

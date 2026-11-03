import { ethers } from "ethers";

const routerIface = new ethers.Interface([
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
]);

export function minOutFromReceived(gotTokens, slippagePercent) {
  const keepBps = BigInt(Math.round((100 - Number(slippagePercent)) * 100));
  if (keepBps <= 0n) return 0n;
  return (gotTokens * keepBps) / 10000n;
}

export function buildBuyTx({
  chain,
  token,
  walletAddress,
  valueWei,
  minOut,
  gasGwei,
  gasLimit,
  nonce,
  deadline,
}) {
  const gas = ethers.parseUnits(String(gasGwei), "gwei");
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
    tx.maxFeePerGas = gas;
    tx.maxPriorityFeePerGas = gas;
  } else {
    tx.type = 0;
    tx.gasPrice = gas;
  }
  return tx;
}

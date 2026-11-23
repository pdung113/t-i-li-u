import { ethers } from "ethers";

const MINT_ABI = {
  mint: "function mint(uint256 quantity) payable",
  publicmint: "function publicMint(uint256 quantity) payable",
  mintpublic: "function mintPublic(uint256 quantity) payable",
  freemint: "function freeMint(uint256 quantity) payable",
};

export function encodeMint(functionName, count) {
  const key = String(functionName || "mint").trim().toLowerCase();
  const fragment = MINT_ABI[key];
  if (!fragment) {
    throw new Error("MINT_FUNCTION phải là mint, publicMint, mintPublic hoặc freeMint");
  }
  const name = fragment.slice("function ".length).split("(")[0];
  return new ethers.Interface([fragment]).encodeFunctionData(name, [BigInt(count)]);
}

export function buildMintTx({ chain, contract, data, valueWei, gas, gasLimit, nonce }) {
  const tx = {
    chainId: chain.chainId,
    to: ethers.getAddress(contract),
    data,
    value: valueWei,
    nonce,
    gasLimit,
  };
  if (chain.eip1559) {
    tx.type = 2;
    tx.maxFeePerGas = gas.maxFeePerGas;
    tx.maxPriorityFeePerGas = gas.maxPriorityFeePerGas;
  } else {
    tx.type = 0;
    tx.gasPrice = gas.gasPrice;
  }
  return tx;
}

export async function mintReady(provider, { to, from, data, valueWei }) {
  try {
    await provider.call({
      to,
      from,
      data,
      value: valueWei,
    });
    return { ok: true, reason: "" };
  } catch (error) {
    const reason = error.shortMessage || error.reason || error.message || "";
    return { ok: false, reason: String(reason).replace(/^execution reverted:?\s*/i, "") };
  }
}

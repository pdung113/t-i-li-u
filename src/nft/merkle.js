import { ethers } from "ethers";

function hexLess(a, b) {
  return a.toLowerCase() < b.toLowerCase();
}

export function hashPair(a, b) {
  const [left, right] = hexLess(a, b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([left, right]));
}

export function makeTree(leaves, { duplicateOdd = false } = {}) {
  if (!leaves.length) return [];
  const layers = [leaves.slice()];
  let level = layers[0];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) next.push(duplicateOdd ? hashPair(level[i], level[i]) : level[i]);
      else next.push(hashPair(level[i], level[i + 1]));
    }
    layers.push(next);
    level = next;
  }
  return layers;
}

export function treeRoot(layers) {
  const top = layers[layers.length - 1];
  return top ? top[0] : null;
}

export function proofFor(layers, index) {
  const proof = [];
  let idx = index;
  for (let level = 0; level < layers.length - 1; level += 1) {
    const pair = idx ^ 1;
    if (pair < layers[level].length) proof.push(layers[level][pair]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(proof, root, leaf) {
  if (!root || !leaf) return false;
  let computed = leaf;
  for (const item of proof || []) {
    computed = hashPair(computed, item);
  }
  return computed.toLowerCase() === root.toLowerCase();
}

export function proofFromLeaves(leaves, index, options) {
  const layers = makeTree(leaves, options);
  return { root: treeRoot(layers), proof: proofFor(layers, index), layers };
}

export function seaDropLeaf(minter, params) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "bool"],
      [
        minter,
        params.mintPrice,
        params.maxTotalMintableByWallet,
        params.startTime,
        params.endTime,
        params.dropStageIndex,
        params.maxTokenSupplyForStage,
        params.feeBps,
        params.restrictFeeRecipients,
      ],
    ),
  );
}

export function thirdwebLeaf(wallet, limit, price, currency) {
  return ethers.solidityPackedKeccak256(
    ["address", "uint256", "uint256", "address"],
    [wallet, limit, price, currency],
  );
}

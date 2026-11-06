export const NFT_CHAINS = {
  eth: {
    chainId: 1,
    nativeSymbol: "ETH",
    eip1559: true,
    rpc: "https://ethereum.publicnode.com",
    opensea: "ethereum",
  },
  base: {
    chainId: 8453,
    nativeSymbol: "ETH",
    eip1559: true,
    rpc: "https://mainnet.base.org",
    opensea: "base",
  },
  polygon: {
    chainId: 137,
    nativeSymbol: "POL",
    eip1559: true,
    rpc: "https://polygon-bor-rpc.publicnode.com",
    opensea: "polygon",
  },
  arbitrum: {
    chainId: 42161,
    nativeSymbol: "ETH",
    eip1559: true,
    rpc: "https://arbitrum-one-rpc.publicnode.com",
    opensea: "arbitrum",
  },
  optimism: {
    chainId: 10,
    nativeSymbol: "ETH",
    eip1559: true,
    rpc: "https://optimism-rpc.publicnode.com",
    opensea: "optimism",
  },
  bsc: {
    chainId: 56,
    nativeSymbol: "BNB",
    eip1559: false,
    rpc: "https://bsc-dataseed.binance.org",
    opensea: "bsc",
  },
};

const CHAIN_ALIASES = {
  ethereum: "eth",
  eth: "eth",
  mainnet: "eth",
  base: "base",
  polygon: "polygon",
  matic: "polygon",
  pol: "polygon",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  optimism: "optimism",
  op: "optimism",
  bsc: "bsc",
  bnb: "bsc",
  binance: "bsc",
};

const CHAIN_IDS = {
  1: "eth",
  8453: "base",
  137: "polygon",
  42161: "arbitrum",
  10: "optimism",
  56: "bsc",
};

export function resolveNftChain(name) {
  const key = CHAIN_ALIASES[String(name || "").toLowerCase()];
  const chain = key ? NFT_CHAINS[key] : null;
  if (!chain) {
    throw new Error(`Chain không hỗ trợ: ${name}. Dùng eth, base, polygon, arbitrum, optimism, hoặc bsc.`);
  }
  return { name: key, ...chain };
}

export function chainFromId(chainId) {
  const key = CHAIN_IDS[Number(chainId)];
  return key ? resolveNftChain(key) : null;
}

export function probeOrder(hinted) {
  const names = [];
  const push = (name) => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const hint of hinted || []) push(hint);
  for (const name of Object.keys(NFT_CHAINS)) push(name);
  return names.map((name) => resolveNftChain(name));
}

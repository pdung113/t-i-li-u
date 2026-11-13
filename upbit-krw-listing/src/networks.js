export const SOL_MINT = "So11111111111111111111111111111111111111112";

export const CHAINS = {
  ethereum: {
    kind: "evm",
    chainId: 1,
    symbol: "ETH",
    eip1559: true,
    nativeDecimals: 18,
    rpc: "https://ethereum.publicnode.com",
    ws: "wss://ethereum.publicnode.com",
    stable: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    stableDecimals: 6,
    wrapped: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    v2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    v3Router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    v3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v3Fees: [100, 500, 3000, 10000],
    v3Deadline: false,
  },
  bsc: {
    kind: "evm",
    chainId: 56,
    symbol: "BNB",
    eip1559: false,
    nativeDecimals: 18,
    rpc: "https://bsc-dataseed.binance.org",
    ws: "wss://bsc.publicnode.com",
    stable: "0x55d398326f99059fF775485246999027B3197955",
    stableDecimals: 18,
    wrapped: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    v2Router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    v3Router: "0x1b81D678ffb9C0263b24A97847620C99d213eB14",
    v3Quoter: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
    v3Fees: [100, 500, 2500, 10000],
    v3Deadline: true,
  },
  base: {
    kind: "evm",
    chainId: 8453,
    symbol: "ETH",
    eip1559: true,
    nativeDecimals: 18,
    rpc: "https://mainnet.base.org",
    ws: "wss://base.publicnode.com",
    stable: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    stableDecimals: 6,
    wrapped: "0x4200000000000000000000000000000000000006",
    v2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    v3Router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    v3Quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    v3Fees: [100, 500, 3000, 10000],
    v3Deadline: false,
  },
  arbitrum: {
    kind: "evm",
    chainId: 42161,
    symbol: "ETH",
    eip1559: true,
    nativeDecimals: 18,
    rpc: "https://arb1.arbitrum.io/rpc",
    ws: "wss://arbitrum-one.publicnode.com",
    stable: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    stableDecimals: 6,
    wrapped: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    v2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    v3Router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    v3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v3Fees: [100, 500, 3000, 10000],
    v3Deadline: false,
  },
  optimism: {
    kind: "evm",
    chainId: 10,
    symbol: "ETH",
    eip1559: true,
    nativeDecimals: 18,
    rpc: "https://mainnet.optimism.io",
    ws: "wss://optimism.publicnode.com",
    stable: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    stableDecimals: 6,
    wrapped: "0x4200000000000000000000000000000000000006",
    v2Router: "",
    v3Router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    v3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v3Fees: [100, 500, 3000, 10000],
    v3Deadline: false,
  },
  polygon: {
    kind: "evm",
    chainId: 137,
    symbol: "POL",
    eip1559: true,
    nativeDecimals: 18,
    rpc: "https://polygon-rpc.com",
    ws: "wss://polygon-bor.publicnode.com",
    stable: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    stableDecimals: 6,
    wrapped: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    v2Router: "",
    v3Router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    v3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v3Fees: [100, 500, 3000, 10000],
    v3Deadline: false,
  },
  solana: {
    kind: "solana",
    symbol: "SOL",
    nativeDecimals: 9,
    rpc: "https://api.mainnet-beta.solana.com",
    stable: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    stableDecimals: 6,
  },
};

export const CHAIN_IDS = Object.keys(CHAINS);

export function chainById(id) {
  return CHAINS[id] ? { id, ...CHAINS[id] } : null;
}

export function scaleUnits(value, multiple) {
  const scaled = BigInt(value) * BigInt(Math.round(Number(multiple) * 100));
  return scaled / 100n;
}

export function priorityLamports(microLamportsSamples, multiple) {
  const positive = microLamportsSamples.filter((fee) => fee > 0).sort((a, b) => a - b);
  const median = positive.length ? positive[Math.floor((positive.length - 1) / 2)] : 10_000;
  const lamports = Math.ceil((median * 400_000) / 1_000_000);
  return Math.max(5_000, Math.ceil(lamports * Number(multiple)));
}

export function minOut(amountOut, slippagePercent) {
  const keep = BigInt(Math.round((100 - Number(slippagePercent)) * 100));
  return (BigInt(amountOut) * keep) / 10000n;
}

export const CHAINS = {
  bsc: {
    chainId: 56,
    nativeSymbol: "BNB",
    eip1559: false,
    rpc: "https://bsc-dataseed.binance.org",
    priceFeed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    blacklist: [
      "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
      "0x10ED43C718714eb63d5aA57B78B54704E256024E",
      "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
      "0x55d398326f99059fF775485246999027B3197955",
      "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
      "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
    ],
  },
  eth: {
    chainId: 1,
    nativeSymbol: "ETH",
    eip1559: true,
    rpc: "https://ethereum.publicnode.com",
    priceFeed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
    router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    blacklist: [
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
      "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    ],
  },
  base: {
    chainId: 8453,
    nativeSymbol: "ETH",
    eip1559: true,
    rpc: "https://mainnet.base.org",
    priceFeed: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    factory: "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
    weth: "0x4200000000000000000000000000000000000006",
    blacklist: [
      "0x4200000000000000000000000000000000000006",
      "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
      "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ],
  },
  robinhood: {
    chainId: 4663,
    nativeSymbol: "ETH",
    eip1559: true,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    priceFeed: null,
    stable: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 },
    router: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
    factory: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    blacklist: [
      "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
      "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f",
      "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    ],
  },
};

const CHAIN_ALIASES = {
  ethereum: "eth",
  bnb: "bsc",
  rh: "robinhood",
  robinhoodchain: "robinhood",
};

export function resolveChain(name) {
  const raw = String(name || "").toLowerCase();
  const key = CHAIN_ALIASES[raw] || raw;
  const chain = CHAINS[key];
  if (!chain) {
    throw new Error(`Chain không hỗ trợ: ${name}. Dùng bsc, eth, base, hoặc robinhood.`);
  }
  return { name: key, ...chain };
}

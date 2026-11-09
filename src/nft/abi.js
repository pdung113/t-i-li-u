import { ethers } from "ethers";

export const ZERO = "0x0000000000000000000000000000000000000000";
export const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const ERC721_ID = "0x80ac58cd";
export const ERC1155_ID = "0xd9b67a26";

export const nftIface = new ethers.Interface([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function getAllowedSeaDrop() view returns (address[])",
  "function getMintStats(address minter) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function name() view returns (string)",
  "function mint(uint256 quantity) payable",
  "function publicMint(uint256 quantity) payable",
  "function mintPublic(uint256 quantity) payable",
  "function purchase(uint256 quantity) payable",
  "function freeMint(uint256 quantity) payable",
  "function mintAllowlist(uint256 quantity) payable",
  "function allowlistMint(uint256 quantity) payable",
  "function whitelistMint(uint256 quantity) payable",
  "function mintWhitelist(uint256 quantity) payable",
  "function mintPrice() view returns (uint256)",
  "function price() view returns (uint256)",
  "function cost() view returns (uint256)",
  "function publicPrice() view returns (uint256)",
  "function getPrice() view returns (uint256)",
  "function saleStart() view returns (uint256)",
  "function publicSaleStart() view returns (uint256)",
  "function startTime() view returns (uint256)",
  "function mintStart() view returns (uint256)",
  "function publicSaleStartTime() view returns (uint256)",
  "function allowlistStart() view returns (uint256)",
  "function whitelistStart() view returns (uint256)",
  "function allowlistStartTime() view returns (uint256)",
  "function maxPerWallet() view returns (uint256)",
  "function maxMintPerWallet() view returns (uint256)",
  "function maxPerTx() view returns (uint256)",
  "function maxMintAmount() view returns (uint256)",
  "function saleActive() view returns (bool)",
  "function publicSaleActive() view returns (bool)",
  "function mintEnabled() view returns (bool)",
  "function paused() view returns (bool)",
  "function allowlist(address account) view returns (bool)",
  "function isAllowlisted(address account) view returns (bool)",
  "function whitelist(address account) view returns (bool)",
  "function isWhitelisted(address account) view returns (bool)",
  "function minted(address account) view returns (uint256)",
  "function numberMinted(address account) view returns (uint256)",
  "function mintedPerWallet(address account) view returns (uint256)",
]);

export const seaDropIface = new ethers.Interface([
  "function getPublicDrop(address nftContract) view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)",
  "function getCreatorPayoutAddress(address nftContract) view returns (address)",
  "function getAllowedFeeRecipients(address nftContract) view returns (address[])",
  "function getAllowListMerkleRoot(address nftContract) view returns (bytes32)",
  "function getTokenGatedAllowedTokens(address nftContract) view returns (address[])",
  "function getTokenGatedDrop(address nftContract, address allowedNftToken) view returns (uint80 mintPrice, uint16 maxTotalMintableByWallet, uint48 startTime, uint48 endTime, uint8 dropStageIndex, uint32 maxTokenSupplyForStage, uint16 feeBps, bool restrictFeeRecipients)",
  "function getAllowedNftTokenIdIsRedeemed(address nftContract, address allowedNftToken, uint256 allowedNftTokenId) view returns (bool)",
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
  "function mintAllowList(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity, (uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients) mintParams, bytes32[] proof) payable",
  "function mintAllowedTokenHolder(address nftContract, address feeRecipient, address minterIfNotPayer, (address allowedNftToken, uint256[] allowedNftTokenIds) mintParams) payable",
]);

export const dropIface = new ethers.Interface([
  "function claimCondition() view returns (uint256 currentStartId, uint256 count)",
  "function getClaimConditionById(uint256 conditionId) view returns ((uint256 startTimestamp, uint256 maxClaimableSupply, uint256 supplyClaimed, uint256 quantityLimitPerWallet, bytes32 merkleRoot, uint256 pricePerToken, address currency, string metadata) condition)",
  "function getSupplyClaimedByWallet(uint256 conditionId, address claimer) view returns (uint256)",
  "function claim(address receiver, uint256 quantity, address currency, uint256 pricePerToken, (bytes32[] proof, uint256 quantityLimitPerWallet, uint256 pricePerToken, address currency) allowlistProof, bytes data) payable",
]);

export const phaseIface = new ethers.Interface([
  "function getPhases() view returns ((string name, uint64 startTime, uint64 endTime, uint128 price, uint32 maxPerWallet, uint32 maxSupply, bool gated)[])",
  "function platformFeePerMint() view returns (uint256)",
  "function totalMinted() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function phaseMinted(uint256 phaseId) view returns (uint256)",
  "function mintedInPhase(uint256 phaseId, address minter) view returns (uint256)",
  "function mint(uint256 phaseId, uint256 quantity, uint256 allowance, bytes signature) payable",
]);

export const PRICE_FNS = ["mintPrice", "price", "cost", "publicPrice", "getPrice"];
export const PUBLIC_START_FNS = ["publicSaleStartTime", "publicSaleStart", "saleStart", "startTime", "mintStart"];
export const ALLOW_START_FNS = ["allowlistStartTime", "allowlistStart", "whitelistStart"];
export const MAX_FNS = ["maxPerWallet", "maxMintPerWallet", "maxPerTx", "maxMintAmount"];
export const MINTED_FNS = ["numberMinted", "mintedPerWallet", "minted"];
export const ALLOW_BOOL_FNS = ["isAllowlisted", "allowlist", "isWhitelisted", "whitelist"];
export const PUBLIC_MINT_FNS = ["mint", "publicMint", "mintPublic", "purchase", "freeMint"];
export const ALLOW_MINT_FNS = ["mintAllowlist", "allowlistMint", "whitelistMint", "mintWhitelist"];

export function selectorOf(iface, name) {
  return iface.getFunction(name).selector.slice(2).toLowerCase();
}

/** ethers Result ném lỗi khi gọi filter/map, kể cả mảng rỗng. */
export function plainList(value) {
  if (value == null) return [];
  const out = [];
  const length = Number(value.length || 0);
  for (let index = 0; index < length; index += 1) out.push(value[index]);
  return out;
}

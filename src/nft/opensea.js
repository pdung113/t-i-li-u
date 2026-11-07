import { fulfillmentTx } from "./listings.js";

const API = "https://api.opensea.io/api/v2";

function headers(apiKey) {
  return {
    "x-api-key": apiKey,
    accept: "application/json",
  };
}

export function contractsFromCollection(body) {
  const list = body?.contracts || body?.collection?.contracts || [];
  return list
    .map((item) => ({
      address: item?.address || null,
      chain: item?.chain || body?.chain || null,
    }))
    .filter((item) => item.address);
}

export async function resolveCollection(slug, apiKey, fetchImpl = fetch) {
  const response = await fetchImpl(`${API}/collections/${encodeURIComponent(slug)}`, { headers: headers(apiKey) });
  if (!response.ok) throw new Error(`OpenSea không trả collection (${response.status}).`);
  return contractsFromCollection(await response.json());
}

export async function fetchListings({ chain, slug, contract, tokenId, apiKey, limit, fetchImpl = fetch }) {
  const headersWithKey = headers(apiKey);
  let url;
  if (contract) {
    const params = new URLSearchParams({
      asset_contract_address: contract,
      order_by: "eth_price",
      order_direction: "asc",
      limit: String(limit),
    });
    if (tokenId) params.set("token_ids", String(tokenId));
    url = `${API}/orders/${chain}/seaport/listings?${params}`;
  } else {
    url = `${API}/listings/collection/${encodeURIComponent(slug)}/best?limit=${limit}`;
  }
  const response = await fetchImpl(url, { headers: headersWithKey });
  if (!response.ok) throw new Error(`OpenSea không trả listing (${response.status}).`);
  const body = await response.json();
  return body.listings || body.orders || [];
}

export async function fetchFulfillment({ hash, chain, protocol, fulfiller, apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${API}/listings/fulfillment_data`, {
    method: "POST",
    headers: { ...headers(apiKey), "content-type": "application/json" },
    body: JSON.stringify({
      listing: { hash, chain, protocol_address: protocol },
      fulfiller: { address: fulfiller },
    }),
  });
  if (!response.ok) throw new Error(`OpenSea không tạo được lệnh mua (${response.status}).`);
  const tx = fulfillmentTx(await response.json());
  if (!tx) throw new Error("OpenSea không trả dữ liệu giao dịch mua.");
  return tx;
}

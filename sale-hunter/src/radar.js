import { isDeepSale, isHuntDeal, isLowStock } from "./deals.js";

export function createRadar() {
  const seen = new Map();
  let ready = false;
  return {
    take(deals, now = Date.now()) {
      const alerts = [];
      if (!ready) {
        for (const deal of deals) {
          seen.set(deal.id, { discount: deal.discount, oneDong: deal.oneDong, low: isLowStock(deal), seenAt: now });
          deal.isNew = false;
          deal.firstSeenAt = now;
        }
        ready = true;
        return alerts;
      }
      for (const deal of deals) {
        const prev = seen.get(deal.id);
        const hunt = isHuntDeal(deal) || isDeepSale(deal);
        const low = isLowStock(deal);
        const wasHunt = prev ? prev.oneDong || prev.discount >= 90 || (deal.platform !== "shopee" && prev.discount >= 70) || (deal.platform === "tiktok" && prev.discount >= 50) : false;
        const shopeeDeep = deal.platform === "shopee" && deal.discount >= 70;
        const wasShopeeDeep = Boolean(prev && deal.platform === "shopee" && prev.discount >= 70);
        deal.isNew = !prev;
        deal.firstSeenAt = prev?.seenAt || now;
        if (((hunt && !wasHunt) || (low && !prev?.low) || (shopeeDeep && !wasShopeeDeep)) && !deal.soldOut) alerts.push(deal);
        seen.set(deal.id, { discount: deal.discount, oneDong: deal.oneDong, low, seenAt: deal.firstSeenAt });
      }
      if (seen.size > 4000) {
        const keep = new Set(deals.map((deal) => deal.id));
        for (const id of seen.keys()) {
          if (!keep.has(id)) seen.delete(id);
        }
      }
      return alerts;
    },
  };
}

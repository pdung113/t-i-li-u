export function createRadar() {
  const seen = new Map();
  let ready = false;
  return {
    take(deals, now = Date.now()) {
      const alerts = [];
      if (!ready) {
        for (const deal of deals) {
          seen.set(deal.id, { discount: deal.discount, oneDong: deal.oneDong, seenAt: now });
          deal.isNew = false;
          deal.firstSeenAt = now;
        }
        ready = true;
        return alerts;
      }
      for (const deal of deals) {
        const prev = seen.get(deal.id);
        const hunt = deal.oneDong || deal.discount >= 90;
        const wasHunt = prev ? prev.oneDong || prev.discount >= 90 : false;
        deal.isNew = !prev;
        deal.firstSeenAt = prev?.seenAt || now;
        if (hunt && !wasHunt && !deal.soldOut) alerts.push(deal);
        seen.set(deal.id, { discount: deal.discount, oneDong: deal.oneDong, seenAt: deal.firstSeenAt });
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

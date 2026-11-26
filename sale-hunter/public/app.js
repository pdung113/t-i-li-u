const sorts = [
  ["save", "Hời nhiều tiền"],
  ["discount", "% giảm sâu"],
  ["price", "Giá thấp"],
  ["stock", "Sắp hết suất"],
];

const els = {
  live: document.querySelector("#live"),
  liveText: document.querySelector("#live-text"),
  clock: document.querySelector("#clock"),
  sessions: document.querySelector("#sessions"),
  sorts: document.querySelector("#sorts"),
  hunt: document.querySelector("#hunt"),
  shopeeMeta: document.querySelector("#shopee-meta"),
  tiktokMeta: document.querySelector("#tiktok-meta"),
  toast: document.querySelector("#toast"),
  q: document.querySelector("#q"),
  sound: document.querySelector("#sound"),
  notify: document.querySelector("#notify"),
};

const ui = {
  sort: "discount",
  sound: localStorage.getItem("sale-sound") === "1",
};
if (ui.sound) els.sound.classList.add("on");

let snapshot = null;
let skew = 0;
let primed = false;
const known = new Map();
let audioCtx = null;

const TIERS = [
  ["1d", "≤1.200đ"],
  ["90", "Từ 90%"],
  ["70", "Từ 70%"],
];

function tierOf(deal) {
  if (!deal) return "";
  if (deal.oneDong) return "1d";
  if (deal.discount >= 90) return "90";
  if (deal.platform !== "shopee" && deal.discount >= 70) return "70";
  if (deal.platform === "tiktok" && deal.discount >= 50) return "50";
  return "";
}

function stockLow(deal) {
  if (!deal || deal.platform === "tiktok" || deal.soldOut) return false;
  const total = Number(deal.stockTotal) || 0;
  const left = Number(deal.stock) || 0;
  return total > 0 && left > 0 && left / total <= 0.3;
}

function allowed(deal) {
  if (!deal?.url) return false;
  try {
    const parsed = new URL(deal.url);
    if (parsed.protocol !== "https:") return false;
    if (deal.platform === "shopee") return parsed.hostname === "shopee.vn";
    if (deal.platform === "tiktok") return parsed.hostname === "shop.tiktok.com" && parsed.pathname.startsWith("/vn/");
  } catch {
    return false;
  }
  return false;
}

function isHunt(deal) {
  return Boolean(deal) && Boolean(tierOf(deal)) && allowed(deal);
}

function rank(deal) {
  if (deal.soldOut) return -1;
  let score = deal.saveVnd + deal.discount * 1000;
  if (deal.oneDong) score += 1e15;
  else if (deal.discount >= 90) score += 1e14;
  return score;
}

function sortDeals(list) {
  const out = [...list];
  const pin = (deal) => (deal.oneDong ? 2 : deal.discount >= 90 ? 1 : 0);
  out.sort((a, b) => {
    if (a.soldOut !== b.soldOut) return a.soldOut ? 1 : -1;
    if (ui.sort !== "price" && ui.sort !== "stock" && pin(a) !== pin(b)) return pin(b) - pin(a);
    if (ui.sort === "discount") return b.discount - a.discount || b.saveVnd - a.saveVnd;
    if (ui.sort === "price") return (a.priceVnd || 1e15) - (b.priceVnd || 1e15);
    if (ui.sort === "stock") {
      const ar = a.stockTotal > 0 ? a.stock / a.stockTotal : 1;
      const br = b.stockTotal > 0 ? b.stock / b.stockTotal : 1;
      return ar - br;
    }
    return rank(b) - rank(a);
  });
  return out;
}

function visibleDeals(deals) {
  const q = els.q.value.trim().toLowerCase();
  return sortDeals((deals || []).filter((deal) => isHunt(deal) && (!q || deal.name.toLowerCase().includes(q))));
}

function visibleLow(deals) {
  const q = els.q.value.trim().toLowerCase();
  const list = (deals || []).filter((deal) => allowed(deal) && stockLow(deal) && !deal.oneDong && deal.discount < 90 && (!q || deal.name.toLowerCase().includes(q)));
  list.sort((a, b) => a.stock / a.stockTotal - b.stock / b.stockTotal || a.stock - b.stock);
  return list;
}

function visibleShelf(deals) {
  const q = els.q.value.trim().toLowerCase();
  const list = (deals || []).filter((deal) => allowed(deal) && !tierOf(deal) && !stockLow(deal) && deal.priceVnd > 0 && !deal.soldOut && (!q || deal.name.toLowerCase().includes(q)));
  list.sort((a, b) => (b.saveVnd || 0) - (a.saveVnd || 0) || b.discount - a.discount);
  return list;
}

function renderStatus() {
  const shopeeDeals = visibleDeals(snapshot?.shopee?.deals);
  const shopeeLow = visibleLow(snapshot?.shopee?.low);
  const tiktokDeals = visibleDeals(snapshot?.tiktok?.deals);
  const every = pollSeconds();
  if (!snapshot?.ready) {
    els.shopeeMeta.textContent = snapshot?.error || "Đang đọc flash sale Shopee Việt Nam…";
  } else if (shopeeDeals.length || shopeeLow.length) {
    const bits = [snapshot.shopee?.watched || "Shopee Việt Nam"];
    if (shopeeDeals.length) bits.push(`${shopeeDeals.length} mốc`);
    if (shopeeLow.length) bits.push(`${shopeeLow.length} sắp hết`);
    bits.push(`quét mỗi ${every}s`);
    els.shopeeMeta.textContent = bits.join(" · ");
  } else {
    const deep = snapshot.shopee?.deepest ? ` Sâu nhất đã thấy -${snapshot.shopee.deepest}%.` : "";
    els.shopeeMeta.textContent = `${snapshot.shopee?.watched || "Shopee Việt Nam"} · đã xem ${snapshot.shopee?.scanned || 0} món, chưa có món từ 1.200đ trở xuống, -90% hay sắp hết suất.${deep} Quét mỗi ${every}s`;
  }
  const tiktok = snapshot?.tiktok;
  els.tiktokMeta.replaceChildren();
  if (!tiktok) {
    els.tiktokMeta.textContent = "Đang quét TikTok Shop Việt Nam…";
  } else if (!tiktok.ok) {
    els.tiktokMeta.append(document.createTextNode(`${tiktok.message || "TikTok Shop Việt Nam chưa đọc được deal."} `));
    els.tiktokMeta.append(shopLink(tiktok.openUrl, "Mở TikTok"));
  } else if (tiktokDeals.length) {
    els.tiktokMeta.textContent = `${tiktok.message} · quét mỗi ${every}s`;
  } else if (!(tiktok.scanned > 0)) {
    els.tiktokMeta.textContent = "Trang hàng 1 đ có deal -70%. Máy chủ nhận danh sách rỗng. Bấm Săn sale trên trang đó để đổ vào cột Từ 70%.";
  } else {
    els.tiktokMeta.append(document.createTextNode(`${tiktok.message || `Đã xem ${tiktok.scanned || 0} món, chưa có món từ 1.200đ trở xuống, -90% hay -70%.`} `));
    els.tiktokMeta.append(shopLink(tiktok.openUrl, "Mở TikTok"));
  }
}

function shopLink(href, text) {
  const link = document.createElement("a");
  link.href = href || "https://shop.tiktok.com/vn/s?q=1%C4%91";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = text;
  return link;
}

function pollSeconds() {
  return Math.max(1, Math.round((snapshot?.pollMs || 15000) / 1000));
}

function renderSessions() {
  els.sessions.replaceChildren();
  const now = Math.floor((Date.now() + skew) / 1000);
  for (const session of snapshot?.sessions || []) {
    const el = document.createElement("div");
    el.className = "session" + (session.ongoing ? " on" : "");
    const left = session.end - now;
    let extra = "";
    if (session.ongoing && left > 0) extra = ` · còn ${clockLeft(left)}`;
    else if (!session.ongoing && session.start > now) extra = ` · mở sau ${clockLeft(session.start - now)}`;
    el.textContent = `${session.label}${extra}`;
    el.title = session.name || session.label;
    els.sessions.append(el);
  }
}

function renderControls() {
  els.sorts.replaceChildren();
  for (const [id, label] of sorts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = ui.sort === id ? "on" : "";
    button.textContent = label;
    button.addEventListener("click", () => {
      ui.sort = id;
      render();
    });
    els.sorts.append(button);
  }
}

function renderGrid() {
  const shopee = visibleDeals(snapshot?.shopee?.deals);
  const shopeeLow = visibleLow(snapshot?.shopee?.low);
  const tiktok = visibleDeals(snapshot?.tiktok?.deals);
  const shopeeShelf = visibleShelf(snapshot?.shopee?.shelf);
  const tiktokShelf = visibleShelf(snapshot?.tiktok?.shelf);
  renderColumns("shopee", shopee, shopeeShelf);
  renderColumns("tiktok", tiktok, tiktokShelf);
  const tiktokLive = (snapshot?.tiktok?.scanned || 0) > 0 || tiktok.length > 0 || tiktokShelf.length > 0;
  document.querySelector("#tiktok-board")?.classList.toggle("has-deals", tiktokLive);
  const hits = [...shopee, ...tiktok].filter((deal) => !deal.soldOut);
  const lowCount = shopeeLow.filter((deal) => !deal.soldOut).length;
  const shown = hits.length + lowCount + shopeeShelf.filter((deal) => !deal.soldOut).length + tiktokShelf.filter((deal) => !deal.soldOut).length;
  els.hunt.className = "hunt" + (shown ? " hit" : "");
  if (!snapshot?.ready) {
    els.hunt.textContent = "Đang quét Shopee và TikTok. Cột ≤1.200đ nhận giá từ 1đ đến 1.200đ. Shopee có cột Sắp hết suất. TikTok có cột Giảm sâu từ 50%.";
  } else if (hits.length || lowCount) {
    const parts = [];
    if (hits.length) parts.push(`${hits.length} deal đúng mốc`);
    if (lowCount) parts.push(`${lowCount} món sắp hết suất`);
    els.hunt.textContent = `${parts.join(", ")}. Cột Sâu nhất kéo dọc theo tiền hời. Bấm Mua ngay.`;
  } else if (shown) {
    els.hunt.textContent = "Chưa có deal từ 1.200đ trở xuống, -90% hay sắp hết suất. Cột Sâu nhất kéo dọc theo tiền hời, bấm Mua ngay.";
  } else {
    els.hunt.textContent = "Chưa đọc được deal nào. Vẫn quét liên tục.";
  }
  document.title = shown ? `(${shown}) Săn sale` : "Săn ≤1.200đ, -90% và sắp hết suất";
}

function renderColumns(prefix, deals, shelf) {
  if (prefix === "shopee") {
    paintColumn(prefix, "1d", deals.filter((deal) => tierOf(deal) === "1d"));
    paintColumn(prefix, "90", deals.filter((deal) => tierOf(deal) === "90"));
    paintColumn(prefix, "low", visibleLow(snapshot?.shopee?.low));
    paintColumn(prefix, "near", shelf || []);
    return;
  }
  const tiers = [...TIERS, ["50", "Giảm sâu"]];
  for (const [id] of tiers) {
    paintColumn(prefix, id, deals.filter((deal) => tierOf(deal) === id));
  }
  paintColumn(prefix, "near", shelf || []);
}

function paintColumn(prefix, id, list) {
  const count = document.querySelector(`#${prefix}-${id}-count`);
  const empty = document.querySelector(`#${prefix}-${id}-empty`);
  const grid = document.querySelector(`#${prefix}-${id}`);
  if (count) count.textContent = String(list.length);
  if (empty) empty.textContent = emptyLabel(prefix, list);
  if (grid) fillGrid(grid, list);
}

function emptyLabel(prefix, list) {
  if (!snapshot?.ready || list.length > 0) return "";
  if (prefix === "tiktok" && !(snapshot.tiktok?.scanned > 0)) return "Web gửi 0 món";
  return "Chưa có";
}

function fillGrid(grid, deals) {
  grid.replaceChildren();
  for (const deal of deals) grid.append(card(deal));
}

function card(deal) {
  const el = document.createElement("article");
  el.className = "card" + (deal.soldOut ? " sold" : "") + (deal.oneDong ? " one" : "") + (deal.discount >= 90 ? " deep" : "") + (stockLow(deal) ? " low" : "");
  const photo = document.createElement("div");
  photo.className = "photo";
  if (deal.image) photo.style.backgroundImage = `url("${cssUrl(deal.image)}")`;
  const badges = document.createElement("div");
  badges.className = "badges";
  if (deal.oneDong) badges.append(badge("≤1.2k", "gold"));
  if (deal.discount >= 90) badges.append(badge(`-${deal.discount}%`, "mint"));
  else if (deal.discount > 0) badges.append(badge(`-${deal.discount}%`, "red"));
  if (deal.isNew) badges.append(badge("MỚI", ""));
  if (!deal.soldOut && stockLow(deal)) badges.append(badge("SẮP HẾT", ""));
  if (deal.platform === "tiktok") badges.append(badge("TIKTOK", ""));
  photo.append(badges);

  const body = document.createElement("div");
  body.className = "body";
  const name = document.createElement("h2");
  name.className = "name";
  name.textContent = deal.name;
  const price = document.createElement("div");
  price.className = "price-row";
  const strong = document.createElement("span");
  strong.className = "price";
  strong.textContent = deal.priceText || vnd(deal.priceVnd);
  price.append(strong);
  if (deal.wasText) {
    const was = document.createElement("span");
    was.className = "was";
    was.textContent = deal.wasText;
    price.append(was);
  }
  const save = document.createElement("div");
  save.className = "save";
  save.textContent = deal.saveVnd > 0 ? `Hời ${deal.saveText || vnd(deal.saveVnd)}` : "";
  const meta = document.createElement("div");
  meta.className = "meta";
  const bits = [];
  if (deal.platform === "shopee") bits.push("Shopee VN");
  if (deal.official) bits.push("Mall");
  if (deal.rating) bits.push(`★ ${deal.rating}`);
  if (deal.soldCount) bits.push(`đã bán ${compact(deal.soldCount)}`);
  if (deal.sessionLabel) bits.push(deal.sessionLabel);
  meta.textContent = bits.join(" · ");
  body.append(name, price, save, meta);
  if (deal.stockTotal > 0) {
    const bar = document.createElement("div");
    bar.className = "bar";
    const span = document.createElement("span");
    span.style.width = `${Math.min(100, Math.round((deal.sold / deal.stockTotal) * 100))}%`;
    bar.append(span);
    const left = document.createElement("div");
    left.className = "left";
    left.textContent = deal.soldOut ? "Hết suất flash sale" : `Còn ${deal.stock}/${deal.stockTotal} suất`;
    body.append(bar, left);
  }
  const actions = document.createElement("div");
  actions.className = "actions";
  const buy = document.createElement("a");
  buy.className = "buy";
  buy.href = deal.url;
  buy.target = "_blank";
  buy.rel = "noopener noreferrer";
  buy.textContent = deal.soldOut ? "Hết suất — mở sản phẩm" : "Mua ngay";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "Chép link";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(deal.url);
      copy.textContent = "Đã chép";
    } catch {
      copy.textContent = "Mở link";
    }
  });
  actions.append(buy, copy);
  body.append(actions);
  el.append(photo, body);
  return el;
}

function badge(text, kind) {
  const el = document.createElement("span");
  el.className = "badge" + (kind ? ` ${kind}` : "");
  el.textContent = text;
  return el;
}

function render() {
  renderControls();
  renderStatus();
  renderSessions();
  renderGrid();
}

function apply(data) {
  snapshot = data;
  if (data?.now) skew = data.now - Date.now();
  els.live.classList.toggle("on", Boolean(data?.ready) && !data?.error);
  const when = data?.updatedAt ? new Date(data.updatedAt) : null;
  els.liveText.textContent = data?.ready
    ? `Mới cập nhật ${when.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "Đang quét";
  notice(data?.deals || []);
  render();
}

function notice(deals) {
  const hits = [];
  const pool = [...(deals || []), ...(snapshot?.shopee?.low || [])];
  const seenIds = new Set();
  for (const deal of pool) {
    if (!deal?.id || seenIds.has(deal.id)) continue;
    seenIds.add(deal.id);
    const prev = known.get(deal.id);
    const deepSale = deal.platform === "tiktok" && deal.discount >= 50 && deal.discount < 70;
    const low = stockLow(deal);
    const hot = !deal.soldOut && (deal.oneDong || deal.discount >= 90 || (deal.platform !== "shopee" && deal.discount >= 70) || deepSale || low);
    const wasHot = prev ? prev.oneDong || prev.discount >= 90 || (deal.platform !== "shopee" && prev.discount >= 70) || (deal.platform === "tiktok" && prev.discount >= 50) || prev.low : false;
    if (primed && hot && !wasHot) hits.push(deal);
    known.set(deal.id, { oneDong: deal.oneDong, discount: deal.discount, low });
  }
  primed = true;
  if (!hits.length) return;
  const first = hits[0];
  showToast(hits.length === 1 ? `${first.priceText} · -${first.discount}% ${first.name}` : `${hits.length} deal vừa chạm mốc săn`, first.url);
  if (ui.sound) beep();
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    const note = new Notification("Săn sale", { body: `${first.priceText} -${first.discount}% ${first.name}` });
    note.onclick = () => window.open(first.url, "_blank", "noopener");
  }
}

function showToast(text, url) {
  els.toast.hidden = false;
  els.toast.replaceChildren();
  const line = document.createElement("div");
  line.textContent = text;
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = "Mua ngay";
  els.toast.append(line, link);
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, 8000);
}

function beep() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  audioCtx = audioCtx || new Ctx();
  const now = audioCtx.currentTime;
  [880, 1175].forEach((freq, index) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    const start = now + index * 0.14;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.18);
    osc.start(start);
    osc.stop(start + 0.2);
  });
}

function vnd(value) {
  const v = Math.round(Number(value) || 0);
  return `${String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}đ`;
}

function compact(n) {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}tr`;
  if (n >= 1000) return `${trim(n / 1000)}k`;
  return String(n);
}
function trim(n) {
  return n.toFixed(1).replace(".0", "");
}

function clockLeft(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}g ${String(m).padStart(2, "0")}p`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function cssUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "";
    return parsed.href.replace(/["\\]/g, "");
  } catch {
    return "";
  }
}

function tick() {
  els.clock.textContent = new Date(Date.now() + skew).toLocaleTimeString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (snapshot?.sessions?.length) renderSessions();
}

els.q.addEventListener("input", render);
els.sound.addEventListener("click", async () => {
  ui.sound = !ui.sound;
  els.sound.classList.toggle("on", ui.sound);
  els.sound.textContent = ui.sound ? "Đang bật tiếng" : "Bật tiếng";
  localStorage.setItem("sale-sound", ui.sound ? "1" : "0");
  if (ui.sound) beep();
});
els.notify.addEventListener("click", async () => {
  if (typeof Notification === "undefined") return;
  const perm = await Notification.requestPermission();
  els.notify.classList.toggle("on", perm === "granted");
  els.notify.textContent = perm === "granted" ? "Đã bật báo" : "Báo trình duyệt";
});

render();
tick();
setInterval(tick, 1000);

const phoneScan = document.querySelector("#phone-scan");
const phoneCopy = document.querySelector("#phone-copy");
let phoneBookmark = "#";

async function armBookmark() {
  try {
    const source = await fetch("/phone-scan.js").then((response) => response.text());
    phoneBookmark = `javascript:${encodeURIComponent(`${source}\nstartPhoneScan(${JSON.stringify(location.origin)});`)}`;
    if (phoneScan) phoneScan.href = phoneBookmark;
  } catch {
    phoneBookmark = "#";
  }
}

phoneCopy?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(phoneBookmark);
    phoneCopy.textContent = "Đã chép";
  } catch {
    phoneCopy.textContent = "Giữ nút Săn sale để lưu";
  }
});

async function takePhoneHash() {
  if (!location.hash.startsWith("#tiktok=")) return;
  const token = location.hash.slice("#tiktok=".length);
  history.replaceState(null, "", location.pathname + location.search);
  if (!token) return;
  const current = await fetch("/api/state").then((response) => response.json());
  if (!current.phoneKey) return;
  await fetch("/api/phone-deals", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Sale-Key": current.phoneKey },
    body: token,
  });
}

function connectStream() {
  const source = new EventSource("/api/stream");
  source.addEventListener("snapshot", (event) => {
    apply(JSON.parse(event.data));
  });
  source.onerror = () => {
    els.live.classList.remove("on");
    els.liveText.textContent = "Mất kết nối, đang nối lại";
  };
}

armBookmark();
takePhoneHash().finally(connectStream);

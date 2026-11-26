const filters = [
  ["all", "Tất cả"],
  ["1d", "1đ"],
  ["90", "Từ 90%"],
  ["cheap", "Dưới 50k"],
  ["low", "Sắp hết"],
  ["instock", "Còn hàng"],
];
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
  status: document.querySelector("#status"),
  sessions: document.querySelector("#sessions"),
  filters: document.querySelector("#filters"),
  sorts: document.querySelector("#sorts"),
  hunt: document.querySelector("#hunt"),
  grid: document.querySelector("#grid"),
  empty: document.querySelector("#empty"),
  toast: document.querySelector("#toast"),
  q: document.querySelector("#q"),
  floor: document.querySelector("#floor"),
  sound: document.querySelector("#sound"),
  notify: document.querySelector("#notify"),
};

const ui = {
  filter: "all",
  sort: "discount",
  sound: localStorage.getItem("sale-sound") === "1",
  floor: Number(localStorage.getItem("sale-floor")) || 90,
};
els.floor.value = String(ui.floor);
if (ui.sound) els.sound.classList.add("on");

let snapshot = null;
let skew = 0;
let primed = false;
const known = new Map();
let audioCtx = null;

function matchFilter(deal, filter) {
  if (filter === "1d") return deal.oneDong;
  if (filter === "90") return deal.discount >= 90;
  if (filter === "cheap") return deal.priceVnd > 0 && deal.priceVnd <= 50_000;
  if (filter === "low") return !deal.soldOut && deal.stockTotal > 0 && deal.stock / deal.stockTotal <= 0.3;
  if (filter === "instock") return !deal.soldOut;
  return true;
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

function visibleDeals() {
  const q = els.q.value.trim().toLowerCase();
  const deals = snapshot?.deals || [];
  return sortDeals(deals.filter((deal) => matchFilter(deal, ui.filter) && (!q || deal.name.toLowerCase().includes(q))));
}

function pill(text) {
  const el = document.createElement("span");
  el.className = "pill";
  el.textContent = text;
  return el;
}

function renderStatus() {
  els.status.replaceChildren();
  if (!snapshot?.ready) {
    els.status.append(pill(snapshot?.error || "Đang đọc flash sale Shopee Việt Nam…"));
    return;
  }
  const deals = snapshot.deals || [];
  const one = deals.filter((deal) => deal.oneDong && !deal.soldOut).length;
  const deep = deals.filter((deal) => deal.discount >= 90 && !deal.soldOut).length;
  const best = deals.reduce((max, deal) => Math.max(max, deal.soldOut ? 0 : deal.saveVnd), 0);
  els.status.append(
    pill(snapshot.watched || "Flash sale"),
    hotPill(one ? `${one} deal 1đ` : "Chưa có 1đ"),
    hotPill(deep ? `${deep} deal từ 90%` : "Chưa có mốc 90%"),
    pill(`${deals.length} món trong khung`),
    pill(best ? `Hời nhất ${vnd(best)}` : "Chưa có giá gốc"),
  );
  const tiktok = snapshot.tiktok;
  if (tiktok) {
    const link = document.createElement("a");
    link.className = "pill go";
    link.href = tiktok.openUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = tiktok.ok ? tiktok.message : "Mở TikTok săn 1đ";
    els.status.append(link);
    if (!tiktok.ok && tiktok.message) {
      const note = document.createElement("span");
      note.className = "pill";
      note.textContent = tiktok.message;
      els.status.append(note);
    }
  }
  if (snapshot.error) els.status.append(pill(snapshot.error));
}

function hotPill(text) {
  const el = pill(text);
  if (!text.startsWith("Chưa")) el.classList.add("hot");
  return el;
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
  els.filters.replaceChildren();
  for (const [id, label] of filters) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip" + (ui.filter === id ? " on" : "");
    button.textContent = label;
    button.addEventListener("click", () => {
      ui.filter = id;
      render();
    });
    els.filters.append(button);
  }
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
  const deals = visibleDeals();
  els.grid.replaceChildren();
  const one = (snapshot?.deals || []).filter((deal) => deal.oneDong && !deal.soldOut).length;
  const deep = (snapshot?.deals || []).filter((deal) => deal.discount >= 90 && !deal.soldOut).length;
  els.hunt.className = "hunt" + (one || deep ? " hit" : "");
  if (!snapshot?.ready) {
    els.hunt.textContent = "Đang lấy giá đồng trên Shopee Việt Nam.";
  } else if (one || deep) {
    els.hunt.textContent = "Có mốc săn. Món 1đ và từ 90% đang nằm trên cùng — bấm Mua ngay.";
  } else {
    els.hunt.textContent = "Khung này chưa có 1đ hay -90%. Tool vẫn canh, có là kêu. Bên dưới là deal đang hời nhất, mỗi món một link mua.";
  }
  els.empty.hidden = deals.length > 0;
  els.empty.textContent = snapshot?.ready
    ? "Bộ lọc này chưa có món. Bấm Tất cả để xem deal đang chạy."
    : "";
  for (const deal of deals) els.grid.append(card(deal));
  const hits = one + deep;
  document.title = hits ? `(${hits}) Săn sale · Shopee VN` : "Săn sale · Shopee Việt Nam";
}

function card(deal) {
  const el = document.createElement("article");
  el.className = "card" + (deal.soldOut ? " sold" : "") + (deal.oneDong ? " one" : "") + (deal.discount >= 90 ? " deep" : "");
  const photo = document.createElement("div");
  photo.className = "photo";
  if (deal.image) photo.style.backgroundImage = `url("${cssUrl(deal.image)}")`;
  const badges = document.createElement("div");
  badges.className = "badges";
  if (deal.oneDong) badges.append(badge("1Đ", "gold"));
  if (deal.discount >= 90) badges.append(badge(`-${deal.discount}%`, "mint"));
  else if (deal.discount > 0) badges.append(badge(`-${deal.discount}%`, "red"));
  if (deal.isNew) badges.append(badge("MỚI", ""));
  if (!deal.soldOut && deal.stockTotal > 0 && deal.stock / deal.stockTotal <= 0.3) badges.append(badge("SẮP HẾT", ""));
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
    left.className = "meta";
    left.textContent = deal.soldOut ? "Hết suất flash sale" : `Còn ${deal.stock}/${deal.stockTotal} suất`;
    body.append(bar, left);
  }
  const buy = document.createElement("a");
  buy.className = "buy";
  buy.href = deal.url;
  buy.target = "_blank";
  buy.rel = "noopener noreferrer";
  buy.textContent = deal.soldOut ? "Hết suất — mở sản phẩm" : "Mua ngay";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy";
  copy.textContent = "Chép link mua";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(deal.url);
      copy.textContent = "Đã chép";
    } catch {
      copy.textContent = deal.url;
    }
  });
  body.append(buy, copy);
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
  const floor = Math.min(99, Math.max(50, Number(els.floor.value) || 90));
  const hits = [];
  for (const deal of deals) {
    const prev = known.get(deal.id);
    const hot = !deal.soldOut && (deal.oneDong || deal.discount >= floor);
    const wasHot = prev ? prev.oneDong || prev.discount >= floor : false;
    if (primed && hot && !wasHot) hits.push(deal);
    known.set(deal.id, { oneDong: deal.oneDong, discount: deal.discount });
  }
  if (!primed && deals.length) primed = true;
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
els.floor.addEventListener("change", () => {
  ui.floor = Number(els.floor.value) || 90;
  localStorage.setItem("sale-floor", String(ui.floor));
});
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

const source = new EventSource("/api/stream");
source.addEventListener("snapshot", (event) => {
  apply(JSON.parse(event.data));
});
source.onerror = () => {
  els.live.classList.remove("on");
  els.liveText.textContent = "Mất kết nối, đang nối lại";
};

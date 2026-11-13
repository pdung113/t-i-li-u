const QUOTES = new Set(["KRW", "BTC", "USDT"]);

const DATE_RE =
  /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일(?:\s*(오전|오후))?\s*(\d{1,2})\s*(?:시\s*(?:(\d{1,2})\s*분)?|:(\d{1,2}))/g;

export function stripMarkup(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|tr|h\d|li|div)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function kstToMs(year, month, day, hour, minute) {
  const pad = (n) => String(n).padStart(2, "0");
  return Date.parse(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+09:00`);
}

export function formatKst(ms) {
  if (!Number.isFinite(ms)) return "khi thị trường mở";
  const text = new Date(ms).toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false });
  return `${text} KST`;
}

function kstParts(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function to24(hour, ampm) {
  if (ampm === "오전") return hour === 12 ? 0 : hour;
  if (ampm === "오후") return hour < 12 ? hour + 12 : hour;
  return hour;
}

export function parseKoreanDate(text, listedAtMs) {
  const found = [];
  for (const match of text.matchAll(DATE_RE)) {
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = to24(Number(match[5]), match[4]);
    const minute = Number(match[6] ?? match[7] ?? 0);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) continue;
    let year = match[1] ? Number(match[1]) : kstParts(listedAtMs || Date.now()).year;
    let stamp = kstToMs(year, month, day, hour, minute);
    if (!match[1] && listedAtMs && stamp < listedAtMs - 36 * 60 * 60 * 1000) {
      year += 1;
      stamp = kstToMs(year, month, day, hour, minute);
    }
    if (Number.isFinite(stamp)) found.push(stamp);
  }
  return found.at(-1) ?? null;
}

function parseMarkets(text) {
  const paren = text.match(/\(([^)]*마켓[^)]*)\)/);
  const source = paren?.[1] || text.match(/마켓[^A-Z]{0,30}((?:KRW|BTC|USDT)(?:\s*[,/]\s*(?:KRW|BTC|USDT))*)/i)?.[1] || "";
  return source
    .replace(/마켓/g, " ")
    .split(/[^A-Za-z]+/)
    .map((item) => item.toUpperCase())
    .filter((item) => QUOTES.has(item))
    .filter((item, index, list) => list.indexOf(item) === index);
}

function parseTickers(title) {
  const found = [];
  for (const match of title.matchAll(/\(([A-Z][A-Z0-9]{0,14})\)/g)) {
    if (!QUOTES.has(match[1]) && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

function isNewListingTitle(title) {
  if (/거래\s*지원\s*종료|상장\s*폐지/.test(title)) return false;
  if (/마켓\s*추가/.test(title) && !/신규\s*거래\s*지원|신규\s*상장/.test(title)) return false;
  return /신규\s*거래\s*지원|신규\s*상장/.test(title);
}

function openSection(text) {
  const start = text.search(/거래\s*지원\s*개시/);
  if (start < 0) return "";
  const rest = text.slice(start);
  const end = rest.search(/거래\s*제한|입금\s*유의|투자\s*위험|추가\s*디지털/);
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 700);
}

function restrictionSection(text) {
  const start = text.search(/거래\s*제한/);
  if (start < 0) return text;
  return text.slice(start, start + 900);
}

export function referenceKrw(text) {
  const start = text.search(/전일\s*종가|최근\s*시세/);
  const slice = start >= 0 ? text.slice(start, start + 800) : text;
  const prices = [];
  for (const match of slice.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*KRW/gi)) {
    const price = Number(`${match[1].replace(/,/g, "")}.${match[2] || "0"}`);
    if (price > 0) prices.push(price);
  }
  return prices.at(-1) ?? null;
}

export function parseRestrictions(text) {
  const section = restrictionSection(text);
  const hasBuyBan = /매수\s*제한/.test(section);
  const buyMinutes = section.match(/매수\s*제한[\s\S]{0,80}?(\d+)\s*분/);
  const hasLimitOnly = /지정가\s*주문/.test(section) && /제한|제외/.test(section);
  const limitHours = section.match(/(\d+)\s*시간\s*동안\s*지정가/) || section.match(/약\s*(\d+)\s*시간[\s\S]{0,20}지정가/);
  return {
    buyBanMs: hasBuyBan ? Number(buyMinutes?.[1] || 5) * 60 * 1000 : 0,
    limitOnlyMs: hasLimitOnly ? Number(limitHours?.[1] || 2) * 60 * 60 * 1000 : 0,
    bodySeen: text.trim().length > 0,
  };
}

export function coerceNotice(raw) {
  const id = raw?.uuid || raw?.uid || raw?.id || raw?.notice_id || "";
  return {
    id: id == null ? "" : String(id),
    title: stripMarkup(raw?.title || raw?.tt || ""),
    body: stripMarkup(raw?.body || raw?.bd || raw?.contents || ""),
    category: String(raw?.category || raw?.cat || ""),
    listedAt: Date.parse(raw?.first_listed_at || raw?.listed_at || raw?.flat || raw?.lat || raw?.created_at || "") || null,
    url: raw?.url || (id ? `https://www.upbit.com/service_center/notice?id=${id}&view=share` : ""),
    eventType: raw?.event_type || raw?.et || "CREATED",
  };
}

export function extractNotices(payload) {
  if (Array.isArray(payload)) return payload.map(coerceNotice);
  const data = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const list = data?.notices || data?.announcements || data?.list || data?.items;
  if (Array.isArray(list)) return list.map(coerceNotice);
  if (data?.title || data?.tt) return [coerceNotice(data)];
  return [];
}

export function decideNotice(raw) {
  const notice = raw?.title ? coerceNotice(raw) : coerceNotice(raw || {});
  const category = notice.category.toLowerCase();
  if (category && category !== "trade" && category !== "거래" && !category.includes("trade")) {
    return { action: "skip", reason: "wrong-category", listings: [] };
  }
  if (!isNewListingTitle(notice.title)) {
    return { action: "skip", reason: "not-new-listing", listings: [], title: notice.title };
  }
  const markets = parseMarkets(`${notice.title}\n${notice.body}`);
  const tickers = parseTickers(notice.title);
  if (!markets.includes("KRW")) {
    return { action: "skip", reason: "no-krw", listings: [], title: notice.title, tickers, markets };
  }
  if (!tickers.length) {
    return { action: "skip", reason: "no-ticker", listings: [], title: notice.title, markets };
  }
  const rules = parseRestrictions(notice.body);
  const openAt = parseKoreanDate(openSection(notice.body), notice.listedAt);
  const refPrice = referenceKrw(notice.body);
  const listings = tickers.map((ticker) => ({
    noticeId: notice.id,
    title: notice.title,
    url: notice.url,
    ticker,
    market: `KRW-${ticker}`,
    openAt,
    buyBanMs: rules.bodySeen ? rules.buyBanMs : 5 * 60 * 1000,
    limitOnlyMs: rules.bodySeen ? rules.limitOnlyMs : 2 * 60 * 60 * 1000,
    refPrice,
    listedAt: notice.listedAt,
    assumedRules: !rules.bodySeen,
  }));
  return { action: "buy", listings };
}

export function noticeIdFromUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.searchParams.get("id") || "";
  } catch {
    return String(value).trim();
  }
}

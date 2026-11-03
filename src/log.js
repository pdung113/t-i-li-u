export function timestamp() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    fractionalSecondDigits: 3,
  }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${pick("hour")}:${pick("minute")}:${pick("second")}.${pick("fractionalSecond")}`;
}

export function log(message) {
  console.log(`[${timestamp()} ICT] ${message}`);
}

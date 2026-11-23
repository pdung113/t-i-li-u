import { ethers } from "ethers";

function looseJson(slice) {
  return slice
    .replace(/([{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/!0/g, "true")
    .replace(/!1/g, "false");
}

function sliceObject(text, start) {
  let depth = 0;
  let quote = false;
  let escape = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === quote) quote = false;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function remember(found, seen, fn) {
  if (!fn?.name || !Array.isArray(fn.inputs)) return;
  const key = `${fn.name}:${fn.inputs.map((input) => input.type).join(",")}`;
  if (seen.has(key)) return;
  seen.add(key);
  found.push(fn);
}

export function abiFunctions(text) {
  const source = String(text || "");
  const found = [];
  const seen = new Set();
  for (const match of source.matchAll(/\{type:"function",name:"([A-Za-z0-9_]+)"/g)) {
    const slice = sliceObject(source, match.index);
    if (!slice) continue;
    try {
      remember(found, seen, JSON.parse(looseJson(slice)));
    } catch {
      // đoạn ABI không đọc được
    }
  }
  let scans = 0;
  for (const match of source.matchAll(/name:"([A-Za-z0-9_]+)"/g)) {
    if (scans >= 80) break;
    if (!/mint|purchase|claim|phase|stage|round|fee|supply|start|price/i.test(match[1])) continue;
    scans += 1;
    let start = source.lastIndexOf("{", match.index);
    let steps = 0;
    while (start >= 0 && steps < 12 && match.index - start < 12_000) {
      const slice = sliceObject(source, start);
      if (slice && slice.includes("inputs")) {
        try {
          const fn = JSON.parse(looseJson(slice));
          if (fn?.name === match[1] && Array.isArray(fn.inputs)) {
            remember(found, seen, fn);
            break;
          }
        } catch {
          // chưa phải object của hàm
        }
      }
      start = source.lastIndexOf("{", start - 1);
      steps += 1;
    }
  }
  return found;
}

function humanType(input) {
  if (String(input?.type || "").startsWith("tuple")) {
    const inner = (input.components || []).map((item) => humanType(item)).join(", ");
    return `(${inner})${input.type.slice(5)}`;
  }
  return `${input?.type || "bytes"} ${input?.name || ""}`.trim();
}

function humanFn(fn) {
  const inputs = (fn.inputs || []).map((input) => humanType(input)).join(", ");
  const outputs = (fn.outputs || []).map((input) => humanType(input)).join(", ");
  const mutability = fn.stateMutability === "view" || fn.stateMutability === "pure" ? " view" : fn.stateMutability === "payable" ? " payable" : "";
  return `function ${fn.name}(${inputs})${mutability}${outputs ? ` returns (${outputs})` : ""}`;
}

function isPhaseView(fn) {
  if (fn.stateMutability !== "view" && fn.stateMutability !== "pure") return false;
  if (fn.inputs?.length) return false;
  const output = fn.outputs?.[0];
  if (!output || !String(output.type).startsWith("tuple") || !String(output.type).includes("[")) return false;
  const names = (output.components || []).map((item) => String(item.name || "").toLowerCase());
  return names.some((name) => /start|open|begin/.test(name));
}

function isMintWrite(fn) {
  if (fn.stateMutability === "view" || fn.stateMutability === "pure") return false;
  const inputs = fn.inputs || [];
  if (inputs.some((input) => String(input.type).includes("tuple"))) return false;
  if (!inputs.some((input) => String(input.type).startsWith("uint"))) return false;
  if (/^(mint|publicMint|mintPublic|mintNft|safeMint|publicSaleMint|freeMint|purchase)$/i.test(fn.name)) return true;
  return fn.name === "claim" && inputs.length <= 3 && inputs.every((input) => /^(uint|bytes|address|bool)/.test(String(input.type)));
}

function uintView(fn) {
  if (fn.inputs?.length || fn.outputs?.length !== 1) return false;
  if (fn.stateMutability && fn.stateMutability !== "view" && fn.stateMutability !== "pure") return false;
  return String(fn.outputs[0].type).startsWith("uint");
}

function viewCall(fn) {
  const iface = new ethers.Interface([humanFn(fn)]);
  return { iface, name: fn.name, data: iface.encodeFunctionData(fn.name) };
}

function pathOf(text, word) {
  const match = String(text || "").match(new RegExp(`["'\`](/[A-Za-z0-9_./-]*${word}\\?[^"'\`]*)["'\`]`));
  if (!match) return null;
  return match[1].replace(/\$\{[^}]+\}/g, "");
}

function apiPrefix(text) {
  return /fetch\(\s*[`'"]\/api\$\{/.test(String(text || "")) ? "/api" : "";
}

function withApiPrefix(prefix, path) {
  if (!path) return null;
  if (!prefix || path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`)) return path;
  return `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
}

export function pageMintPlan(text, pageUrl = "") {
  const functions = abiFunctions(text);
  const mint = functions.find(isMintWrite);
  if (!mint) return null;
  const phase = functions.find(isPhaseView);
  const fee = functions.find((fn) => uintView(fn) && /fee/i.test(fn.name));
  const mintLine = humanFn({ ...mint, stateMutability: mint.stateMutability || "payable" });
  const mintIface = new ethers.Interface([mintLine]);
  const signature = `${mint.name}(${mint.inputs.map((input) => input.type).join(",")})`;
  const shared = {
    mintIface,
    mintName: mint.name,
    mintInputs: mint.inputs,
    selector: ethers.id(signature).slice(0, 10),
    checkPath: withApiPrefix(apiPrefix(text), pathOf(text, "checker") || pathOf(text, "check")),
    authPath: (text.match(/["'`](\/[A-Za-z0-9_./-]*mint-auth)["'`]/) || [])[1] || "",
    passPath: withApiPrefix(apiPrefix(text), pathOf(text, "pass")),
    pageUrl: pageUrl || "https://mint.local/",
  };
  if (phase) {
    const phaseIface = new ethers.Interface([humanFn(phase)]);
    const feeIface = fee ? new ethers.Interface([humanFn(fee)]) : null;
    return {
      mode: "phases",
      ...shared,
      phaseIface,
      phaseName: phase.name,
      phaseData: phaseIface.encodeFunctionData(phase.name),
      phaseComponents: phase.outputs[0].components || [],
      feeIface,
      feeName: fee?.name || "",
    };
  }
  const views = functions.filter(uintView);
  const start = views.find((fn) => /start|open|begin/i.test(fn.name) && !/end/i.test(fn.name));
  const price = views.find((fn) => /price|cost/i.test(fn.name) && !/fee/i.test(fn.name));
  const max = views.find((fn) => /maxper|perwallet|maxmint|walletlimit/i.test(fn.name));
  return {
    mode: "simple",
    ...shared,
    start: start ? viewCall(start) : null,
    price: price ? viewCall(price) : null,
    max: max ? viewCall(max) : null,
    fee: fee ? viewCall(fee) : null,
  };
}

export function encodeAbiMint(plan, phaseIndex, quantity, extras = {}) {
  const uints = plan.mintInputs.filter((input) => String(input.type).startsWith("uint"));
  const namedPhase = uints.some((input) => /phase|stage|round/.test(String(input.name || "")));
  let phaseUsed = false;
  let quantityUsed = false;
  const args = plan.mintInputs.map((input) => {
    const name = String(input.name || "").toLowerCase();
    const type = String(input.type || "");
    if (type.startsWith("uint") && /phase|stage|round/.test(name)) {
      phaseUsed = true;
      return BigInt(phaseIndex);
    }
    if (type.startsWith("uint") && !name && !phaseUsed && !namedPhase && uints.length > 1) {
      phaseUsed = true;
      return BigInt(phaseIndex);
    }
    if (type.startsWith("uint") && /quant|qty|amount|count/.test(name)) {
      quantityUsed = true;
      return BigInt(quantity || 1);
    }
    if (type.startsWith("uint") && /allow/.test(name)) return BigInt(extras.allowance || 0);
    if (type.startsWith("uint") && !quantityUsed) {
      quantityUsed = true;
      return BigInt(quantity || 1);
    }
    if (type.startsWith("uint")) return BigInt(extras.allowance || 0);
    if (type === "bool") return false;
    if (type === "address") return extras.wallet || ethers.ZeroAddress;
    if (type.startsWith("bytes")) return extras.signature || (type.includes("[") ? [] : "0x");
    return 0;
  });
  return plan.mintIface.encodeFunctionData(plan.mintName, args);
}

export function mintPlanFromText(text, pageUrl = "") {
  const functions = abiFunctions(text);
  const mint = functions.find((fn) => fn.name === "mint" && fn.inputs?.some((input) => input.type === "bytes"));
  const info = functions.find((fn) => fn.name === "info" && fn.inputs?.length === 0 && fn.outputs?.some((output) => output.name === "start"));
  if (!mint || !info) return null;
  const types = mint.inputs.map((input) => input.type).join(",");
  const signature = `mint(${types})`;
  const mintIface = new ethers.Interface([`function ${signature} payable`]);
  const infoTypes = info.outputs.map((output) => `${output.type} ${output.name || ""}`.trim()).join(", ");
  const infoIface = new ethers.Interface([`function info() view returns (${infoTypes})`]);
  const views = {};
  for (const fn of functions) {
    if (fn.inputs?.length === 1 && fn.inputs[0].type === "address" && fn.outputs?.length === 1) {
      views[fn.name] = new ethers.Interface([`function ${fn.name}(address) view returns (${fn.outputs[0].type})`]);
    }
  }
  return {
    mintIface,
    infoIface,
    infoName: "info",
    infoData: infoIface.encodeFunctionData("info"),
    selector: ethers.id(signature).slice(0, 10),
    outputNames: info.outputs.map((output) => output.name || ""),
    views,
    passPath: withApiPrefix(apiPrefix(text), pathOf(text, "pass")),
    checkPath: withApiPrefix(apiPrefix(text), pathOf(text, "check")),
    pageUrl: pageUrl || "https://mint.local/",
    quantityIndex: Math.max(0, mint.inputs.findIndex((input) => input.type.startsWith("uint"))),
    bytesIndex: mint.inputs.findIndex((input) => input.type === "bytes"),
    inputs: mint.inputs.map((input) => input.type),
  };
}

export function encodePlanMint(plan, quantity, extras = {}) {
  const args = plan.inputs.map((type, index) => {
    if (index === plan.quantityIndex) return BigInt(quantity || 1);
    if (index === plan.bytesIndex) return extras.signature || "0x";
    if (type.startsWith("uint")) return BigInt(extras.allowance || 0);
    if (type === "address") return extras.address || ethers.ZeroAddress;
    if (type === "bool") return false;
    return "0x";
  });
  return plan.mintIface.encodeFunctionData("mint", args);
}

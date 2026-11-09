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
  for (const match of source.matchAll(/name:"([A-Za-z0-9_]+)"/g)) {
    if (!/mint|purchase|phase|stage|round|fee|supply/i.test(match[1])) continue;
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
  if (!output || !String(output.type).startsWith("tuple")) return false;
  const names = (output.components || []).map((item) => String(item.name || "").toLowerCase());
  return names.some((name) => /start/.test(name));
}

function isMintWrite(fn) {
  if (fn.stateMutability === "view" || fn.stateMutability === "pure") return false;
  if (!/^(mint|publicMint|mintPublic|purchase)$/.test(fn.name)) return false;
  return (fn.inputs || []).some((input) => String(input.type).startsWith("uint"));
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
  const phase = functions.find(isPhaseView);
  if (!mint || !phase) return null;
  const fee = functions.find((fn) => !fn.inputs?.length && /fee/i.test(fn.name) && fn.outputs?.length === 1 && String(fn.outputs[0].type).startsWith("uint"));
  const mintLine = humanFn({ ...mint, stateMutability: mint.stateMutability || "payable" });
  const phaseLine = humanFn(phase);
  const mintIface = new ethers.Interface([mintLine]);
  const phaseIface = new ethers.Interface([phaseLine]);
  const feeIface = fee ? new ethers.Interface([humanFn(fee)]) : null;
  const signature = `${mint.name}(${mint.inputs.map((input) => input.type).join(",")})`;
  return {
    mintIface,
    mintName: mint.name,
    mintInputs: mint.inputs,
    phaseIface,
    phaseName: phase.name,
    phaseData: phaseIface.encodeFunctionData(phase.name),
    phaseComponents: phase.outputs[0].components || [],
    feeIface,
    feeName: fee?.name || "",
    selector: ethers.id(signature).slice(0, 10),
    checkPath: withApiPrefix(apiPrefix(text), pathOf(text, "checker") || pathOf(text, "check")),
    authPath: (text.match(/["'`](\/[A-Za-z0-9_./-]*mint-auth)["'`]/) || [])[1] || "",
    pageUrl: pageUrl || "https://mint.local/",
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

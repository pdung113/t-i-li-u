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

export function abiFunctions(text) {
  const source = String(text || "");
  const found = [];
  for (const match of source.matchAll(/\{type:"function",name:"([A-Za-z0-9_]+)"/g)) {
    const slice = sliceObject(source, match.index);
    if (!slice) continue;
    try {
      const fn = JSON.parse(looseJson(slice));
      if (fn?.type === "function" && fn.name && Array.isArray(fn.inputs)) found.push(fn);
    } catch {
      // đoạn ABI không đọc được
    }
  }
  return found;
}

function pathOf(text, word) {
  const match = String(text || "").match(new RegExp(`["'\`](/[A-Za-z0-9_./-]*${word}\\?[^"'\`]*)["'\`]`));
  if (!match) return null;
  return match[1].replace(/\$\{[^}]+\}/g, "");
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
    passPath: pathOf(text, "pass"),
    checkPath: pathOf(text, "check"),
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

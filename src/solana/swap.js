import bs58 from "bs58";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { WSOL_MINT } from "./detect.js";
import * as settings from "./settings.js";

export const JITO_TIP_ACCOUNTS = [
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

export const JITO_ENDPOINTS = [
  "https://mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/transactions",
  "https://slc.mainnet.block-engine.jito.wtf/api/v1/transactions",
];

const JUPITER_BUILD = "https://api.jup.ag/swap/v2/build";

export function pickTipAccount(random = Math.random) {
  const index = Math.min(JITO_TIP_ACCOUNTS.length - 1, Math.floor(random() * JITO_TIP_ACCOUNTS.length));
  return JITO_TIP_ACCOUNTS[index];
}

export function toInstruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: (ix.accounts || []).map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: Boolean(account.isSigner),
      isWritable: Boolean(account.isWritable),
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

export function blockhashFromBuild(build) {
  const raw = build?.blockhashWithMetadata?.blockhash;
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw)) return bs58.encode(Uint8Array.from(raw));
  throw new Error("Jupiter không trả blockhash");
}

export function lookupTablesFromBuild(raw) {
  if (!raw) return [];
  return Object.entries(raw).map(
    ([key, addresses]) =>
      new AddressLookupTableAccount({
        key: new PublicKey(key),
        state: {
          deactivationSlot: BigInt("18446744073709551615"),
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          authority: PublicKey.default,
          addresses: addresses.map((address) => new PublicKey(address)),
        },
      }),
  );
}

export function assembleSwapTransaction({ build, payer, cuLimit, jitoTipLamports, tipAccount }) {
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ...(build.computeBudgetInstructions || []).map(toInstruction),
    ...(build.setupInstructions || []).map(toInstruction),
    toInstruction(build.swapInstruction),
    ...(build.cleanupInstruction ? [toInstruction(build.cleanupInstruction)] : []),
    ...(build.otherInstructions || []).map(toInstruction),
  ];
  if (jitoTipLamports > 0) {
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: new PublicKey(tipAccount),
        lamports: jitoTipLamports,
      }),
    );
  }
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhashFromBuild(build),
    instructions,
  }).compileToV0Message(lookupTablesFromBuild(build.addressesByLookupTableAddress));
  return new VersionedTransaction(message);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 180) || `HTTP ${response.status}` };
  }
}

export async function fetchBuild({ apiKey, taker, mint, lamports, slippageBps, maxBytes }) {
  const params = new URLSearchParams({
    inputMint: WSOL_MINT,
    outputMint: mint,
    amount: lamports.toString(),
    taker,
    slippageBps: String(slippageBps),
    mode: "fast",
    computeUnitPricePercentile: settings.COMPUTE_UNIT_PRICE_PERCENTILE,
  });
  if (maxBytes) params.set("maxBytes", String(maxBytes));
  const headers = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  const response = await fetch(`${JUPITER_BUILD}?${params}`, {
    headers,
    signal: AbortSignal.timeout(4000),
  });
  const body = await readJson(response);
  if (!response.ok || body.error || !body.swapInstruction) {
    const detail = body.error || body.message || `HTTP ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body;
}

export function transactionBytes(tx) {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(4000),
  });
  const payload = await readJson(response);
  return { ok: response.ok && !payload.error, error: payload.error || null };
}

export async function broadcastTransaction(raw, { rpcUrl, useJito, jitoUuid }) {
  const encoded = Buffer.from(raw).toString("base64");
  const jobs = [
    postJson(rpcUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [encoded, { encoding: "base64", skipPreflight: true, maxRetries: 2 }],
    }),
  ];
  if (useJito) {
    const headers = jitoUuid ? { "x-jito-auth": jitoUuid } : {};
    for (const url of JITO_ENDPOINTS) {
      jobs.push(
        postJson(
          url,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "sendTransaction",
            params: [encoded, { encoding: "base64" }],
          },
          headers,
        ),
      );
    }
  }
  const settled = await Promise.allSettled(jobs);
  const accepted = settled.filter((item) => item.status === "fulfilled" && item.value.ok).length;
  return { accepted, total: settled.length };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForLanding(connection, signature, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await connection.getSignatureStatuses([signature]);
    const row = status.value?.[0];
    if (row?.err) return { ok: false, err: row.err };
    if (row?.confirmationStatus) return { ok: true, status: row.confirmationStatus };
    await sleep(400);
  }
  return { ok: false, err: "timeout" };
}

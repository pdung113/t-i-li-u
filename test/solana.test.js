import assert from "node:assert/strict";
import test from "node:test";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { keypairFromEnv, loadSolanaConfig, resolveEndpoints } from "../src/solana/config.js";
import {
  detectBuy,
  formatLamports,
  fromNotification,
  overImpact,
  solToLamports,
} from "../src/solana/detect.js";
import { main } from "../src/solana/index.js";
import { JITO_TIP_ACCOUNTS, assembleSwapTransaction, pickTipAccount } from "../src/solana/swap.js";
import { logsSubscribeRequest, transactionSubscribeRequest } from "../src/solana/watch.js";

function wallet(byte) {
  return Keypair.fromSeed(Buffer.alloc(32, byte)).publicKey.toBase58();
}

function buyTx({ target, mint, preSol, postSol, fee = 5000, preToken = "0", postToken = "1000", err = null, owner = target }) {
  return {
    signature: "sig",
    slot: 10,
    accountKeys: [target],
    meta: {
      err,
      fee,
      preBalances: [preSol],
      postBalances: [postSol],
      preTokenBalances: [
        { owner, mint, uiTokenAmount: { amount: preToken } },
      ],
      postTokenBalances: [
        { owner, mint, uiTokenAmount: { amount: postToken } },
      ],
    },
  };
}

test("đổi SOL sang lamports", () => {
  assert.equal(solToLamports("0.05"), 50_000_000n);
  assert.equal(solToLamports("1"), 1_000_000_000n);
  assert.equal(solToLamports("0.000000001"), 1n);
  assert.equal(formatLamports(50_000_000n), "0.05");
  assert.throws(() => solToLamports("0.1234567891"), /9 chữ số/);
});

test("nhận ra lệnh mua và bỏ qua lệnh không phải mua", () => {
  const target = wallet(1);
  const mint = wallet(2);
  const bought = detectBuy(buyTx({ target, mint, preSol: 1_000_000_000, postSol: 900_000_000 }), target);
  assert.equal(bought.mint, mint);
  assert.equal(bought.solSpent, 99_995_000n);

  const feeOnly = detectBuy(buyTx({ target, mint, preSol: 1_000_000_000, postSol: 999_995_000 }), target);
  assert.equal(feeOnly, null);

  const sell = detectBuy(
    buyTx({ target, mint, preSol: 900_000_000, postSol: 1_000_000_000, preToken: "1000", postToken: "0" }),
    target,
  );
  assert.equal(sell, null);

  const failed = detectBuy(buyTx({ target, mint, preSol: 1_000_000_000, postSol: 900_000_000, err: "fail" }), target);
  assert.equal(failed, null);

  const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const paidWithUsdc = {
    signature: "sig2",
    slot: 11,
    accountKeys: [target],
    meta: {
      err: null,
      fee: 5000,
      preBalances: [10_000_000],
      postBalances: [9_995_000],
      preTokenBalances: [
        { owner: target, mint: usdc, uiTokenAmount: { amount: "5000000" } },
        { owner: target, mint, uiTokenAmount: { amount: "0" } },
      ],
      postTokenBalances: [
        { owner: target, mint: usdc, uiTokenAmount: { amount: "1000000" } },
        { owner: target, mint, uiTokenAmount: { amount: "42" } },
      ],
    },
  };
  assert.equal(detectBuy(paidWithUsdc, target).mint, mint);

  const stableOnly = detectBuy(buyTx({ target, mint: usdc, preSol: 1_000_000_000, postSol: 800_000_000 }), target);
  assert.equal(stableOnly, null);
});

test("đọc notification và ghép subscription", () => {
  const target = wallet(3);
  const mint = wallet(4);
  const tx = fromNotification({
    signature: "abc",
    slot: 9,
    transaction: {
      transaction: {
        message: { accountKeys: [{ pubkey: target, signer: true, writable: true }] },
      },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [2_000_000_000],
        postBalances: [1_500_000_000],
        preTokenBalances: [],
        postTokenBalances: [{ owner: target, mint, uiTokenAmount: { amount: "7" } }],
        loadedAddresses: { writable: [], readonly: [] },
      },
    },
  });
  assert.equal(detectBuy(tx, target).mint, mint);
  assert.equal(detectBuy(tx, target).signature, "abc");

  const request = transactionSubscribeRequest(target);
  assert.equal(request.params[0].accountInclude[0], target);
  assert.equal(request.params[0].tokenAccounts, "balanceChanged");
  assert.equal(request.params[1].commitment, "processed");
  assert.equal(logsSubscribeRequest(target).method, "logsSubscribe");
  assert.equal(overImpact({ priceImpactPct: "0.3" }, 25), true);
  assert.equal(overImpact({ priceImpactPct: "0.0001" }, 25), false);
});

test("dựng lệnh có tip Jito và ký được", () => {
  const payer = Keypair.fromSeed(Buffer.alloc(32, 5));
  const dest = wallet(6);
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(1000n, 4);
  const tx = assembleSwapTransaction({
    build: {
      computeBudgetInstructions: [],
      setupInstructions: [],
      swapInstruction: {
        programId: "11111111111111111111111111111111",
        accounts: [
          { pubkey: payer.publicKey.toBase58(), isSigner: true, isWritable: true },
          { pubkey: dest, isSigner: false, isWritable: true },
        ],
        data: data.toString("base64"),
      },
      cleanupInstruction: null,
      otherInstructions: [],
      blockhashWithMetadata: { blockhash: Array.from(Buffer.alloc(32, 9)) },
      addressesByLookupTableAddress: null,
    },
    payer: payer.publicKey,
    cuLimit: 200_000,
    jitoTipLamports: 1_000_000,
    tipAccount: JITO_TIP_ACCOUNTS[0],
  });
  tx.sign([payer]);
  const raw = tx.serialize();
  assert.ok(raw.length > 0);
  assert.ok(raw.length <= 1232);
  assert.ok(tx.message.staticAccountKeys.some((key) => key.toBase58() === JITO_TIP_ACCOUNTS[0]));
  assert.equal(pickTipAccount(() => 0), JITO_TIP_ACCOUNTS[0]);
});

test("cấu hình ví và từ chối địa chỉ lạ", async () => {
  const previous = process.exitCode;
  await main([]);
  assert.equal(process.exitCode, 1);
  process.exitCode = previous;

  await assert.rejects(() => main(["khong-phai-vi"]), /không phải địa chỉ Solana/);

  const owner = Keypair.fromSeed(Buffer.alloc(32, 8));
  assert.throws(
    () => loadSolanaConfig(owner.publicKey.toBase58(), { SOLANA_PRIVATE_KEY: bs58.encode(owner.secretKey), DRY_RUN: "true" }),
    /trùng/,
  );
  const loaded = keypairFromEnv(JSON.stringify(Array.from(owner.secretKey)));
  assert.equal(loaded.publicKey.toBase58(), owner.publicKey.toBase58());

  const endpoints = resolveEndpoints({ HELIUS_API_KEY: "test-key" });
  assert.equal(endpoints.rpc, "https://mainnet.helius-rpc.com/?api-key=test-key");
  assert.equal(endpoints.ws, "wss://mainnet.helius-rpc.com/?api-key=test-key");
});

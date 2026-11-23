import { ethers } from "ethers";

export function createSleeper() {
  const waiters = new Set();
  return {
    pulse() {
      for (const wake of [...waiters]) wake();
    },
    wait(ms) {
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(finish, ms);
        function finish() {
          clearTimeout(timer);
          waiters.delete(finish);
          resolve();
        }
        waiters.add(finish);
      });
    },
    close() {},
  };
}

function socketUrl(config) {
  const rpc = config.rpc || "";
  if (/^wss?:\/\//i.test(rpc)) return rpc;
  return config.chain.wss || "";
}

export function openBlockSleeper(config) {
  const sleeper = createSleeper();
  let socket = null;
  let started = false;

  function ensure() {
    if (started) return;
    started = true;
    const url = socketUrl(config);
    if (!url) return;
    try {
      socket = new ethers.WebSocketProvider(url, config.chain.chainId, { staticNetwork: true });
      socket.websocket?.on?.("error", () => {});
      socket.on("block", () => sleeper.pulse());
      socket.on("error", () => {});
    } catch {
      socket = null;
    }
  }

  return {
    wait(ms) {
      ensure();
      return sleeper.wait(ms);
    },
    async close() {
      const current = socket;
      socket = null;
      if (!current) return;
      try {
        current.websocket?.on?.("error", () => {});
      } catch {
        // Socket đã đóng.
      }
      await Promise.race([
        current.destroy().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    },
  };
}

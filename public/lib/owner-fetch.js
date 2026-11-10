// Only idempotent reads may be replayed; financial commands must keep their
// original outcome. Pace reads below the private gateway's request allowance.
export function createOwnerTransport({ fetchImpl = globalThis.fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now } = {}) {
  let nextReadAt = 0;
  return async (input, init = {}) => {
    const target = new URL(input instanceof Request ? input.url : input);
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    const read = ["GET", "HEAD"].includes(method) || method === "POST" && /\/rest\/v1\/rpc\/(asset_history_updates|asset_mark_reference_snapshot|mark_reference_health|paper_fee_volume)$/.test(target.pathname);
    for (let attempt = 0; ; attempt++) {
      if (read) {
        const scheduled = Math.max(now(), nextReadAt); nextReadAt = scheduled + 125;
        if (scheduled > now()) await wait(scheduled - now());
      }
      let response;
      try {
        response = await fetchImpl(input, { ...init, signal: init.signal ?? AbortSignal.timeout(25000) });
      } catch (error) {
        if (!read || attempt >= 3 || init.signal?.aborted) throw error;
        await wait(500 * 2 ** attempt); continue;
      }
      if (!read || attempt >= 3 || ![429, 502, 503, 504].includes(response.status)) return response;
      await response.body?.cancel();
      await wait(500 * 2 ** attempt);
    }
  };
}

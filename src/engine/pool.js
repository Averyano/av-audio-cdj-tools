// Runs `worker(item, index)` over `items` with at most `limit` in flight.
// Workers must handle their own errors; an aborted signal stops new starts.
export async function runPool(items, limit, worker, signal) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}

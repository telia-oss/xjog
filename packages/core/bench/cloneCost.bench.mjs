import { performance } from 'node:perf_hooks';

// Synthesize a context roughly the size of a heavy checkout chart:
// large journal array + nested payloads in xstate context.
function bigContext() {
  return {
    cart: { itemIds: Array.from({ length: 50 }, (_, i) => `item-${i}`) },
    subscriptionCccData: {
      variants: Array.from({ length: 200 }, (_, i) => ({
        id: i,
        nak: `NAK${i}`,
        rules: { a: i, b: `${i}`, c: [i, i + 1, i + 2] },
      })),
    },
    journal: Array.from({ length: 2000 }, (_, i) => ({
      ts: i,
      event: `EVENT_${i % 20}`,
      payload: { k: i, v: `value-${i}`, meta: { x: i, y: `${i}` } },
    })),
  };
}

function timed(label, fn, iters = 200) {
  fn(); // warm up
  const start = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - start) / iters;
  console.log(`${label}: ${ms.toFixed(3)} ms/op`);
  return ms;
}

const ctx = bigContext();
console.log(`context JSON size: ${(JSON.stringify(ctx).length / 1024).toFixed(1)} KiB\n`);

// OLD per-transition hot path: old state cloned twice + new cloned once
// (≈3 full JSON round-trips of the context) + the persist stringify.
const oldMs = timed('OLD  ~3x JSON.parse(JSON.stringify) + 1 stringify', () => {
  JSON.parse(JSON.stringify(ctx)); // 745 snapshot (old)
  JSON.parse(JSON.stringify(ctx)); // mapState(previousState) re-clone of old
  JSON.parse(JSON.stringify(ctx)); // mapState(nextState) clone of new
  JSON.stringify(ctx); // persist write (irreducible)
});

// NEW per-transition hot path: old snapshot (structuredClone) + new
// (structuredClone), old NOT re-cloned in resolver, + the persist stringify.
const newMs = timed('NEW  2x structuredClone + 1 stringify (persist)', () => {
  structuredClone(ctx); // 745 snapshot (old)
  structuredClone(ctx); // mapState(nextState) clone of new
  JSON.stringify(ctx); // persist write (irreducible)
});

console.log(`\nspeedup: ${(oldMs / newMs).toFixed(2)}x  (old ${oldMs.toFixed(2)} ms/op -> new ${newMs.toFixed(2)} ms/op)`);

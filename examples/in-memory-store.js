import { IdempotencyManager, InMemoryIdempotencyStore } from "../dist/index.js";

const store = new InMemoryIdempotencyStore();
const manager = new IdempotencyManager(store, {
  keyPrefix: "checkout",
  defaultTtlSeconds: 300,
  storeCanonicalPayload: true,
});

const payload = {
  orderId: "order-123",
  customerId: "cust-42",
  items: [
    { sku: "A-1", quantity: 1 },
    { sku: "B-9", quantity: 2 },
  ],
};

const main = async () => {
  const first = await manager.register(payload, {
    metadata: { workflow: "checkout", triggeredBy: "example" },
  });

  console.log("First registration stored:", first.stored); // true
  console.log("Record metadata:", first.record.metadata);

  const second = await manager.register(payload);
  console.log("Second registration stored:", second.stored); // false

  const lookup = await manager.lookupByPayload(payload);
  console.log("Lookup found id:", lookup?.id);

  await manager.updateTtl(first.id, 600);
  console.log("TTL updated to 10 minutes for id:", first.id);

  const cleared = await manager.clear(first.id);
  console.log("Record cleared:", cleared);
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

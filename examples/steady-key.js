import { canonicalize, steadyKey } from "../dist/index.js";

const payloadA = {
  orderId: "order-123",
  total: 42.5,
  items: [
    { sku: "A-1", quantity: 1 },
    { sku: "B-9", quantity: 2 },
  ],
};

const payloadB = {
  items: [
    { quantity: 1, sku: "A-1" },
    { quantity: 2, sku: "B-9" },
  ],
  total: 42.5,
  orderId: "order-123",
};

const keyA = steadyKey(payloadA);
const keyB = steadyKey(payloadB);

console.log("Key A:", keyA);
console.log("Key B (same logical payload, different order):", keyB);
console.log("Keys match:", keyA === keyB);

console.log("Canonical payload string:");
console.log(canonicalize(payloadA));

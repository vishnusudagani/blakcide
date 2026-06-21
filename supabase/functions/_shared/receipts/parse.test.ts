// Node-runnable test for the receipt pipeline (run: node parse.test.ts).
// Proves classify -> parse -> deriveFacts on realistic fixtures, foundation-free.

import { classify, parseEmails } from "./parse.ts";
import { deriveFacts } from "./facts.ts";
import type { ParsedEmail } from "./types.ts";

let failures = 0;
function assert(cond: unknown, msg: string) {
  if (cond) { console.log("  ok  -", msg); }
  else { console.error("  FAIL-", msg); failures++; }
}

const fixtures: ParsedEmail[] = [
  { id: "1", from: "Swiggy <noreply@swiggy.in>", subject: "Your order from Mehfil Restaurant is on the way!", date: "2026-06-10T13:00:00Z", text: "Order summary\n1 x Hyderabadi Chicken Biryani\n1 x Coke\nItem total ₹320\nDelivery ₹40\nGrand Total: ₹385" },
  { id: "2", from: "Swiggy <noreply@swiggy.in>", subject: "Your order from Mehfil Restaurant is on the way!", date: "2026-06-14T20:30:00Z", text: "1 x Mutton Biryani\nTotal Paid ₹410" },
  { id: "3", from: "Zomato <order@zomato.com>", subject: "Order from Paradise Biryani delivered", date: "2026-06-16T21:00:00Z", text: "2 x Chicken Biryani\nGrand Total: ₹512" },
  { id: "4", from: "Uber Receipts <uber.india@uber.com>", subject: "Your Tuesday evening trip with Uber", date: "2026-06-15T18:00:00Z", text: "Thanks for riding\nDropoff: Hi-Tech City\nTotal ₹247" },
  { id: "5", from: "Uber Receipts <uber.india@uber.com>", subject: "Your trip with Uber", date: "2026-06-17T09:00:00Z", text: "Dropoff: Hi-Tech City\nTotal ₹263" },
  { id: "6", from: "Uber Receipts <uber.india@uber.com>", subject: "Your trip with Uber", date: "2026-06-18T09:00:00Z", text: "Dropoff: Gachibowli\nTotal ₹190" },
  { id: "7", from: "Blinkit <noreply@blinkit.com>", subject: "Order delivered", date: "2026-06-12T11:00:00Z", text: "2 x Amul Milk\n1 x Bread\nBill total ₹240" },
  { id: "8", from: "Swiggy Offers <promos@swiggy.in>", subject: "50% off this weekend!", date: "2026-06-11T10:00:00Z", text: "Use code WEEKEND. Offers up to ₹150 off." },
];

console.log("Classification:");
assert(classify(fixtures[0])?.id === "swiggy", "swiggy classified");
assert(classify(fixtures[2])?.id === "zomato", "zomato classified");
assert(classify(fixtures[3])?.id === "uber", "uber classified");
assert(classify(fixtures[6])?.id === "blinkit", "blinkit classified");

const orders = parseEmails(fixtures);
console.log("\nParsed orders:");
for (const o of orders) {
  console.log(`  ${o.provider.padEnd(9)} ${o.category.padEnd(14)} ${(o.merchant || "—").padEnd(22)} ₹${o.amountInr ?? "?"}  ${o.destination || ""}  [${o.items.join(", ")}]`);
}

console.log("\nAssertions:");
assert(orders.length === 7, "7 real orders (promo dropped)");
assert(orders[0].merchant?.includes("Mehfil"), "merchant parsed = Mehfil");
assert(orders[0].amountInr === 385, "grand total ₹385 preferred over item total ₹320");
assert(orders[3].destination === "Hi-Tech City", "uber dropoff = Hi-Tech City");
assert(!orders.some((o) => o.provider === "swiggy" && o.amountInr === 150), "promo not parsed as an order");

const facts = deriveFacts(orders);
console.log("\nDerived facts:");
for (const f of facts) console.log(`  [${f.area}] ${f.value}  (conf ${f.confidence.toFixed(2)}) — ${f.evidence}`);

console.log("\nAssertions:");
assert(facts.some((f) => /Mehfil/.test(f.value)), "fact: Mehfil is a favourite");
assert(facts.some((f) => /Biryani/i.test(f.value)), "fact: biryani is a frequent dish");
assert(facts.some((f) => /Hi-Tech City/.test(f.value)), "fact: Hi-Tech City frequent destination");
assert(facts.some((f) => /per food order/.test(f.value)), "fact: food spend habit");

console.log(failures ? `\n${failures} FAILED` : "\nAll passed ✓");
if (failures) process.exitCode = 1;

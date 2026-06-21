// Derive a handful of high-signal facts from a batch of orders. These map
// straight onto symp_knowledge_facts rows (the index endpoint adds user_id and
// upserts on (user_id, area, key), so re-runs are idempotent).

import type { Order, DerivedFact } from "./types.ts";

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function countBy(xs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) || 0) + 1);
  return m;
}
function top(m: Map<string, number>, n: number): [string, number][] {
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// Map an item line to a single best dish/ingredient keyword (specific first).
const KEYWORDS = [
  "biryani", "pizza", "burger", "dosa", "idli", "noodles", "momos", "thali",
  "paneer", "tikka", "shawarma", "sushi", "pasta", "sandwich", "roll", "samosa",
  "chicken", "mutton", "coffee", "tea", "cake", "ice cream", "milk", "eggs",
  "bread", "curd", "banana", "chips", "chocolate", "water",
];
function dishKeyword(item: string): string | null {
  const s = item.toLowerCase();
  for (const k of KEYWORDS) if (s.includes(k)) return k;
  return null;
}
function dishKeywords(items: string[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const k = dishKeyword(it);
    if (k) out.push(k);
  }
  return out;
}

export function deriveFacts(orders: Order[]): DerivedFact[] {
  const facts: DerivedFact[] = [];
  const food = orders.filter((o) => o.category === "food");
  const cabs = orders.filter((o) => o.category === "cabs");
  const qc = orders.filter((o) => o.category === "quick_commerce");

  // Favourite food places
  const merchants = countBy(food.map((o) => o.merchant).filter((m): m is string => !!m));
  for (const [merchant, n] of top(merchants, 3)) {
    if (n < 2) continue;
    facts.push({
      area: "tastes", key: "food_fav_" + slug(merchant),
      label: "Favourite place to order from",
      value: `${merchant} — ordered ${n} times`,
      evidence: "from your food delivery receipts",
      confidence: clamp(0.55 + 0.1 * n, 0, 0.9),
    });
  }

  // Favourite dishes / cuisines
  const dishes = countBy(dishKeywords(food.flatMap((o) => o.items)));
  for (const [dish, n] of top(dishes, 2)) {
    if (n < 2) continue;
    facts.push({
      area: "tastes", key: "food_dish_" + slug(dish),
      label: "Often orders",
      value: `${cap(dish)} (seen ${n}×)`,
      evidence: "from your food orders",
      confidence: clamp(0.5 + 0.1 * n, 0, 0.85),
    });
  }

  // Food spend habit
  if (food.length >= 3) {
    const amts = food.map((o) => o.amountInr).filter((x): x is number => typeof x === "number");
    if (amts.length) {
      facts.push({
        area: "world", key: "food_spend",
        label: "Food ordering",
        value: `Usually spends about ₹${Math.round(avg(amts))} per food order (${food.length} recent orders)`,
        evidence: "from your food delivery receipts",
        confidence: 0.7,
      });
    }
  }

  // Frequent ride destinations
  const dests = countBy(cabs.map((o) => o.destination).filter((d): d is string => !!d));
  for (const [dest, n] of top(dests, 3)) {
    if (n < 2) continue;
    facts.push({
      area: "world", key: "cab_dest_" + slug(dest),
      label: "Frequent destination",
      value: `Often travels to ${dest} (${n} rides)`,
      evidence: "from your ride receipts",
      confidence: clamp(0.55 + 0.1 * n, 0, 0.9),
    });
  }

  // Ride spend habit
  if (cabs.length >= 3) {
    const amts = cabs.map((o) => o.amountInr).filter((x): x is number => typeof x === "number");
    if (amts.length) {
      facts.push({
        area: "world", key: "cab_spend",
        label: "Rides",
        value: `Typical ride costs about ₹${Math.round(avg(amts))} (${cabs.length} recent rides)`,
        evidence: "from your ride receipts",
        confidence: 0.7,
      });
    }
  }

  // Quick-commerce reorders
  const qcItems = countBy(dishKeywords(qc.flatMap((o) => o.items)));
  for (const [item, n] of top(qcItems, 3)) {
    if (n < 2) continue;
    facts.push({
      area: "tastes", key: "qc_item_" + slug(item),
      label: "Frequently buys",
      value: `${cap(item)} (seen ${n}×)`,
      evidence: "from your quick-commerce receipts",
      confidence: clamp(0.5 + 0.1 * n, 0, 0.85),
    });
  }

  return facts;
}

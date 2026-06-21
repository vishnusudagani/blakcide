// Turn a decoded receipt email into a normalised Order (or null if it isn't a
// genuine order/ride receipt we recognise). Promos on a real sender domain are
// filtered out so they don't pollute spend/frequency facts.

import type { ParsedEmail, Order } from "./types.ts";
import { PROVIDERS, type Provider } from "./providers.ts";

const PROMO =
  /\b(\d{1,3}%\s*off|use\s+code|coupon|flat\s+(?:rs\.?|₹)?\s*\d+\s+off|\bsale\b|offer\s+ends|cashback|earn\s+\d+)\b/i;
const LABELED_TOTAL =
  /(?:grand\s*total|total\s*paid|amount\s*paid|bill\s*total|order\s*total|total|payable)\s*[:\-]?\s*(?:Rs\.?|INR|₹)/i;

export function classify(email: ParsedEmail): Provider | null {
  for (const p of PROVIDERS) {
    if (!p.senders.test(email.from)) continue;
    if (p.subjectHint && !p.subjectHint.test(email.subject)) continue;
    return p;
  }
  return null;
}

function isReceipt(email: ParsedEmail, order: Order): boolean {
  // A promo on a real sender (no actual total) is not an order.
  if (PROMO.test(email.subject) && !LABELED_TOTAL.test(email.text)) return false;
  return order.items.length > 0 || LABELED_TOTAL.test(email.text) || order.destination != null;
}

export function parseEmail(email: ParsedEmail): Order | null {
  const p = classify(email);
  if (!p) return null;
  const order: Order = {
    provider: p.id, category: p.category, merchant: null, items: [],
    amountInr: null, destination: null, date: email.date, messageId: email.id,
    ...p.extract(email),
  };
  return isReceipt(email, order) ? order : null;
}

export function parseEmails(emails: ParsedEmail[]): Order[] {
  const out: Order[] = [];
  for (const e of emails) {
    const o = parseEmail(e);
    if (o) out.push(o);
  }
  return out;
}

// Provider registry — how Blak recognises a receipt and pulls structured fields
// out of it. Classification is by sender domain (stable); field extraction is
// heuristic and format-tolerant, and is the part to TUNE against real emails
// once Gmail OAuth is connected (formats drift; sender domains rarely do).

import type { ParsedEmail, Order, Category } from "./types.ts";

export interface Provider {
  id: string;
  category: Category;
  senders: RegExp; // tested against the raw From header
  subjectHint?: RegExp; // optional disambiguator (e.g. Instamart on the Swiggy domain)
  extract: (e: ParsedEmail) => Partial<Order>;
}

function toNum(s: string): number | null {
  const n = parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Pull the most likely "amount paid" out of a receipt body. Strong labels
 * (grand total / total paid / …) win; else the LAST weak "total ₹…"; else the
 * first ₹ amount. This stops "item total" winning over "grand total". */
export function parseAmount(text: string): number | null {
  const strong = text.match(
    /(?:grand\s*total|total\s*paid|amount\s*paid|bill\s*total|order\s*total|amount\s*payable|net\s*payable)\s*[:\-]?\s*(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
  );
  if (strong) return toNum(strong[1]);
  const weak = [...text.matchAll(
    /(?:total|paid|payable)\s*[:\-]?\s*(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi,
  )];
  if (weak.length) return toNum(weak[weak.length - 1][1]);
  const any = text.match(/(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  return any ? toNum(any[1]) : null;
}

/** Best-effort "N x Item" line extraction. */
export function extractItems(text: string): string[] {
  const items: string[] = [];
  const re = /(\d+)\s*[x×]\s*([A-Za-z][A-Za-z0-9 '&().\-]{2,40})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && items.length < 12) {
    items.push(m[2].trim().replace(/\s+/g, " "));
  }
  return items;
}

/** Pull a restaurant/store name out of a food-delivery subject line. */
export function merchantFromSubject(subject: string): string | null {
  const stop = /(?:\s+(?:is|has|was|on|will|delivered|arriving|order)\b|[.!|–-]|$)/i;
  const m = subject.match(new RegExp(`(?:order|delivery)\\s+from\\s+(.+?)${stop.source}`, "i")) ||
    subject.match(new RegExp(`\\bfrom\\s+(.+?)${stop.source}`, "i"));
  return m ? m[1].trim() : null;
}

/** Best-effort drop location for a ride receipt. */
export function destFromText(text: string): string | null {
  const m = text.match(
    /(?:drop(?:\s*off)?|destination|dropoff\s*location)\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 ,.\-]{2,40})/i,
  );
  return m ? m[1].trim().replace(/[,.\s]+$/, "") : null;
}

// Order matters: Instamart shares the Swiggy domain, so it must match first.
export const PROVIDERS: Provider[] = [
  {
    id: "instamart",
    category: "quick_commerce",
    senders: /@([\w.-]*\.)?swiggy\.(in|com)/i,
    subjectHint: /instamart/i,
    extract: (e) => ({ merchant: "Swiggy Instamart", items: extractItems(e.text), amountInr: parseAmount(e.text) }),
  },
  {
    id: "swiggy",
    category: "food",
    senders: /@([\w.-]*\.)?swiggy\.(in|com)/i,
    extract: (e) => ({ merchant: merchantFromSubject(e.subject), items: extractItems(e.text), amountInr: parseAmount(e.text) }),
  },
  {
    id: "zomato",
    category: "food",
    senders: /@([\w.-]*\.)?zomato\.com/i,
    extract: (e) => ({ merchant: merchantFromSubject(e.subject), items: extractItems(e.text), amountInr: parseAmount(e.text) }),
  },
  {
    id: "blinkit",
    category: "quick_commerce",
    senders: /@([\w.-]*\.)?(blinkit\.com|grofers\.com)/i,
    extract: (e) => ({ merchant: "Blinkit", items: extractItems(e.text), amountInr: parseAmount(e.text) }),
  },
  {
    id: "zepto",
    category: "quick_commerce",
    senders: /@([\w.-]*\.)?zepto(now)?\.com/i,
    extract: (e) => ({ merchant: "Zepto", items: extractItems(e.text), amountInr: parseAmount(e.text) }),
  },
  {
    id: "uber",
    category: "cabs",
    senders: /@([\w.-]*\.)?uber\.com/i,
    extract: (e) => ({ merchant: "Uber", amountInr: parseAmount(e.text), destination: destFromText(e.text) }),
  },
  {
    id: "ola",
    category: "cabs",
    senders: /@([\w.-]*\.)?olacabs\.com/i,
    extract: (e) => ({ merchant: "Ola", amountInr: parseAmount(e.text), destination: destFromText(e.text) }),
  },
  {
    id: "rapido",
    category: "cabs",
    senders: /@([\w.-]*\.)?rapido\.bike/i,
    extract: (e) => ({ merchant: "Rapido", amountInr: parseAmount(e.text), destination: destFromText(e.text) }),
  },
];

// Shared types for the receipt-learning pipeline (Gmail -> orders -> facts).

export type Category = "food" | "quick_commerce" | "cabs";

/** A receipt email after Gmail decoding, before parsing. */
export interface ParsedEmail {
  id: string; // gmail message id (for dedupe)
  from: string; // raw From header, e.g. "Swiggy <noreply@swiggy.in>"
  subject: string;
  date: string; // ISO timestamp
  text: string; // decoded plain-text body
}

/** A normalised order/ride extracted from one receipt. */
export interface Order {
  provider: string; // 'swiggy' | 'zomato' | ...
  category: Category;
  merchant: string | null; // restaurant / store
  items: string[]; // best-effort item names
  amountInr: number | null; // total paid
  destination: string | null; // cabs only
  date: string; // ISO
  messageId: string;
}

/** A fact derived from a set of orders, ready to upsert into symp_knowledge_facts. */
export interface DerivedFact {
  area: string; // 'tastes' | 'world' | 'other'
  key: string; // stable slug within the area
  label: string;
  value: string;
  evidence: string;
  confidence: number; // 0..1
}

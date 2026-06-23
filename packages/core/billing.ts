// packages/core/billing.ts
// Portable, framework-agnostic billing abstraction — the seed of `packages/core`.
// One interface, three platform implementations. Digital goods (Minit credits,
// subscriptions) MUST use Apple IAP on iOS and Play Billing on Android per store
// rules; the web uses Razorpay/Stripe (and may price differently). Server-side
// receipt verification is mandatory — never trust a client-confirmed purchase.
//
// Status: SEED. Interfaces + platform routing are real; the three purchase paths
// are stubs (the real IAP/Play/gateway wiring needs the dev accounts + a plugin).

export type BillingPlatform = 'web' | 'ios' | 'android';

export interface Product {
  id: string;            // e.g. com.blaksyd.credits.standard
  title: string;
  description: string;
  price: string;         // localized display price, e.g. "₹199"
  priceMicros?: number;
  currency?: string;
}

export interface PurchaseResult {
  ok: boolean;
  productId: string;
  platform: BillingPlatform;
  transactionId?: string;
  receipt?: string;      // opaque token, verified server-side
  error?: string;
}

export interface BillingAdapter {
  readonly platform: BillingPlatform;
  getProducts(ids: string[]): Promise<Product[]>;
  purchase(productId: string): Promise<PurchaseResult>;
  restore(): Promise<PurchaseResult[]>;
  /** POST the receipt to the server, which verifies with Apple/Google/Razorpay and
   *  credits the account. Returns true ONLY on a server-verified grant. */
  verifyAndGrant(receipt: string, platform: BillingPlatform): Promise<boolean>;
}

// Register identical product IDs in App Store Connect + Play Console.
export const PRODUCTS = {
  creditsStarter:  'com.blaksyd.credits.starter',
  creditsStandard: 'com.blaksyd.credits.standard',
  creditsPremium:  'com.blaksyd.credits.premium',
  proMonthly:      'com.blaksyd.pro.monthly',
} as const;

const RECEIPT_VERIFY_URL = '/api/billing/verify'; // server endpoint to build

async function verifyAndGrant(receipt: string, platform: BillingPlatform): Promise<boolean> {
  try {
    const res = await fetch(RECEIPT_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt, platform }),
    });
    const data = await res.json().catch(() => ({} as any));
    return !!(res.ok && data && data.granted);
  } catch {
    return false;
  }
}

// ── Web: Razorpay/Stripe ──────────────────────────────────────────────────────
class WebBilling implements BillingAdapter {
  readonly platform = 'web' as const;
  async getProducts(): Promise<Product[]> { return []; /* TODO: server catalog */ }
  async purchase(productId: string): Promise<PurchaseResult> {
    return { ok: false, productId, platform: 'web', error: 'web-billing-not-wired (Razorpay/Stripe)' };
  }
  async restore(): Promise<PurchaseResult[]> { return []; }
  verifyAndGrant = verifyAndGrant;
}

// ── iOS: Apple In-App Purchase (StoreKit via a Capacitor IAP plugin) ──────────
class AppleBilling implements BillingAdapter {
  readonly platform = 'ios' as const;
  async getProducts(): Promise<Product[]> { return []; /* TODO: StoreKit products */ }
  async purchase(productId: string): Promise<PurchaseResult> {
    return { ok: false, productId, platform: 'ios', error: 'apple-iap-not-wired (needs Apple acct + plugin)' };
  }
  async restore(): Promise<PurchaseResult[]> { return []; }
  verifyAndGrant = verifyAndGrant;
}

// ── Android: Google Play Billing ──────────────────────────────────────────────
class GoogleBilling implements BillingAdapter {
  readonly platform = 'android' as const;
  async getProducts(): Promise<Product[]> { return []; }
  async purchase(productId: string): Promise<PurchaseResult> {
    return { ok: false, productId, platform: 'android', error: 'play-billing-not-wired (needs Play acct + plugin)' };
  }
  async restore(): Promise<PurchaseResult[]> { return []; }
  verifyAndGrant = verifyAndGrant;
}

export function detectPlatform(): BillingPlatform {
  const cap = (typeof window !== 'undefined') ? (window as any).Capacitor : null;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) {
    return cap.getPlatform() === 'ios' ? 'ios' : 'android';
  }
  return 'web';
}

export function getBilling(): BillingAdapter {
  switch (detectPlatform()) {
    case 'ios': return new AppleBilling();
    case 'android': return new GoogleBilling();
    default: return new WebBilling();
  }
}

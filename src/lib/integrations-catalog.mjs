// Catalog of app integrations for the Blaksyd beta — the apps Blak can learn
// from and (via ONDC) act through. This is presentation/config only; a user's
// live connection STATE lives in the symp_integrations table.
//
// The honest capability model (India reality — most of these apps have NO public
// consumer API, so "Blak orders directly" rides on ONDC, not their private apps):
//   learn    — Blak rebuilds your history from receipts (Gmail now, SMS later).
//              Works for EVERY app, independent of any official API.
//   headless — Blak completes the order/booking itself. Real only via ONDC
//              ('via_ondc', cabs first). The big food/grocery brands are false here.
//   deeplink — Blak prepares it and opens the app for you to confirm.
//
// Priority order (per the product brief): food delivery → quick commerce → cabs.
// More categories (calendar, music, messages…) slot in later with the same shape.

// Small inline icons (stroke style matches the rest of the beta UI).
const ICON = {
  food:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 14.3h17"/><path d="M5 14.3a7 7 0 0 1 14 0"/><path d="M12 7.4V5.6"/><path d="M6.6 17.8h10.8"/></svg>',
  quick_commerce:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 8h10.8l-1 11.4H7.6L6.6 8Z"/><path d="M9.2 8.4a2.8 2.8 0 0 1 5.6 0"/></svg>',
  cabs:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16.6l1.3-5A2 2 0 0 1 7.2 10h9.6a2 2 0 0 1 1.9 1.6l1.3 5"/><path d="M3.4 16.6h17.2v2.3h-2.9v-2.3m-11.4 0v2.3H3.4v-2.3"/><circle cx="7.6" cy="16.6" r="1.1"/><circle cx="16.4" cy="16.6" r="1.1"/></svg>',
  mail:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="M4.6 7.7l7.4 5.4 7.4-5.4"/></svg>',
};

// Categories in priority order. `action` is the category-level, Blak-native
// headless capability (the cleanest model: Blak books/orders for you via ONDC,
// while the brand cards below handle learning + open-to-confirm).
export const CATEGORIES = [
  {
    id: 'food',
    label: 'Food delivery',
    icon: ICON.food,
    accent: 'coral',
    action: {
      state: 'soon',
      label: 'Blak orders food for you',
      note: 'Headless ordering arrives with ONDC restaurants — next phase. For now Blak learns your taste and opens the app for you.',
    },
  },
  {
    id: 'quick_commerce',
    label: 'Quick commerce',
    icon: ICON.quick_commerce,
    accent: 'gold',
    action: {
      state: 'soon',
      label: 'Blak shops for you',
      note: 'Groceries & essentials via ONDC — next phase. For now Blak learns what you reorder and opens the app for you.',
    },
  },
  {
    id: 'cabs',
    label: 'Cabs & rides',
    icon: ICON.cabs,
    accent: 'aqua',
    action: {
      state: 'live',
      label: 'Ask Blak to book a ride',
      note: 'Blak books a real ride for you over ONDC (Namma Yatri / Rapido / Uber on the network). You confirm payment with one UPI tap.',
    },
  },
];

// The apps. `caps.headless: 'via_ondc'` means Blak can actually complete it (cabs);
// `false` means deep-link only (the brand has no consumer ordering API).
export const APPS = [
  // ---- Food delivery ----
  { id: 'swiggy',    name: 'Swiggy',           category: 'food',           bg: '#FC8019', ink: '#FFFFFF', mark: 'S',
    caps: { learn: true, headless: false, deeplink: true }, url: 'https://www.swiggy.com' },
  { id: 'zomato',    name: 'Zomato',           category: 'food',           bg: '#E23744', ink: '#FFFFFF', mark: 'Z',
    caps: { learn: true, headless: false, deeplink: true }, url: 'https://www.zomato.com' },

  // ---- Quick commerce ----
  { id: 'blinkit',   name: 'Blinkit',          category: 'quick_commerce', bg: '#F8CB46', ink: '#16161D', mark: 'B',
    caps: { learn: true, headless: false, deeplink: true }, url: 'https://blinkit.com' },
  { id: 'zepto',     name: 'Zepto',            category: 'quick_commerce', bg: '#6C3DF4', ink: '#FFFFFF', mark: 'Z',
    caps: { learn: true, headless: false, deeplink: true }, url: 'https://www.zeptonow.com' },
  { id: 'instamart', name: 'Swiggy Instamart', category: 'quick_commerce', bg: '#FC8019', ink: '#FFFFFF', mark: 'I',
    caps: { learn: true, headless: false, deeplink: true }, url: 'https://www.swiggy.com/instamart' },

  // ---- Cabs & rides (headless via ONDC) ----
  { id: 'uber',      name: 'Uber',             category: 'cabs',           bg: '#10100E', ink: '#FFFFFF', mark: 'U',
    caps: { learn: true, headless: 'via_ondc', deeplink: true }, url: 'https://m.uber.com' },
  { id: 'ola',       name: 'Ola',              category: 'cabs',           bg: '#1AAE5A', ink: '#FFFFFF', mark: 'O',
    caps: { learn: true, headless: 'via_ondc', deeplink: true }, url: 'https://book.olacabs.com' },
  { id: 'rapido',    name: 'Rapido',           category: 'cabs',           bg: '#FFD11A', ink: '#1A1A22', mark: 'R',
    caps: { learn: true, headless: 'via_ondc', deeplink: true }, url: 'https://www.rapido.bike' },
];

export const MAIL_ICON = ICON.mail;

export const appsByCategory = (catId) => APPS.filter((a) => a.category === catId);

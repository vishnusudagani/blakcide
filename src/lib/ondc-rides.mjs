// ONDC ride provider — the single interface Blak's cab booking talks to.
//
// Today it returns clearly-marked PREVIEW data. When the ONDC provider sandbox
// is wired, set RIDES_LIVE = true and implement search()/confirm() against the
// Beckn flow. The booking UI maps 1:1 to that lifecycle, so swapping in the real
// client stays local to this file:
//   searchRides()  -> Beckn  search   -> on_search   (collect quotes)
//   confirmRide()  -> Beckn  select/init/confirm     -> on_confirm (+ driver)
//
// No secrets live here. Real calls go through a server-side BAP (edge function)
// that signs requests with the network keys — the browser never holds them.

export const RIDES_LIVE = false; // foundation gate: flip once the BAP sandbox is in

// Mirrors ONDC mobility: several modes/providers come back from on_search.
const PREVIEW_OPTIONS = [
  { id: 'bike', mode: 'Bike',       provider: 'Rapido · ONDC',      etaMin: 3, fareInr: 52 },
  { id: 'auto', mode: 'Auto',       provider: 'Namma Yatri · ONDC', etaMin: 4, fareInr: 86 },
  { id: 'mini', mode: 'Cab · Mini', provider: 'Uber · ONDC',        etaMin: 6, fareInr: 143 },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function searchRides({ from, to }) {
  if (!RIDES_LIVE) {
    await wait(650); // the feel of a real network search
    return { live: false, options: PREVIEW_OPTIONS.map((o) => ({ ...o })) };
  }
  // TODO(ondc): POST /search to the BAP gateway; aggregate on_search quotes.
  throw new Error('ONDC search not wired yet');
}

export async function confirmRide({ option, from, to }) {
  if (!RIDES_LIVE) {
    await wait(500);
    return { live: false, status: 'preview', otp: '••••', driver: null };
  }
  // TODO(ondc): select -> init -> confirm; return the on_confirm order + driver.
  throw new Error('ONDC confirm not wired yet');
}

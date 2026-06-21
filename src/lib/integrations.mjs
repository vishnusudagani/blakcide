// App Integrations — the "Your apps" grid on the beta account page.
//
// Renders a category-grouped grid (Food · Quick Commerce · Cabs) of brand cards
// plus the master "learn" controls. What's real today vs. wired-for-foundation:
//   • REAL NOW: "Tell Blak a taste" writes a live fact to symp_knowledge_facts;
//     "Open ↗" deep-links the app; data-control links to the profile page.
//   • PREVIEW (foundation-gated): Connect Gmail (needs the Google OAuth backend),
//     and the cab booking flow (needs the ONDC provider sandbox — see ondc-rides).
//     Both are clearly labelled so nobody thinks a real ride/connection happened.
//
// State (which providers a user connected) lives in symp_integrations; reads are
// defensive so the grid still renders before that migration is applied.

import { CATEGORIES, APPS, MAIL_ICON, appsByCategory } from './integrations-catalog.mjs';
import { searchRides, confirmRide, RIDES_LIVE } from './ondc-rides.mjs';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);

const state = {
  supabase: null,
  user: null,
  container: null,
  connections: [],   // rows from symp_integrations (defensive: [] if table absent)
  gmailPending: false,
  note: '',          // transient status line under the master card
  booking: { open: false, step: 'dest', from: 'Current location', to: '', options: [], selected: null, result: null },
};

const conn = (provider) => state.connections.find((c) => c.provider === provider) || null;
const gmailConn = () => conn('gmail');
const learningOn = () => state.gmailPending || !!gmailConn();

// ---------- render: app card ----------
function appCard(app) {
  const on = learningOn();
  const learnBadge = on
    ? '<span class="int-badge learn">Learning ✓</span>'
    : '<span class="int-badge muted">Learns from receipts</span>';
  return (
    '<div class="int-app">' +
      '<div class="int-app-top">' +
        '<span class="int-logo" style="background:' + esc(app.bg) + ';color:' + esc(app.ink) + '">' + esc(app.mark) + '</span>' +
        '<span class="int-app-name">' + esc(app.name) + '</span>' +
      '</div>' +
      '<div class="int-badges">' + learnBadge + '</div>' +
      '<div class="int-app-actions">' +
        '<button class="int-open" data-act="open" data-url="' + esc(app.url) + '" data-name="' + esc(app.name) + '">Open ↗</button>' +
      '</div>' +
    '</div>'
  );
}

// ---------- render: category block (head + Blak action banner + grid) ----------
function categoryBlock(cat) {
  const apps = appsByCategory(cat.id);
  const a = cat.action;
  const live = a.state === 'live';
  const banner =
    '<div class="int-action ' + (live ? 'is-live' : 'is-soon') + '">' +
      '<div class="int-action-main">' +
        '<span class="int-action-label">' + esc(a.label) + '</span>' +
        '<span class="int-action-pill">' + (live ? 'Blak does this' : 'soon') + '</span>' +
      '</div>' +
      '<p class="int-action-note">' + esc(a.note) + '</p>' +
      (live
        ? '<button class="int-cta" data-act="book-toggle">' + (state.booking.open ? 'Close' : 'Book a ride') + '</button>'
        : '') +
      (live && state.booking.open ? bookingPanel() : '') +
    '</div>';
  return (
    '<section class="int-cat">' +
      '<div class="int-cat-head">' +
        '<span class="int-cat-ic ' + esc(cat.accent) + '">' + cat.icon + '</span>' +
        '<h3 class="int-cat-title">' + esc(cat.label) + '</h3>' +
      '</div>' +
      banner +
      '<div class="int-grid">' + apps.map(appCard).join('') + '</div>' +
    '</section>'
  );
}

// ---------- render: cab booking flow (Beckn-shaped; preview until RIDES_LIVE) ----------
const pvPill = () => (RIDES_LIVE ? '' : '<span class="int-pv">Preview</span>');

function bookingPanel() {
  const b = state.booking;
  if (b.step === 'searching') return '<p class="int-book-status">Blak is finding you a ride…</p>';
  if (b.step === 'confirming') return '<p class="int-book-status">Confirming your ride…</p>';
  if (b.step === 'options') {
    const rows = b.options.map((o) =>
      '<button class="int-ride" data-act="book-pick" data-id="' + esc(o.id) + '">' +
        '<span class="int-ride-mode">' + esc(o.mode) + '</span>' +
        '<span class="int-ride-meta">' + esc(o.provider) + ' · ~' + o.etaMin + ' min</span>' +
        '<span class="int-ride-fare">₹' + o.fareInr + '</span>' +
      '</button>'
    ).join('');
    return (
      '<div class="int-rides">' +
        '<div class="int-book-head">Rides to “' + esc(b.to) + '” ' + pvPill() + '</div>' +
        rows +
        '<button class="int-link" data-act="book-reset">Change destination</button>' +
      '</div>'
    );
  }
  if (b.step === 'confirm') {
    const o = b.selected;
    return (
      '<div class="int-confirm">' +
        '<div class="int-book-head">Confirm ' + pvPill() + '</div>' +
        '<div class="int-confirm-row"><span>' + esc(o.mode) + ' · ' + esc(o.provider) + '</span><b>₹' + o.fareInr + '</b></div>' +
        '<p class="int-confirm-note">' + (RIDES_LIVE
          ? 'Pay ₹' + o.fareInr + ' with one UPI tap to confirm.'
          : 'Preview only — no real ride or payment. Real booking + UPI confirm switch on with the ONDC sandbox.') + '</p>' +
        '<div class="int-book">' +
          '<button class="int-link" data-act="book-back">Back</button>' +
          '<button class="int-cta int-confirm-go" data-act="book-confirm">' + (RIDES_LIVE ? 'Confirm & pay' : 'Confirm (preview)') + '</button>' +
        '</div>' +
      '</div>'
    );
  }
  if (b.step === 'booked') {
    const o = b.selected;
    return (
      '<div class="int-booked">' +
        '<div class="int-book-head">' + (RIDES_LIVE ? 'Ride confirmed' : 'Preview complete') + ' ' + pvPill() + '</div>' +
        '<p class="int-book-status">' + (RIDES_LIVE
          ? esc(o.mode) + ' on the way · OTP ' + esc((b.result && b.result.otp) || '••••')
          : 'That’s how booking will feel. Real rides arrive when the ONDC provider sandbox is connected.') + '</p>' +
        '<button class="int-link" data-act="book-reset">Book another</button>' +
      '</div>'
    );
  }
  // default: destination entry
  return (
    '<div class="int-book">' +
      '<input class="int-input" id="int-dest" placeholder="Where to? (e.g. Hi-Tech City)" value="' + esc(b.to) + '" />' +
      '<button class="int-book-go" data-act="book-find">Find rides</button>' +
    '</div>'
  );
}

// ---------- render: master learn controls (Gmail + manual taste) ----------
function masterCard() {
  const g = gmailConn();
  let gmailRow;
  if (g) {
    gmailRow =
      '<div class="int-m-row">' +
        '<span class="int-m-ic on">' + MAIL_ICON + '</span>' +
        '<div class="int-m-tx"><b>Gmail connected</b><i>' + esc(g.display_name || 'Reading your receipts') + '</i></div>' +
        '<button class="int-ghost" data-act="gmail-disconnect">Disconnect</button>' +
      '</div>';
  } else {
    gmailRow =
      '<div class="int-m-row">' +
        '<span class="int-m-ic">' + MAIL_ICON + '</span>' +
        '<div class="int-m-tx"><b>Connect Gmail</b><i>One connection lets Blak learn your taste &amp; spend from receipts — across every app.</i></div>' +
        '<button class="int-connect" data-act="gmail-connect"' + (state.gmailPending ? ' disabled' : '') + '>' +
          (state.gmailPending ? 'Soon' : 'Connect') + '</button>' +
      '</div>';
  }
  const note = state.note ? '<p class="int-note">' + esc(state.note) + '</p>' : '';
  return (
    '<div class="int-master">' +
      gmailRow +
      note +
      '<div class="int-divider"></div>' +
      '<label class="int-pref-label" for="int-pref">Tell Blak a taste</label>' +
      '<div class="int-pref">' +
        '<input class="int-input" id="int-pref" placeholder="e.g. I love biryani from Mehfil" />' +
        '<button class="int-pref-go" data-act="pref-save">Tell Blak</button>' +
      '</div>' +
      '<p class="int-fwd">No Gmail? You\'ll soon be able to forward receipts to <b>receipts@blaksyd.com</b>.</p>' +
    '</div>'
  );
}

function paint() {
  state.container.innerHTML =
    masterCard() +
    CATEGORIES.map(categoryBlock).join('') +
    '<a class="int-manage" href="/beta/profile/">Manage everything Blak has learned →</a>';
}

// ---------- actions ----------
function openApp(url) {
  if (!url) return;
  try { window.open(url, '_blank', 'noopener'); } catch (e) { location.href = url; }
}

async function savePref(text) {
  const v = String(text || '').trim();
  if (!v) return;
  const key = 'pref_' + (slug(v) || ('n' + Date.now()));
  const row = {
    user_id: state.user.id, area: 'tastes', key,
    label: 'Preference', value: v,
    source: 'user', status: 'user_edited', confidence: 1,
    last_seen_at: new Date().toISOString(),
  };
  try {
    const { error } = await state.supabase
      .from('symp_knowledge_facts')
      .upsert(row, { onConflict: 'user_id,area,key' });
    state.note = error ? 'Couldn’t save that — try again.' : 'Saved ✓ Blak will remember.';
  } catch (e) {
    state.note = 'Couldn’t save that — try again.';
  }
  paint();
}

function connectGmail() {
  // Preview: the Google OAuth (gmail.readonly) backend lands with the foundation.
  // When it does, swap this for supabase.auth OAuth + a server token store.
  state.gmailPending = true;
  state.note = 'Receipt-reading is being switched on — you’ll connect Gmail right here shortly. Meanwhile, tell Blak a taste below.';
  paint();
}

async function disconnectGmail() {
  if (!confirm('Disconnect Gmail? Blak will stop reading your receipts. What it already learned stays in your profile (you can delete it there).')) return;
  try {
    await state.supabase.from('symp_integrations').delete()
      .eq('user_id', state.user.id).eq('provider', 'gmail');
  } catch (e) { /* table may not exist yet — fall through */ }
  state.connections = state.connections.filter((c) => c.provider !== 'gmail');
  state.gmailPending = false;
  state.note = '';
  paint();
}

async function findRides() {
  if (!state.booking.to) return;
  state.booking.step = 'searching';
  paint();
  try {
    const res = await searchRides({ from: state.booking.from, to: state.booking.to });
    state.booking.options = res.options || [];
    state.booking.step = 'options';
  } catch (e) {
    state.booking.step = 'dest';
    state.note = 'Couldn’t fetch rides right now.';
  }
  paint();
}

async function confirmBooking() {
  state.booking.step = 'confirming';
  paint();
  try {
    state.booking.result = await confirmRide({
      option: state.booking.selected, from: state.booking.from, to: state.booking.to,
    });
    state.booking.step = 'booked';
  } catch (e) {
    state.booking.step = 'confirm';
    state.note = 'Couldn’t confirm right now.';
  }
  paint();
}

function resetBooking(keepOpen) {
  state.booking.step = 'dest';
  state.booking.options = [];
  state.booking.selected = null;
  state.booking.result = null;
  if (keepOpen === false) state.booking.open = false;
}

function onClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'open') openApp(btn.dataset.url);
  else if (act === 'pref-save') { const el = document.getElementById('int-pref'); savePref(el ? el.value : ''); }
  else if (act === 'gmail-connect') connectGmail();
  else if (act === 'gmail-disconnect') disconnectGmail();
  else if (act === 'book-toggle') { state.booking.open = !state.booking.open; if (state.booking.open) resetBooking(true); paint(); }
  else if (act === 'book-find') { const el = document.getElementById('int-dest'); state.booking.to = el ? el.value.trim() : ''; findRides(); }
  else if (act === 'book-pick') { state.booking.selected = state.booking.options.find((o) => o.id === btn.dataset.id) || null; state.booking.step = 'confirm'; paint(); }
  else if (act === 'book-back') { state.booking.step = 'options'; paint(); }
  else if (act === 'book-confirm') { confirmBooking(); }
  else if (act === 'book-reset') { resetBooking(true); paint(); }
}

function onKeydown(e) {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'int-pref') { e.preventDefault(); savePref(e.target.value); }
  else if (e.target.id === 'int-dest') { e.preventDefault(); state.booking.to = e.target.value.trim(); findRides(); }
}

export async function mountIntegrations({ supabase, user, container }) {
  state.supabase = supabase;
  state.user = user;
  state.container = container;
  // Defensive read: if the symp_integrations migration isn't applied yet, just
  // render the catalog with nothing connected.
  try {
    const { data } = await supabase
      .from('symp_integrations')
      .select('provider,category,status,display_name,last_sync_at')
      .eq('user_id', user.id);
    state.connections = data || [];
  } catch (e) {
    state.connections = [];
  }
  container.addEventListener('click', onClick);
  container.addEventListener('keydown', onKeydown);
  paint();
}

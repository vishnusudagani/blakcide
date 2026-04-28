// Symp.ai API Contract — v1
// Single source of truth for endpoints, headers, error codes, and request/response
// shapes. Imported by:
//   - netlify/functions/symp-v1-*.js   (server handlers)
//   - symp-core/sdk/symp-client.js     (frontend adapter)
// UMD-lite wrapper so the same file works via CommonJS `require()` in Netlify
// Functions and via `<script>` tag in the Blaksyd browser bundle.

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SympContract = api;
})(typeof self !== 'undefined' ? self : this, function () {

    const SYMP_API_VERSION      = 'v1';
    const SYMP_API_BASE         = '/api/symp/' + SYMP_API_VERSION;
    // Blaksyd proxy base. The browser SDK points here by default. The proxy
    // authenticates the user via Supabase JWT and forwards to SYMP_API_BASE
    // with x-symp-api-key injected server-side.
    const BLAKSYD_PROXY_BASE    = '/api/blaksyd/symp';
    const SYMP_API_KEY_HEADER   = 'x-symp-api-key';
    const SYMP_REQUEST_ID_HEADER = 'x-symp-request-id';

    const ENDPOINTS = Object.freeze({
        HEALTH:         SYMP_API_BASE + '/health',           // GET   — JSON  (liveness + version)
        CHAT:           SYMP_API_BASE + '/chat',             // POST  — SSE stream
        TRANSCRIBE:     SYMP_API_BASE + '/transcribe',       // POST  — JSON
        VISION:         SYMP_API_BASE + '/vision',           // POST  — JSON
        TTS:            SYMP_API_BASE + '/tts',              // POST  — audio/mpeg
        SESSION_INGEST: SYMP_API_BASE + '/session/ingest',   // POST  — JSON
        ANALYSE_RUN:    SYMP_API_BASE + '/analyse/run',      // POST  — JSON
        COPILOT_HINT:   SYMP_API_BASE + '/copilot/hint',     // POST  — JSON (listener whisper)
        VAULT_GET:      SYMP_API_BASE + '/vault',            // GET /vault/:user_id (admin)
        WHISPER_WS:     SYMP_API_BASE + '/whisper',          // WebSocket
        PROACTIVE_CHECKIN: SYMP_API_BASE + '/proactive-checkin', // POST — JSON
        VIBE:                SYMP_API_BASE + '/vibe',                // GET — current vibe state
        VIBE_EVENT:          SYMP_API_BASE + '/vibe/event',          // POST — record an event
        PERSONAS:            SYMP_API_BASE + '/personas',            // GET — list of available personas
        PERSONA_STATE:       SYMP_API_BASE + '/persona/state',       // GET — current persona row
        PERSONA_SWAP:        SYMP_API_BASE + '/persona/swap',        // POST — swap active persona
        ACTION_LOOP_RUN:     SYMP_API_BASE + '/action-loop/run',     // POST — CRON entry
        LISTENER_BRIEF:      SYMP_API_BASE + '/listener/brief',      // POST — pre-session brief
        LISTENER_VIBE_CHECK: SYMP_API_BASE + '/listener/vibe-check', // POST — mid-session check
        DIAGNOSTIC_TURN:     SYMP_API_BASE + '/diagnostic/turn',     // POST — analyse last turn
        DIAGNOSTIC_PEEK:     SYMP_API_BASE + '/diagnostic/peek',     // GET  — read pinned corrections

        // ── Nexus (community module) ──
        NEXUS_COMMUNITIES:        SYMP_API_BASE + '/nexus/communities',           // GET list / POST create
        NEXUS_COMMUNITY_BY_SLUG:  SYMP_API_BASE + '/nexus/communities/by-slug',   // GET ?slug=
        NEXUS_COMMUNITY_JOIN:     SYMP_API_BASE + '/nexus/communities/join',      // POST { community_id }
        NEXUS_COMMUNITY_LEAVE:    SYMP_API_BASE + '/nexus/communities/leave',     // POST { community_id }
        NEXUS_FEED:               SYMP_API_BASE + '/nexus/feed',                  // GET ?community_id=
        NEXUS_POSTS:              SYMP_API_BASE + '/nexus/posts',                 // GET ?id= / POST create
        NEXUS_COMMENTS:           SYMP_API_BASE + '/nexus/comments',              // POST create
        NEXUS_IMPACTS:            SYMP_API_BASE + '/nexus/impacts',               // POST give / DELETE withdraw
        NEXUS_ME_IMPACT_STATS:    SYMP_API_BASE + '/nexus/me/impact-stats',       // GET ?days=

        // ── Credits (wallet, ledger, admin grants) ──
        CREDITS_BALANCE:          SYMP_API_BASE + '/credits/balance',             // GET — caller's wallet
        CREDITS_TRANSACTIONS:     SYMP_API_BASE + '/credits/transactions',        // GET ?limit=&before=
        CREDITS_CHECKOUT_START:   SYMP_API_BASE + '/credits/checkout/start',      // POST — Stripe stub (Phase 2)
        ADMIN_CREDITS_GRANT:      SYMP_API_BASE + '/admin/credits/grant',         // POST { target_user_id, amount, reason }
        ADMIN_CREDITS_LOOKUP:     SYMP_API_BASE + '/admin/credits/lookup',        // GET ?user_id= — wallet + history
        ADMIN_USERS_SEARCH:       SYMP_API_BASE + '/admin/users/search',          // GET ?q=

        // ── Admin dashboard data feeds ──
        ADMIN_OVERVIEW:           SYMP_API_BASE + '/admin/overview',              // GET — KPI strip
        ADMIN_USERS_LIST:         SYMP_API_BASE + '/admin/users/list',            // GET ?q=&limit=&offset=
        ADMIN_USER_DETAIL:        SYMP_API_BASE + '/admin/users/detail',          // GET ?target_user_id=
        ADMIN_SYMP_STATUS:        SYMP_API_BASE + '/admin/symp-status',           // GET — inference + loop + nexus AI
        ADMIN_RECENT_ACTIVITY:    SYMP_API_BASE + '/admin/recent-activity',       // GET ?limit=
    });

    const NEXUS_IMPACT_TYPES = Object.freeze(['felt_seen','resonated','helpful','sending_strength']);

    const PERSONAS = Object.freeze(['friend', 'father', 'mother', 'astrologer', 'spiritual', 'tech_savvy', 'therapist']);

    const SESSION_TYPES = Object.freeze({
        AI_CHAT:    'ai_chat',
        AI_CALL:    'ai_call',
        HUMAN_CHAT: 'human_chat',
        HUMAN_CALL: 'human_call',
    });

    // Entry types in symp_daily_journals.entry_type — matches the CHECK
    // constraint on the deployed table.
    const ENTRY_TYPES = Object.freeze({
        AI_COMPANION:  'ai_companion',
        HUMAN_CONNECT: 'human_connect',
    });

    const LANGUAGES = Object.freeze({ TELUGU: 'te', HINDI: 'hi', ENGLISH: 'en' });

    const ERROR_CODES = Object.freeze({
        INVALID_API_KEY:      'INVALID_API_KEY',   // 401 — missing/wrong x-symp-api-key
        MISSING_USER_ID:      'MISSING_USER_ID',   // 400
        USER_NOT_FOUND:       'USER_NOT_FOUND',    // 404 — user_id not in profiles
        BAD_REQUEST:          'BAD_REQUEST',       // 400 — malformed payload
        RATE_LIMITED:         'RATE_LIMITED',      // 429
        UPSTREAM_FAILED:      'UPSTREAM_FAILED',   // 502 — OpenAI/Supabase error
        INTERNAL_ERROR:       'INTERNAL_ERROR',    // 500
        FORBIDDEN:            'FORBIDDEN',         // 403 — non-admin hitting admin endpoint
        INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS', // 402 — wallet would go negative
    });

    const CREDIT_TRANSACTION_TYPES = Object.freeze([
        'admin_grant', 'purchase', 'promo', 'referral',
        'spend_ai_chat', 'spend_human', 'refund', 'correction',
    ]);

    // Maps session_type → entry_type. Consumed by /session/ingest to choose
    // the (user_id, journal_date, entry_type) row in symp_daily_journals.
    const SESSION_TYPE_TO_ENTRY_TYPE = Object.freeze({
        ai_chat:    ENTRY_TYPES.AI_COMPANION,
        ai_call:    ENTRY_TYPES.AI_COMPANION,
        human_chat: ENTRY_TYPES.HUMAN_CONNECT,
        human_call: ENTRY_TYPES.HUMAN_CONNECT,
    });

    // ── Shapes (JSDoc typedefs — not runtime-enforced) ─────────────────

    /**
     * Standard JSON envelope. Every non-streaming endpoint returns this.
     * @typedef  {Object} SympResponse
     * @property {boolean} ok
     * @property {Object}  [data]                // success payload
     * @property {{code:string, message:string}} [error]
     * @property {string}  request_id
     */

    /**
     * POST /chat   — Server-Sent Events stream.
     * Wire format matches existing Blaksyd /api/chat so consumers can swap URL without
     * rewriting their SSE parser:
     *   data: {"delta":"token"}    — incremental token
     *   data: {"done":true}        — stream finished
     *   data: {"error":"..."}      — fatal error
     *
     * @typedef  {Object} ChatRequest
     * @property {string}  user_id
     * @property {Array<{role:'user'|'assistant'|'system', content:string}>} messages
     * @property {boolean} [stream=true]
     * @property {'te'|'hi'|'en'} [language_hint]
     */

    /**
     * POST /session/ingest
     * @typedef  {Object} SessionIngestRequest
     * @property {string} user_id
     * @property {'ai_chat'|'ai_call'|'human_chat'|'human_call'} session_type
     * @property {string} session_id
     * @property {Array<{role:string, content:string, ts?:string}>} transcript
     * @property {string} started_at    // ISO
     * @property {string} ended_at      // ISO
     *
     * @typedef  {Object} SessionIngestData
     * @property {string}                 summary_id
     * @property {'ai'|'human'}            bucket
     * @property {'created'|'appended'}    action
     * @property {string}                  summary_date   // YYYY-MM-DD
     */

    /**
     * POST /analyse/run
     * @typedef  {Object} AnalyseRunRequest
     * @property {string}  user_id
     * @property {string}  [date]            // YYYY-MM-DD, defaults to yesterday (user TZ = UTC for v1)
     * @property {boolean} [force=false]     // re-run even if already analysed
     *
     * @typedef  {Object} AnalyseRunData
     * @property {boolean} skipped           // true if already analysed and !force
     * @property {string}  analysis_date
     * @property {{psychology:Object, key_themes:string[], metrics:Object, integrations:Object}} [analysis]
     */

    /**
     * GET /vault/:user_id   (admin dashboard only — distinct admin key, TBD Step 5)
     * @typedef  {Object} VaultGetData
     * @property {Object}   profile                 // symp_vault_profiles row
     * @property {Array}    recent_summaries        // last 14 symp_session_summaries
     * @property {Array}    recent_analyses         // last 14 symp_daily_analyses
     */

    /**
     * WSS /whisper?session_id=<uuid>
     * Auth: first frame MUST be { type:'auth', api_key, user_id, listener_id, connect_session_id }.
     *
     * Client → server frames:
     *   { type:'auth', api_key, user_id, listener_id, connect_session_id }
     *   { type:'transcript', speaker:'user'|'listener', text, ts, final:boolean }
     *   { type:'end' }
     *
     * Server → client frames:
     *   { type:'ready', live_session_id }
     *   { type:'hint', text, priority:'low'|'medium'|'high', reasons:string[] }
     *   { type:'ack' }
     *   { type:'error', code, message }
     */

    const WHISPER_FRAME_TYPES = Object.freeze({
        AUTH:       'auth',
        TRANSCRIPT: 'transcript',
        END:        'end',
        READY:      'ready',
        HINT:       'hint',
        ACK:        'ack',
        ERROR:      'error',
    });

    return {
        SYMP_API_VERSION,
        SYMP_API_BASE,
        BLAKSYD_PROXY_BASE,
        SYMP_API_KEY_HEADER,
        SYMP_REQUEST_ID_HEADER,
        ENDPOINTS,
        SESSION_TYPES,
        ENTRY_TYPES,
        SESSION_TYPE_TO_ENTRY_TYPE,
        LANGUAGES,
        PERSONAS,
        ERROR_CODES,
        WHISPER_FRAME_TYPES,
        NEXUS_IMPACT_TYPES,
        CREDIT_TRANSACTION_TYPES,
    };
});

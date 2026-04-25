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
    });

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
        INVALID_API_KEY: 'INVALID_API_KEY',   // 401 — missing/wrong x-symp-api-key
        MISSING_USER_ID: 'MISSING_USER_ID',   // 400
        USER_NOT_FOUND:  'USER_NOT_FOUND',    // 404 — user_id not in profiles
        BAD_REQUEST:     'BAD_REQUEST',       // 400 — malformed payload
        RATE_LIMITED:    'RATE_LIMITED',      // 429
        UPSTREAM_FAILED: 'UPSTREAM_FAILED',   // 502 — OpenAI/Supabase error
        INTERNAL_ERROR:  'INTERNAL_ERROR',    // 500
    });

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
        ERROR_CODES,
        WHISPER_FRAME_TYPES,
    };
});

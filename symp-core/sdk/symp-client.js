// Symp.ai client SDK — the Adapter layer Blaksyd uses to talk to the Brain.
//
// Two modes:
//   1) BROWSER (recommended): pass { getAuthToken } — an async callback that
//      returns the current Supabase session JWT. The SDK routes through the
//      /api/blaksyd/symp/* proxy, which injects SYMP_API_KEY server-side.
//      The browser NEVER holds SYMP_API_KEY.
//
//        const client = new SympClient({
//          getAuthToken: async () => (await supabase.auth.getSession()).data.session?.access_token,
//        });
//
//   2) SERVER: pass { apiKey } — hits /api/symp/v1/* directly with
//      x-symp-api-key header. Use this from a trusted Node context (tests,
//      cron jobs, admin tools).
//
//        const client = new SympClient({ apiKey: process.env.SYMP_API_KEY });
//
// Load order in a browser bundle:
//   <script src="/symp-core/contract/endpoints.js"></script>
//   <script src="/symp-core/sdk/symp-client.js"></script>

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.SympClient = api;
})(typeof self !== 'undefined' ? self : this, function () {

    let Contract = null;
    if (typeof self !== 'undefined' && self.SympContract) {
        Contract = self.SympContract;
    } else if (typeof require !== 'undefined') {
        try { Contract = require('../contract/endpoints.js'); } catch (_) { Contract = null; }
    }
    if (!Contract) {
        throw new Error('[SympClient] Contract module not found. Load symp-core/contract/endpoints.js first.');
    }

    const {
        SYMP_API_BASE, BLAKSYD_PROXY_BASE,
        SYMP_API_KEY_HEADER, SYMP_REQUEST_ID_HEADER,
        WHISPER_FRAME_TYPES,
    } = Contract;

    // Proxy-facing endpoint paths (relative to BLAKSYD_PROXY_BASE). These
    // mirror the bare names used in the proxy's allowlist.
    const PROXY_PATHS = Object.freeze({
        HEALTH:         '/health',
        CHAT:           '/chat',
        TRANSCRIBE:     '/transcribe',
        VISION:         '/vision',
        TTS:            '/tts',
        SESSION_INGEST: '/session/ingest',
        ANALYSE_RUN:    '/analyse/run',
        COPILOT_HINT:   '/copilot/hint',
    });

    // Direct Symp.ai endpoint paths (relative to SYMP_API_BASE).
    const DIRECT_PATHS = Object.freeze({
        HEALTH:         '/health',
        CHAT:           '/chat',
        TRANSCRIBE:     '/transcribe',
        VISION:         '/vision',
        TTS:            '/tts',
        SESSION_INGEST: '/session/ingest',
        ANALYSE_RUN:    '/analyse/run',
        COPILOT_HINT:   '/copilot/hint',
    });

    function newRequestId() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'req-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
    }

    class SympClient {
        /**
         * @param {Object}   opts
         * @param {Function} [opts.getAuthToken]  async () => string (Supabase JWT). Browser mode.
         * @param {string}   [opts.apiKey]        Server mode only. If set, takes precedence.
         * @param {string}   [opts.baseUrl='']    Absolute origin override. '' = same-origin.
         * @param {Function} [opts.fetch]         Custom fetch for testing.
         * @param {Function} [opts.onRequest]     Hook: ({requestId,endpoint,method}) => void
         */
        constructor(opts) {
            opts = opts || {};
            this.apiKey       = opts.apiKey || null;
            this.getAuthToken = opts.getAuthToken || null;

            // Pick mode. apiKey wins if both are set (explicit server intent).
            if (this.apiKey) {
                this._mode    = 'api-key';
                this._apiBase = SYMP_API_BASE;
                this._paths   = DIRECT_PATHS;
            } else if (this.getAuthToken) {
                this._mode    = 'jwt';
                this._apiBase = BLAKSYD_PROXY_BASE;
                this._paths   = PROXY_PATHS;
            } else {
                throw new Error('[SympClient] Must provide either { getAuthToken } (browser) or { apiKey } (server).');
            }

            this.baseUrl   = opts.baseUrl || '';
            this.fetch     = opts.fetch   || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
            this.onRequest = opts.onRequest || null;
            if (!this.fetch) throw new Error('[SympClient] No fetch implementation available.');
        }

        _url(path) { return (this.baseUrl || '') + this._apiBase + path; }

        async _authHeaders(requestId) {
            const h = {
                'Content-Type':           'application/json',
                [SYMP_REQUEST_ID_HEADER]: requestId,
            };
            if (this._mode === 'api-key') {
                h[SYMP_API_KEY_HEADER] = this.apiKey;
            } else {
                const token = await this.getAuthToken();
                if (!token) throw new Error('[SympClient] getAuthToken returned empty — user not signed in?');
                h['Authorization'] = `Bearer ${token}`;
            }
            return h;
        }

        _beforeRequest(requestId, path, method) {
            if (this.onRequest) {
                try { this.onRequest({ requestId, endpoint: this._apiBase + path, method }); } catch (_) {}
            }
        }

        // ── Liveness ─────────────────────────────────────────────────────────
        async health() {
            const requestId = newRequestId();
            this._beforeRequest(requestId, this._paths.HEALTH, 'GET');
            const res = await this.fetch(this._url(this._paths.HEALTH), {
                method:  'GET',
                headers: await this._authHeaders(requestId),
            });
            return res.json();
        }

        // ── Chat (streaming) ─────────────────────────────────────────────────
        /**
         * @param {Object}   req
         * @param {string}   [req.user_id]      Optional in jwt mode (proxy overrides from JWT).
         *                                      Required in api-key mode.
         * @param {Array}    req.messages
         * @param {boolean} [req.stream=true]
         * @param {'te'|'hi'|'en'} [req.language_hint]
         * @param {Function}[req.onToken]       (delta) => void
         * @param {Function}[req.onDone]        (fullText) => void
         * @param {Function}[req.onError]       (errMsg) => void
         */
        async chat(req) {
            if (!req || !Array.isArray(req.messages)) {
                throw new Error('[SympClient] chat: messages array required');
            }
            if (this._mode === 'api-key' && !req.user_id) {
                throw new Error('[SympClient] chat: user_id required in api-key mode');
            }

            const requestId = newRequestId();
            this._beforeRequest(requestId, this._paths.CHAT, 'POST');
            const stream = req.stream !== false;

            const res = await this.fetch(this._url(this._paths.CHAT), {
                method:  'POST',
                headers: await this._authHeaders(requestId),
                body:    JSON.stringify({
                    user_id:       req.user_id || null, // proxy overrides in jwt mode
                    messages:      req.messages,
                    stream,
                    language_hint: req.language_hint,
                }),
            });

            if (!stream) return res.json();

            if (!res.body || !res.body.getReader) {
                throw new Error('[SympClient] chat: streaming body not available in this runtime');
            }

            // Sentence boundary: . ? ! । or newline. Used when onSentence is provided
            // so TTS / streaming voice callers can start speaking before the full
            // response arrives.
            const SENT_RE = /[.?!।]+(?=[\s\n]|$)|\n/g;
            const wantSentences = typeof req.onSentence === 'function';
            let sentenceQueue = '';
            const flushSentences = (force) => {
                if (!wantSentences) return;
                SENT_RE.lastIndex = 0;
                let last = 0, m;
                while ((m = SENT_RE.exec(sentenceQueue)) !== null) {
                    const piece = sentenceQueue.slice(last, m.index + m[0].length).trim();
                    if (piece) req.onSentence(piece, fullText);
                    last = m.index + m[0].length;
                }
                sentenceQueue = sentenceQueue.slice(last);
                if (force && sentenceQueue.trim()) {
                    req.onSentence(sentenceQueue.trim(), fullText);
                    sentenceQueue = '';
                }
            };

            const reader  = res.body.getReader();
            const decoder = new TextDecoder();
            let buf = '', fullText = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    const t = line.trim();
                    if (!t.startsWith('data:')) continue;
                    const payload = t.slice(5).trim();
                    if (!payload) continue;
                    let evt;
                    try { evt = JSON.parse(payload); } catch (_) { continue; }
                    if (evt.delta) {
                        fullText      += evt.delta;
                        sentenceQueue += evt.delta;
                        if (req.onToken) req.onToken(evt.delta, fullText);
                        flushSentences(false);
                    } else if (evt.done) {
                        flushSentences(true);
                        if (req.onDone) req.onDone(fullText);
                        return { ok: true, data: { reply: fullText }, request_id: requestId };
                    } else if (evt.error) {
                        if (req.onError) req.onError(evt.error);
                        return {
                            ok: false,
                            error: { code: 'UPSTREAM_FAILED', message: String(evt.error) },
                            request_id: requestId,
                        };
                    }
                }
            }
            flushSentences(true);
            if (req.onDone) req.onDone(fullText);
            return { ok: true, data: { reply: fullText }, request_id: requestId };
        }

        // ── Transcription ────────────────────────────────────────────────────
        /**
         * @param {Object} req
         * @param {string} req.audioBase64
         * @param {string} [req.mimeType]
         * @param {'te'|'hi'|'en'} [req.language_hint]
         * @returns {Promise<{ok, data:{text, language}, request_id}>}
         */
        async transcribe(req) {
            if (!req || !req.audioBase64) {
                throw new Error('[SympClient] transcribe: audioBase64 required');
            }
            const requestId = newRequestId();
            this._beforeRequest(requestId, this._paths.TRANSCRIBE, 'POST');
            const res = await this.fetch(this._url(this._paths.TRANSCRIBE), {
                method:  'POST',
                headers: await this._authHeaders(requestId),
                body:    JSON.stringify({
                    user_id:       req.user_id || null,
                    audioBase64:   req.audioBase64,
                    mimeType:      req.mimeType || 'audio/webm',
                    language_hint: req.language_hint,
                }),
            });
            return res.json();
        }

        // ── Vision ───────────────────────────────────────────────────────────
        /**
         * @param {Object} req
         * @param {string} req.imageUrl   http(s) URL or data: URI
         * @returns {Promise<{ok, data:{description}, request_id}>}
         */
        async describeImage(req) {
            if (!req || !req.imageUrl) {
                throw new Error('[SympClient] describeImage: imageUrl required');
            }
            const requestId = newRequestId();
            this._beforeRequest(requestId, this._paths.VISION, 'POST');
            const res = await this.fetch(this._url(this._paths.VISION), {
                method:  'POST',
                headers: await this._authHeaders(requestId),
                body:    JSON.stringify({
                    user_id:  req.user_id || null,
                    imageUrl: req.imageUrl,
                }),
            });
            return res.json();
        }

        // ── Post-session summariser ──────────────────────────────────────────
        /**
         * @param {Object} req
         * @param {string} [req.user_id]       Optional in jwt mode.
         * @param {'ai_chat'|'ai_call'|'human_chat'|'human_call'} req.session_type
         * @param {string} req.session_id
         * @param {Array}  req.transcript      [{role, content, ts?}]
         * @param {string} req.started_at      ISO
         * @param {string} req.ended_at        ISO
         */
        async ingestSession(req) {
            if (!req) throw new Error('[SympClient] ingestSession: payload required');
            if (!req.session_type || !req.session_id) {
                throw new Error('[SympClient] ingestSession: session_type and session_id required');
            }
            if (!Array.isArray(req.transcript)) {
                throw new Error('[SympClient] ingestSession: transcript array required');
            }
            if (this._mode === 'api-key' && !req.user_id) {
                throw new Error('[SympClient] ingestSession: user_id required in api-key mode');
            }

            const requestId = newRequestId();
            this._beforeRequest(requestId, this._paths.SESSION_INGEST, 'POST');
            const res = await this.fetch(this._url(this._paths.SESSION_INGEST), {
                method:  'POST',
                headers: await this._authHeaders(requestId),
                body:    JSON.stringify({
                    user_id:      req.user_id || null,
                    session_type: req.session_type,
                    session_id:   req.session_id,
                    transcript:   req.transcript,
                    started_at:   req.started_at,
                    ended_at:     req.ended_at,
                }),
            });
            return res.json();
        }

        // ── Omniscient Analyser ──────────────────────────────────────────────
        /**
         * @param {Object}  [req]
         * @param {string}  [req.user_id]   Optional in jwt mode (proxy overrides).
         * @param {string}  [req.date]      YYYY-MM-DD; defaults to yesterday UTC.
         * @param {boolean} [req.force]     Re-run even if already analysed.
         * @returns {Promise<{ok, data:{skipped, analysis_date, analysis?}, request_id}>}
         */
        async runAnalysis(req) {
            req = req || {};
            const requestId = newRequestId();
            this._beforeRequest(requestId, this._paths.ANALYSE_RUN, 'POST');
            const res = await this.fetch(this._url(this._paths.ANALYSE_RUN), {
                method:  'POST',
                headers: await this._authHeaders(requestId),
                body:    JSON.stringify({
                    user_id: req.user_id || null,
                    date:    req.date    || undefined,
                    force:   !!req.force,
                }),
            });
            return res.json();
        }

        // Convenience alias — fire-and-forget version used at app start-up.
        // Swallows errors so it can be safely chained without try/catch.
        triggerAnalysis(req) {
            return this.runAnalysis(req || {}).catch(e => ({
                ok: false, error: { code: 'CLIENT_ERROR', message: String(e.message || e) },
            }));
        }

        // ── Listener Co-Pilot hint ───────────────────────────────────────────
        /**
         * Returns a private, listener-only suggestion grounded in the seeker's
         * Vault analysis + the most recent transcript lines.
         *
         * @param {Object} req
         * @param {string} req.target_user_id   Seeker whose Vault should be used (NOT the listener).
         * @param {Array<{role:string, content:string}>} req.recent_messages
         * @param {string} [req.session_id]
         * @param {string} [req.listener_question]   Optional explicit ask from listener.
         */
        async getCopilotHint(req) {
            if (!req || !req.target_user_id) {
                throw new Error('[SympClient] getCopilotHint: target_user_id required');
            }
            const requestId = newRequestId();
            this._beforeRequest(requestId, this._paths.COPILOT_HINT, 'POST');
            const res = await this.fetch(this._url(this._paths.COPILOT_HINT), {
                method:  'POST',
                headers: await this._authHeaders(requestId),
                body:    JSON.stringify({
                    user_id:           req.user_id || null,
                    target_user_id:    req.target_user_id,
                    session_id:        req.session_id        || null,
                    recent_messages:   Array.isArray(req.recent_messages) ? req.recent_messages : [],
                    listener_question: req.listener_question || null,
                }),
            });
            return res.json();
        }

        // ── Whisper WebSocket (ships later) ──────────────────────────────────
        openWhisper(_opts) {
            throw new Error('[SympClient] openWhisper: ships with the live transcript pipeline');
        }
    }

    return SympClient;
});

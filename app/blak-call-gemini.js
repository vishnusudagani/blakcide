/* Blak voice call — Gemini Live (speech-to-speech) path.
 *
 * Uses gemini-3.1-flash-live-preview, the cheapest current native-audio Live
 * model. The browser opens the Gemini Live WebSocket directly using a short-
 * lived ephemeral token minted by /api/gemini-live-session (the raw key never
 * reaches the client).
 *
 * PROGRESSIVE ENHANCEMENT + SAFETY: this file loads AFTER app.js and WRAPS the
 * existing window.startAICall / endAICall / toggleAICallMute / toggleAICallSpeaker.
 * If the Gemini token can't be minted (key unset, Google error) or the WS fails
 * to open, it transparently falls back to the original OpenAI Realtime call —
 * so calls never break, and Gemini is used only when it actually connects.
 *
 * ⚠️ NEEDS A REAL-DEVICE TEST: realtime audio (mic capture, PCM streaming,
 * playback, barge-in) can't be verified in CI. Test on a phone before relying
 * on it; until then the OpenAI fallback keeps calls working.
 *
 * Audio: Gemini Live wants 16 kHz PCM16 in, emits 24 kHz PCM16 out.
 */
(function () {
    'use strict';

    var WS_BASE = 'wss://generativelanguage.googleapis.com/ws/' +
        'google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

    var IN_RATE  = 16000;  // mic → Gemini
    var OUT_RATE = 24000;  // Gemini → speaker

    var ws = null, audioCtx = null, gain = null;
    var micStream = null, micSource = null, processor = null;
    var active = false, muted = false, speaker = true, aiSpeaking = false;
    var nextPlayTime = 0, secs = 0, timerInt = null;
    var aiTextBuf = '';

    function $(id) { return document.getElementById(id); }
    function setStatus(t) { var e = $('ai-call-status'); if (e) e.innerText = t; }

    function setTimer() {
        timerInt = setInterval(function () {
            secs++;
            var m = Math.floor(secs / 60), s = secs % 60;
            var el = $('ai-call-timer');
            if (el) el.innerText = m + ':' + String(s).padStart(2, '0');
        }, 1000);
    }

    function addTranscript(who, text) {
        var el = $('ai-call-transcript');
        if (!el || !text) return;
        var wrap = document.createElement('div');
        wrap.className = 'ai-call-msg';
        wrap.innerHTML = '<span class="ai-call-msg-label">' + (who === 'user' ? 'You' : 'AI') +
            '</span><span class="ai-call-msg-text-' + who + '"></span>';
        wrap.querySelector('span:last-child').textContent = text;
        el.appendChild(wrap);
        el.scrollTop = el.scrollHeight;
    }

    function setSpeaking(on) {
        aiSpeaking = on;
        var av = $('ai-call-avatar-el');
        if (av) av.classList.toggle('ai-speaking', on);
        setStatus(on ? 'Speaking…' : 'Listening…');
    }

    // ── PCM16 base64 (24 kHz) → scheduled playback through a GainNode ──────────
    function enqueueAudio(b64) {
        if (!audioCtx || !active || !speaker) return;
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var int16 = new Int16Array(bytes.buffer);
        var f32 = new Float32Array(int16.length);
        for (var j = 0; j < int16.length; j++) f32[j] = int16[j] / 32768;
        var buf = audioCtx.createBuffer(1, f32.length, OUT_RATE);
        buf.copyToChannel(f32, 0);
        var src = audioCtx.createBufferSource();
        src.buffer = buf;
        src.connect(gain || audioCtx.destination);
        var now = audioCtx.currentTime;
        var when = Math.max(now + 0.08, nextPlayTime);
        src.start(when);
        nextPlayTime = when + buf.duration;
        if (!aiSpeaking) setSpeaking(true);
    }

    // Instantly silence scheduled audio (barge-in / interruption / end).
    function stopAudio() {
        if (!audioCtx) return;
        nextPlayTime = audioCtx.currentTime;
        if (gain) {
            var g = gain.gain;
            g.cancelScheduledValues(audioCtx.currentTime);
            g.setValueAtTime(0, audioCtx.currentTime);
            g.linearRampToValueAtTime(1, audioCtx.currentTime + 0.03);
        }
    }

    // ── Mic → downsample to 16 kHz PCM16 → realtimeInput ──────────────────────
    function startMicCapture() {
        if (!micStream || !audioCtx || !ws) return;
        var sourceRate = audioCtx.sampleRate;
        micSource = audioCtx.createMediaStreamSource(micStream);
        processor = audioCtx.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = function (e) {
            if (!active || muted || !ws || ws.readyState !== WebSocket.OPEN) return;
            if (aiSpeaking) return; // duck mic while Blak talks — avoids echo false-triggers
            var input = e.inputBuffer.getChannelData(0);
            var ratio = sourceRate / IN_RATE;
            var outLen = Math.floor(input.length / ratio);
            var pcm16 = new Int16Array(outLen);
            for (var i = 0; i < outLen; i++) {
                var s = input[Math.round(i * ratio)] || 0;
                pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
            }
            var bytes = new Uint8Array(pcm16.buffer);
            var b = '', CHK = 8192;
            for (var k = 0; k < bytes.length; k += CHK) {
                b += String.fromCharCode.apply(null, bytes.subarray(k, k + CHK));
            }
            ws.send(JSON.stringify({
                realtimeInput: { audio: { data: btoa(b), mimeType: 'audio/pcm;rate=' + IN_RATE } },
            }));
        };
        micSource.connect(processor);
        processor.connect(audioCtx.destination);
    }

    function handleServerMessage(obj) {
        if (!obj) return;
        if (obj.setupComplete) { setStatus('Listening…'); return; }
        var sc = obj.serverContent;
        if (!sc) return;
        if (sc.interrupted) { stopAudio(); setSpeaking(false); return; }
        if (sc.modelTurn && sc.modelTurn.parts) {
            sc.modelTurn.parts.forEach(function (p) {
                if (p.inlineData && p.inlineData.data &&
                    (p.inlineData.mimeType || '').indexOf('audio') === 0) {
                    enqueueAudio(p.inlineData.data);
                }
            });
        }
        if (sc.outputTranscription && sc.outputTranscription.text) {
            aiTextBuf += sc.outputTranscription.text;
        }
        if (sc.inputTranscription && sc.inputTranscription.text) {
            addTranscript('user', sc.inputTranscription.text);
        }
        if (sc.turnComplete) {
            if (aiTextBuf.trim()) { addTranscript('ai', aiTextBuf.trim()); aiTextBuf = ''; }
            setSpeaking(false);
        }
    }

    var BlakGeminiCall = {
        isActive: function () { return active; },

        // Returns true if Gemini took over the call; false → caller falls back.
        start: async function () {
            var res;
            try {
                res = await fetch('/api/gemini-live-session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_id: (window.currentUser && window.currentUser.id) || null }),
                });
            } catch (e) { console.warn('[gemini-call] token fetch failed:', e.message); return false; }
            if (!res || !res.ok) {
                console.warn('[gemini-call] no token (status ' + (res && res.status) + ') — using fallback');
                return false; // no UI shown yet → clean fallback to OpenAI
            }
            var cfg = await res.json();
            if (!cfg || !cfg.wsUrl) return false;
            // The Cloud Run bridge authenticates us by our Supabase access token,
            // passed as a WS subprotocol. No session → can't open the bridge.
            var sbToken = null;
            try {
                var sb = window._sbClient;
                if (sb && sb.auth) { var ses = await sb.auth.getSession(); sbToken = ses && ses.data && ses.data.session && ses.data.session.access_token; }
            } catch (_) {}
            if (!sbToken) { console.warn('[gemini-call] no Supabase session — using fallback'); return false; }

            active = true; muted = false; speaker = true; secs = 0; aiTextBuf = ''; nextPlayTime = 0;

            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
                audioCtx.resume();
                gain = audioCtx.createGain();
                gain.gain.value = 1;
                gain.connect(audioCtx.destination);
            } catch (e) { console.warn('[gemini-call] AudioContext:', e); }

            var ov = $('ai-call-overlay');
            if (ov) ov.style.display = 'flex';
            var tr = $('ai-call-transcript'); if (tr) tr.innerHTML = '';
            setStatus('Connecting…');
            var tEl = $('ai-call-timer'); if (tEl) tEl.innerText = '0:00';
            setTimer();

            try {
                micStream = await navigator.mediaDevices.getUserMedia({
                    audio: { echoCancellation: true, noiseSuppression: true }, video: false,
                });
            } catch (e) { console.warn('[gemini-call] mic denied:', e); }

            ws = new WebSocket(cfg.wsUrl, ['blak.v1', 'blak.jwt.' + sbToken]);
            ws.onopen = function () {
                setStatus('Connected…');
                ws.send(JSON.stringify({
                    setup: {
                        model: 'models/' + cfg.model,
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice || 'Aoede' } } },
                        },
                        systemInstruction: { parts: [{ text: cfg.instructions || '' }] },
                        inputAudioTranscription: {},
                        outputAudioTranscription: {},
                    },
                }));
                if (micStream) startMicCapture();
            };
            ws.onmessage = function (ev) {
                if (typeof ev.data === 'string') {
                    try { handleServerMessage(JSON.parse(ev.data)); } catch (_) {}
                } else if (ev.data && ev.data.text) {
                    ev.data.text().then(function (t) { try { handleServerMessage(JSON.parse(t)); } catch (_) {} });
                }
            };
            ws.onerror = function (e) { console.error('[gemini-call] ws error', e); };
            ws.onclose = function (e) {
                console.log('[gemini-call] ws closed', e.code, e.reason);
                if (active) setStatus('Reconnecting…');
            };
            return true;
        },

        end: function () {
            active = false;
            clearInterval(timerInt);
            stopAudio();
            if (processor) { try { processor.disconnect(); } catch (_) {} processor = null; }
            if (micSource) { try { micSource.disconnect(); } catch (_) {} micSource = null; }
            if (ws) { try { ws.close(); } catch (_) {} ws = null; }
            if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
            if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
            gain = null; aiSpeaking = false;
            var ov = $('ai-call-overlay');
            if (ov) ov.style.display = 'none';
        },

        toggleMute: function () {
            muted = !muted;
            var btn = $('ai-call-mute-btn');
            if (btn) {
                btn.innerHTML = '<ion-icon name="' + (muted ? 'mic-off-outline' : 'mic-outline') + '"></ion-icon>';
                btn.classList.toggle('btn-muted', muted);
            }
        },

        toggleSpeaker: function () {
            speaker = !speaker;
            if (!speaker) stopAudio();
            var btn = $('ai-call-speaker-btn');
            if (btn) {
                btn.innerHTML = '<ion-icon name="' + (speaker ? 'volume-high-outline' : 'volume-mute-outline') + '"></ion-icon>';
                btn.classList.toggle('btn-muted', !speaker);
            }
        },
    };
    window.BlakGeminiCall = BlakGeminiCall;

    // ── Wrap the existing call entrypoints (OpenAI stays the fallback) ─────────
    var _origStart   = window.startAICall;
    var _origEnd     = window.endAICall;
    var _origMute    = window.toggleAICallMute;
    var _origSpeaker = window.toggleAICallSpeaker;

    window.startAICall = async function () {
        try {
            if (await BlakGeminiCall.start()) return; // Gemini connected
        } catch (e) { console.warn('[gemini-call] start failed, falling back:', e && e.message); }
        if (typeof _origStart === 'function') return _origStart();
    };
    window.endAICall = function () {
        if (BlakGeminiCall.isActive()) return BlakGeminiCall.end();
        if (typeof _origEnd === 'function') return _origEnd();
    };
    window.toggleAICallMute = function () {
        if (BlakGeminiCall.isActive()) return BlakGeminiCall.toggleMute();
        if (typeof _origMute === 'function') return _origMute();
    };
    window.toggleAICallSpeaker = function () {
        if (BlakGeminiCall.isActive()) return BlakGeminiCall.toggleSpeaker();
        if (typeof _origSpeaker === 'function') return _origSpeaker();
    };
})();

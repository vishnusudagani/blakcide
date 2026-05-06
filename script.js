/* ════════════════════════════════════════════════════════════════════
   blaksyd — landing  ·  interaction layer
   ──────────────────────────────────────────────────────────────────────
   - theme toggle with bloom sweep
   - vibe slider that re-tints the Symp Core
   - four micro-trials (Journal · Nexus · Echo · Listeners)
   - Echo trial uses the real /api/chat endpoint (one-shot)
   - auth modal hand-off
   ════════════════════════════════════════════════════════════════════ */

(() => {
    'use strict';

    /* ─── tiny utils ─────────────────────────────────────────────── */
    const $  = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    /* ═══════════════════════════════════════════════════════════════
       1. THEME — saved preference, system fallback, bloom transition
       ═══════════════════════════════════════════════════════════════ */
    const THEME_KEY = 'blaksyd:theme';
    function initTheme() {
        const saved = localStorage.getItem(THEME_KEY);
        const sys   = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        const theme = saved || sys;
        document.documentElement.setAttribute('data-theme', theme);
        updateThemeMeta(theme);
    }
    function updateThemeMeta(theme) {
        const meta = $('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', theme === 'light' ? '#F8F4ED' : '#0F172A');
    }
    function setTheme(theme, originEl) {
        const bloom = $('#theme-bloom');
        if (bloom && originEl) {
            const r = originEl.getBoundingClientRect();
            bloom.style.setProperty('--bx', `${r.left + r.width / 2}px`);
            bloom.style.setProperty('--by', `${r.top + r.height / 2}px`);
            bloom.classList.remove('bloom-active');
            void bloom.offsetWidth; // restart animation
            bloom.classList.add('bloom-active');
        }
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem(THEME_KEY, theme);
        updateThemeMeta(theme);
    }
    function bindTheme() {
        const btn = $('#theme-toggle');
        if (!btn) return;
        btn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            setTheme(next, btn);
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       2. NAV scroll state + button magnetic shimmer
       ═══════════════════════════════════════════════════════════════ */
    function bindNav() {
        const nav = $('.top-nav');
        const onScroll = () => nav?.classList.toggle('scrolled', window.scrollY > 8);
        window.addEventListener('scroll', onScroll, { passive: true });
        onScroll();

        $$('.nav-tell-us, .hook-cta').forEach(b => {
            b.addEventListener('mousemove', (e) => {
                const r = b.getBoundingClientRect();
                b.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
                b.style.setProperty('--my', `${((e.clientY - r.top)  / r.height) * 100}%`);
            });
        });

        $('#nav-tell-us')?.addEventListener('click', () => openAuth());
    }

    /* ═══════════════════════════════════════════════════════════════
       3. HERO input → Echo trial
       ═══════════════════════════════════════════════════════════════ */
    function bindHero() {
        const form = $('#hero-input-form');
        const input = $('#hero-input');
        if (!form) return;
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) { input.focus(); return; }
            openTrial('echo', { seed: text });
            input.value = '';
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       4. VIBE PAD  —  drag a dot in 2-D space
       maps emotional state, re-tints the Symp Core in real time
       ═══════════════════════════════════════════════════════════════ */
    const vibePresets = [
        // [xMin, xMax, yMin, yMax, word, line, orbA, orbB, orbC]
        // x = heavy (0) → light (1)  ·  y = still (0) → activated (1)
        { x:[0,.33], y:[.66,1],   w:'on edge',          l:"a lot is moving inside. let's slow it down together.",
          a:'rgba(167,139,250,.55)', b:'rgba(245,107,107,.4)', c:'rgba(94,234,212,.3)' },
        { x:[.33,.66], y:[.66,1], w:'wired',            l:'energy without a home. we have a place for it.',
          a:'rgba(245,185,98,.55)',  b:'rgba(167,139,250,.4)', c:'rgba(94,234,212,.4)' },
        { x:[.66,1], y:[.66,1],   w:'lit up',           l:'this is a good kind of awake. enjoy it.',
          a:'rgba(94,234,212,.55)',  b:'rgba(245,185,98,.45)', c:'rgba(167,243,208,.4)' },
        { x:[0,.33], y:[.33,.66], w:'heavy',            l:"the weight is real. you don't have to lift it alone.",
          a:'rgba(167,139,250,.5)',  b:'rgba(80,100,160,.4)',  c:'rgba(94,234,212,.25)' },
        { x:[.33,.66], y:[.33,.66], w:'somewhere in the middle', l:"that's a fine place to sit. take a breath.",
          a:'rgba(245,185,98,.45)',  b:'rgba(94,234,212,.35)', c:'rgba(167,139,250,.3)' },
        { x:[.66,1], y:[.33,.66], w:'open',             l:'a soft kind of okay. nice to meet you here.',
          a:'rgba(94,234,212,.5)',   b:'rgba(167,243,208,.4)', c:'rgba(245,185,98,.3)' },
        { x:[0,.33], y:[0,.33],   w:'flat',             l:"low and quiet. we'll just sit with you.",
          a:'rgba(80,100,160,.5)',   b:'rgba(167,139,250,.35)',c:'rgba(94,234,212,.2)' },
        { x:[.33,.66], y:[0,.33], w:'still',            l:'the rest you needed. let it stay a while.',
          a:'rgba(94,234,212,.4)',   b:'rgba(167,139,250,.3)', c:'rgba(245,185,98,.3)' },
        { x:[.66,1], y:[0,.33],   w:'at peace',         l:"hold this one. it's the rare one.",
          a:'rgba(167,243,208,.55)', b:'rgba(94,234,212,.4)',  c:'rgba(245,185,98,.3)' },
    ];

    function vibeReadout(nx, ny) {
        for (const p of vibePresets) {
            if (nx >= p.x[0] && nx <= p.x[1] && ny >= p.y[0] && ny <= p.y[1]) return p;
        }
        return vibePresets[4];
    }

    function bindVibe() {
        const pad   = $('#vibe-pad');
        const dot   = $('#vibe-dot');
        const glow  = $('#vibe-glow');
        const word  = $('#vibe-word');
        const line  = $('#vibe-line');
        const core  = $('#symp-core');
        if (!pad) return;

        // start centered
        let x = .5, y = .5;
        let dragging = false;

        function paint(nx, ny) {
            const padRect = pad.getBoundingClientRect();
            const px = nx * padRect.width;
            const py = (1 - ny) * padRect.height;  // y inverted: top = 1
            dot.style.left  = `${px}px`;
            dot.style.top   = `${py}px`;
            glow.style.left = `${px}px`;
            glow.style.top  = `${py}px`;

            const r = vibeReadout(nx, ny);
            if (word.textContent !== r.w) {
                word.style.opacity = 0;
                setTimeout(() => { word.textContent = r.w; word.style.opacity = 1; }, 180);
            }
            line.textContent = r.l;

            // Re-tint the Symp Core orb gradients
            core?.style.setProperty('--orb-a', r.a);
            core?.style.setProperty('--orb-b', r.b);
            core?.style.setProperty('--orb-c', r.c);

            // aria
            pad.setAttribute('aria-valuenow', Math.round((nx + ny) * 50));
        }

        function pointerXY(ev) {
            const rect = pad.getBoundingClientRect();
            const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
            const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY) - rect.top;
            return {
                nx: clamp(cx / rect.width, 0, 1),
                ny: clamp(1 - cy / rect.height, 0, 1),  // invert
            };
        }

        function start(ev) {
            dragging = true;
            dot.classList.add('dragging');
            const { nx, ny } = pointerXY(ev);
            x = nx; y = ny; paint(x, y);
            ev.preventDefault?.();
        }
        function move(ev) {
            if (!dragging) return;
            const { nx, ny } = pointerXY(ev);
            x = nx; y = ny; paint(x, y);
            ev.preventDefault?.();
        }
        function end() {
            dragging = false;
            dot.classList.remove('dragging');
        }

        pad.addEventListener('mousedown', start);
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', end);
        pad.addEventListener('touchstart', start, { passive: false });
        window.addEventListener('touchmove', move, { passive: false });
        window.addEventListener('touchend', end);

        // Keyboard support
        pad.addEventListener('keydown', (e) => {
            const step = .06;
            if (e.key === 'ArrowLeft')  x = clamp(x - step, 0, 1);
            else if (e.key === 'ArrowRight') x = clamp(x + step, 0, 1);
            else if (e.key === 'ArrowUp')    y = clamp(y + step, 0, 1);
            else if (e.key === 'ArrowDown')  y = clamp(y - step, 0, 1);
            else return;
            paint(x, y); e.preventDefault();
        });

        // initial paint after layout
        requestAnimationFrame(() => paint(x, y));
        window.addEventListener('resize', () => paint(x, y));
    }

    /* ═══════════════════════════════════════════════════════════════
       5. TRIAL OVERLAY  —  expanded glass-pane experience
       ═══════════════════════════════════════════════════════════════ */
    const overlay  = () => $('#trial-overlay');
    const card     = () => $('#trial-card');
    const titleEl  = () => $('#trial-title');
    const tagEl    = () => $('#trial-tag');
    const bodyEl   = () => $('#trial-body');
    const hookEl   = () => $('#trial-hook');
    const progress = () => $('.trial-progress-bar');

    function showHook(delay = 600) {
        const h = hookEl();
        if (!h) return;
        setTimeout(() => {
            h.hidden = false;
            h.style.opacity = 0;
            h.style.transform = 'translateY(10px)';
            h.style.transition = 'opacity .8s ease, transform .8s ease';
            requestAnimationFrame(() => {
                h.style.opacity = 1;
                h.style.transform = 'translateY(0)';
            });
            progress() && (progress().style.width = '100%');
        }, delay);
    }

    function setProgress(pct) {
        const p = progress(); if (p) p.style.width = `${pct}%`;
    }

    function openTrial(kind, opts = {}) {
        const o = overlay(); if (!o) return;
        const ttl = $('#trial-tag');
        const sub = $('#trial-title');

        const meta = TRIALS[kind];
        if (!meta) return;
        ttl.textContent = meta.tag;
        sub.textContent = meta.title;

        // reset hook + progress
        const h = hookEl(); if (h) { h.hidden = true; h.removeAttribute('style'); }
        setProgress(8);

        // populate body
        bodyEl().innerHTML = '';
        bodyEl().appendChild(meta.render(opts));

        o.classList.add('is-open');
        o.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';

        // run after-mount hook
        meta.afterMount?.(opts);
    }

    function closeTrial() {
        const o = overlay(); if (!o) return;
        o.classList.remove('is-open');
        o.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }

    function bindOverlay() {
        $$('.pane').forEach(p => {
            const kind = p.dataset.trial;
            p.addEventListener('click', () => openTrial(kind));
            p.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTrial(kind); }
            });
        });
        $$('[data-close]').forEach(el => el.addEventListener('click', closeTrial));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay()?.classList.contains('is-open')) closeTrial();
        });

        $('#hook-cta')?.addEventListener('click', () => {
            closeTrial();
            setTimeout(() => openAuth(), 250);
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       6. THE FOUR TRIALS
       ═══════════════════════════════════════════════════════════════ */

    const TRIALS = {

        /* ─────────── JOURNAL ─────────── */
        journal: {
            tag: 'a place to leave it',
            title: 'Journal',
            render() {
                const el = document.createElement('div');
                el.innerHTML = `
                    <p class="journal-prompt">type one sentence you couldn't say out loud today. press enter to leave it behind.</p>
                    <div class="journal-paper" id="j-paper">
                        <textarea
                            id="j-text"
                            class="journal-textarea"
                            placeholder="i feel like…"
                            spellcheck="false"
                            autocomplete="off"
                            rows="3"></textarea>
                        <div class="journal-meta">
                            <span id="j-count">0 / 220</span>
                            <button type="button" id="j-release">release ↵</button>
                        </div>
                        <div class="dust-layer" id="j-dust"></div>
                    </div>
                    <div class="journal-validation" id="j-val" aria-live="polite">
                        <strong>Echo</strong>
                        <span id="j-val-text"></span>
                    </div>
                `;
                return el;
            },
            afterMount() {
                const ta   = $('#j-text');
                const cnt  = $('#j-count');
                const btn  = $('#j-release');
                const dust = $('#j-dust');
                const val  = $('#j-val');
                const valT = $('#j-val-text');

                setTimeout(() => ta?.focus(), 250);
                setProgress(28);

                ta.addEventListener('input', () => {
                    cnt.textContent = `${ta.value.length} / 220`;
                    if (ta.value.length > 220) ta.value = ta.value.slice(0, 220);
                });

                ta.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); release(); }
                });
                btn.addEventListener('click', release);

                async function release() {
                    const txt = ta.value.trim();
                    if (!txt) { ta.focus(); return; }

                    setProgress(60);

                    // capture text bounds
                    const paperRect = $('#j-paper').getBoundingClientRect();
                    const taRect    = ta.getBoundingClientRect();
                    const baseLeft  = taRect.left - paperRect.left + 16;
                    const baseTop   = taRect.top  - paperRect.top  + 16;

                    // build dust particles
                    const PIECES = Math.min(60, Math.max(20, txt.length * 1.5));
                    for (let i = 0; i < PIECES; i++) {
                        const d = document.createElement('span');
                        d.className = 'dust-particle';
                        const rx = Math.random() * (taRect.width - 30);
                        const ry = Math.random() * Math.min(taRect.height, 60);
                        d.style.left = `${baseLeft + rx}px`;
                        d.style.top  = `${baseTop + ry}px`;
                        const angle = (Math.random() - .5) * Math.PI;
                        const dist  = 60 + Math.random() * 140;
                        d.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
                        d.style.setProperty('--dy', `${-40 - Math.random() * dist}px`);
                        d.style.animationDelay = `${Math.random() * .2}s`;
                        dust.appendChild(d);
                    }
                    requestAnimationFrame(() => $$('.dust-particle', dust).forEach(p => p.classList.add('go')));

                    // fade out the text
                    ta.style.transition = 'opacity .55s ease';
                    ta.style.opacity = 0;

                    await sleep(900);
                    ta.value = '';
                    ta.style.opacity = 1;
                    cnt.textContent = '0 / 220';
                    dust.innerHTML = '';

                    valT.textContent = "that sounds incredibly heavy to carry alone. your thought is safe here. we can unpack it whenever you are ready.";
                    val.classList.add('is-shown');
                    showHook(900);
                }
            },
        },

        /* ─────────── NEXUS ─────────── */
        nexus: {
            tag: 'you are not the only one',
            title: 'Nexus',
            render() {
                const el = document.createElement('div');
                el.innerHTML = `
                    <p class="nexus-prompt">what is weighing on you right now? two words is enough.</p>
                    <input id="nx-input" class="nexus-input" placeholder="e.g. anxiety about the future" autocomplete="off" />
                    <div class="nexus-feed" id="nx-feed">
                        <div class="nexus-card">
                            <div class="nexus-card-head">
                                <span class="nexus-handle">QuietNorth_22</span>
                                <span class="nexus-match">— %</span>
                            </div>
                            <p class="nexus-body">i scroll past everyone's highlight reel and feel further behind every time</p>
                        </div>
                        <div class="nexus-card">
                            <div class="nexus-card-head">
                                <span class="nexus-handle">NeonSky_42</span>
                                <span class="nexus-match">— %</span>
                            </div>
                            <p class="nexus-body">lying awake at 3am wondering if i'm on the right path. it feels overwhelming today.</p>
                        </div>
                        <div class="nexus-card">
                            <div class="nexus-card-head">
                                <span class="nexus-handle">SoftLamp_7</span>
                                <span class="nexus-match">— %</span>
                            </div>
                            <p class="nexus-body">i smile at work all day, then sit in my car and just exhale</p>
                        </div>
                    </div>
                    <p class="nexus-status" id="nx-status">type a feeling — we'll find your match.</p>
                `;
                return el;
            },
            afterMount() {
                const inp    = $('#nx-input');
                const feed   = $('#nx-feed');
                const status = $('#nx-status');
                setTimeout(() => inp?.focus(), 250);
                setProgress(28);

                let armed = false;
                inp.addEventListener('input', () => {
                    if (inp.value.trim().length >= 3 && !armed) {
                        armed = true;
                        runMatch();
                    }
                });
                inp.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && !armed) { armed = true; runMatch(); }
                });

                async function runMatch() {
                    setProgress(55);
                    status.innerHTML = `<span class="nx-spinner"></span> reading the room…`;
                    await sleep(700);
                    status.innerHTML = `<span class="nx-spinner"></span> finding people who feel exactly like this…`;
                    await sleep(900);

                    // reveal the matched card with the strongest pull
                    const cards = $$('.nexus-card', feed);
                    cards[1].classList.add('revealed');
                    cards[1].querySelector('.nexus-match').textContent = '🔥 94% vibe match';

                    await sleep(600);
                    cards[0].classList.add('revealed');
                    cards[0].querySelector('.nexus-match').textContent = '82% vibe match';
                    await sleep(500);
                    cards[2].classList.add('revealed');
                    cards[2].querySelector('.nexus-match').textContent = '78% vibe match';

                    status.textContent = "you are not the only one feeling this. you never were.";
                    showHook(700);
                }
            },
        },

        /* ─────────── ECHO ─────────── */
        echo: {
            tag: 'a voice in the quiet',
            title: 'Echo',
            render() {
                const el = document.createElement('div');
                el.innerHTML = `
                    <div class="echo-stream" id="e-stream">
                        <div class="echo-msg echo-msg-echo">echo is awake. say hello, or drop a thought.</div>
                    </div>
                    <div class="echo-input-row">
                        <input id="e-input" placeholder="i'm just tired…" autocomplete="off" />
                        <button id="e-send" class="echo-send">send</button>
                    </div>
                    <p style="margin-top:14px;font-size:11.5px;color:var(--ink-mute);text-align:center;letter-spacing:.04em">
                        a one-message taste · the full conversation lives inside your vault
                    </p>
                `;
                return el;
            },
            afterMount(opts = {}) {
                const stream = $('#e-stream');
                const inp    = $('#e-input');
                const btn    = $('#e-send');
                let used     = false;

                setTimeout(() => inp?.focus(), 250);
                setProgress(28);

                if (opts.seed) {
                    inp.value = opts.seed;
                    setTimeout(send, 320);
                }

                btn.addEventListener('click', send);
                inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

                async function send() {
                    if (used) return;
                    const txt = inp.value.trim();
                    if (!txt) { inp.focus(); return; }
                    used = true;
                    btn.disabled = true;
                    inp.disabled = true;

                    // user message
                    const me = document.createElement('div');
                    me.className = 'echo-msg echo-msg-you';
                    me.textContent = txt;
                    stream.appendChild(me);
                    stream.scrollTop = stream.scrollHeight;

                    // typing bubble
                    const bot = document.createElement('div');
                    bot.className = 'echo-msg echo-msg-echo typing';
                    bot.textContent = '';
                    stream.appendChild(bot);

                    setProgress(60);

                    let reply = '';
                    try {
                        const r = await fetch('/api/chat', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                stream: false,
                                messages: [
                                    {
                                        role: 'system',
                                        content:
                                            'You are Echo, a quietly empathetic companion on the blaksyd landing page. ' +
                                            'You are giving the user a single, deeply present response — under 50 words, ' +
                                            'warm, no advice, no clinical language, no questions piled on. ' +
                                            'Match their language. Acknowledge what they said specifically, gently. ' +
                                            'Reflect back the feeling in plain words. Lowercase or normal sentence case is fine. ' +
                                            'No emojis. No "I\'m sorry to hear". Sound like a friend who reads slowly.',
                                    },
                                    { role: 'user', content: txt },
                                ],
                            }),
                        });
                        if (r.ok) {
                            const data = await r.json();
                            reply = (data.reply || data.message || '').toString().trim();
                        }
                    } catch (_) { /* fall through */ }

                    if (!reply) reply = canonicalEchoReply(txt);

                    await typeOut(bot, reply);
                    bot.classList.remove('typing');
                    showHook(800);
                }

                function canonicalEchoReply(txt) {
                    const t = txt.toLowerCase();
                    if (/(tired|exhaust|drain)/.test(t))
                        return "i hear you. the kind of tired that sleep doesn't fix, right? i'm right here. take a breath, there's no rush.";
                    if (/(anxious|anxiety|panic|nerv)/.test(t))
                        return "your body is doing a lot right now, even if no one can see it. that's real. you can sit here as long as you need.";
                    if (/(sad|down|low|empty|numb)/.test(t))
                        return "you don't have to call it anything. it's heavy and that's enough of a reason. i'm here.";
                    if (/(lonely|alone|isolat)/.test(t))
                        return "being unseen is its own kind of loud. you are seen here. not by an algorithm — by us.";
                    if (/(angry|mad|furious|rage)/.test(t))
                        return "anger usually means something underneath it got hurt. you don't have to explain. i'm not going anywhere.";
                    return "thank you for trusting me with that. it's safe here. you don't have to perform anything.";
                }

                async function typeOut(node, text) {
                    // cascade at a calm reading pace — ~32 chars/sec
                    const total = text.length;
                    let out = '';
                    for (let i = 0; i < total; i++) {
                        out += text[i];
                        node.textContent = out;
                        stream.scrollTop = stream.scrollHeight;
                        const ch = text[i];
                        let d = 28;
                        if (ch === ' ') d = 18;
                        if (/[.,!?;:]/.test(ch)) d = 220;
                        if (ch === '\n') d = 320;
                        await sleep(d);
                    }
                }
            },
        },

        /* ─────────── LISTENERS ─────────── */
        listener: {
            tag: 'someone is ready to listen',
            title: 'Listeners',
            render() {
                const el = document.createElement('div');
                el.innerHTML = `
                    <div class="listener-status">
                        <span class="live-dot"></span>
                        <b id="l-online">12 listeners online</b> · trained · anonymous
                    </div>
                    <p class="listener-prompt">sometimes you just need a real human. what do you want to talk about?</p>
                    <div class="listener-tags" id="l-tags">
                        <button class="listener-tag" data-mood="Heartbreak">Heartbreak</button>
                        <button class="listener-tag" data-mood="Work Stress">Work Stress</button>
                        <button class="listener-tag" data-mood="Family">Family</button>
                        <button class="listener-tag" data-mood="Loneliness">Loneliness</button>
                        <button class="listener-tag" data-mood="Burnout">Burnout</button>
                        <button class="listener-tag" data-mood="Just need to vent">Just need to vent</button>
                    </div>
                    <div class="listener-match" id="l-match" aria-live="polite">
                        <p class="listener-match-line">pick a tag above — we'll find someone who's been there.</p>
                    </div>
                `;
                return el;
            },
            afterMount() {
                const tagBox = $('#l-tags');
                const match  = $('#l-match');
                setProgress(28);

                const profiles = {
                    'Heartbreak':  { name: 'Maya',  bio: "navigated a long breakup last year. soft listener, gives you the floor." },
                    'Work Stress': { name: 'Sarah', bio: "navigated burnout before. patient, won't try to fix you." },
                    'Family':      { name: 'Arjun', bio: "knows messy family lines. holds space without taking sides." },
                    'Loneliness':  { name: 'Iris',  bio: "spent a year mostly alone. understands the quiet kind of heavy." },
                    'Burnout':     { name: 'Sarah', bio: "navigated burnout before. patient, won't try to fix you." },
                    'Just need to vent': { name: 'Theo', bio: "the kind of person who actually waits for you to finish." },
                };

                tagBox.addEventListener('click', async (e) => {
                    const btn = e.target.closest('.listener-tag');
                    if (!btn) return;
                    $$('.listener-tag', tagBox).forEach(t => t.classList.remove('is-active'));
                    btn.classList.add('is-active');
                    const mood = btn.dataset.mood;

                    setProgress(55);

                    match.classList.remove('found');
                    match.innerHTML = `
                        <p class="listener-match-line"><span class="nx-spinner"></span> finding a listener who understands "<b>${mood}</b>"…</p>
                    `;
                    await sleep(900);

                    match.innerHTML = `
                        <p class="listener-match-line"><span class="nx-spinner"></span> three matches found. picking the closest one…</p>
                    `;
                    await sleep(800);

                    const p = profiles[mood] || profiles['Just need to vent'];
                    match.classList.add('found');
                    match.innerHTML = `
                        <p class="listener-match-line lead">found ${p.name}. she's online right now.</p>
                        <div class="listener-profile">
                            <div class="listener-avatar">${p.name[0]}</div>
                            <div>
                                <div class="listener-name">${p.name} · trained listener</div>
                                <div class="listener-bio">${p.bio}</div>
                            </div>
                        </div>
                        <p class="listener-match-line" style="margin-top:14px">she'll be there when you're ready. nothing happens until you say so.</p>
                    `;
                    showHook(700);
                });
            },
        },

    };

    /* ═══════════════════════════════════════════════════════════════
       7. AUTH OVERLAY
       ═══════════════════════════════════════════════════════════════ */
    function openAuth() {
        const o = $('#auth-overlay'); if (!o) return;
        o.classList.add('is-open');
        o.setAttribute('aria-hidden', 'false');
        document.body.style.overflow = 'hidden';
        setTimeout(() => $('#email')?.focus(), 320);
    }
    function closeAuth() {
        const o = $('#auth-overlay'); if (!o) return;
        o.classList.remove('is-open');
        o.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
    }
    function bindAuth() {
        $$('[data-close-auth]').forEach(el => el.addEventListener('click', closeAuth));
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && $('#auth-overlay')?.classList.contains('is-open')) closeAuth();
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       8. LISTENERS-ONLINE — gentle drift to feel alive
       ═══════════════════════════════════════════════════════════════ */
    function bindLiveCount() {
        const a = $('#listeners-online');
        const b = $('#l-online');
        let n = 12;
        function tick() {
            const drift = Math.random() < .5 ? -1 : 1;
            n = clamp(n + drift, 8, 18);
            if (a) a.textContent = n;
            if (b) b.textContent = `${n} listeners online`;
        }
        setInterval(tick, 8000);
    }

    /* ═══════════════════════════════════════════════════════════════
       9. FOOTER YEAR
       ═══════════════════════════════════════════════════════════════ */
    function bindMisc() {
        const y = $('#foot-year'); if (y) y.textContent = new Date().getFullYear();
    }

    /* ═══════════════════════════════════════════════════════════════
       BOOT
       ═══════════════════════════════════════════════════════════════ */
    function boot() {
        initTheme();
        bindTheme();
        bindNav();
        bindHero();
        bindVibe();
        bindOverlay();
        bindAuth();
        bindLiveCount();
        bindMisc();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})();

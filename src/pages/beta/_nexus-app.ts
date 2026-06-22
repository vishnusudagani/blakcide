    // ── Nexus, wired ──────────────────────────────────────────────────────────
    // Live Rooms (the star) are genuinely real-time: Supabase Realtime carries
    // PRESENCE (who's here) + BROADCAST (live chat); the nexus_rooms table is the
    // persistent registry + Pulse history. Tribes read the real nexus_communities
    // / nexus_posts. Works for anonymous beta visitors (anon key, RLS-safe) and
    // uses your real identity if signed in.
    import { supabase, supabaseConfigured } from '../../lib/supabaseClient';
    import * as NexusData from './_nexus-data';
    const NX_PROXY = NexusData.NEXUS_PROXY;

    const grad = [
      'linear-gradient(135deg,#5BC0FF,#1872B0)','linear-gradient(135deg,#6AD3B8,#1E7D62)',
      'linear-gradient(135deg,#C9B8FF,#7459CE)','linear-gradient(135deg,#FFD27A,#FF9B6C)',
      'linear-gradient(135deg,#FF6B9D,#7459CE)'
    ];
    const g = (i) => grad[((i % grad.length) + grad.length) % grad.length];
    const IMG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
    const hashIdx = (s) => { let h = 0; s = s || ''; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
    const faces = (n, seed = 0) => { let s = ''; for (let i = 0; i < n; i++) s += '<span style="background:' + g(seed + i) + '"></span>'; return s; };
    const el = (id) => document.getElementById(id);
    const esc = (t) => { const d = document.createElement('div'); d.textContent = (t == null ? '' : String(t)); return d.innerHTML; };
    const rel = (ts) => { if (!ts) return 'now'; let s = Math.max(1, Math.floor((Date.now() - new Date(ts).getTime()) / 1000)); if (s < 60) return s + 's'; let m = Math.floor(s / 60); if (m < 60) return m + 'm'; let h = Math.floor(m / 60); if (h < 24) return h + 'h'; return Math.floor(h / 24) + 'd'; };
    const dayOf = (ts) => Math.max(1, Math.round((Date.now() - new Date(ts).getTime()) / 86400000));

    let toastT;
    function toast(msg) {
      let t = el('nx-toast');
      if (!t) { t = document.createElement('div'); t.id = 'nx-toast'; t.className = 'nx-toast'; document.body.appendChild(t); }
      t.textContent = msg; t.classList.add('show');
      clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
    }

    // ── image sharing: re-encode via canvas to STRIP EXIF (incl. GPS → anonymity)
    //    and cap dimensions, then upload to the public nexus-img bucket ──
    const MAX_IMG = 5 * 1024 * 1024;
    async function processImage(file) {
      try {
        const bmp = await createImageBitmap(file);
        const max = 1600; let w = bmp.width, hh = bmp.height;
        if (w > max || hh > max) { const s = max / Math.max(w, hh); w = Math.round(w * s); hh = Math.round(hh * s); }
        const c = document.createElement('canvas'); c.width = w; c.height = hh;
        c.getContext('2d').drawImage(bmp, 0, 0, w, hh);
        const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
        return blob || file;
      } catch (e) { return file; }
    }
    async function uploadImage(file) {
      if (!file) return null;
      if (file.size > MAX_IMG) { toast('Image is too large (max 5MB).'); return null; }
      const blob = await processImage(file);
      const path = ((window.crypto && crypto.randomUUID) ? crypto.randomUUID() : (Date.now() + '-' + Math.round(Math.random() * 1e9))) + '.jpg';
      const { error } = await supabase.storage.from('nexus-img').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) { toast('Image upload failed — try again.'); return null; }
      const publicUrl = supabase.storage.from('nexus-img').getPublicUrl(path).data.publicUrl;
      if (NX_PROXY) {
        let ok = true; try { ok = await NexusData.moderateImage(publicUrl); } catch (e) {}
        if (!ok) { try { await supabase.storage.from('nexus-img').remove([path]); } catch (e) {} toast('That image didn’t pass our safety check.'); return null; }
      }
      return publicUrl;
    }

    // ── identity: anonymous ALWAYS — never the person's email ──
    // A calm adjective-noun-NN handle (e.g. "quiet-harbor-47"). Derived from a stable
    // seed but revealing nothing about who you are — anonymity is a core Nexus promise.
    // The numeric tail lifts the space from 144 to ~52k combos so two people rarely
    // collide. anonHandle() is reused for signed-in users (seeded by account id).
    const ADJ = ['quiet','warm','steady','night','soft','open','kind','calm','bright','still','easy','true','gentle','lucid','amber','golden','hidden','distant','velvet','lunar','drifting','slow','mellow','wandering'];
    const NOUN = ['harbor','signal','ember','meadow','tide','comet','willow','lantern','river','pine','spark','haven','cedar','orchard','thicket','current','beacon','hollow','summit','delta','cove','aurora','marsh','dune'];
    const anonHandle = (seed) => ADJ[hashIdx(seed) % ADJ.length] + '-' + NOUN[hashIdx(seed + 'n') % NOUN.length] + '-' + (hashIdx(seed + 'x') % 90 + 10);
    // Blak — the one synthetic community member, rendered as a named coral peer
    // (not an anonymous handle). Mirrors nexus_posts/comments.is_ai_author.
    const BLAK_UID = 'b1ab1ab1-aaaa-4aaa-8aaa-b1ab1ab1b1ab';
    const isBlak = (x) => !!(x && (x.is_ai_author || x.author_user_id === BLAK_UID));
    const ME = (() => {
      let id, handle, color;
      try { id = localStorage.getItem('nx_id'); handle = localStorage.getItem('nx_handle'); color = localStorage.getItem('nx_color'); } catch (e) {}
      if (!id) id = 'g' + hashIdx(String(Math.random()) + performance.now()).toString(36);
      if (!handle) handle = anonHandle(id);
      if (color == null) color = String(hashIdx(id) % grad.length);
      try { localStorage.setItem('nx_id', id); localStorage.setItem('nx_handle', handle); localStorage.setItem('nx_color', color); } catch (e) {}
      return { id, handle, color: +color };
    })();
    let SESSION = null;
    const SB_URL = import.meta.env.PUBLIC_SUPABASE_URL || '';
    const SB_KEY = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || '';
    async function ensureSession() { if (SESSION) return true; try { const { data } = await supabase.auth.getSession(); SESSION = data.session || null; } catch (e) {} return !!SESSION; }

    const views = { home: el('nx-home'), room: el('nx-room'), tribe: el('nx-tribe'), dm: el('nx-dm') };
    function show(v) { for (const k in views) { if (views[k]) views[k].hidden = (k !== v); } window.scrollTo(0, 0); }

    const roomsEl = el('nx-rooms');
    const tribesEl = el('nx-tribes-grid');

    // graceful degrade if env vars missing
    if (!supabaseConfigured || !supabase) {
      roomsEl.innerHTML = '<div class="nx-start-card" style="cursor:default">Live data needs the Supabase env vars (PUBLIC_SUPABASE_URL / _ANON_KEY).</div>';
    } else {
      boot();
    }

    function boot() {
      let ROOMS = [];
      let TRIBES = [];

      // ── lobby: rooms — a room exists ONLY while real people are in it ──────
      // No seeded/mock rooms, ever. The lobby shows only rooms with someone here
      // right now (fresh heartbeat); when the last person leaves, the room is gone.
      const FRESH_MS = 90000;
      const isActive = (r) => r.here_now > 0 && !r.archived_at && (Date.now() - new Date(r.last_active_at).getTime() < FRESH_MS);
      function roomCard(r) {
        const heat = Math.min(0.12 + r.here_now / 22, 0.5);
        return '<div class="nx-room-card compact" data-room="' + esc(r.id) + '" style="--heat:rgba(255,150,90,' + heat + ')">'
          + '<div class="nx-rc-top"><span class="nx-livedot"></span><span class="nx-rc-pulse"><span class="nx-flame"></span>' + r.pulse + '</span></div>'
          + '<div class="nx-rc-title">' + esc(r.title) + '</div>'
          + '<div class="nx-rc-bottom"><span class="nx-faces">' + faces(Math.min(r.here_now, 3), hashIdx(r.id)) + '</span><span class="nx-here-n">' + r.here_now + ' here</span></div></div>';
      }
      function renderRooms() {
        const live = ROOMS.filter(isActive).sort((a, b) => (b.here_now - a.here_now) || (b.pulse - a.pulse));
        el('nx-rooms-sub').textContent = live.length ? (live.length + ' live now') : 'tap + to start';
        const startCard = '<div class="nx-start-card compact" data-start><b>+</b><span>Start</span></div>';
        const hint = live.length ? '' : '<div class="nx-rooms-hint">No rooms live yet — start one; it lights up the moment you arrive.</div>';
        roomsEl.innerHTML = startCard + live.map(roomCard).join('') + hint;
      }
      async function loadRooms() {
        try { await supabase.rpc('nexus_sweep_rooms'); } catch (e) {}
        const { data, error } = await supabase.from('nexus_rooms').select('*').is('archived_at', null).gt('here_now', 0).order('last_active_at', { ascending: false }).limit(40);
        ROOMS = (error ? [] : (data || [])); renderRooms();
      }

      // live lobby updates: rooms appear when occupied, vanish when the last leaves
      supabase.channel('nx-lobby')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'nexus_rooms' }, (payload) => {
          const row = payload.new || payload.old; if (!row) return;
          const gone = payload.eventType === 'DELETE' || (payload.new && (payload.new.here_now <= 0 || payload.new.archived_at));
          if (gone) ROOMS = ROOMS.filter((r) => r.id !== row.id);
          else {
            const i = ROOMS.findIndex((r) => r.id === payload.new.id);
            if (i >= 0) ROOMS[i] = payload.new; else ROOMS.push(payload.new);
          }
          renderRooms();
        }).subscribe();

      // prune ghosts + pick up rooms started elsewhere, periodically
      setInterval(loadRooms, 30000);

      // ── lobby: tribes (real communities) ──────────────────────────────────
      let TRIBE_COUNTS = {}, MY_TRIBES = [], MY_RECENT = {};
      function tribeCard(c) {
        const n = TRIBE_COUNTS[c.id] || 0;
        return '<div class="nx-tribe-card" data-tribe="' + esc(c.id) + '"><span class="nx-tc-mark" style="background:' + g(hashIdx(c.id)) + '"></span>'
          + '<span class="nx-tc-who"><b>' + esc(c.name) + '</b><span>' + n + ' discussion' + (n === 1 ? '' : 's') + '</span></span></div>';
      }
      function tilePostRow(p, commId) {
        const txt = (p.image_url && !(p.body || '').trim()) ? '📷 shared an image' : esc((p.body || '').slice(0, 100));
        return '<button type="button" class="nx-tile-post" data-open-tribe="' + esc(commId) + '">' + (p.is_ai_author ? '<span class="nx-tile-av nx-av-blak"></span>' : '<span class="nx-tile-av" style="background:' + g(hashIdx(p.author_token || p.id)) + '"></span>') + '<span class="nx-tile-ptxt">' + txt + '</span><span class="nx-tile-when">' + rel(p.created_at) + '</span></button>';
      }
      function tileFor(c) {
        const recent = MY_RECENT[c.id] || [];
        const updates = recent.length ? recent.map((p) => tilePostRow(p, c.id)).join('') : '<p class="nx-tile-empty">No posts yet — start the conversation.</p>';
        return '<div class="nx-tile">'
          + '<div class="nx-tile-head" data-open-tribe="' + esc(c.id) + '"><span class="nx-tc-mark" style="background:' + g(hashIdx(c.id)) + '"></span><div class="nx-tile-id"><b>' + esc(c.name) + '</b><span>open tribe →</span></div></div>'
          + '<form class="nx-tile-compose" data-tribe="' + esc(c.id) + '"><label class="nx-img-btn" title="Add image"><input type="file" accept="image/*" hidden data-tile-img />' + IMG_SVG + '</label><input type="text" placeholder="Post to ' + esc(c.name) + '…" data-tile-input autocomplete="off" /><button type="submit">Post</button></form>'
          + '<div class="nx-tile-prev" data-tile-prev hidden></div>'
          + '<p class="nx-tile-k">Recent updates</p><div class="nx-tile-updates">' + updates + '</div></div>';
      }
      function emptyTribesTile() {
        return '<div class="nx-tile nx-tile-empty-state"><p class="nx-tile-k">You’re not in any tribes yet</p><p class="nx-tile-empty">Search above to find your people, or start your own.</p><button type="button" class="nx-start" data-new-tribe>+ Create a tribe</button></div>';
      }
      function renderTribes(filter) {
        const ctrl = el('nx-tribes-ctrl');
        const q = (filter != null ? filter : (el('nx-tribe-search') ? el('nx-tribe-search').value : '') || '').trim().toLowerCase();
        if (q) {
          tribesEl.className = 'nx-tiles list';
          const list = TRIBES.filter((c) => (c.name || '').toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q));
          tribesEl.innerHTML = list.length ? list.map(tribeCard).join('') : '<p class="nx-pulse-explain">No tribes match “' + esc(q) + '”.</p>';
          if (ctrl) ctrl.hidden = true;
          NexusData.searchPosts(q).then((posts) => {
            const cur = ((el('nx-tribe-search') && el('nx-tribe-search').value) || '').trim().toLowerCase();
            if (cur !== q || !posts.length) return;
            tribesEl.insertAdjacentHTML('beforeend', '<p class="nx-tile-k">Posts</p>' + posts.map(feedCard).join(''));
          }).catch(() => {});
          return;
        }
        tribesEl.className = 'nx-tiles';
        if (!MY_TRIBES.length) { tribesEl.innerHTML = emptyTribesTile(); if (ctrl) ctrl.hidden = true; return; }
        tribesEl.innerHTML = MY_TRIBES.map(tileFor).join('');
        buildCarousel();
      }
      function buildCarousel() {
        const ctrl = el('nx-tribes-ctrl'), dots = el('nx-tribes-dots'); if (!ctrl || !dots) return;
        const tiles = tribesEl.querySelectorAll('.nx-tile');
        if (tiles.length < 2) { ctrl.hidden = true; dots.innerHTML = ''; return; }
        ctrl.hidden = false;
        dots.innerHTML = Array.from(tiles).map((_, i) => '<span' + (i === 0 ? ' class="on"' : '') + '></span>').join('');
        let raf = 0;
        tribesEl.onscroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => {
          const first = tribesEl.querySelector('.nx-tile'); if (!first) return;
          const cw = first.offsetWidth + 16;
          const idx = Math.min(tiles.length - 1, Math.max(0, Math.round(tribesEl.scrollLeft / cw)));
          dots.querySelectorAll('span').forEach((d, i) => d.classList.toggle('on', i === idx));
        }); };
      }
      async function loadTribes() {
        const { data: comms } = await supabase.from('nexus_communities').select('id,slug,name,description,visibility').eq('visibility', 'public').order('created_at');
        TRIBE_COUNTS = {};
        const { data: posts } = await supabase.from('nexus_posts').select('community_id').eq('is_soft_hidden', false).order('created_at', { ascending: false }).limit(2000);
        if (posts) posts.forEach((p) => { TRIBE_COUNTS[p.community_id] = (TRIBE_COUNTS[p.community_id] || 0) + 1; });
        TRIBES = comms || [];
      }
      async function loadMyTribes() {
        if (!(await ensureSession())) { MY_TRIBES = []; renderTribes(''); return; }
        const { data: mems } = await supabase.from('nexus_community_members').select('community_id').eq('user_id', SESSION.user.id);
        const ids = (mems || []).map((m) => m.community_id);
        if (!ids.length) { MY_TRIBES = []; renderTribes(''); return; }
        const { data: comms } = await supabase.from('nexus_communities').select('id,slug,name,description,visibility').in('id', ids);
        MY_TRIBES = comms || [];
        MY_RECENT = await NexusData.loadRecentPosts(ids, SESSION.user.id).catch(() => ({}));
        renderTribes('');
      }
      el('nx-tribe-search') && el('nx-tribe-search').addEventListener('input', (e) => renderTribes(e.target.value));
      const carScroll = (dir) => { const first = tribesEl.querySelector('.nx-tile'); const cw = (first ? first.offsetWidth : 300) + 16; tribesEl.scrollBy({ left: dir * cw, behavior: 'smooth' }); };
      el('nx-tribes-prev') && el('nx-tribes-prev').addEventListener('click', () => carScroll(-1));
      el('nx-tribes-next') && el('nx-tribes-next').addEventListener('click', () => carScroll(1));
      tribesEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-tile-x]')) { const tile = e.target.closest('.nx-tile'); const fileEl = tile && tile.querySelector('[data-tile-img]'); if (fileEl) fileEl.value = ''; const pv = tile && tile.querySelector('[data-tile-prev]'); if (pv) { pv.hidden = true; pv.innerHTML = ''; } return; }
        if (e.target.closest('[data-new-tribe]')) { openTribeCreate(); return; }
        if (e.target.closest('.nx-tile-compose')) return;
        const open = e.target.closest('[data-open-tribe]') || e.target.closest('[data-tribe]');
        if (!open) return;
        const id = open.getAttribute('data-open-tribe') || open.getAttribute('data-tribe');
        const t = MY_TRIBES.find((x) => x.id === id) || TRIBES.find((x) => x.id === id);
        if (t) openTribe(t);
      });
      tribesEl.addEventListener('change', (e) => {
        const fileEl = e.target.closest('[data-tile-img]'); if (!fileEl) return;
        const f = fileEl.files && fileEl.files[0]; if (!f) return;
        const tile = fileEl.closest('.nx-tile'); const pv = tile && tile.querySelector('[data-tile-prev]');
        if (pv) { pv.hidden = false; pv.innerHTML = '<img alt="" src="' + URL.createObjectURL(f) + '" /><button type="button" data-tile-x aria-label="Remove">✕</button>'; }
      });
      tribesEl.addEventListener('submit', async (e) => {
        const form = e.target.closest('.nx-tile-compose'); if (!form) return;
        e.preventDefault();
        const id = form.getAttribute('data-tribe');
        const input = form.querySelector('[data-tile-input]'); const v = input.value.trim();
        const fileEl = form.querySelector('[data-tile-img]'); const file = fileEl && fileEl.files && fileEl.files[0];
        if (!v && !file) return;
        if (!(await ensureSession())) { toast('Sign in to post.'); return; }
        const btn = form.querySelector('button[type="submit"]'); if (btn) btn.disabled = true;
        let imgUrl = null; if (file) { imgUrl = await uploadImage(file); if (!imgUrl) { if (btn) btn.disabled = false; return; } }
        let data;
        try { data = await NexusData.createPost(id, null, v || '', imgUrl, SESSION.user.id); }
        catch (e) { if (btn) btn.disabled = false; toast('Could not post — try again.'); return; }
        if (btn) btn.disabled = false;
        input.value = ''; if (fileEl) fileEl.value = '';
        const tile = form.closest('.nx-tile'); const pv = tile && tile.querySelector('[data-tile-prev]'); if (pv) { pv.hidden = true; pv.innerHTML = ''; }
        MY_RECENT[id] = [data].concat(MY_RECENT[id] || []).slice(0, 3);
        const ups = tile && tile.querySelector('.nx-tile-updates');
        if (ups) { const empty = ups.querySelector('.nx-tile-empty'); if (empty) ups.innerHTML = ''; const wrap = document.createElement('div'); wrap.innerHTML = tilePostRow(data, id); ups.insertBefore(wrap.firstElementChild, ups.firstChild); }
        toast('Posted to your tribe.');
      });

      // ── in-room (the star): presence + broadcast + pulse ──────────────────
      let chan = null, here = 0, sessionStart = 0, timer = null, keepAlive = null, hbAt = 0, curRoom = null;
      const setPulse = (n) => { el('nx-pulse-big').textContent = n; el('nx-pulse-n').textContent = n; };

      async function heartbeat(h, msgDelta) {
        if (!curRoom) return;
        const now = Date.now();
        if (!msgDelta && now - hbAt < 2500) return;
        hbAt = now;
        const { data } = await supabase.rpc('nexus_room_heartbeat', { p_room_id: curRoom.id, p_here: h, p_msg_delta: msgDelta || 0 });
        if (data) { curRoom = data; setPulse(data.pulse); }
      }
      function renderHere(state) {
        const metas = Object.values(state).map((a) => a && a[0]).filter(Boolean);
        here = Math.max(Object.keys(state).length, 1); // I'm always here while in the room
        el('nx-room-here').textContent = here + ' here';
        el('nx-stat-here').textContent = here;
        el('nx-here-faces').innerHTML = metas.slice(0, 12).map((m) => '<span style="background:' + g(m.color || 0) + '"></span>').join('') || faces(1, hashIdx(ME.id));
        const orb = el('nx-pulse-orb'); if (orb) orb.classList.toggle('resting', here === 0);
        el('nx-heat-fill').style.width = Math.min(8 + here * 12, 100) + '%';
      }
      function appendMsg(m, me) {
        const feed = el('nx-room-feed');
        const blak = !me && !!(m && (m.is_ai || m.handle === 'Blak'));
        const d = document.createElement('div'); d.className = 'nx-rmsg' + (me ? ' me' : '') + (blak ? ' nx-rmsg-blak' : '');
        d.innerHTML = '<span class="nx-rav' + (blak ? ' nx-av-blak' : '') + '"' + (blak ? '' : ' style="background:' + g(me ? ME.color : (m.color || 0)) + '"') + '></span><div><span class="nx-rh"></span><p></p></div>';
        const rh = d.querySelector('.nx-rh');
        if (blak) rh.innerHTML = '<span class="nx-blak">✦ Blak</span>'; else rh.textContent = me ? 'you' : (m.handle || 'someone');
        d.querySelector('p').textContent = m.text;
        feed.appendChild(d); feed.scrollTop = feed.scrollHeight;
      }
      function openRoom(r) {
        curRoom = r;
        el('nx-room-title').textContent = r.title;
        { const cb = el('nx-room-close'); if (cb) cb.hidden = !(SESSION && SESSION.user && r.host_id && r.host_id === SESSION.user.id); }
        el('nx-stat-day').textContent = 'day ' + dayOf(r.created_at);
        setPulse(r.pulse); el('nx-stat-here').textContent = 1; el('nx-stat-time').textContent = '0m';
        el('nx-heat-fill').style.width = '20%';
        el('nx-pulse-orb').classList.remove('resting');
        el('nx-room-feed').innerHTML = '<div class="nx-rmsg nx-rmsg-blak"><span class="nx-rav nx-av-blak"></span><div><span class="nx-rh"><span class="nx-blak">✦ Blak</span></span><p></p></div></div>';
        el('nx-room-feed').querySelector('p').textContent = 'hey — welcome in 👋 i’ll be around. what’s on your mind?';
        show('room');
        sessionStart = Date.now(); clearInterval(timer); clearInterval(keepAlive);
        timer = setInterval(() => { el('nx-stat-time').textContent = Math.floor((Date.now() - sessionStart) / 60000) + 'm'; }, 5000);
        keepAlive = setInterval(() => { if (chan) heartbeat(here, 0); }, 25000); // stay listed while occupied

        chan = supabase.channel('nx-room:' + r.id, { config: { presence: { key: ME.id }, broadcast: { self: false } } });
        chan
          .on('presence', { event: 'sync' }, () => { renderHere(chan.presenceState()); heartbeat(here, 0); })
          .on('broadcast', { event: 'msg' }, ({ payload }) => appendMsg(payload, false))
          // Pulse is server-authoritative and SHARED: when ANY participant's heartbeat
          // updates the room row, every client here gets the new value pushed in real
          // time — so the Pulse reads the SAME number for everyone, instead of drifting
          // because each client only saw its own heartbeat's response.
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'nexus_rooms', filter: 'id=eq.' + r.id }, (payload) => {
            const row = payload.new; if (!row || row.id !== r.id) return;
            curRoom = row; setPulse(row.pulse);
            el('nx-heat-fill').style.width = Math.min(8 + (row.here_now || 0) * 12, 100) + '%';
          })
          .subscribe(async (status) => { if (status === 'SUBSCRIBED') await chan.track({ handle: ME.handle, color: ME.color, at: Date.now() }); });
      }
      async function leaveRoom() {
        clearInterval(timer); clearInterval(keepAlive);
        const room = curRoom, leftHere = Math.max(0, here - 1);
        try { if (chan) { await chan.untrack(); await supabase.removeChannel(chan); } } catch (e) {}
        chan = null; curRoom = null;
        if (room) { try { await supabase.rpc('nexus_room_heartbeat', { p_room_id: room.id, p_here: leftHere, p_msg_delta: 0 }); } catch (e) {} }
        show('home'); loadRooms();
      }

      el('nx-room-form').addEventListener('submit', (e) => {
        e.preventDefault();
        const inp = el('nx-room-input'); const v = inp.value.trim(); if (!v || !chan) return; inp.value = '';
        chan.send({ type: 'broadcast', event: 'msg', payload: { handle: ME.handle, color: ME.color, text: v } });
        appendMsg({ text: v }, true); heartbeat(here, 1);
      });
      el('nx-room-input').addEventListener('focus', () => setTimeout(() => el('nx-room-input').scrollIntoView({ block: 'center' }), 200));
      el('nx-room-close') && el('nx-room-close').addEventListener('click', async () => { if (!curRoom) return; try { await supabase.rpc('nexus_close_room', { p_room_id: curRoom.id }); } catch (e) {} toast('Room closed.'); leaveRoom(); });

      // ── create room (modal) ───────────────────────────────────────────────
      const modal = el('nx-modal');
      const openCreate = () => { modal.hidden = false; setTimeout(() => el('nx-create-title').focus(), 30); };
      const closeCreate = () => { modal.hidden = true; el('nx-create-form').reset(); };
      el('nx-create-cancel').addEventListener('click', closeCreate);
      modal.addEventListener('click', (e) => { if (e.target === modal) closeCreate(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeCreate(); });
      el('nx-create-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const title = el('nx-create-title').value.trim(); if (!title) return;
        const topic = el('nx-create-topic').value.trim();
        const { data, error } = await supabase.rpc('nexus_create_room', { p_title: title, p_topic: topic || null, p_emoji: null, p_host_handle: ME.handle });
        closeCreate();
        if (error || !data) { toast('Could not start the room — try again.'); return; }
        openRoom(data);
      });

      roomsEl.addEventListener('click', (e) => {
        if (e.target.closest('[data-start]')) return openCreate();
        const c = e.target.closest('[data-room]'); if (!c) return;
        const r = ROOMS.find((x) => x.id === c.getAttribute('data-room')); if (r) openRoom(r);
      });
      el('nx-start') && el('nx-start').addEventListener('click', openCreate);

      // ── tribe view (real communities + posts) ─────────────────────────────
      let curTribe = null, curTribeIsMod = false, curTribeChan = null;
      async function openTribe(c) {
        curTribe = c;
        el('nx-tribe-name').textContent = c.name;
        el('nx-tribe-mark').style.background = g(hashIdx(c.id));
        el('nx-tribe-desc').textContent = c.description || 'A Blaksyd tribe.';
        el('nx-tribe-meta').textContent = 'community';
        el('nx-tribe-live').innerHTML = '<div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap"><span class="nx-livedot"></span><b>' + esc(c.name) + ' · live room</b><span class="nx-here-n" style="margin-left:auto">gather in real time</span><span class="nx-join-btn" data-tribe-room>Start a room</span></div>';
        el('nx-discussions').innerHTML = '<p class="nx-pulse-explain">Loading discussions…</p>';
        show('tribe');
        refreshJoinState();
        loadDiscussions();
        // #30 realtime: new posts in this tribe appear live (refetch on any change)
        if (curTribeChan) { try { supabase.removeChannel(curTribeChan); } catch (e) {} curTribeChan = null; }
        curTribeChan = supabase.channel('nx-tribe:' + c.id)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'nexus_posts', filter: 'community_id=eq.' + c.id }, () => { loadDiscussions(); })
          .subscribe();
      }
      async function refreshJoinState() {
        const btn = el('nx-tribe-join'); btn.dataset.joined = ''; btn.textContent = 'Join'; curTribeIsMod = false;
        if (!curTribe || !(await ensureSession())) return;
        try {
          const { data } = await supabase.from('nexus_community_members').select('community_id,role').eq('community_id', curTribe.id).eq('user_id', SESSION.user.id).maybeSingle();
          if (data) { btn.dataset.joined = '1'; btn.textContent = 'Joined ✓'; curTribeIsMod = (data.role === 'moderator'); }
        } catch (e) {}
      }
      // Participating in a tribe makes you a member (so others can DM you). Quietly.
      async function joinTribeSilently() {
        if (!curTribe || !SESSION) return;
        const btn = el('nx-tribe-join'); const wasJoined = btn && btn.dataset.joined === '1';
        try { await supabase.from('nexus_community_members').insert({ community_id: curTribe.id, user_id: SESSION.user.id }); } catch (e) {}
        if (btn && !wasJoined) { btn.dataset.joined = '1'; btn.textContent = 'Joined ✓'; }
        if (!wasJoined) loadMyTribes().catch(() => {}); // first time in this tribe → show it on home
      }
      // Stable, anonymous per-tribe handle derived from (author, tribe) — consistent
      // within a tribe, unlinkable across tribes, and never reversible to the account.
      const handleFor = (uid, comm) => anonHandle((uid || 'x') + (comm || ''));
      const discHandle = (uid) => handleFor(uid, curTribe ? curTribe.id : '');
      const tribeName = (id) => { const t = TRIBES.find((x) => x.id === id); return t ? t.name : 'a tribe'; };
      function discCard(p, resonated) {
        const token = p.author_token || '';
        const blak = !!p.is_ai_author;
        const mine = !!p.is_mine;
        const handle = p.author_handle || 'someone';
        const reso = (resonated === undefined) ? !!p.my_resonated : resonated;
        const who = blak
          ? '<span class="nx-blak">✦ Blak</span>'
          : (mine
            ? '@' + esc(handle) + ' (you)'
            : '<span class="nx-dm-link" data-dm-token="' + esc(token) + '" data-dm-handle="' + esc(handle) + '">@' + esc(handle) + '</span>');
        const av = blak
          ? '<span class="nx-disc-av nx-av-blak"></span>'
          : '<span class="nx-disc-av" style="background:' + g(hashIdx(token || p.id)) + '"></span>';
        return '<div class="nx-disc' + (blak ? ' nx-disc-blak' : '') + '" data-post="' + esc(p.id) + '">'
          + '<div class="nx-disc-top">' + av + who + ' · ' + rel(p.created_at) + '</div>'
          + (p.title ? '<div class="nx-disc-text" style="font-weight:650">' + esc(p.title) + '</div>' : '')
          + (p.body ? '<div class="nx-disc-text">' + esc(p.body) + '</div>' : '')
          + (p.image_url ? '<img class="nx-img" loading="lazy" src="' + esc(p.image_url) + '" alt="shared image" />' : '')
          + '<div class="nx-disc-foot"><span class="nx-reso' + (reso ? ' on' : '') + '" data-reso>◈ <b>' + (p.impact_count || 0) + '</b> resonate</span>'
          + '<span class="nx-disc-replies" data-open>💬 <b>' + (p.comment_count || 0) + '</b> replies</span>'
          + (mine ? '<button type="button" class="nx-del" data-del-post>delete</button>' : '')
          + ((NX_PROXY && !blak && !mine) ? '<button type="button" class="nx-more-btn" data-safety="post" data-st-id="' + esc(p.id) + '" data-st-token="' + esc(token) + '" data-st-handle="' + esc(handle) + '" data-st-comm="' + esc(p.community_id) + '" aria-label="More options">⋯</button>' : '')
          + '</div>'
          + '<div class="nx-comments" hidden></div></div>';
      }
      async function loadDiscussions() {
        const disc = el('nx-discussions');
        await ensureSession();
        let posts = [];
        try { posts = await NexusData.loadDiscussions(curTribe.id, SESSION ? SESSION.user.id : null); } catch (e) {}
        if (!posts.length) { disc.innerHTML = '<p class="nx-pulse-explain">No discussions yet — be the first.</p>'; return; }
        disc.innerHTML = posts.map((p) => discCard(p)).join('');
      }
      async function openComments(postId, box) {
        box.innerHTML = '<p class="nx-pulse-explain" style="margin:.2rem 0">Loading replies…</p>';
        await ensureSession();
        let cs = [];
        try { cs = await NexusData.loadComments(postId, curTribe ? curTribe.id : '', SESSION ? SESSION.user.id : null); } catch (e) {}
        box.innerHTML = '<div class="nx-cmt-list"></div><div class="nx-reply-hint" data-reply-hint hidden></div><form class="nx-cmt-form" data-cform><input placeholder="Write a reply…" autocomplete="off" maxlength="600" /><button type="submit">Reply</button></form>';
        const listEl = box.querySelector('.nx-cmt-list');
        const hintEl = box.querySelector('[data-reply-hint]');
        let replyParent = null;
        if (!cs.length) listEl.innerHTML = '<p class="nx-pulse-explain" style="margin:.2rem 0">No replies yet — be the first.</p>';
        else {
          const byParent = {};
          cs.forEach((c) => { const k = c.parent_id || 'root'; (byParent[k] = byParent[k] || []).push(c); });
          const cmtHTML = (c, depth) => {
            const blak = !!c.is_ai_author;
            const av = blak ? '<span class="nx-cmt-av nx-av-blak"></span>' : '<span class="nx-cmt-av" style="background:' + g(hashIdx(c.author_token || c.id)) + '"></span>';
            const h = blak ? '<span class="nx-blak">✦ Blak</span> · ' + rel(c.created_at) : '@' + esc(c.author_handle || 'someone') + ' · ' + rel(c.created_at);
            const more = (NX_PROXY && !blak && !c.is_mine) ? '<button type="button" class="nx-more-btn" data-safety="comment" data-st-id="' + esc(c.id) + '" data-st-token="' + esc(c.author_token) + '" data-st-handle="' + esc(c.author_handle || 'someone') + '" data-st-comm="' + esc(curTribe ? curTribe.id : '') + '" aria-label="More options">⋯</button>' : (c.is_mine ? '<button type="button" class="nx-del nx-cmt-del" data-del-comment="' + esc(c.id) + '">delete</button>' : '');
            const reply = '<button type="button" class="nx-reply-btn" data-reply="' + esc(c.id) + '" data-reply-handle="' + esc(blak ? 'Blak' : (c.author_handle || 'someone')) + '">reply</button>';
            let html = '<div class="nx-cmt' + (blak ? ' nx-cmt-blak' : '') + '"' + (depth > 0 ? ' style="margin-left:' + (Math.min(depth, 3) * 16) + 'px"' : '') + '>' + av + '<div class="nx-cmt-main"><span class="nx-cmt-h">' + h + '</span><p>' + esc(c.body || '') + '</p><div class="nx-cmt-acts">' + reply + more + '</div></div></div>';
            (byParent[c.id] || []).forEach((ch) => { html += cmtHTML(ch, depth + 1); });
            return html;
          };
          listEl.innerHTML = (byParent['root'] || []).map((c) => cmtHTML(c, 0)).join('');
        }
        listEl.addEventListener('click', (e) => {
          const r = e.target.closest('[data-reply]'); if (!r) return;
          replyParent = r.getAttribute('data-reply');
          hintEl.hidden = false;
          hintEl.innerHTML = '↳ Replying to @' + esc(r.getAttribute('data-reply-handle') || 'someone') + ' <button type="button" data-reply-cancel aria-label="Cancel reply">✕</button>';
          const inp2 = box.querySelector('[data-cform] input'); if (inp2) inp2.focus();
        });
        hintEl.addEventListener('click', (e) => { if (e.target.closest('[data-reply-cancel]')) { replyParent = null; hintEl.hidden = true; hintEl.innerHTML = ''; } });
        box.querySelector('[data-cform]').addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const inp = ev.currentTarget.querySelector('input'); const v = inp.value.trim(); if (!v) return;
          if (!(await ensureSession())) { toast('Sign in to reply.'); return; }
          inp.value = '';
          try { await NexusData.createComment(postId, curTribe ? curTribe.id : '', v, SESSION.user.id, replyParent); }
          catch (e) { toast('Could not post your reply — try again.'); return; }
          joinTribeSilently();
          const card = box.closest('[data-post]'); const rb = card && card.querySelector('.nx-disc-replies b'); if (rb) rb.textContent = (+rb.textContent + 1);
          openComments(postId, box);
        });
      }

      el('nx-tribe-live').addEventListener('click', async (e) => {
        if (!e.target.closest('[data-tribe-room]') || !curTribe) return;
        const existing = ROOMS.find((r) => isActive(r) && (r.community_id === curTribe.id || r.title === curTribe.name));
        if (existing) { openRoom(existing); return; }
        const { data } = await supabase.rpc('nexus_create_room', { p_title: curTribe.name, p_topic: 'live room · ' + curTribe.name, p_emoji: null, p_host_handle: ME.handle, p_community: curTribe.id });
        if (data) openRoom(data); else toast('Could not open the room — try again.');
      });

      el('nx-discussions').addEventListener('click', async (e) => {
        const card = e.target.closest('[data-post]'); if (!card) return;
        const id = card.getAttribute('data-post');
        const safety = e.target.closest('[data-safety]');
        if (safety) { openSafety(safety); return; }
        const delP = e.target.closest('[data-del-post]');
        if (delP) { if (confirm('Delete this post? This can’t be undone.')) NexusData.deletePost(id).then(() => loadDiscussions()).catch(() => toast('Could not delete — try again.')); return; }
        const delC = e.target.closest('[data-del-comment]');
        if (delC) { const cid = delC.getAttribute('data-del-comment'); if (confirm('Delete this reply?')) NexusData.deleteComment(cid).then(() => { const box = card.querySelector('.nx-comments'); if (box && !box.hidden) openComments(id, box); const rb = card.querySelector('.nx-disc-replies b'); if (rb) rb.textContent = Math.max(0, (+rb.textContent) - 1); }).catch(() => toast('Could not delete — try again.')); return; }
        const dm = e.target.closest('[data-dm-token]');
        if (dm) { openDM(curTribe.id, dm.getAttribute('data-dm-token'), dm.getAttribute('data-dm-handle'), 'tribe'); return; }
        const r = e.target.closest('[data-reso]');
        if (r) {
          if (!(await ensureSession())) { toast('Sign in to resonate.'); return; }
          const b = r.querySelector('b'); const on = r.classList.contains('on');
          r.classList.toggle('on'); b.textContent = Math.max(0, (+b.textContent) + (on ? -1 : 1));
          try { const c = await NexusData.setResonance(id, !on, SESSION.user.id); if (typeof c === 'number') b.textContent = c; }
          catch (e2) { r.classList.toggle('on'); b.textContent = Math.max(0, (+b.textContent) + (on ? 1 : -1)); toast('Could not resonate — try again.'); }
          return;
        }
        if (e.target.closest('[data-open]') || e.target.closest('.nx-disc-text')) {
          const box = card.querySelector('.nx-comments'); if (!box) return;
          if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
          box.hidden = false; openComments(id, box);
        }
      });

      // ── safety sheet: report / block (Phase 1 #1/#2; proxy-era) ───────────
      let safetyTarget = null;
      const safetyModal = el('nx-safety');
      function openSafety(btn) {
        safetyTarget = { type: btn.getAttribute('data-safety'), id: btn.getAttribute('data-st-id'), token: btn.getAttribute('data-st-token'), handle: btn.getAttribute('data-st-handle'), comm: btn.getAttribute('data-st-comm') };
        if (!safetyModal) return;
        el('nx-safety-title').textContent = '@' + (safetyTarget.handle || 'someone');
        el('nx-safety-main').hidden = false; el('nx-safety-reasons').hidden = true;
        const modCan = curTribeIsMod && (safetyTarget.type === 'post' || safetyTarget.type === 'comment');
        const rm = el('nx-safety-remove'); if (rm) rm.hidden = !modCan;
        const bn = el('nx-safety-ban'); if (bn) bn.hidden = !modCan;
        safetyModal.hidden = false;
      }
      function closeSafety() { if (safetyModal) safetyModal.hidden = true; safetyTarget = null; }
      if (safetyModal) {
        safetyModal.addEventListener('click', (e) => {
          if (e.target === safetyModal || e.target.closest('[data-safety-cancel]')) { closeSafety(); return; }
          if (e.target.closest('[data-safety-report]')) { el('nx-safety-main').hidden = true; el('nx-safety-reasons').hidden = false; return; }
          if (e.target.closest('[data-safety-block]')) {
            if (!safetyTarget) return;
            const t = safetyTarget; closeSafety();
            NexusData.blockUser(t.comm, t.token).then(() => {
              if (t.type === 'user') { toast('Blocked. They can’t message you.'); dmOther = null; teardownDM(); show(curTribe ? 'tribe' : 'home'); }
              else { toast('Blocked. You won’t see their posts.'); if (curTribe) loadDiscussions(); }
            }).catch(() => toast('Could not block — try again.'));
            return;
          }
          if (e.target.closest('[data-safety-remove]')) {
            if (!safetyTarget) return;
            const t = safetyTarget; closeSafety();
            const p = t.type === 'comment' ? NexusData.modRemoveComment(t.id) : NexusData.modRemovePost(t.id);
            p.then(() => { toast('Removed from the tribe.'); if (curTribe) loadDiscussions(); }).catch(() => toast('Could not remove — try again.'));
            return;
          }
          if (e.target.closest('[data-safety-ban]')) {
            if (!safetyTarget) return;
            const t = safetyTarget; closeSafety();
            NexusData.modBan(t.comm, t.token).then(() => { toast('Banned from the tribe.'); if (curTribe) loadDiscussions(); }).catch(() => toast('Could not ban — try again.'));
            return;
          }
          const reason = e.target.closest('[data-reason]');
          if (reason) {
            if (!safetyTarget) return;
            const t = safetyTarget; closeSafety();
            NexusData.reportTarget(t.type, t.id, t.comm, reason.getAttribute('data-reason')).then(() => toast('Reported — thank you. Our team will review it.')).catch(() => toast('Could not report — try again.'));
          }
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && safetyModal && !safetyModal.hidden) closeSafety(); });
      }

      let discImg = null;
      const discImgInput = el('nx-disc-img');
      if (discImgInput) discImgInput.addEventListener('change', () => {
        const f = discImgInput.files && discImgInput.files[0]; if (!f) return;
        discImg = f; el('nx-disc-preview-img').src = URL.createObjectURL(f); el('nx-disc-preview').hidden = false;
      });
      el('nx-disc-preview-x') && el('nx-disc-preview-x').addEventListener('click', () => { discImg = null; if (discImgInput) discImgInput.value = ''; el('nx-disc-preview').hidden = true; });
      el('nx-disc-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!curTribe) return;
        const inp = el('nx-disc-input'), titleInp = el('nx-disc-title');
        const v = inp.value.trim(), t = titleInp ? titleInp.value.trim() : '';
        if (!v && !discImg) return;
        if (!(await ensureSession())) { toast('Sign in to post a discussion.'); return; }
        const goBtn = el('nx-disc-form').querySelector('button[type="submit"]'); if (goBtn) goBtn.disabled = true;
        let imgUrl = null;
        if (discImg) { imgUrl = await uploadImage(discImg); if (!imgUrl) { if (goBtn) goBtn.disabled = false; return; } }
        let data;
        try { data = await NexusData.createPost(curTribe.id, t || null, v || '', imgUrl, SESSION.user.id); }
        catch (e) { if (goBtn) goBtn.disabled = false; toast('Could not post — try again.'); return; }
        if (goBtn) goBtn.disabled = false;
        joinTribeSilently();
        inp.value = ''; if (titleInp) titleInp.value = '';
        discImg = null; if (discImgInput) discImgInput.value = ''; el('nx-disc-preview').hidden = true;
        const disc = el('nx-discussions');
        const wrap = document.createElement('div'); wrap.innerHTML = discCard(data, false);
        const node = wrap.firstElementChild;
        if (disc.querySelector('.nx-disc')) disc.insertBefore(node, disc.firstChild);
        else { disc.innerHTML = ''; disc.appendChild(node); }
      });

      el('nx-tribe-join').addEventListener('click', async () => {
        if (!curTribe) return;
        if (!(await ensureSession())) { toast('Sign in to join this tribe.'); return; }
        const btn = el('nx-tribe-join'); const joined = btn.dataset.joined === '1'; btn.disabled = true;
        if (joined) {
          const { error } = await supabase.from('nexus_community_members').delete().eq('community_id', curTribe.id).eq('user_id', SESSION.user.id);
          btn.disabled = false;
          if (error) { toast('Could not leave — try again.'); return; }
          btn.dataset.joined = ''; btn.textContent = 'Join';
        } else {
          const { error } = await supabase.from('nexus_community_members').insert({ community_id: curTribe.id, user_id: SESSION.user.id });
          btn.disabled = false;
          if (error && error.code !== '23505') { toast('Could not join — try again.'); return; }
          btn.dataset.joined = '1'; btn.textContent = 'Joined ✓';
        }
        loadMyTribes().catch(() => {}); // reflect the new membership on the home swiper at once
      });

      // ── DMs: tribe-scoped, anonymous 1:1 (handles only; never names) ──────
      let dmOther = null, dmChanSub = null, dmImg = null, dmThreadComm = null, dmBackView = 'tribe', dmInboxComm = null;
      function dmAppend(m) {
        const feed = el('nx-dm-feed'); if (!feed) return;
        const mine = !!m.is_mine;
        const d = document.createElement('div'); d.className = 'nx-rmsg' + (mine ? ' me' : '');
        d.innerHTML = '<span class="nx-rav" style="background:' + g(hashIdx(mine ? ((SESSION && SESSION.user.id) || ME.id) : (m.other_token || '0'))) + '"></span><div><span class="nx-rh"></span></div>';
        d.querySelector('.nx-rh').textContent = mine ? 'you' : ('@' + (m.other_handle || 'someone'));
        const body = d.querySelector('div');
        if (m.body) { const p = document.createElement('p'); p.textContent = m.body; body.appendChild(p); }
        if (m.image_url) { const im = document.createElement('img'); im.className = 'nx-img'; im.loading = 'lazy'; im.src = m.image_url; body.appendChild(im); }
        feed.appendChild(d); feed.scrollTop = feed.scrollHeight;
      }
      function teardownDM() { if (dmChanSub) { try { supabase.removeChannel(dmChanSub); } catch (e) {} dmChanSub = null; } }
      function subscribeGlobalDM() {
        if (dmChanSub || !SESSION) return;
        // Filter is the user's OWN id (not a leak) — incoming events only signal a
        // refresh; we never render the payload's raw uids, we refetch via the view.
        dmChanSub = supabase.channel('nx-dm:' + SESSION.user.id)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'nexus_dm_messages', filter: 'recipient_user_id=eq.' + SESSION.user.id }, (p) => {
            const m = p.new; if (!m) return;
            if (dmOther && m.community_id === dmThreadComm) renderDMThread();
            else toast('New private message');
          }).subscribe();
      }
      async function renderDMThread() {
        const feed = el('nx-dm-feed'); if (!feed) return;
        feed.innerHTML = '<div class="nx-rmsg"><span class="nx-rav" style="background:' + g(2) + '"></span><div><span class="nx-rh">private</span><p>Anonymous & members-only — only the two of you can see this.</p></div></div>';
        let msgs = [];
        try { msgs = await NexusData.dmThread(dmThreadComm, dmOther, SESSION ? SESSION.user.id : null); } catch (e) {}
        msgs.forEach((m) => dmAppend(m));
      }
      async function openDM(communityId, otherToken, otherHandle, from) {
        if (!(await ensureSession())) { toast('Sign in to message.'); return; }
        if (!otherToken || !communityId) return;
        dmOther = otherToken; dmThreadComm = communityId; dmBackView = (from === 'inbox') ? 'inbox' : 'tribe';
        el('nx-dm-title').textContent = '@' + (otherHandle || 'someone');
        el('nx-dm-sub').textContent = tribeName(communityId) + ' · anonymous';
        el('nx-dm-form').hidden = false;
        const dmMore = el('nx-dm-more');
        if (dmMore) {
          if (NX_PROXY) { dmMore.hidden = false; dmMore.setAttribute('data-safety', 'user'); dmMore.setAttribute('data-st-id', otherToken); dmMore.setAttribute('data-st-token', otherToken); dmMore.setAttribute('data-st-handle', otherHandle || 'someone'); dmMore.setAttribute('data-st-comm', communityId); }
          else dmMore.hidden = true;
        }
        show('dm');
        await renderDMThread();
        subscribeGlobalDM();
      }
      async function openMsgInbox(commId) {
        if (!(await ensureSession())) { toast('Sign in to see messages.'); return; }
        dmOther = null; dmInboxComm = commId || null;
        { const dmMore = el('nx-dm-more'); if (dmMore) dmMore.hidden = true; }
        el('nx-dm-title').textContent = 'Messages';
        el('nx-dm-sub').textContent = (commId ? tribeName(commId) : 'all tribes') + ' · anonymous';
        el('nx-dm-form').hidden = true;
        const feed = el('nx-dm-feed'); feed.innerHTML = '<p class="nx-pulse-explain">Loading…</p>';
        show('dm'); subscribeGlobalDM();
        let convos = [];
        try { convos = await NexusData.dmInbox(commId || null, SESSION.user.id); } catch (e) {}
        if (!convos.length) { feed.innerHTML = '<p class="nx-pulse-explain">No messages yet. Open a discussion and tap a member’s @handle to start a private, anonymous chat.</p>'; return; }
        const requests = convos.filter((c) => c.is_request);
        const accepted = convos.filter((c) => !c.is_request);
        const row = (c) => '<button type="button" class="nx-inbox-row" data-dm-open="' + esc(c.other_token) + '" data-dm-comm="' + esc(c.community_id) + '" data-dm-handle="' + esc(c.other_handle) + '"><span class="nx-disc-av" style="background:' + g(hashIdx(c.other_token)) + '"></span><span class="nx-inbox-meta"><b>@' + esc(c.other_handle) + '</b><span>' + esc((commId ? '' : tribeName(c.community_id) + ' · ') + (c.last_body || '')) + '</span></span><span class="nx-inbox-when">' + rel(c.last_at) + '</span></button>';
        const reqRow = (c) => '<div class="nx-inbox-row nx-req-row"><button type="button" class="nx-req-open" data-dm-open="' + esc(c.other_token) + '" data-dm-comm="' + esc(c.community_id) + '" data-dm-handle="' + esc(c.other_handle) + '"><span class="nx-disc-av" style="background:' + g(hashIdx(c.other_token)) + '"></span><span class="nx-inbox-meta"><b>@' + esc(c.other_handle) + '</b><span>' + esc((commId ? '' : tribeName(c.community_id) + ' · ') + (c.last_body || '')) + '</span></span></button><span class="nx-req-actions"><button type="button" class="nx-req-accept" data-req-accept data-tk="' + esc(c.other_token) + '" data-cm="' + esc(c.community_id) + '" data-hn="' + esc(c.other_handle) + '">Accept</button><button type="button" class="nx-req-decline" data-req-decline data-tk="' + esc(c.other_token) + '" data-cm="' + esc(c.community_id) + '">Decline</button></span></div>';
        const reqHtml = requests.length ? '<p class="nx-tile-k" style="margin-top:0">Requests</p>' + requests.map(reqRow).join('') + '<p class="nx-tile-k">Messages</p>' : '';
        feed.innerHTML = '<input type="text" class="nx-dm-search" id="nx-dm-search" placeholder="Search messages…" autocomplete="off" />' + reqHtml + '<div id="nx-dm-rows"></div>';
        const rowsEl = el('nx-dm-rows'); rowsEl.innerHTML = accepted.length ? accepted.map(row).join('') : '<p class="nx-pulse-explain">No conversations yet.</p>';
        const si = el('nx-dm-search');
        if (si) si.addEventListener('input', () => { const qq = si.value.trim().toLowerCase(); const f = qq ? accepted.filter((c) => (c.other_handle || '').toLowerCase().includes(qq) || (c.last_body || '').toLowerCase().includes(qq) || tribeName(c.community_id).toLowerCase().includes(qq)) : accepted; rowsEl.innerHTML = f.length ? f.map(row).join('') : '<p class="nx-pulse-explain">No matches.</p>'; });
      }
      el('nx-dm-feed').addEventListener('click', (e) => {
        const acc = e.target.closest('[data-req-accept]');
        if (acc) { const cm = acc.getAttribute('data-cm'), tk = acc.getAttribute('data-tk'), hn = acc.getAttribute('data-hn'); NexusData.dmAccept(cm, tk).then(() => openDM(cm, tk, hn, 'inbox')).catch(() => toast('Could not accept — try again.')); return; }
        const dec = e.target.closest('[data-req-decline]');
        if (dec) { const cm = dec.getAttribute('data-cm'), tk = dec.getAttribute('data-tk'); NexusData.dmDecline(cm, tk).then(() => openMsgInbox(dmInboxComm)).catch(() => toast('Could not decline — try again.')); return; }
        const row = e.target.closest('[data-dm-open]'); if (!row) return; openDM(row.getAttribute('data-dm-comm'), row.getAttribute('data-dm-open'), row.getAttribute('data-dm-handle'), 'inbox');
      });
      el('nx-dm-back').addEventListener('click', () => {
        if (dmOther) { dmOther = null; if (dmBackView === 'inbox') { openMsgInbox(dmInboxComm); return; } teardownDM(); show(curTribe ? 'tribe' : 'home'); return; }
        teardownDM(); show(dmInboxComm ? 'tribe' : 'home');
      });
      el('nx-tribe-msgs') && el('nx-tribe-msgs').addEventListener('click', () => openMsgInbox(curTribe ? curTribe.id : null));
      el('nx-dm-more') && el('nx-dm-more').addEventListener('click', () => { const b = el('nx-dm-more'); if (b) openSafety(b); });
      el('nx-home-msgs') && el('nx-home-msgs').addEventListener('click', () => openMsgInbox(null));
      el('nx-tribe-share') && el('nx-tribe-share').addEventListener('click', async () => { if (!curTribe) return; const link = location.origin + '/beta/nexus/?tribe=' + curTribe.id; try { await navigator.clipboard.writeText(link); toast('Tribe link copied — share it with your people.'); } catch (e) { toast('Copy this link: ' + link); } });
      const dmImgInput = el('nx-dm-img');
      if (dmImgInput) dmImgInput.addEventListener('change', () => { const f = dmImgInput.files && dmImgInput.files[0]; if (!f) return; dmImg = f; el('nx-dm-preview-img').src = URL.createObjectURL(f); el('nx-dm-preview').hidden = false; });
      el('nx-dm-preview-x') && el('nx-dm-preview-x').addEventListener('click', () => { dmImg = null; if (dmImgInput) dmImgInput.value = ''; el('nx-dm-preview').hidden = true; });
      el('nx-dm-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!dmOther || !dmThreadComm || !(await ensureSession())) return;
        const inp = el('nx-dm-input'); const v = inp.value.trim();
        if (!v && !dmImg) return;
        let imgUrl = null; if (dmImg) { imgUrl = await uploadImage(dmImg); if (!imgUrl) return; }
        inp.value = '';
        let data;
        try { data = await NexusData.sendDM(dmThreadComm, dmOther, v || null, imgUrl, SESSION.user.id); }
        catch (err) { toast(err && err.code === '42501' ? 'You both need to be in this tribe to message.' : 'Could not send — try again.'); return; }
        dmImg = null; if (dmImgInput) dmImgInput.value = ''; el('nx-dm-preview').hidden = true;
        dmAppend(data);
      });
      el('nx-dm-input').addEventListener('focus', () => setTimeout(() => el('nx-dm-input').scrollIntoView({ block: 'center' }), 200));

      // ── create tribe (persistent community; signed-in only) ───────────────
      const tribeModal = el('nx-tribe-modal');
      const openTribeCreate = () => {
        if (!SESSION) { toast('Sign in to create a tribe.'); return; }
        tribeModal.hidden = false; setTimeout(() => el('nx-tribe-name-in').focus(), 30);
      };
      const closeTribeCreate = () => { tribeModal.hidden = true; el('nx-tribe-form').reset(); };
      el('nx-newtribe').addEventListener('click', openTribeCreate);
      el('nx-tribe-cancel').addEventListener('click', closeTribeCreate);
      el('nx-tribe-vis') && el('nx-tribe-vis').addEventListener('click', (e) => { const b = e.target.closest('.nx-vis'); if (!b) return; el('nx-tribe-vis').querySelectorAll('.nx-vis').forEach((x) => x.classList.remove('on')); b.classList.add('on'); });
      tribeModal.addEventListener('click', (e) => { if (e.target === tribeModal) closeTribeCreate(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tribeModal.hidden) closeTribeCreate(); });
      el('nx-tribe-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!SESSION) { toast('Sign in to create a tribe.'); return; }
        const name = el('nx-tribe-name-in').value.trim(); if (!name) return;
        const desc = el('nx-tribe-desc-in').value.trim();
        const goBtn = el('nx-tribe-form').querySelector('.nx-modal-go'); if (goBtn) goBtn.disabled = true;
        const visBtn = el('nx-tribe-vis') && el('nx-tribe-vis').querySelector('.nx-vis.on');
        const p_visibility = visBtn ? visBtn.getAttribute('data-vis') : 'public';
        const { data, error } = await supabase.rpc('nexus_create_tribe', { p_name: name, p_description: desc || null, p_visibility });
        if (goBtn) goBtn.disabled = false;
        if (error || !data) { toast(error && error.code === '42501' ? 'Sign in to create a tribe.' : 'Could not create the tribe — try again.'); return; }
        closeTribeCreate();
        TRIBES.unshift(data);
        openTribe(data);
        loadTribes();
        loadMyTribes().catch(() => {}); // creator is auto-membered → show on home swiper
      });

      // back buttons
      document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => { if (curTribeChan) { try { supabase.removeChannel(curTribeChan); } catch (e) {} curTribeChan = null; } if (chan) leaveRoom(); else show('home'); }));
      // Real leave on tab close: keepalive heartbeat reporting here-1 so the room
      // decrements / archives instead of lingering as a ghost. (Belt-and-braces with
      // the server-side nexus-sweep-rooms cron.)
      window.addEventListener('pagehide', () => {
        if (!curRoom || !SB_URL) return;
        try {
          fetch(SB_URL + '/rest/v1/rpc/nexus_room_heartbeat', { method: 'POST', keepalive: true, headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_room_id: curRoom.id, p_here: Math.max(0, here - 1), p_msg_delta: 0 }) });
        } catch (e) {}
      });

      // ── greeting: they're logged in, so greet them (don't explain Nexus) ──
      // Nexus is anonymous ALWAYS — greet by the anonymous handle, never the real name.
      function setGreeting() {
        const h = new Date().getHours();
        const gword = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
        const gEl = el('nx-greet'); if (!gEl) return;
        gEl.textContent = '';
        gEl.appendChild(document.createTextNode(gword + ', '));
        const s = document.createElement('span'); s.className = 'nx-accent'; s.textContent = ME.handle;
        gEl.appendChild(s);
        gEl.appendChild(document.createTextNode(' — you’re anonymous here.'));
      }

      // Live membership: when THIS account joins/leaves a tribe (here, another tab, or
      // another device), re-render the home swiper in realtime. RLS is self-read, so the
      // user_id filter only ever delivers this account's own rows.
      let myTribesSub = null;
      function subscribeMyTribes() {
        if (myTribesSub || !SESSION || !SESSION.user) return;
        myTribesSub = supabase.channel('nx-my-tribes:' + SESSION.user.id)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'nexus_community_members', filter: 'user_id=eq.' + SESSION.user.id }, () => { loadMyTribes().catch(() => {}); })
          .subscribe();
      }

      // ── crisis support card (#5): private, author-only, runs in BOTH modes ─
      const crisisModal = el('nx-crisis');
      async function checkCrisisSupport() {
        if (!crisisModal) return;
        const ev = await NexusData.getCrisisSupport();
        if (!ev) return;
        crisisModal.dataset.eventId = ev.id;
        crisisModal.hidden = false;
      }
      if (crisisModal) crisisModal.addEventListener('click', (e) => {
        const ok = e.target.closest('#nx-crisis-ok');
        const cta = e.target.closest('.nx-crisis-cta');
        if (!ok && !cta) return;
        const id = crisisModal.dataset.eventId; if (id) NexusData.ackCrisis(id);
        if (ok) crisisModal.hidden = true; // the CTA navigates to Minit
      });

      // ── removal notices (#11): tell the author when their content was removed ─
      async function checkRemovalNotices() {
        const n = await NexusData.getRemovalNotices();
        if (n > 0) { toast(n === 1 ? 'A moderator removed one of your posts.' : 'A moderator removed ' + n + ' of your posts.'); NexusData.ackRemovalNotices(); }
      }

      // ── recognition (#18/#19): gentle streak + earned badges ──────────────
      async function renderStanding() {
        const elS = el('nx-standing'); if (!elS) return;
        const st = await NexusData.getStanding(); if (!st) { elS.hidden = true; return; }
        const parts = [];
        if (st.streak && st.streak.current > 0) parts.push('<span class="nx-streak-chip">🔥 ' + st.streak.current + '-day streak</span>');
        (st.badges || []).slice(0, 10).forEach((b) => parts.push('<span class="nx-badge" title="' + esc(b.label) + '">' + b.emoji + '</span>'));
        if (!parts.length) { elS.hidden = true; return; }
        elS.innerHTML = parts.join(''); elS.hidden = false;
      }

      // ── #17 "For you" feed (resonance-ranked) ─────────────────────────────
      const feedEl = el('nx-feed');
      function feedCard(p) {
        const blak = !!p.is_ai_author;
        const who = blak ? '<span class="nx-blak">✦ Blak</span>' : '@' + esc(p.author_handle || 'someone');
        const av = blak ? '<span class="nx-disc-av nx-av-blak"></span>' : '<span class="nx-disc-av" style="background:' + g(hashIdx(p.author_token || p.id)) + '"></span>';
        const txt = (p.image_url && !(p.body || '').trim()) ? '📷 shared an image' : esc((p.title ? p.title + ' — ' : '') + (p.body || '').slice(0, 140));
        return '<button type="button" class="nx-feed-card" data-open-tribe="' + esc(p.community_id) + '" data-tribe-name="' + esc(p.community_name || 'a tribe') + '">'
          + '<div class="nx-feed-top">' + av + '<span class="nx-feed-who">' + who + '</span><span>·</span><span class="nx-feed-tribe">' + esc(p.community_name || '') + '</span>' + (p.resonance != null ? '<span class="nx-feed-reso">◈ ' + p.resonance + '%</span>' : '') + '</div>'
          + '<div class="nx-feed-body">' + txt + '</div>'
          + '<div class="nx-feed-foot">◈ ' + (p.impact_count || 0) + ' · 💬 ' + (p.comment_count || 0) + ' · ' + rel(p.created_at) + '</div></button>';
      }
      async function loadFeed() {
        if (!feedEl) return;
        let posts = [];
        try { posts = await NexusData.getFeed(24); } catch (e) {}
        if (!posts.length) { feedEl.innerHTML = '<p class="nx-pulse-explain" style="margin:0">Nothing here yet — join a tribe or post something, and your feed fills in.</p>'; return; }
        feedEl.innerHTML = posts.map(feedCard).join('');
      }
      feedEl && feedEl.addEventListener('click', (e) => {
        const c = e.target.closest('[data-open-tribe]'); if (!c) return;
        const id = c.getAttribute('data-open-tribe'), name = c.getAttribute('data-tribe-name');
        const t = MY_TRIBES.find((x) => x.id === id) || TRIBES.find((x) => x.id === id) || { id, name, description: '' };
        openTribe(t);
      });

      // ── #32 discover (trending public tribes) ─────────────────────────────
      const discoverEl = el('nx-discover');
      async function loadTrending() {
        if (!discoverEl) return;
        let list = [];
        try { list = await NexusData.getTrending(); } catch (e) {}
        if (!list.length) { discoverEl.innerHTML = '<p class="nx-pulse-explain" style="margin:0">No public tribes yet — be the first to start one.</p>'; return; }
        discoverEl.innerHTML = list.map((t) => '<button type="button" class="nx-tribe-card" data-open-tribe="' + esc(t.id) + '" data-tribe-name="' + esc(t.name) + '"><span class="nx-tc-mark" style="background:' + g(hashIdx(t.id)) + '"></span><span class="nx-tc-who"><b>' + esc(t.name) + '</b><span>' + (t.members || 0) + ' member' + (t.members === 1 ? '' : 's') + ' · ' + (t.recent_posts || 0) + ' recent</span></span></button>').join('');
      }
      discoverEl && discoverEl.addEventListener('click', (e) => { const c = e.target.closest('[data-open-tribe]'); if (!c) return; const id = c.getAttribute('data-open-tribe'), name = c.getAttribute('data-tribe-name'); const t = TRIBES.find((x) => x.id === id) || { id, name, description: '' }; openTribe(t); });

      // ── #36 onboarding (one-time, anti-FOMO, dismissible) ─────────────────
      (function onboard() {
        const o = el('nx-onboard'); if (!o) return;
        let seen = false; try { seen = localStorage.getItem('nx_onboarded') === '1'; } catch (e) {}
        if (seen) return;
        o.hidden = false;
        const ok = el('nx-onboard-ok'); if (ok) ok.addEventListener('click', () => { o.hidden = true; try { localStorage.setItem('nx_onboarded', '1'); } catch (e) {} });
      })();

      // ── go ── (resilient: render first, never block the home on auth) ──
      setGreeting();                  // immediate anonymous greeting
      loadRooms().catch(() => {});    // live rooms — independent of auth
      loadTribes().catch(() => {});   // public tribes — for discovery + name lookup
      loadFeed().catch(() => {});     // "For you" resonance-ranked feed (anon-safe)
      loadTrending().catch(() => {}); // #32 discover trending public tribes
      // #33 deep link: ?tribe=<id> opens that tribe (RLS gates private/anon to members)
      (async () => {
        try {
          const tid = new URLSearchParams(location.search).get('tribe'); if (!tid) return;
          let t = TRIBES.find((x) => x.id === tid);
          if (!t) { const { data } = await supabase.from('nexus_communities').select('id,slug,name,description,visibility').eq('id', tid).maybeSingle(); if (data) t = data; }
          if (t) openTribe(t);
        } catch (e) {}
      })();
      (async () => {
        // Stay ANONYMOUS even when signed in: derive a stable handle from the account
        // id instead of leaking the email. getSession is raced with a timeout so a
        // slow/locked auth call can never freeze the home.
        try {
          const res = await Promise.race([
            supabase.auth.getSession(),
            new Promise((r) => setTimeout(() => r({ data: { session: null } }), 4000)),
          ]);
          SESSION = (res && res.data && res.data.session) || null;
          if (SESSION && SESSION.user) { ME.handle = anonHandle(SESSION.user.id); setGreeting(); }
        } catch (e) {}
        loadMyTribes().catch(() => {});
        subscribeMyTribes(); // live updates for join/leave on this account
        if (SESSION && SESSION.user) { checkCrisisSupport(); checkRemovalNotices(); renderStanding(); }
      })();
    }

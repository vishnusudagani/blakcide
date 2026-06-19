    // ── Nexus, wired ──────────────────────────────────────────────────────────
    // Live Rooms (the star) are genuinely real-time: Supabase Realtime carries
    // PRESENCE (who's here) + BROADCAST (live chat); the nexus_rooms table is the
    // persistent registry + Pulse history. Tribes read the real nexus_communities
    // / nexus_posts. Works for anonymous beta visitors (anon key, RLS-safe) and
    // uses your real identity if signed in.
    import { supabase, supabaseConfigured } from '../../lib/supabaseClient';

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
      return supabase.storage.from('nexus-img').getPublicUrl(path).data.publicUrl;
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
        return '<button type="button" class="nx-tile-post" data-open-tribe="' + esc(commId) + '">' + (isBlak(p) ? '<span class="nx-tile-av nx-av-blak"></span>' : '<span class="nx-tile-av" style="background:' + g(hashIdx(p.author_user_id || p.id)) + '"></span>') + '<span class="nx-tile-ptxt">' + txt + '</span><span class="nx-tile-when">' + rel(p.created_at) + '</span></button>';
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
        const { data: posts } = await supabase.from('nexus_posts').select('community_id').eq('is_soft_hidden', false);
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
        MY_RECENT = {};
        const { data: posts } = await supabase.from('nexus_posts').select('id,body,image_url,created_at,author_user_id,community_id,is_ai_author').in('community_id', ids).eq('is_soft_hidden', false).order('created_at', { ascending: false }).limit(60);
        (posts || []).forEach((p) => { MY_RECENT[p.community_id] = MY_RECENT[p.community_id] || []; if (MY_RECENT[p.community_id].length < 3) MY_RECENT[p.community_id].push(p); });
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
        const { data, error } = await supabase.from('nexus_posts').insert({ community_id: id, author_user_id: SESSION.user.id, body: v || '', image_url: imgUrl }).select('id,body,image_url,created_at,author_user_id,community_id').single();
        if (btn) btn.disabled = false;
        if (error || !data) { toast('Could not post — try again.'); return; }
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
        const d = document.createElement('div'); d.className = 'nx-rmsg' + (me ? ' me' : '');
        d.innerHTML = '<span class="nx-rav" style="background:' + g(me ? ME.color : (m.color || 0)) + '"></span><div><span class="nx-rh"></span><p></p></div>';
        d.querySelector('.nx-rh').textContent = me ? 'you' : (m.handle || 'someone');
        d.querySelector('p').textContent = m.text;
        feed.appendChild(d); feed.scrollTop = feed.scrollHeight;
      }
      function openRoom(r) {
        curRoom = r;
        el('nx-room-title').textContent = r.title;
        el('nx-stat-day').textContent = 'day ' + dayOf(r.created_at);
        setPulse(r.pulse); el('nx-stat-here').textContent = 1; el('nx-stat-time').textContent = '0m';
        el('nx-heat-fill').style.width = '20%';
        el('nx-pulse-orb').classList.remove('resting');
        el('nx-room-feed').innerHTML = '<div class="nx-rmsg"><span class="nx-rav" style="background:' + g(3) + '"></span><div><span class="nx-rh">blak · quiet moderator</span><p></p></div></div>';
        el('nx-room-feed').querySelector('p').textContent = 'You’re in — say hello 👋';
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
      let curTribe = null;
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
      }
      async function refreshJoinState() {
        const btn = el('nx-tribe-join'); btn.dataset.joined = ''; btn.textContent = 'Join';
        if (!curTribe || !(await ensureSession())) return;
        try {
          const { data } = await supabase.from('nexus_community_members').select('community_id').eq('community_id', curTribe.id).eq('user_id', SESSION.user.id).maybeSingle();
          if (data) { btn.dataset.joined = '1'; btn.textContent = 'Joined ✓'; }
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
        const uid = p.author_user_id || '';
        const blak = isBlak(p);
        const mine = SESSION && uid === SESSION.user.id;
        const who = blak
          ? '<span class="nx-blak">✦ Blak</span>'
          : (mine
            ? '@' + esc(discHandle(uid)) + ' (you)'
            : '<span class="nx-dm-link" data-dm-user="' + esc(uid) + '">@' + esc(discHandle(uid)) + '</span>');
        const av = blak
          ? '<span class="nx-disc-av nx-av-blak"></span>'
          : '<span class="nx-disc-av" style="background:' + g(hashIdx(uid || p.id)) + '"></span>';
        return '<div class="nx-disc' + (blak ? ' nx-disc-blak' : '') + '" data-post="' + esc(p.id) + '">'
          + '<div class="nx-disc-top">' + av + who + ' · ' + rel(p.created_at) + '</div>'
          + (p.title ? '<div class="nx-disc-text" style="font-weight:650">' + esc(p.title) + '</div>' : '')
          + (p.body ? '<div class="nx-disc-text">' + esc(p.body) + '</div>' : '')
          + (p.image_url ? '<img class="nx-img" loading="lazy" src="' + esc(p.image_url) + '" alt="shared image" />' : '')
          + '<div class="nx-disc-foot"><span class="nx-reso' + (resonated ? ' on' : '') + '" data-reso>◈ <b>' + (p.impact_count || 0) + '</b> resonate</span>'
          + '<span class="nx-disc-replies" data-open>💬 <b>' + (p.comment_count || 0) + '</b> replies</span></div>'
          + '<div class="nx-comments" hidden></div></div>';
      }
      async function loadDiscussions() {
        const disc = el('nx-discussions');
        const { data: posts } = await supabase.from('nexus_posts')
          .select('id,title,body,image_url,impact_count,comment_count,created_at,author_user_id')
          .eq('community_id', curTribe.id).eq('is_soft_hidden', false).order('created_at', { ascending: false });
        if (!posts || !posts.length) { disc.innerHTML = '<p class="nx-pulse-explain">No discussions yet — be the first.</p>'; return; }
        const mine = new Set();
        if (await ensureSession()) {
          try { const { data: imp } = await supabase.from('nexus_impacts').select('post_id').eq('user_id', SESSION.user.id).eq('impact_type', 'resonated').in('post_id', posts.map((p) => p.id)); (imp || []).forEach((r) => mine.add(r.post_id)); } catch (e) {}
        }
        disc.innerHTML = posts.map((p) => discCard(p, mine.has(p.id))).join('');
      }
      async function openComments(postId, box) {
        box.innerHTML = '<p class="nx-pulse-explain" style="margin:.2rem 0">Loading replies…</p>';
        const { data: cs } = await supabase.from('nexus_comments').select('id,body,created_at,author_user_id,is_ai_author').eq('post_id', postId).eq('is_soft_hidden', false).order('created_at', { ascending: true });
        box.innerHTML = '<div class="nx-cmt-list"></div><form class="nx-cmt-form" data-cform><input placeholder="Write a reply…" autocomplete="off" maxlength="600" /><button type="submit">Reply</button></form>';
        const listEl = box.querySelector('.nx-cmt-list');
        if (!cs || !cs.length) listEl.innerHTML = '<p class="nx-pulse-explain" style="margin:.2rem 0">No replies yet — be the first.</p>';
        else cs.forEach((c) => { const blak = isBlak(c); const d = document.createElement('div'); d.className = 'nx-cmt' + (blak ? ' nx-cmt-blak' : ''); const av = blak ? '<span class="nx-cmt-av nx-av-blak"></span>' : '<span class="nx-cmt-av" style="background:' + g(hashIdx(c.author_user_id || c.id)) + '"></span>'; const h = blak ? '<span class="nx-blak">✦ Blak</span> · ' + rel(c.created_at) : '@' + esc(discHandle(c.author_user_id)) + ' · ' + rel(c.created_at); d.innerHTML = av + '<div><span class="nx-cmt-h">' + h + '</span><p></p></div>'; d.querySelector('p').textContent = c.body; listEl.appendChild(d); });
        box.querySelector('[data-cform]').addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const inp = ev.currentTarget.querySelector('input'); const v = inp.value.trim(); if (!v) return;
          if (!(await ensureSession())) { toast('Sign in to reply.'); return; }
          inp.value = '';
          const { error } = await supabase.from('nexus_comments').insert({ post_id: postId, author_user_id: SESSION.user.id, body: v });
          if (error) { toast('Could not post your reply — try again.'); return; }
          joinTribeSilently();
          const card = box.closest('[data-post]'); const rb = card && card.querySelector('.nx-disc-replies b'); if (rb) rb.textContent = (+rb.textContent + 1);
          openComments(postId, box);
        });
      }

      el('nx-tribe-live').addEventListener('click', async (e) => {
        if (!e.target.closest('[data-tribe-room]') || !curTribe) return;
        const existing = ROOMS.find((r) => isActive(r) && r.title === curTribe.name);
        if (existing) { openRoom(existing); return; }
        const { data } = await supabase.rpc('nexus_create_room', { p_title: curTribe.name, p_topic: 'live room · ' + curTribe.name, p_emoji: null, p_host_handle: ME.handle });
        if (data) openRoom(data); else toast('Could not open the room — try again.');
      });

      el('nx-discussions').addEventListener('click', async (e) => {
        const card = e.target.closest('[data-post]'); if (!card) return;
        const id = card.getAttribute('data-post');
        const dm = e.target.closest('[data-dm-user]');
        if (dm) { const uid = dm.getAttribute('data-dm-user'); openDM(curTribe.id, uid, discHandle(uid), 'tribe'); return; }
        const r = e.target.closest('[data-reso]');
        if (r) {
          if (!(await ensureSession())) { toast('Sign in to resonate.'); return; }
          const b = r.querySelector('b'); const on = r.classList.contains('on');
          r.classList.toggle('on'); b.textContent = Math.max(0, (+b.textContent) + (on ? -1 : 1));
          if (on) { await supabase.from('nexus_impacts').delete().eq('post_id', id).eq('user_id', SESSION.user.id).eq('impact_type', 'resonated'); }
          else { const { error } = await supabase.from('nexus_impacts').insert({ post_id: id, user_id: SESSION.user.id, impact_type: 'resonated' }); if (error && error.code !== '23505') { r.classList.remove('on'); b.textContent = Math.max(0, (+b.textContent) - 1); toast('Could not resonate — try again.'); } }
          return;
        }
        if (e.target.closest('[data-open]') || e.target.closest('.nx-disc-text')) {
          const box = card.querySelector('.nx-comments'); if (!box) return;
          if (!box.hidden) { box.hidden = true; box.innerHTML = ''; return; }
          box.hidden = false; openComments(id, box);
        }
      });

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
        const { data, error } = await supabase.from('nexus_posts')
          .insert({ community_id: curTribe.id, author_user_id: SESSION.user.id, title: t || null, body: v || '', image_url: imgUrl })
          .select('id,title,body,image_url,impact_count,comment_count,created_at,author_user_id').single();
        if (goBtn) goBtn.disabled = false;
        if (error || !data) { toast('Could not post — try again.'); return; }
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
      function dmAppend(m, mine) {
        const feed = el('nx-dm-feed'); if (!feed) return;
        const d = document.createElement('div'); d.className = 'nx-rmsg' + (mine ? ' me' : '');
        d.innerHTML = '<span class="nx-rav" style="background:' + g(hashIdx(mine ? ((SESSION && SESSION.user.id) || ME.id) : (m.sender_user_id || '0'))) + '"></span><div><span class="nx-rh"></span></div>';
        d.querySelector('.nx-rh').textContent = mine ? 'you' : ('@' + handleFor(m.sender_user_id, dmThreadComm));
        const body = d.querySelector('div');
        if (m.body) { const p = document.createElement('p'); p.textContent = m.body; body.appendChild(p); }
        if (m.image_url) { const im = document.createElement('img'); im.className = 'nx-img'; im.loading = 'lazy'; im.src = m.image_url; body.appendChild(im); }
        feed.appendChild(d); feed.scrollTop = feed.scrollHeight;
      }
      function teardownDM() { if (dmChanSub) { try { supabase.removeChannel(dmChanSub); } catch (e) {} dmChanSub = null; } }
      function subscribeGlobalDM() {
        if (dmChanSub || !SESSION) return;
        dmChanSub = supabase.channel('nx-dm:' + SESSION.user.id)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'nexus_dm_messages', filter: 'recipient_user_id=eq.' + SESSION.user.id }, (p) => {
            const m = p.new; if (!m) return;
            if (dmOther && m.sender_user_id === dmOther && m.community_id === dmThreadComm) dmAppend(m, false);
            else toast('New private message');
          }).subscribe();
      }
      async function openDM(communityId, otherId, otherHandle, from) {
        if (!(await ensureSession())) { toast('Sign in to message.'); return; }
        if (!otherId || !communityId || otherId === SESSION.user.id) return;
        dmOther = otherId; dmThreadComm = communityId; dmBackView = (from === 'inbox') ? 'inbox' : 'tribe';
        el('nx-dm-title').textContent = '@' + (otherHandle || handleFor(otherId, communityId));
        el('nx-dm-sub').textContent = tribeName(communityId) + ' · anonymous';
        el('nx-dm-form').hidden = false;
        el('nx-dm-feed').innerHTML = '<div class="nx-rmsg"><span class="nx-rav" style="background:' + g(2) + '"></span><div><span class="nx-rh">private</span><p>Anonymous & members-only — only the two of you can see this.</p></div></div>';
        show('dm');
        const { data } = await supabase.from('nexus_dm_messages').select('*').eq('community_id', communityId)
          .or('and(sender_user_id.eq.' + SESSION.user.id + ',recipient_user_id.eq.' + otherId + '),and(sender_user_id.eq.' + otherId + ',recipient_user_id.eq.' + SESSION.user.id + ')')
          .order('created_at', { ascending: true });
        (data || []).forEach((m) => dmAppend(m, m.sender_user_id === SESSION.user.id));
        subscribeGlobalDM();
      }
      async function openMsgInbox(commId) {
        if (!(await ensureSession())) { toast('Sign in to see messages.'); return; }
        dmOther = null; dmInboxComm = commId || null;
        el('nx-dm-title').textContent = 'Messages';
        el('nx-dm-sub').textContent = (commId ? tribeName(commId) : 'all tribes') + ' · anonymous';
        el('nx-dm-form').hidden = true;
        const feed = el('nx-dm-feed'); feed.innerHTML = '<p class="nx-pulse-explain">Loading…</p>';
        show('dm'); subscribeGlobalDM();
        const me = SESSION.user.id;
        let q = supabase.from('nexus_dm_messages').select('community_id,sender_user_id,recipient_user_id,body,image_url,created_at').or('sender_user_id.eq.' + me + ',recipient_user_id.eq.' + me).order('created_at', { ascending: false }).limit(300);
        if (commId) q = q.eq('community_id', commId);
        const { data } = await q;
        const seen = {}, convos = [];
        (data || []).forEach((m) => { const other = m.sender_user_id === me ? m.recipient_user_id : m.sender_user_id; const key = m.community_id + ':' + other; if (seen[key]) return; seen[key] = 1; convos.push({ other, comm: m.community_id, last: m }); });
        if (!convos.length) { feed.innerHTML = '<p class="nx-pulse-explain">No messages yet. Open a discussion and tap a member’s @handle to start a private, anonymous chat.</p>'; return; }
        const row = (c) => '<button type="button" class="nx-inbox-row" data-dm-open="' + esc(c.other) + '" data-dm-comm="' + esc(c.comm) + '"><span class="nx-disc-av" style="background:' + g(hashIdx(c.other)) + '"></span><span class="nx-inbox-meta"><b>@' + esc(handleFor(c.other, c.comm)) + '</b><span>' + esc((commId ? '' : tribeName(c.comm) + ' · ') + (c.last.image_url && !c.last.body ? '📷 image' : (c.last.body || ''))) + '</span></span><span class="nx-inbox-when">' + rel(c.last.created_at) + '</span></button>';
        feed.innerHTML = '<input type="text" class="nx-dm-search" id="nx-dm-search" placeholder="Search messages…" autocomplete="off" /><div id="nx-dm-rows"></div>';
        const rowsEl = el('nx-dm-rows'); rowsEl.innerHTML = convos.map(row).join('');
        const si = el('nx-dm-search');
        if (si) si.addEventListener('input', () => { const qq = si.value.trim().toLowerCase(); const f = qq ? convos.filter((c) => handleFor(c.other, c.comm).toLowerCase().includes(qq) || (c.last.body || '').toLowerCase().includes(qq) || tribeName(c.comm).toLowerCase().includes(qq)) : convos; rowsEl.innerHTML = f.length ? f.map(row).join('') : '<p class="nx-pulse-explain">No matches.</p>'; });
      }
      el('nx-dm-feed').addEventListener('click', (e) => { const row = e.target.closest('[data-dm-open]'); if (!row) return; const other = row.getAttribute('data-dm-open'); const comm = row.getAttribute('data-dm-comm'); openDM(comm, other, handleFor(other, comm), 'inbox'); });
      el('nx-dm-back').addEventListener('click', () => {
        if (dmOther) { dmOther = null; if (dmBackView === 'inbox') { openMsgInbox(dmInboxComm); return; } teardownDM(); show(curTribe ? 'tribe' : 'home'); return; }
        teardownDM(); show(dmInboxComm ? 'tribe' : 'home');
      });
      el('nx-tribe-msgs') && el('nx-tribe-msgs').addEventListener('click', () => openMsgInbox(curTribe ? curTribe.id : null));
      el('nx-home-msgs') && el('nx-home-msgs').addEventListener('click', () => openMsgInbox(null));
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
        const { data, error } = await supabase.from('nexus_dm_messages').insert({ community_id: dmThreadComm, sender_user_id: SESSION.user.id, recipient_user_id: dmOther, body: v || null, image_url: imgUrl }).select('*').single();
        if (error || !data) { toast(error && error.code === '42501' ? 'You both need to be in this tribe to message.' : 'Could not send — try again.'); return; }
        dmImg = null; if (dmImgInput) dmImgInput.value = ''; el('nx-dm-preview').hidden = true;
        dmAppend(data, true);
      });

      // ── create tribe (persistent community; signed-in only) ───────────────
      const tribeModal = el('nx-tribe-modal');
      const openTribeCreate = () => {
        if (!SESSION) { toast('Sign in to create a tribe.'); return; }
        tribeModal.hidden = false; setTimeout(() => el('nx-tribe-name-in').focus(), 30);
      };
      const closeTribeCreate = () => { tribeModal.hidden = true; el('nx-tribe-form').reset(); };
      el('nx-newtribe').addEventListener('click', openTribeCreate);
      el('nx-tribe-cancel').addEventListener('click', closeTribeCreate);
      tribeModal.addEventListener('click', (e) => { if (e.target === tribeModal) closeTribeCreate(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !tribeModal.hidden) closeTribeCreate(); });
      el('nx-tribe-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!SESSION) { toast('Sign in to create a tribe.'); return; }
        const name = el('nx-tribe-name-in').value.trim(); if (!name) return;
        const desc = el('nx-tribe-desc-in').value.trim();
        const goBtn = el('nx-tribe-form').querySelector('.nx-modal-go'); if (goBtn) goBtn.disabled = true;
        const { data, error } = await supabase.rpc('nexus_create_tribe', { p_name: name, p_description: desc || null });
        if (goBtn) goBtn.disabled = false;
        if (error || !data) { toast(error && error.code === '42501' ? 'Sign in to create a tribe.' : 'Could not create the tribe — try again.'); return; }
        closeTribeCreate();
        TRIBES.unshift(data);
        openTribe(data);
        loadTribes();
        loadMyTribes().catch(() => {}); // creator is auto-membered → show on home swiper
      });

      // back buttons
      document.querySelectorAll('[data-home]').forEach((b) => b.addEventListener('click', () => { if (chan) leaveRoom(); else show('home'); }));
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

      // ── go ── (resilient: render first, never block the home on auth) ──
      setGreeting();                  // immediate anonymous greeting
      loadRooms().catch(() => {});    // live rooms — independent of auth
      loadTribes().catch(() => {});   // public tribes — for discovery + name lookup
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
      })();
    }

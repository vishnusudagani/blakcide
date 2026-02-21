document.addEventListener('DOMContentLoaded', () => {

    // --- 1. THREE.JS HOLOGRAPHIC BACKGROUND ---
    const canvas = document.getElementById('pearl-canvas');
    if (canvas && typeof THREE !== 'undefined') {
        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
        
        const resize = () => renderer.setSize(window.innerWidth, window.innerHeight);
        resize(); 
        window.addEventListener('resize', resize);
        
        const uniforms = { uTime: { value: 0 }, uMouse: { value: new THREE.Vector2(0, 0) }, uScroll: { value: 0 } };
        
        window.addEventListener('mousemove', (e) => {
            uniforms.uMouse.value.x = (e.clientX / window.innerWidth) * 2 - 1;
            uniforms.uMouse.value.y = -(e.clientY / window.innerHeight) * 2 + 1;
        });

        const material = new THREE.ShaderMaterial({
            uniforms: uniforms,
            vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }`,
            fragmentShader: `
                uniform float uTime; uniform vec2 uMouse; uniform float uScroll; varying vec2 vUv;
                vec3 palette( in float t ) { return vec3(0.9)+vec3(0.1)*cos(6.283*(vec3(1.0)*t+vec3(0.00,0.33,0.67))); }
                void main() {
                    vec2 uv = vUv * 2.0 - 1.0; float t = uTime * 0.15; vec2 uMu = uMouse * 0.1;
                    for(float i=1.0; i<3.0; i++){ uv.x+=0.3/i*sin(i*2.0*uv.y+t+uMu.x); uv.y+=0.3/i*cos(i*2.0*uv.x+t+uMu.y); }
                    float dist = length(uv); vec3 col = palette(dist * 0.4 - t + uScroll * 0.8);
                    col = mix(col, vec3(0.98, 0.97, 0.96), 0.4); gl_FragColor = vec4(col, 1.0);
                }
            `
        });
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
        
        const animate = () => { uniforms.uTime.value += 0.005; renderer.render(scene, camera); requestAnimationFrame(animate); };
        animate();
    } else {
        console.warn("Background couldn't load. Check internet connection for Three.js.");
    }

    // --- 2. UI BUTTONS & NAVIGATION ---
    const getEl = (id) => document.getElementById(id);
    const click = (id, fn) => { const el = getEl(id); if(el) el.addEventListener('click', fn); };

    // Flip Feature Cards
    document.querySelectorAll('.bento-card').forEach(card => {
        card.addEventListener('click', () => card.classList.toggle('flipped'));
    });

    // Dropdown Menu Logic
    const menuBtn = getEl('menu-toggle-btn');
    const menuDropdown = getEl('dropdown-menu');
    
    if (menuBtn && menuDropdown) {
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menuDropdown.classList.toggle('active');
        });

        window.addEventListener('click', (e) => {
            if (!menuDropdown.contains(e.target) && !menuBtn.contains(e.target)) {
                menuDropdown.classList.remove('active');
            }
        });
    }

    window.closeMenu = () => {
        if(menuDropdown) menuDropdown.classList.remove('active');
    };

    // Scroll & Auth Buttons
    click('know-us-btn', () => {
        const target = getEl('promise');
        const container = getEl('main-scroll');
        if(target && container) container.scrollTo({ top: target.offsetTop, behavior: 'smooth' });
    });
    
    click('tell-us-btn', () => {
        const auth = getEl('auth-overlay');
        if(auth) auth.classList.add('active');
    });
    
    click('close-auth-btn', () => {
        const auth = getEl('auth-overlay');
        if(auth) auth.classList.remove('active');
    });

    // --- 3. SUPABASE AUTHENTICATION ---
    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
   
    if (typeof window.supabase !== 'undefined') {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }

    function proceedToSanctuary() {
        window.location.href = 'app/chat.html';
    }
     // Listen for Auth Changes to auto-redirect
    if (typeof window.supabase !== 'undefined') {
        supabase.auth.onAuthStateChange((event, session) => {
            const urlParams = new URLSearchParams(window.location.search);
            if (event === 'SIGNED_IN' && session && !urlParams.get('noredirect')) {
                window.location.href = 'app/chat.html';
            }
        });
    }

    click('google-login-btn', async () => {
        if(!supabase) return;
        const { error } = await supabase.auth.signInWithOAuth({ 
            provider: 'google', 
            options: { redirectTo: window.location.origin + '/app/chat.html' } 
        });
        if(error) alert(error.message);
    });

    const logForm = getEl('login-form');
    if (logForm) {
        logForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if(!supabase) return;

            const email = getEl('email').value; 
            const password = getEl('password').value;
            const errBox = getEl('auth-error');
            
            const { data, error } = await supabase.auth.signInWithPassword({ email, password });
            
            if (error) {
                // Try Sign Up if Login fails
                const { data: upData, error: upError } = await supabase.auth.signUp({ email, password });
                if (upError) { 
                    if(errBox) errBox.innerText = "Authentication Failed. Please try again."; 
                    return; 
                }
                if (upData.user) { proceedToSanctuary(); }
            } else { 
                proceedToSanctuary(); 
            }
        });
    }
    
    // Auto-login Check
    async function checkSession() {
        if(!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        
        const urlParams = new URLSearchParams(window.location.search);
        const preventRedirect = urlParams.get('noredirect');

        if (session && !preventRedirect) { 
            proceedToSanctuary(); 
        } else if (session && preventRedirect) {
            const tellUsBtn = document.querySelector('#tell-us-btn span');
            if(tellUsBtn) tellUsBtn.innerText = "Enter App";
        }
    }
    
    checkSession();
});
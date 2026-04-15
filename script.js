document.addEventListener('DOMContentLoaded', () => {

    // --- 1. THREE.JS HOLOGRAPHIC BACKGROUND ---
    const canvas = document.getElementById('pearl-canvas');
    if (canvas && typeof THREE !== 'undefined') {
        const scene = new THREE.Scene();
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const renderer = new THREE.WebGLRenderer({ canvas, alpha: true });
        
        const resize = () => renderer.setSize(window.innerWidth, window.innerHeight);
        resize(); window.addEventListener('resize', resize);
        
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

    document.querySelectorAll('.bento-card').forEach(card => {
        card.addEventListener('click', () => card.classList.toggle('flipped'));
    });

    const menuBtn = getEl('menu-toggle-btn');
    const menuDropdown = getEl('dropdown-menu');
    if (menuBtn && menuDropdown) {
        menuBtn.addEventListener('click', (e) => { e.stopPropagation(); menuDropdown.classList.toggle('active'); });
        window.addEventListener('click', (e) => {
            if (!menuDropdown.contains(e.target) && !menuBtn.contains(e.target)) menuDropdown.classList.remove('active');
        });
    }

    window.closeMenu = () => { if(menuDropdown) menuDropdown.classList.remove('active'); };

    click('know-us-btn', () => {
        const target = getEl('promise'); const container = getEl('main-scroll');
        if(target && container) container.scrollTo({ top: target.offsetTop, behavior: 'smooth' });
    });
    
    click('tell-us-btn', () => { const auth = getEl('auth-overlay'); if(auth) auth.classList.add('active'); });
    click('close-auth-btn', () => { const auth = getEl('auth-overlay'); if(auth) auth.classList.remove('active'); });

    // --- 3. SUPABASE AUTHENTICATION & SMART ROUTING ---
    const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
    const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

    let supabase;
    if (typeof window.supabase !== 'undefined') {
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }

    // The Master Router
    async function proceedToSanctuary(userId) {
        const submitBtn = document.querySelector('button[type="submit"]');
        if(submitBtn) submitBtn.innerText = "Routing securely...";

        try {
            // Check if user is an admin-approved listener
            const { data: listenerData } = await supabase
                .from('listeners')
                .select('id')
                .eq('user_id', userId)
                .maybeSingle(); 

            if (listenerData && listenerData.id) {
                window.location.href = 'app/listener-console.html';
            } else {
                window.location.href = 'app/dashboard.html';
            }
        } catch (err) {
            console.error("Routing error:", err);
            window.location.href = 'app/dashboard.html'; 
        }
    }

    // Google Login
    click('google-login-btn', async () => {
        if(!supabase) return;
        await supabase.auth.signInWithOAuth({ 
            provider: 'google', 
            options: { redirectTo: window.location.origin } 
        });
    });

    // Email & Password Handling
    const logForm = getEl('login-form');
    if (logForm) {
        logForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if(!supabase) return;

            const email = getEl('email').value.trim(); 
            const password = getEl('password').value;
            const errBox = getEl('auth-error');
            const submitBtn = logForm.querySelector('button[type="submit"]');
            
            if(errBox) { errBox.innerText = ""; errBox.style.color = "red"; }
            const originalBtnText = submitBtn ? submitBtn.innerText : "Enter Blakcide";
            if(submitBtn) { submitBtn.innerText = "Authenticating..."; submitBtn.disabled = true; }
            
            try {
                let sessionUser = null;

                // 1. Attempt Login
                const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password });
                
                if (signInError) {
                    // 2. If login fails, try to Sign Up automatically
                    if (signInError.message.toLowerCase().includes("invalid login")) {
                        if(submitBtn) submitBtn.innerText = "Creating Account...";
                        
                        const { data: signUpData, error: signUpError } = await supabase.auth.signUp({ email, password });
                        
                        if (signUpError) {
                            if (signUpError.message.includes("already registered")) throw new Error("Incorrect password. Please try again.");
                            throw signUpError;
                        }

                        // Handle if your Supabase requires Email Verification
                        if (signUpData.user && !signUpData.session) {
                            if(errBox) {
                                errBox.style.color = "#4CAF50"; 
                                errBox.innerText = "Account created! Please check your email to verify."; 
                            }
                            if(submitBtn) { submitBtn.innerText = originalBtnText; submitBtn.disabled = false; }
                            return;
                        }

                        sessionUser = signUpData.user;
                    } else {
                        throw signInError; // Throw rate limit or other errors
                    }
                } else {
                    sessionUser = signInData.user;
                }

                // 3. Route the validated user
                if (sessionUser) {
                    await proceedToSanctuary(sessionUser.id);
                }

            } catch (err) {
                console.error("Auth Error:", err);
                if(errBox) {
                    errBox.style.color = "red";
                    errBox.innerText = err.message || "Authentication Failed. Please try again."; 
                }
                if(submitBtn) { submitBtn.innerText = originalBtnText; submitBtn.disabled = false; }
            }
        });
    }
    
    // Auto-login Check on page load
    async function checkSession() {
        if(!supabase) return;
        const { data: { session } } = await supabase.auth.getSession();
        
        const urlParams = new URLSearchParams(window.location.search);
        const preventRedirect = urlParams.get('noredirect');

        if (session && !preventRedirect) { 
            await proceedToSanctuary(session.user.id); 
        } else if (session && preventRedirect) {
            const tellUsBtn = document.querySelector('#tell-us-btn span');
            if(tellUsBtn) tellUsBtn.innerText = "Enter App";
        }
    }
    
    checkSession();
});
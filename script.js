/* =========================================
   1. API CONFIGURATION (SAFE MODE)
   ========================================= */
// We do NOT store the key here for GitHub.
// We allow the user to input it in the browser for demo purposes.
let userApiKey = localStorage.getItem("blakcide_api_key") || "";

// Update the UI if a key is found
function updateKeyStatus() {
    const statusEl = document.getElementById("key-status");
    if (userApiKey) {
        statusEl.innerText = "🔒 API Key Active (Securely saved in your browser)";
        statusEl.style.color = "#4caf50"; // Green
    } else {
        statusEl.innerText = "🔒 No API Key detected. Click here to add one to test AI.";
        statusEl.style.color = "rgba(255,255,255,0.7)";
    }
}

function resetKey() {
    const key = prompt("Please enter your OpenAI API Key to test the demo:\n(It will be saved locally in your browser only)");
    if (key) {
        localStorage.setItem("blakcide_api_key", key);
        userApiKey = key;
        updateKeyStatus();
    }
}

// Initial check
updateKeyStatus();


/* =========================================
   SUPABASE CONFIGURATION
   ========================================= */
// It is generally okay to expose the Anon key for Supabase if Row Level Security (RLS) is on.
// If you want to be extra safe, use Netlify Environment variables for this too.
const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';


/* =========================================
   2. AI AGENT LOGIC (OpenAI)
   ========================================= */
async function sendToOpenAI() {
    const inputEl = document.getElementById("agent-input");
    const responseEl = document.getElementById("ai-response");
    const userText = inputEl.value.trim();
    if (!userText) return;

    if (!userApiKey) {
        resetKey();
        if(!userApiKey) return; // If they cancelled
    }
    
    // UI Feedback
    inputEl.value = "";
    responseEl.className = "active";
    responseEl.innerText = "Thinking...";

    try {
        const systemPrompt = `You are Blakcide, an empathetic AI friend.
        When answering, explain HOW a feature helps emotionally.
        - About us : blakcide exists for every person who wants to express and feel heard. Who wants an ear which is nonjudgemental, non-advised giving, very understanding, empathetic, supportive, private, loyal, has time just for them, make sense and has a deeper connection. Many people today, though have close friends aren’t close enough to speak their heart out. Or sometimes people are unavailable. Therapy feels like a stigma. Privacy issues and many more.
        - AI Companion: a companion who is like a replica to your best friend in digital form. you can text or call your friend and also expect back initiation from them. When you chat or talk with your friend, you can choose from the listener modes available such as deep connection mode(where AI tries to be even more empathetic and understand criticality of the situation and might enable you to talk deeper, just like a understanding, empathetic, loyal, and understanding, nonjudgemental, friend,) reflection mode(this mode enables AI to help you reflect on a particular situation by asking you deeper questions and derive a clarity based on your answers, )casual mode(just a casual AI friend, with whom you can talk, anything, no pressure, no limit), silent mode(sometimes, when you prefer listening over responses and advices, you can prefer silent mode).
        - Human support: this is where real humans talk to you or chat with you 1 to one with two privacy modes, anonymous and identity revealed based on your choice. We also provide topic based expert to cater for the needs specifically such as heartbreak, anxiety, stress, et cetera, we also can provide instant talking facility for shorter durations or pre-book a session for a longer duration. Human support is available on chat as well as call.
        - New age Journal: a traditional typical writing tool. This journal is integrated into your daily life, just like how you use your social media, but then this is your profile for which you are the follower. Snap or story style entries, enable you to click a picture and upload it immediately, or you can also write which is assisted by AI or insta journalling where you just write one liner or two liners based on the mode. Also, suggestion based journals are available based on your location time music. Quick entry option is also available where you just have to answer one or two questions with options against it, which makes entry even easier.
        - Games: specifically designed for mood enhancement and typical mind deviation for situations when we feel anxious, stressed or any other kind of deviation required.
        - Our AI is an analyser as well as summarise which can cross monitor the emotional patterns through user activity on the platform. Create user summary to the listener, make the profile clear for reflecting and greeting back the user. It gives non-diagnostic insights, only sometimes signaling, overthinking burnout, loneliness, et cetera, analysing language and tone, aware of your behavioural shift and identifying emotional triggers also detect thought repetation.
        Keep it warm, human, and under 2 sentences.`;

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${userApiKey}`
            },
            body: JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userText }]
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            responseEl.innerText = "Error: " + data.error.message;
        } else {
            responseEl.innerText = data.choices ? data.choices[0].message.content : "I'm having trouble connecting right now.";
        }

    } catch (err) {
        console.error(err);
        responseEl.innerText = "Connection error. Check your API Key.";
    }
}
function handleEnter(e) { if(e.key === 'Enter') sendToOpenAI(); }


/* =========================================
   3. NAVIGATION & UI LOGIC
   ========================================= */
const menu = document.getElementById("crystalMenu");

function toggleNav() {
    menu.classList.toggle("open");
}

function goTo(idx) {
    const h = window.innerHeight;
    document.getElementById("scroll-container").scrollTo({ top: idx * h, behavior: 'smooth' });
    menu.classList.remove("open");
}

// Intersection Observer for Scroll Animations
document.addEventListener("DOMContentLoaded", () => {
    const sections = document.querySelectorAll('.section');
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) entry.target.classList.add('visible');
        });
    }, { threshold: 0.2 });
    sections.forEach(sec => observer.observe(sec));
});


/* =========================================
   4. SUPABASE DATABASE LOGIC
   ========================================= */
let supabaseClient = null;
try {
    if (window.supabase) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
    console.warn("Supabase not initialized");
}

async function submitForm() {
    if (!supabaseClient) { alert("Please add Supabase keys in script.js to save data."); return; }
    
    const email = document.getElementById('email-input').value.trim();
    const vibe = document.getElementById('vibe-input').value;
    
    if (!email || !vibe) { alert("Please fill in both fields."); return; }

    const { error } = await supabaseClient.from('waitlist').insert([{ email, vibe }]);

    if (error && (error.code === '23505' || error.message.includes('duplicate'))) {
        document.getElementById('signup-form').style.display = 'none';
        document.getElementById('success-msg').style.display = 'block';
        document.getElementById('status-text').innerText = "You are already here. Welcome back.";
    } else if (error) {
        alert("Connection Error. Please try again.");
    } else {
        document.getElementById('signup-form').style.display = 'none';
        document.getElementById('success-msg').style.display = 'block';
    }
}


/* =========================================
   5. WEBGL SHADER BACKGROUND (VIVID NEBULA)
   ========================================= */
const canvas = document.getElementById("glcanvas");
const gl = canvas.getContext("webgl");
const container = document.getElementById("scroll-container");

const vertexShaderSource = `
    attribute vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const fragmentShaderSource = `
    precision highp float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform float u_scroll;

    // Simplex Noise
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
    float snoise(vec2 v) {
        const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy) );
        vec2 x0 = v - i + dot(i, C.xx);
        vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz;
        x12.xy -= i1;
        i = mod289(i);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
        vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
        m = m*m ; m = m*m ;
        vec3 x = 2.0 * fract(p * C.www) - 1.0;
        vec3 h = abs(x) - 0.5;
        vec3 ox = floor(x + 0.5);
        vec3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
        vec3 g;
        g.x  = a0.x  * x0.x  + h.x  * x0.y;
        g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        return 130.0 * dot(m, g);
    }

    // FBM for Clouds
    float fbm(vec2 st) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 3; i++) {
            v += a * snoise(st);
            st *= 2.0;
            a *= 0.5;
        }
        return v;
    }

    void main() {
        vec2 st = gl_FragCoord.xy / u_resolution.xy;
        st.x *= u_resolution.x / u_resolution.y;

        // Faster movement, diagonal drift
        float time = u_time * 0.15; 
        float flow = (st.x + st.y) * 0.8 - time;

        // Noise pattern
        float n = fbm(st * 1.5 + flow);

        // Colorful Gradient Palette (Vivid Nebula)
        vec3 c1 = vec3(0.4, 0.2, 0.8); // Deep Purple
        vec3 c2 = vec3(0.9, 0.4, 0.7); // Pink/Magenta
        vec3 c3 = vec3(0.2, 0.8, 0.9); // Cyan/Teal
        vec3 c4 = vec3(1.0, 0.6, 0.3); // Sunset Orange

        // Mix based on scroll + noise + time
        float p = u_scroll * 0.5 + n * 0.4 + st.y * 0.3;
        
        vec3 color;
        if (p < 0.33) {
            color = mix(c1, c2, p * 3.0);
        } else if (p < 0.66) {
            color = mix(c2, c3, (p - 0.33) * 3.0);
        } else {
            color = mix(c3, c4, (p - 0.66) * 3.0);
        }

        // Soften slightly with white
        color = mix(color, vec3(0.95), 0.1);

        gl_FragColor = vec4(color, 1.0);
    }
`;

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener("resize", resize); resize();

function createShader(gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if(!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null; return s;
}

const prog = gl.createProgram();
const vs = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

if (vs && fs) {
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog);
    const posLoc = gl.getAttribLocation(prog, "position");
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, "u_resolution");
    const uTime = gl.getUniformLocation(prog, "u_time");
    const uScroll = gl.getUniformLocation(prog, "u_scroll");

    function render(time) {
        const max = container.scrollHeight - container.clientHeight;
        const scroll = container.scrollTop / (max || 1);
        gl.uniform2f(uRes, canvas.width, canvas.height);
        gl.uniform1f(uTime, time * 0.001);
        gl.uniform1f(uScroll, scroll);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
}

/* =========================================
   1. NAVIGATION & UI LOGIC
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
   2. PUBLIC AI LOGIC (VIA NETLIFY FUNCTION)
   ========================================= */
async function sendToOpenAI() {
    const inputEl = document.getElementById("agent-input");
    const responseEl = document.getElementById("ai-response");
    const userText = inputEl.value.trim();
    if (!userText) return;
    
    // UI Feedback
    inputEl.value = "";
    responseEl.className = "active";
    responseEl.innerText = "Thinking...";

    try {
        // Attempts to talk to your Netlify Function
        const response = await fetch("/.netlify/functions/fetchAI", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userText: userText })
        });

        // If you haven't set up the function yet, this might 404
        if (!response.ok) {
            throw new Error("Netlify Function not found or error");
        }

        const data = await response.json();

        if (data.reply) {
            responseEl.innerText = data.reply;
        } else {
            responseEl.innerText = "I'm having a little trouble connecting. Try again?";
        }

    } catch (err) {
        console.error(err);
        responseEl.innerText = "To chat with AI, you must complete the 'Netlify Function' setup step.";
    }
}
function handleEnter(e) { if(e.key === 'Enter') sendToOpenAI(); }


/* =========================================
   3. SUPABASE LOGIC
   ========================================= */
// TODO: Replace with your actual Supabase Keys
const SUPABASE_URL = 'https://uoosspumdmffccinszuj.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVvb3NzcHVtZG1mZmNjaW5zenVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjcxNzYyNTUsImV4cCI6MjA4Mjc1MjI1NX0.3NayM6uC5-yZv9im-8W7ko28rZFRTnDQbIagN6BArs0';

let supabaseClient = null;
try {
    if (window.supabase) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) { console.warn("Supabase not initialized"); }

async function submitForm() {
    if (!supabaseClient) { alert("Please connect database keys in script.js"); return; }
    
    const email = document.getElementById('email-input').value.trim();
    const vibe = document.getElementById('vibe-input').value;
    
    if (!email || !vibe) { alert("Please fill in both fields."); return; }

    const { error } = await supabaseClient.from('waitlist').insert([{ email, vibe }]);

    if (error && (error.code === '23505' || error.message.includes('duplicate'))) {
        document.getElementById('signup-form').style.display = 'none';
        document.getElementById('success-msg').style.display = 'block';
        document.getElementById('status-text').innerText = "You are already here. Welcome back.";
    } else if (error) {
        alert("Connection Error.");
    } else {
        document.getElementById('signup-form').style.display = 'none';
        document.getElementById('success-msg').style.display = 'block';
    }
}


/* =========================================
   4. WEBGL BACKGROUND (VIVID NEBULA)
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

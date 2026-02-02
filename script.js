/* --- SHADER SOURCE CODE --- */
// Vertex Shader (Standard)
const vertexShaderSource = `
    attribute vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

// Fragment Shader (Crystal Horizon Logic)
const fragmentShaderSource = `
    precision highp float;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform float u_scroll;

    // Noise Functions
    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
    float snoise(vec2 v) {
        const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
        vec2 i  = floor(v + dot(v, C.yy) );
        vec2 x0 = v - i + dot(i, C.xx);
        vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
        vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
        i = mod289(i);
        vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
        vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
        m = m*m ;
        vec3 x = 2.0 * fract(p * C.www) - 1.0;
        vec3 h = abs(x) - 0.5;
        vec3 ox = floor(x + 0.5);
        vec3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
        vec3 g; g.x  = a0.x  * x0.x  + h.x  * x0.y; g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        return 130.0 * dot(m, g);
    }

    float fbm(vec2 st) {
        float v = 0.0; float a = 0.5;
        for (int i = 0; i < 3; i++) { v += a * snoise(st); st *= 2.0; a *= 0.5; }
        return v;
    }

    void main() {
        vec2 st = gl_FragCoord.xy / u_resolution.xy;
        st.x *= u_resolution.x / u_resolution.y;

        // DIAGONAL FLOW LOGIC (Bottom-Left to Top-Right)
        // st.x + st.y creates the diagonal gradient base.
        // u_time adds the slow drift.
        float drift = (st.x + st.y) * 0.5 - u_time * 0.05;

        // Add large soft noise for "clouds"
        float n = fbm(st * 1.5 + drift);

        // LIGHT THERAPY PALETTE (Soft & Bright)
        vec3 c_sky    = vec3(0.85, 0.93, 1.0); // Soft Blue
        vec3 c_peach  = vec3(1.0, 0.90, 0.85); // Soft Peach
        vec3 c_lav    = vec3(0.95, 0.90, 1.0); // Soft Lavender
        vec3 c_mint   = vec3(0.90, 1.0, 0.95); // Soft Mint

        // Mix colors based on scroll depth + noise variation
        float mixVal = u_scroll + n * 0.2;
        
        vec3 color;
        if(mixVal < 0.33) {
            color = mix(c_sky, c_mint, mixVal * 3.0);
        } else if(mixVal < 0.66) {
            color = mix(c_mint, c_peach, (mixVal - 0.33) * 3.0);
        } else {
            color = mix(c_peach, c_lav, (mixVal - 0.66) * 3.0);
        }

        // Whitewash mix to ensure readability (Avoid dark colors)
        color = mix(color, vec3(0.97), 0.3);

        gl_FragColor = vec4(color, 1.0);
    }
`;

/* --- WEBGL INIT & RENDER LOOP --- */
const canvas = document.getElementById("glcanvas");
const gl = canvas.getContext("webgl");
const container = document.getElementById("scroll-container");

// Resize Handling
function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
}
window.addEventListener("resize", resize);
resize();

// Shader Compiler Helper
function createShader(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(s));
        return null;
    }
    return s;
}

// Program Setup
const prog = gl.createProgram();
gl.attachShader(prog, createShader(gl, gl.VERTEX_SHADER, vertexShaderSource));
gl.attachShader(prog, createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource));
gl.linkProgram(prog);
gl.useProgram(prog);

// Buffer Setup
const posLoc = gl.getAttribLocation(prog, "position");
gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(posLoc);
gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

// Uniform Locations
const uRes = gl.getUniformLocation(prog, "u_resolution");
const uTime = gl.getUniformLocation(prog, "u_time");
const uScroll = gl.getUniformLocation(prog, "u_scroll");

// --- RENDER LOOP ---
function render(time) {
    // 1. Update Shader Uniforms
    const maxScroll = container.scrollHeight - container.clientHeight;
    const scrollPercent = container.scrollTop / (maxScroll || 1);
    
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, time * 0.001);
    gl.uniform1f(uScroll, scrollPercent);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 2. Handle Scroll Animations (Reveal Sections & Bubbles)
    const scrollPos = container.scrollTop;
    const viewHeight = window.innerHeight;
    
    document.querySelectorAll('.section').forEach((sec, idx) => {
        const offset = sec.offsetTop;
        // Check if section is centered in view
        if (scrollPos >= offset - viewHeight/2 && scrollPos < offset + viewHeight/2) {
            sec.classList.add('active');
            updateDots(idx);
        } else {
            sec.classList.remove('active');
        }
    });

    requestAnimationFrame(render);
}
requestAnimationFrame(render);

/* --- UI INTERACTIONS --- */
// Nav Dots
function updateDots(idx) {
    document.querySelectorAll('.dot').forEach((d, i) => d.classList.toggle('active', i === idx));
}

// Smooth Scroll to Section
function scrollToSec(idx) {
    const h = window.innerHeight;
    container.scrollTo({ top: idx * h, behavior: 'smooth' });
}

// Sign Up Logic
function finish() {
    const vibe = document.getElementById('vibe-input').value;
    if(!vibe) {
        alert("Please share a thought first.");
        return;
    }
    // Hide form, show success
    document.getElementById('signup-form').style.display = 'none';
    document.getElementById('success-msg').style.display = 'block';
}

// Expose functions to window so HTML onClick works
window.scrollToSec = scrollToSec;
window.finish = finish;

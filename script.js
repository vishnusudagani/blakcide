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
        // We now talk to YOUR Netlify Function, not OpenAI directly
        const response = await fetch("/.netlify/functions/fetchAI", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userText: userText })
        });

        const data = await response.json();

        if (data.reply) {
            responseEl.innerText = data.reply;
        } else {
            responseEl.innerText = "I'm having a little trouble connecting. Try again?";
        }

    } catch (err) { 
        console.error(err);
        responseEl.innerText = "Connection error."; 
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
   4. WEBGL BACKGROUND
   ========================================= */
// (Keep the previous Shader code here - it is safe and doesn't need changing)
// ... [Paste the exact same WebGL code from the previous response here] ...

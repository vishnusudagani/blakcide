// Blak LLM bake-off — compare candidate "brain" models on the four things that
// matter for Blak: warmth, multilingual fluency (Telugu/Hindi, native + romanized),
// latency, and cost. Nothing here touches production: it just sends a handful of
// prompts to each provider's OpenAI-compatible /chat/completions endpoint and
// prints the reply + time-to-response so you can pick the TE/HI winner — ideally
// on the Google credits.
//
// Run with whichever keys you have (providers with no key are skipped):
//
//   GEMINI_API_KEY=... GROQ_API_KEY=... SARVAM_API_KEY=... \
//   node scripts/blak-llm-bakeoff.mjs
//
// Requires Node 18+ (global fetch).

const env = (k) => process.env[k] || undefined;

// ── Candidate providers (OpenAI-compatible chat/completions) ─────────────────
function providers() {
  const list = [];
  if (env('GEMINI_API_KEY')) list.push({
    id: 'gemini',
    model: env('GEMINI_CHAT_MODEL') || 'gemini-2.5-flash',
    url: env('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    headers: { Authorization: `Bearer ${env('GEMINI_API_KEY')}` },
  });
  if (env('SARVAM_API_KEY')) list.push({
    id: 'sarvam-m',
    model: env('SARVAM_CHAT_MODEL') || 'sarvam-m',
    url: env('SARVAM_BASE_URL') || 'https://api.sarvam.ai/v1/chat/completions',
    // Sarvam authenticates with a subscription-key header (confirm in your dashboard).
    headers: { 'api-subscription-key': env('SARVAM_API_KEY') },
  });
  if (env('DEEPINFRA_API_KEY')) list.push({
    id: 'qwen-deepinfra',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    url: 'https://api.deepinfra.com/v1/openai/chat/completions',
    headers: { Authorization: `Bearer ${env('DEEPINFRA_API_KEY')}` },
  });
  if (env('TOGETHER_API_KEY')) list.push({
    id: 'qwen-together',
    model: 'Qwen/Qwen2.5-72B-Instruct-Turbo',
    url: 'https://api.together.xyz/v1/chat/completions',
    headers: { Authorization: `Bearer ${env('TOGETHER_API_KEY')}` },
  });
  if (env('OPENROUTER_API_KEY')) list.push({
    id: 'qwen-openrouter',
    model: 'qwen/qwen-2.5-72b-instruct',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    headers: {
      Authorization: `Bearer ${env('OPENROUTER_API_KEY')}`,
      'HTTP-Referer': 'https://blaksyd.com',
      'X-Title': 'Blaksyd Blak bake-off',
    },
  });
  if (env('GROQ_API_KEY')) list.push({
    id: 'groq-llama-3.3-70b',
    model: env('GROQ_CHAT_MODEL') || 'llama-3.3-70b-versatile',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    headers: { Authorization: `Bearer ${env('GROQ_API_KEY')}` },
  });
  return list;
}

// Blak's real voice rule, trimmed — so the bake-off tests actual behaviour.
const SYSTEM = [
  "You are Blak, a warm, emotionally intelligent companion who lives in the user's phone.",
  'MIRROR RULE: reply in the EXACT same language and script as the user\'s message —',
  'pure English -> English; Telugu -> native Telugu; Hindi -> native Hindi;',
  'Romanized Telugu/Hindi (e.g. "naaku stress ga undi") -> reply in the same romanized style.',
  'Never code-switch. Speak like a warm local from Hyderabad/Mumbai, not a textbook.',
  'Keep replies short and human.',
].join(' ');

const PROMPTS = [
  { tag: 'EN · vent',      text: "i'm so behind on everything and i can't focus today" },
  { tag: 'TE · native',    text: 'నాకు ఈ రోజు చాలా టెన్షన్‌గా ఉంది, ఏం చేయాలో అర్థం కావట్లేదు' },
  { tag: 'TE · romanized', text: 'naaku chala stress ga undi ra, em cheyali ardam kavatledu' },
  { tag: 'HI · native',    text: 'आज मन बहुत भारी है, कुछ अच्छा नहीं लग रहा' },
  { tag: 'HI · romanized', text: 'yaar aaj bahut akela feel ho raha hai' },
  { tag: 'EN · factual',   text: 'quick — what time is it in Hyderabad and is it a good time to call my mom in London?' },
];

async function ask(p, prompt) {
  const t0 = Date.now();
  try {
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...p.headers },
      body: JSON.stringify({
        model: p.model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 220,
      }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { ms, text: `(HTTP ${res.status}) ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '(empty)';
    return { ms, text };
  } catch (e) {
    return { ms: Date.now() - t0, text: `(error) ${e.message}` };
  }
}

const provs = providers();
if (!provs.length) {
  console.error('No provider keys found. Set at least one of: GEMINI_API_KEY, GROQ_API_KEY, SARVAM_API_KEY, DEEPINFRA_API_KEY, TOGETHER_API_KEY, OPENROUTER_API_KEY.');
  process.exit(1);
}
console.log(`\nBlak LLM bake-off — ${provs.length} provider(s): ${provs.map((p) => p.id).join(', ')}\n`);

for (const prompt of PROMPTS) {
  console.log('='.repeat(74));
  console.log(`PROMPT [${prompt.tag}]  ${prompt.text}`);
  console.log('='.repeat(74));
  for (const p of provs) {
    const { ms, text } = await ask(p, prompt.text);
    console.log(`\n  > ${p.id} (${p.model})  ${ms}ms`);
    console.log('    ' + text.replace(/\n/g, '\n    '));
  }
  console.log('');
}
console.log('Done. Eyeball Telugu/Hindi fluency + latency; pick the primary, keep Groq as the free floor.\n');

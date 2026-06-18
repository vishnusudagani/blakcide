// Smoke test for the Gemini Live bridge (/live) — mic-free.
//
// Connects like the browser does, runs the setup handshake, sends a TEXT turn,
// and checks that AUDIO frames actually come back. That end-to-end proof
// (auth → setupComplete → input → audio output) is exactly what catches the
// Vertex native-audio "setupComplete then silence" gotcha — without a mic.
//
// Usage:
//   node smoke-live.mjs "wss://vertex---blak-vertex-proxy-xxxx.us-central1.run.app/live" "<SUPABASE_ACCESS_TOKEN>"
// or:  WS_URL=... JWT=... MODEL=... node smoke-live.mjs
//
// Exit code 0 = audio received (PASS); 1 = no audio (FAIL); 2 = bad usage.

import { WebSocket } from 'ws';

const WS_URL = process.argv[2] || process.env.WS_URL || '';
const JWT    = process.argv[3] || process.env.JWT || '';
const MODEL  = process.env.MODEL || 'gemini-live-2.5-flash-native-audio';

if (!WS_URL || !JWT) {
  console.error('Usage: node smoke-live.mjs <wssUrl ending in /live> <supabaseAccessToken>');
  process.exit(2);
}

const ws = new WebSocket(WS_URL, ['blak.v1', 'blak.jwt.' + JWT]);
let setupOk = false, audioBytes = 0, gotText = '';
const t0 = Date.now();
const deadline = setTimeout(() => finish('TIMEOUT — no audio within 20s'), 20000);

function finish(reason) {
  clearTimeout(deadline);
  console.log('--- smoke result ---');
  console.log('setupComplete :', setupOk);
  console.log('audio bytes   :', audioBytes);
  console.log('transcript    :', gotText.trim().slice(0, 200));
  console.log('elapsed ms    :', Date.now() - t0);
  console.log('verdict       :', reason);
  try { ws.close(); } catch (e) {}
  process.exit(audioBytes > 0 ? 0 : 1);
}

ws.on('open', () => {
  console.log('[open] sending setup…');
  ws.send(JSON.stringify({ setup: {
    model: MODEL,                       // bridge rewrites this to the full resource path
    generationConfig: { responseModalities: ['AUDIO'], temperature: 0.9,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } },
    systemInstruction: { parts: [{ text: 'You are Blak. Reply in one short spoken sentence.' }] },
    outputAudioTranscription: {},
  } }));
});

ws.on('message', (data) => {
  let o; try { o = JSON.parse(data.toString()); } catch (e) { return; }
  if (o.setupComplete) {
    setupOk = true;
    console.log('[setupComplete] sending a text turn…');
    ws.send(JSON.stringify({ clientContent: {
      turns: [{ role: 'user', parts: [{ text: 'Say hello in one short sentence.' }] }],
      turnComplete: true,
    } }));
    return;
  }
  const sc = o.serverContent;
  if (sc) {
    for (const p of (sc.modelTurn?.parts || [])) {
      if (p.inlineData?.data) audioBytes += Buffer.from(p.inlineData.data, 'base64').length;
    }
    if (sc.outputTranscription?.text) gotText += sc.outputTranscription.text;
    if (sc.turnComplete && setupOk) finish(audioBytes > 0 ? 'PASS — audio received' : 'FAIL — turn complete, no audio (the silence gotcha)');
  }
});

ws.on('error', (e) => finish('WS ERROR: ' + (e?.message || e)));
ws.on('close', (code, reason) => { if (!setupOk) finish('CLOSED before setup (code ' + code + ' ' + String(reason) + ')'); });

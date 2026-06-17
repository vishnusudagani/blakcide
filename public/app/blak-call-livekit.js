/* Blak realtime call — LiveKit client (open-source path).
 *
 * Replaces the OpenAI Realtime WebSocket call. The browser only has to:
 *   1) get a token from /api/livekit-token
 *   2) join the room, publish the mic, play the agent's audio
 * Barge-in, VAD, STT (Groq Whisper), LLM (Qwen/Llama) and TTS (voice-infer) all
 * run server-side in the agent worker, so this client stays tiny. No OpenAI.
 *
 * Usage (kept separate from the existing call so nothing breaks until LiveKit is live):
 *   const call = await BlakCall.start({ userId, onState: s => updateUI(s) });
 *   call.mute(true);   // mute mic
 *   call.end();        // hang up
 *
 * onState emits: 'connecting' | 'connected' | 'listening' | 'blak-speaking' | 'ended' | 'error'
 *
 * Requires: the agent worker running + LIVEKIT_* env on /api/livekit-token.
 */
(function () {
  const LK_ESM = 'https://esm.sh/livekit-client@2';
  let room = null;
  let audioEl = null;

  function cleanup() {
    if (audioEl) { try { audioEl.remove(); } catch (_) {} audioEl = null; }
    room = null;
  }

  async function start({ userId = null, tokenUrl = '/api/livekit-token', onState = () => {} } = {}) {
    onState('connecting');
    const LK = await import(LK_ESM);

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId }),
    });
    if (!res.ok) { onState('error'); throw new Error('token request failed: ' + res.status); }
    const { url, token } = await res.json();
    if (!url || !token) { onState('error'); throw new Error('no LiveKit url/token — is LiveKit configured?'); }

    room = new LK.Room({ adaptiveStream: true, dynacast: true });

    // Play the agent's voice the moment its track arrives.
    room.on(LK.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'audio') {
        audioEl = track.attach();
        audioEl.autoplay = true;
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
      }
    });
    room.on(LK.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
    });
    room.on(LK.RoomEvent.Disconnected, () => { onState('ended'); cleanup(); });

    // Simple speaking hints for the UI (orb pulse, etc.).
    room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const agentSpeaking = speakers.some((p) => (p.identity || '').startsWith('agent'));
      onState(agentSpeaking ? 'blak-speaking' : 'listening');
    });

    await room.connect(url, token);
    await room.localParticipant.setMicrophoneEnabled(true);
    onState('connected');

    return {
      mute: async (m) => { await room.localParticipant.setMicrophoneEnabled(!m); },
      end: async () => { try { await room.disconnect(); } finally { cleanup(); } },
      get room() { return room; },
    };
  }

  window.BlakCall = { start };
})();

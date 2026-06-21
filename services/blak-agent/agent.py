# Blak — group-voice mediator agent (LiveKit Agents + Gemini Live on Vertex).
#
# A persistent LiveKit worker that joins every group voice room (the only rooms
# in this LiveKit project are the app's blak_group_* voice calls), hears all the
# humans, and speaks as Blak — the warm, quiet host/mediator. Uses the Google
# plugin in VERTEX mode (ADC via the Cloud Run service account) so it draws GCP
# credits and respects the org "no Google API keys" policy — same as the voice
# bridge. A tiny HTTP server answers Cloud Run's health check on $PORT.
import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import google

BLAK_INSTRUCTIONS = (
    "You are Blak — a warm, real presence in a small private group VOICE call "
    "(friends in a room together). You are the group's quiet host and mediator, "
    "NOT an assistant and NOT a therapist.\n"
    "STAY MOSTLY QUIET and let the humans talk to each other. Speak ONLY when: "
    "someone addresses you ('Blak ...'), a real question is left hanging, things "
    "get tense and need softening, or someone is being left out and you can warmly "
    "bring them in. If the conversation is flowing fine without you, say NOTHING.\n"
    "When you do speak: ONE short, natural spoken line — casual and warm, like a "
    "friend on the call. Use people's names. Never lecture, never dominate the call, "
    "never announce or admit you are an AI, and never claim to be human. Keep the "
    "room warm and inclusive."
)


def _start_health_server():
    """Cloud Run needs the container to listen on $PORT — answer health checks."""
    port = int(os.environ.get("PORT", "8080"))

    class _H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.end_headers()
            self.wfile.write(b"blak-agent ok")

        def log_message(self, *_args):
            pass

    HTTPServer(("0.0.0.0", port), _H).serve_forever()


async def entrypoint(ctx: JobContext):
    await ctx.connect()
    session = AgentSession(
        llm=google.beta.realtime.RealtimeModel(
            model=os.environ.get("GEMINI_LIVE_MODEL", "gemini-2.0-flash-live-preview-04-09"),
            voice=os.environ.get("BLAK_VOICE", "Puck"),
            temperature=0.8,
            vertexai=True,
            project=os.environ.get("GCP_PROJECT"),
            location=os.environ.get("GCP_REGION", "us-central1"),
            instructions=BLAK_INSTRUCTIONS,
        ),
    )
    await session.start(room=ctx.room, agent=Agent(instructions=BLAK_INSTRUCTIONS))


if __name__ == "__main__":
    threading.Thread(target=_start_health_server, daemon=True).start()
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))

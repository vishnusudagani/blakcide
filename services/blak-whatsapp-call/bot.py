# Blak on WhatsApp — 1:1 voice-call pipeline (Pipecat + Gemini Live native audio).
#
# Mirrors services/blak-agent (the LiveKit group agent) but for a single WhatsApp
# caller: WhatsApp's WebRTC media arrives via Pipecat's SmallWebRTCTransport, and
# Blak talks back through Gemini Live (native audio). server.py wires the WhatsApp
# webhook + SDP accept and calls run_bot() with a connected SmallWebRTCConnection.
#
# ⚠️ Pin Pipecat and verify these imports/classes at deploy time — the Gemini Live
# + SmallWebRTC APIs move between versions. Based on daily-co/pcc-gemini-whatsapp.

import os

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.services.gemini_multimodal_live.gemini import GeminiMultimodalLiveLLMService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport

from bot_prompt import BLAK_CALL_INSTRUCTIONS


async def run_bot(webrtc_connection):
    """Run a Blak voice session over an already-negotiated WebRTC connection."""
    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
        ),
    )

    # Gemini Live, native audio — same family as the web /live bridge + blak-agent.
    # AI Studio key path (matches the current web voice backend). For Vertex/ADC
    # (no key, GCP credits) swap to the Vertex constructor — see README.
    llm = GeminiMultimodalLiveLLMService(
        api_key=os.environ["GEMINI_LIVE_API_KEY"],
        voice_id=os.environ.get("BLAK_VOICE", "Charon"),
        system_instruction=BLAK_CALL_INSTRUCTIONS,
    )

    context = OpenAILLMContext()
    aggregator = llm.create_context_aggregator(context)

    pipeline = Pipeline([
        transport.input(),       # caller audio in
        aggregator.user(),
        llm,                     # Gemini Live: hears + speaks
        transport.output(),      # Blak audio out
        aggregator.assistant(),
    ])

    task = PipelineTask(pipeline, params=PipelineParams(allow_interruptions=True))

    @transport.event_handler("on_client_connected")
    async def _connected(_transport, _client):
        # Blak opens the call warmly, like picking up the phone.
        await task.queue_frames([aggregator.user().get_context_frame()])

    @transport.event_handler("on_client_disconnected")
    async def _disconnected(_transport, _client):
        await task.cancel()

    await PipelineRunner().run(task)

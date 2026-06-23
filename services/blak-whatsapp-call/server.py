# WhatsApp Business Calling API ↔ Blak voice bridge — HTTP front door (Cloud Run).
#
# Flow:
#   GET  /whatsapp  → webhook verification handshake (hub.challenge)
#   POST /whatsapp  → 'calls' webhook events:
#       - "connect": validate X-Hub-Signature-256, take the SDP OFFER, create a
#         SmallWebRTCConnection, produce the SDP ANSWER, POST it to the Graph API
#         to ACCEPT the call, then run bot.run_bot() on that connection.
#       - "terminate": tear the session down.
#
# The Netlify webhook (netlify/functions/whatsapp-webhook.mjs) forwards 'calls'
# events here (single Meta callback URL → routed by field), preserving the raw
# body + signature header.
#
# ⚠️ SKELETON: the exact SmallWebRTC offer/answer calls + the Pipecat WhatsApp
# helper differ by version — verify against the pinned Pipecat at deploy time and
# against daily-co/pcc-gemini-whatsapp. The Graph API accept shape below matches
# the WhatsApp Business Calling API docs.

import asyncio
import hashlib
import hmac
import os

import aiohttp
from fastapi import FastAPI, Request, Response

import bot

GRAPH = os.environ.get("WHATSAPP_GRAPH_VERSION", "v21.0")
PHONE_ID = os.environ.get("WHATSAPP_PHONE_NUMBER_ID", "")
TOKEN = os.environ.get("WHATSAPP_TOKEN", "")
APP_SECRET = os.environ.get("WHATSAPP_APP_SECRET", "")
VERIFY_TOKEN = os.environ.get("WHATSAPP_VERIFY_TOKEN", "")

app = FastAPI()


@app.get("/whatsapp")
async def verify(request: Request):
    p = request.query_params
    if p.get("hub.mode") == "subscribe" and p.get("hub.verify_token") == VERIFY_TOKEN:
        return Response(content=p.get("hub.challenge", ""), media_type="text/plain")
    return Response(status_code=403)


def _valid_sig(raw: bytes, header: str) -> bool:
    if not APP_SECRET:
        return True  # skip until configured (set before going public!)
    if not header:
        return False
    expected = "sha256=" + hmac.new(APP_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


async def _graph_accept(call_id: str, sdp_answer: str):
    """Accept the WhatsApp call by returning our SDP answer to the Graph API."""
    url = f"https://graph.facebook.com/{GRAPH}/{PHONE_ID}/calls"
    body = {
        "messaging_product": "whatsapp",
        "call_id": call_id,
        "action": "accept",
        "session": {"sdp_type": "answer", "sdp": sdp_answer},
    }
    async with aiohttp.ClientSession() as s:
        async with s.post(url, json=body, headers={"Authorization": f"Bearer {TOKEN}"}) as r:
            if r.status >= 300:
                print("[wa-call] accept failed", r.status, (await r.text())[:200])


@app.post("/whatsapp")
async def incoming(request: Request):
    raw = await request.body()
    if not _valid_sig(raw, request.headers.get("x-hub-signature-256", "")):
        return Response(status_code=401)

    payload = await request.json()
    try:
        call = payload["entry"][0]["changes"][0]["value"]["calls"][0]
    except (KeyError, IndexError):
        return Response(content="ok")  # not a call event

    event = call.get("event")
    call_id = call.get("id")

    if event == "connect":
        offer_sdp = call.get("session", {}).get("sdp")
        # TODO(deploy): build a SmallWebRTCConnection from offer_sdp, get the answer
        # SDP, then accept + run the bot. Exact API per pinned Pipecat version:
        #   conn = SmallWebRTCConnection(ice_servers=[...])
        #   await conn.initialize(sdp=offer_sdp, type="offer")
        #   answer = conn.get_answer()  # {"sdp": ..., "type": "answer"}
        #   await _graph_accept(call_id, answer["sdp"])
        #   asyncio.create_task(bot.run_bot(conn))
        print(f"[wa-call] connect call_id={call_id} (skeleton — wire SmallWebRTC at deploy)")
        _ = offer_sdp  # silence unused until wired
        return Response(content="ok")

    if event == "terminate":
        print(f"[wa-call] terminate call_id={call_id}")
        # TODO(deploy): cancel the running session for call_id.
        return Response(content="ok")

    return Response(content="ok")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))

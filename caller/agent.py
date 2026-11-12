"""Tapnod phone-call approvals.

The Tapnod server sends this agent into a LiveKit room with the payment details.
The agent rings the customer, reads the payment out, and she answers on her keypad:
  1 = approve (then her 4-digit PIN), 2 = decline.
It reports every step back to the Tapnod server, which tells the POS.

Run locally:  python agent.py dev
Deploy:       lk agent create   (first time)  /  lk agent deploy
"""

import asyncio
import json
import logging
import os

import aiohttp
from dotenv import load_dotenv
from livekit import api, rtc
from livekit.agents import Agent, AgentSession, JobContext, WorkerOptions, cli
from livekit.plugins import deepgram

load_dotenv()
log = logging.getLogger("tapnod-caller")

AGENT_NAME = os.getenv("CALL_AGENT_NAME", "tapnod-caller")
TRUNK_ID = os.getenv("SIP_OUTBOUND_TRUNK_ID", "")
VOICE = os.getenv("CALL_VOICE", "aura-asteria-en")
PIN_LENGTH = 4
PIN_TRIES = 3


class Keypad:
    """Collects the digits the caller presses."""

    def __init__(self, room: rtc.Room):
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        room.on("sip_dtmf_received", lambda dtmf: self.queue.put_nowait(dtmf.digit))

    def clear(self):
        while not self.queue.empty():
            self.queue.get_nowait()

    async def one(self, timeout: float) -> str | None:
        try:
            return await asyncio.wait_for(self.queue.get(), timeout)
        except asyncio.TimeoutError:
            return None

    async def many(self, count: int, timeout: float) -> str:
        digits = ""
        while len(digits) < count:
            d = await self.one(timeout)
            if d is None:
                break
            if d == "#":
                break
            if d.isdigit():
                digits += d
        return digits


async def report(info: dict, **body) -> dict:
    """Tell the Tapnod server what happened. Returns its answer, e.g. {"status": "approved"}."""
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as http:
            async with http.post(info["callback"], json={"call_token": info["call_token"], **body}) as res:
                data = await res.json(content_type=None)
                data["_http"] = res.status
                return data
    except Exception as e:  # the call should carry on even if one report fails
        log.warning("report failed: %s", e)
        return {"_http": 0}


async def entrypoint(ctx: JobContext):
    info = json.loads(ctx.job.metadata or "{}")
    if not info.get("phone") or not info.get("callback"):
        log.error("missing call details in job metadata")
        ctx.shutdown()
        return

    await ctx.connect()
    keypad = Keypad(ctx.room)

    # 1. Ring the customer and wait until she answers.
    try:
        await ctx.api.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                room_name=ctx.room.name,
                sip_trunk_id=TRUNK_ID,
                sip_call_to=info["phone"],
                participant_identity="customer",
                participant_name=info.get("first_name") or "Customer",
                wait_until_answered=True,
            )
        )
    except api.TwirpError as e:
        log.warning("call not answered: %s %s", e.message, e.metadata)
        await report(info, action="call_status", status="failed")
        ctx.shutdown()
        return

    await report(info, action="call_status", status="answered")

    session = AgentSession(tts=deepgram.TTS(model=VOICE))
    await session.start(room=ctx.room, agent=Agent(instructions="You read Tapnod payment requests aloud."))

    async def say(text: str):
        await session.say(text, allow_interruptions=False, add_to_chat_ctx=False)

    async def hang_up(text: str):
        await say(text)
        await asyncio.sleep(0.5)
        await report(info, action="call_status", status="ended")
        await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))

    async def still_waiting() -> bool:
        res = await report(info, action="status")
        if res.get("status") in (None, "pending"):
            return True
        words = {"approved": "approved", "declined": "declined", "expired": "timed out", "cancelled": "cancelled by the shop"}
        await hang_up(f"This payment has already been {words.get(res['status'], res['status'])}. Goodbye.")
        return False

    name = info.get("first_name") or "there"
    await say(
        f"Hello {name}. This is Tapnod. "
        f"{info.get('merchant', 'A shop')} is asking you to pay {info.get('amount_words', 'some money')}."
    )

    # 2. Approve or decline. Repeat the question once if she says nothing.
    choice = None
    for attempt in range(2):
        if not await still_waiting():
            return
        if attempt:
            await say(f"Again: {info.get('merchant', 'the shop')} is asking for {info.get('amount_words', 'money')}.")
        keypad.clear()
        await say("To approve, press 1. To decline, press 2.")
        choice = await keypad.one(timeout=12)
        if choice in ("1", "2"):
            break
        choice = None

    if choice is None:
        await hang_up("I didn't get an answer, so nothing was paid. Goodbye.")
        return

    if choice == "2":
        res = await report(info, action="decline")
        if res.get("status") == "declined":
            await hang_up("Payment declined. No money left your account. Goodbye.")
        else:
            await still_waiting()
        return

    # 3. PIN on the keypad. Never read back, only how many digits arrived.
    for attempt in range(PIN_TRIES):
        if not await still_waiting():
            return
        keypad.clear()
        await say(f"Type your {PIN_LENGTH} digit Tapnod PIN now.")
        pin = await keypad.many(PIN_LENGTH, timeout=10)
        if len(pin) < PIN_LENGTH:
            await say(f"I got {len(pin)} digits, I need {PIN_LENGTH}.")
            continue
        res = await report(info, action="approve", pin=pin)
        if res.get("status") == "approved":
            await hang_up(f"Payment approved. You paid {info.get('amount_words')} to {info.get('merchant')}. Thank you. Goodbye.")
            return
        if res.get("_http") == 401:
            left = PIN_TRIES - attempt - 1
            if left:
                await say(f"That PIN is not correct. You have {left} {'try' if left == 1 else 'tries'} left.")
            continue
        await still_waiting()
        return

    await report(info, action="decline")
    await hang_up("Too many wrong PINs, so the payment was declined. Goodbye.")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=AGENT_NAME))

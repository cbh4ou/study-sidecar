"""Full-duplex local voice worker."""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import contextlib
import functools
import hmac
import importlib.util
import json
import logging
import os
import re
import secrets
import sys
import tempfile
import wave
from array import array
from pathlib import Path
from typing import Any, Literal

try:
    from pydantic import BaseModel, ConfigDict, TypeAdapter, ValidationError
except ImportError:  # The optional protocol extra is unavailable in lightweight test installs.
    BaseModel = ConfigDict = TypeAdapter = ValidationError = None  # type: ignore[assignment,misc]

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None

try:
    from kokoro_onnx import Kokoro
except ImportError:
    Kokoro = None

try:
    from silero_vad import load_silero_vad as SileroModel
except ImportError:
    SileroModel = None

SAMPLE_RATE = 16_000
SILENCE_SAMPLES = int(SAMPLE_RATE * 0.6)
ENERGY_START_THRESHOLD = 400
ENERGY_STOP_THRESHOLD = 250
TTS_CHUNK_BYTES = 8_192
MAX_TEXT_MESSAGE_BYTES = 256 * 1024
MAX_AUDIO_BYTES = 160 * 1024
MAX_SPEECH_SEGMENT_BYTES = SAMPLE_RATE * 2 * 30
MAX_SPEAK_TEXT_CHARS = 2_000
MESSAGE_TYPES = {"listen_start", "listen_stop", "audio", "speak", "interrupt"}


if BaseModel is not None:
    class _Message(BaseModel):
        model_config = ConfigDict(extra="forbid")


    class ListenStart(_Message):
        type: Literal["listen_start"]


    class ListenStop(_Message):
        type: Literal["listen_stop"]


    class Audio(_Message):
        type: Literal["audio"]
        pcm_b16: str


    class VoiceOptions(_Message):
        language: str | None = None
        speed: float | None = None
        voice: str | None = None


    class Speak(_Message):
        type: Literal["speak"]
        id: str
        text: str
        voice: VoiceOptions | None = None

    class Interrupt(_Message):
        type: Literal["interrupt"]


    MessageAdapter = TypeAdapter(ListenStart | ListenStop | Audio | Speak | Interrupt)
else:
    MessageAdapter = None


def encode_audio(pcm: bytes) -> str:
    return base64.b64encode(pcm).decode("ascii")


def decode_audio(encoded: str) -> bytes:
    try:
        pcm = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("pcm_b16 must be valid base64") from error
    if len(pcm) % 2:
        raise ValueError("pcm_b16 must contain s16le samples")
    return pcm


def validate_message(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("message must be an object")
    message_type = payload.get("type")
    if message_type not in MESSAGE_TYPES:
        raise ValueError("unknown message type")
    if MessageAdapter is not None:
        try:
            return MessageAdapter.validate_python(payload).model_dump()
        except ValidationError as error:
            raise ValueError(f"invalid {message_type} message") from error

    # The production extra supplies Pydantic v2. This narrow fallback keeps the
    # base worker/test install usable when optional packages are intentionally absent.
    required: dict[str, tuple[str, ...]] = {
        "listen_start": (),
        "listen_stop": (),
        "audio": ("pcm_b16",),
        "speak": ("id", "text"),
        "interrupt": (),
    }
    fields = required[message_type]
    if set(payload) - {"type", *fields, "voice"} or any(
        not isinstance(payload[field], str) for field in fields
    ):
        raise ValueError(f"invalid {message_type} message")
    voice = payload.get("voice")
    if "voice" in payload and (
        message_type != "speak"
        or not isinstance(voice, dict)
        or set(voice) - {"language", "speed", "voice"}
        or any(
            value is not None and not isinstance(value, (str, float, int))
            for value in voice.values()
        )
    ):
        raise ValueError(f"invalid {message_type} message")
    return dict(payload)


def pcm_samples(pcm: bytes) -> array:
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def pcm_bytes(samples: Any) -> bytes:
    pcm = array(
        "h",
        (max(-32_768, min(32_767, round(float(sample) * 32_767))) for sample in samples),
    )
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm.tobytes()


class StreamingVad:
    def __init__(self) -> None:
        self._model: Any = None
        self._energy_speech = False
        if SileroModel is not None:
            with contextlib.suppress(Exception):
                self._model = SileroModel()
        self.kind = "silero" if self._model is not None else "energy"

    def is_speech(self, pcm: bytes) -> bool:
        samples = pcm_samples(pcm)
        if self._model is not None and len(samples) >= 512:
            try:
                import torch

                probabilities = (
                    float(
                        self._model(torch.tensor(frame, dtype=torch.float32) / 32768, SAMPLE_RATE)
                    )
                    for frame in (
                        samples[index : index + 512]
                        for index in range(0, len(samples) - 511, 512)
                    )
                )
                return any(probability >= 0.5 for probability in probabilities)
            except Exception:
                self._model = None
                self.kind = "energy"
        if not samples:
            self._energy_speech = False
            return False
        rms = (sum(sample * sample for sample in samples) / len(samples)) ** 0.5
        threshold = ENERGY_STOP_THRESHOLD if self._energy_speech else ENERGY_START_THRESHOLD
        self._energy_speech = rms >= threshold
        return self._energy_speech


@functools.cache
def whisper_settings() -> tuple[str, str]:
    device = os.getenv("WHISPER_DEVICE")
    if not device:
        try:
            import ctranslate2

            device = "cuda" if ctranslate2.get_cuda_device_count() else "cpu"
        except Exception:
            device = "cpu"
    return device, os.getenv(
        "WHISPER_COMPUTE_TYPE", "float16" if device == "cuda" else "int8"
    )


def speech_chunks(text: str) -> list[str]:
    chunks: list[str] = []
    current = ""
    for sentence in re.split(r"(?<=[.!?])\s+", text.strip()):
        while len(sentence) > 220:
            split = sentence.rfind(" ", 0, 220)
            split = split if split > 0 else 220
            chunks.append(sentence[:split].strip())
            sentence = sentence[split:].strip()
        if current and len(current) + len(sentence) + 1 > 220:
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        chunks.append(current)
    return chunks

KOKORO_VOICE_ID = re.compile(r"^[a-z]{2}_[a-z]+$", re.IGNORECASE)
LANGUAGE_DEFAULT_VOICES = {
    "en-us": "af_heart",
    "en-gb": "bm_george",
    "es": "ef_dora",
    "es-es": "ef_dora",
    "fr": "ff_siwis",
    "fr-fr": "ff_siwis",
    "hi": "hf_alpha",
    "hi-in": "hf_alpha",
    "it": "if_sara",
    "it-it": "if_sara",
    "ja": "jf_alpha",
    "ja-jp": "jf_alpha",
    "pt": "pf_dora",
    "pt-br": "pf_dora",
    "zh": "zf_xiaobei",
    "zh-cn": "zf_xiaobei",
}
AZURE_MALE_VOICES = {
    "andrew",
    "brandon",
    "brian",
    "christopher",
    "davis",
    "eric",
    "guy",
    "jacob",
    "jason",
    "roger",
    "steffan",
    "tony",
}
logger = logging.getLogger(__name__)


def normalize_voice(value: object | None) -> str:
    fallback = os.getenv("KOKORO_VOICE", "af_heart")
    if value is None:
        return fallback
    voice = str(value)
    if KOKORO_VOICE_ID.fullmatch(voice):
        return voice
    name = voice.casefold()
    if name.startswith("en-us-guy"):
        normalized = "am_adam"
    elif name.startswith("en-us-aria"):
        normalized = "af_heart"
    elif name.startswith("en-gb-ryan"):
        normalized = "bm_george"
    elif name.startswith("en-us-") and name.endswith("-neural"):
        azure_name = name.removeprefix("en-us-").removesuffix("-neural")
        normalized = "am_michael" if azure_name in AZURE_MALE_VOICES else "af_heart"
    else:
        match = re.match(r"^([a-z]{2}(?:-[a-z]{2})?)-", name)
        normalized = (
            LANGUAGE_DEFAULT_VOICES.get(match.group(1)) if match else None
        ) or fallback
    logger.warning("Unknown Kokoro voice %r; using %s", voice, normalized)
    return normalized


def optional_module(name: str) -> bool:
    """True when a top-level module is importable, without importing it."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def available_engines() -> dict[str, list[str]]:
    stt: list[str] = []
    tts: list[str] = []
    if WhisperModel is not None:
        stt.append("faster-whisper")
    if optional_module("nemo") or optional_module("parakeet_mlx"):
        stt.append("parakeet")
    if Kokoro is not None:
        tts.append("kokoro")
    if optional_module("piper"):
        tts.append("piper")
    return {"stt": stt, "tts": tts}


class VoiceWorker:
    def __init__(self) -> None:
        self._whisper: Any = None
        self._kokoro: Any = None

    def engines(self) -> dict[str, list[str]]:
        return available_engines()

    @property
    def tts_available(self) -> bool:
        return Kokoro is not None

    def transcribe_pcm(self, pcm: bytes) -> str:
        if WhisperModel is None:
            raise RuntimeError("STT unavailable")
        if self._whisper is None:
            device, compute_type = whisper_settings()
            self._whisper = WhisperModel(
                os.getenv("WHISPER_MODEL", "distil-large-v3"),
                device=device,
                compute_type=compute_type,
            )
        with tempfile.NamedTemporaryFile(
            prefix="study-sidecar-", suffix=".wav", delete=False
        ) as file:
            path = Path(file.name)
        try:
            with wave.open(str(path), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(SAMPLE_RATE)
                output.writeframes(pcm)
            segments, _ = self._whisper.transcribe(str(path), beam_size=1)
            return " ".join(segment.text.strip() for segment in segments).strip()
        finally:
            path.unlink(missing_ok=True)

    def synthesize(self, text: str, voice: dict[str, Any] | None = None) -> bytes:
        if Kokoro is None:
            raise RuntimeError("TTS unavailable")
        if self._kokoro is None:
            self._kokoro = Kokoro(
                os.getenv("KOKORO_MODEL_PATH", "kokoro-v1.0.onnx"),
                os.getenv("KOKORO_VOICES_PATH", "voices-v1.0.bin"),
            )
        options = voice or {}
        language = str(options.get("language") or "en-us").lower()
        samples, _ = self._kokoro.create(
            text,
            voice=normalize_voice(options.get("voice")),
            speed=float(options["speed"]) if options.get("speed") is not None else 1.0,
            lang={"en": "en-us"}.get(language, language),
        )
        return pcm_bytes(samples)


class VoiceSession:
    def __init__(self, worker: VoiceWorker, socket: Any) -> None:
        self.worker = worker
        self.socket = socket
        self.vad = StreamingVad()
        self.listening = False
        self.speaking = False
        self.segment = bytearray()
        self.silence_samples = 0
        self.segment_capped = False
        self.tts_task: asyncio.Task[None] | None = None

    async def send(self, message: dict[str, Any]) -> None:
        await self.socket.send(json.dumps(message))

    async def ready(self) -> None:
        await self.send(
            {
                "type": "ready",
                "vad": self.vad.kind,
                "tts": "kokoro" if self.worker.tts_available else "unavailable",
                "engines": self.worker.engines(),
            }
        )

    async def handle(self, payload: object) -> None:
        try:
            message = validate_message(payload)
            message_type = message["type"]
            if message_type == "listen_start":
                self.listening = True
                self.segment.clear()
                self.segment_capped = False
                self.speaking = False
                self.silence_samples = 0
            elif message_type == "listen_stop":
                # Push-to-talk release: stop capturing and finalize right away
                # instead of waiting for 600 ms of trailing silence.
                self.listening = False
                if self.speaking or self.segment:
                    await self.finish_speech()
                else:
                    await self.send({"type": "transcript", "final": True, "text": ""})
            elif message_type == "audio":
                pcm = decode_audio(message["pcm_b16"])
                if len(pcm) > MAX_AUDIO_BYTES:
                    raise ValueError("pcm_b16 exceeds 160 KiB")
                if self.listening:
                    await self.audio(pcm)
            elif message_type == "speak":
                if len(message["text"]) > MAX_SPEAK_TEXT_CHARS:
                    raise ValueError("text exceeds 2000 characters")
                await self.interrupt("superseded")
                self.tts_task = asyncio.create_task(
                    self.speak(message["id"], message["text"], message.get("voice"))
                )
            elif message_type == "interrupt":
                await self.interrupt()
        except (ValueError, TypeError) as error:
            await self.send({"type": "error", "message": str(error)})

    async def append_segment(self, pcm: bytes) -> None:
        remaining = MAX_SPEECH_SEGMENT_BYTES - len(self.segment)
        if remaining > 0:
            self.segment.extend(pcm[:remaining])
        if len(pcm) > remaining and not self.segment_capped:
            self.segment_capped = True
            await self.send(
                {"type": "error", "message": "speech segment exceeds 30 seconds; dropping audio"}
            )

    async def audio(self, pcm: bytes) -> None:
        speech = self.vad.is_speech(pcm)
        if speech:
            if not self.speaking:
                self.speaking = True
                await self.send({"type": "vad", "speech": True})
            self.silence_samples = 0
            await self.append_segment(pcm)
            return
        if not self.speaking:
            return
        await self.append_segment(pcm)
        self.silence_samples += len(pcm) // 2
        if self.silence_samples >= SILENCE_SAMPLES:
            await self.finish_speech()

    async def finish_speech(self) -> None:
        pcm = bytes(self.segment)
        self.segment.clear()
        self.speaking = False
        self.segment_capped = False
        self.silence_samples = 0
        await self.send({"type": "vad", "speech": False})
        text = ""
        if pcm:
            try:
                text = await asyncio.to_thread(self.worker.transcribe_pcm, pcm)
            except Exception as error:
                await self.send({"type": "error", "message": str(error)})
        await self.send({"type": "transcript", "final": True, "text": text})

    async def speak(
        self, request_id: str, text: str, voice: dict[str, Any] | None = None
    ) -> None:
        try:
            if not text.strip():
                raise ValueError("text is required")
            if not self.worker.tts_available:
                await self.send({"type": "tts_stopped", "id": request_id, "reason": "unavailable"})
                return
            await self.send({"type": "tts_started", "id": request_id})
            for text_chunk in speech_chunks(text):
                pcm = await asyncio.to_thread(self.worker.synthesize, text_chunk, voice)
                for offset in range(0, len(pcm), TTS_CHUNK_BYTES):
                    await self.send(
                        {
                            "type": "tts_audio",
                            "id": request_id,
                            "pcm_b16": encode_audio(pcm[offset : offset + TTS_CHUNK_BYTES]),
                        }
                    )
                    await asyncio.sleep(0)
            await self.send({"type": "tts_stopped", "id": request_id, "reason": "complete"})
        except asyncio.CancelledError as error:
            reason = str(error.args[0]) if error.args else "interrupted"
            await self.send({"type": "tts_stopped", "id": request_id, "reason": reason})
        except Exception as error:
            await self.send({"type": "error", "message": str(error)})
            await self.send({"type": "tts_stopped", "id": request_id, "reason": "complete"})

    async def interrupt(self, reason: str = "interrupted") -> None:
        if self.tts_task is None or self.tts_task.done():
            return
        self.tts_task.cancel(reason)
        try:
            await self.tts_task
        except asyncio.CancelledError:
            pass
        finally:
            self.tts_task = None


def voice_token() -> str:
    token = os.getenv("SIDECAR_VOICE_TOKEN")
    if token:
        return token
    token = secrets.token_urlsafe(24)
    print(f"voice token: {token}", flush=True)
    return token


async def run_websocket(worker: VoiceWorker) -> None:
    from urllib.parse import parse_qs, urlsplit

    import websockets

    token = voice_token()
    active = False

    async def handler(socket: Any) -> None:
        nonlocal active
        request = getattr(socket, "request", None)
        path = getattr(request, "path", getattr(socket, "path", ""))
        headers = getattr(request, "headers", {})
        authorization = headers.get("Authorization", headers.get("authorization", ""))
        bearer = authorization.removeprefix("Bearer ") if isinstance(authorization, str) else ""
        provided = parse_qs(urlsplit(path).query).get("token", [bearer])[0]
        if not hmac.compare_digest(provided, token):
            await socket.send(json.dumps({"type": "error", "message": "invalid voice token"}))
            await socket.close(1008, "invalid voice token")
            return
        if active:
            await socket.close(1013, "voice worker is busy")
            return
        active = True
        try:
            session = VoiceSession(worker, socket)
            await session.ready()
            try:
                async for raw in socket:
                    if isinstance(raw, str) and len(raw.encode()) > MAX_TEXT_MESSAGE_BYTES:
                        await socket.close(1009, "message too large")
                        break
                    try:
                        await session.handle(json.loads(raw))
                    except json.JSONDecodeError:
                        await session.send(
                            {"type": "error", "message": "message must be valid JSON"}
                        )
            finally:
                await session.interrupt()
        finally:
            active = False

    async with websockets.serve(handler, "127.0.0.1", 8879, max_size=MAX_TEXT_MESSAGE_BYTES):
        await asyncio.Future()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ws", action="store_true")
    args = parser.parse_args()
    if not args.ws:
        parser.error("--ws is required")
    try:
        asyncio.run(run_websocket(VoiceWorker()))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

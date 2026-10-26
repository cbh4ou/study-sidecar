from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import sys
from array import array
from typing import Any

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import server


class Socket:
    def __init__(self, block_audio: bool = False) -> None:
        self.messages: list[dict[str, object]] = []
        self.block_audio = block_audio
        self.audio_started = asyncio.Event()
        self.release_audio = asyncio.Event()

    async def send(self, raw: str) -> None:
        message = json.loads(raw)
        self.messages.append(message)
        if self.block_audio and message["type"] == "tts_audio":
            self.audio_started.set()
            await self.release_audio.wait()


class FakeKokoro:
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def __init__(self, *args: object) -> None:
        pass

    def create(self, *args: object, **kwargs: object) -> tuple[list[float], int]:
        self.calls.append((args, kwargs))
        return [0.25] * 20_000, 24_000


def test_whisper_defaults_use_cuda_float16_when_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class CTranslate:
        @staticmethod
        def get_cuda_device_count() -> int:
            return 1

    monkeypatch.delenv("WHISPER_DEVICE", raising=False)
    monkeypatch.delenv("WHISPER_COMPUTE_TYPE", raising=False)
    monkeypatch.setitem(sys.modules, "ctranslate2", CTranslate)
    server.whisper_settings.cache_clear()

    assert server.whisper_settings() == ("cuda", "float16")

    server.whisper_settings.cache_clear()


def pcm(samples: list[int]) -> bytes:
    values = array("h", samples)
    if __import__("sys").byteorder != "little":
        values.byteswap()
    return values.tobytes()


def message_types(socket: Socket | FakeConnection) -> list[str]:
    return [str(message["type"]) for message in socket.messages]


def test_protocol_dispatch_reports_invalid_messages() -> None:
    async def check() -> None:
        socket = Socket()
        session = server.VoiceSession(server.VoiceWorker(), socket)

        await session.handle({"type": "unknown"})

        assert socket.messages == [{"type": "error", "message": "unknown message type"}]

    asyncio.run(check())


def test_energy_vad_reports_speech_then_final_transcript(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "SileroModel", None)
        worker = server.VoiceWorker()
        monkeypatch.setattr(worker, "transcribe_pcm", lambda _: "heard")
        socket = Socket()
        session = server.VoiceSession(worker, socket)

        await session.ready()
        await session.handle({"type": "listen_start"})
        await session.handle({"type": "audio", "pcm_b16": server.encode_audio(pcm([0] * 1_600))})
        await session.handle({"type": "audio", "pcm_b16": server.encode_audio(pcm([800] * 1_600))})
        await session.handle({"type": "audio", "pcm_b16": server.encode_audio(pcm([0] * 9_600))})

        assert socket.messages[0]["vad"] == "energy"
        assert message_types(socket) == ["ready", "vad", "vad", "transcript"]
        assert socket.messages[-1] == {"type": "transcript", "final": True, "text": "heard"}

    asyncio.run(check())


def test_interrupt_cancels_running_speech(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "Kokoro", FakeKokoro)
        socket = Socket(block_audio=True)
        session = server.VoiceSession(server.VoiceWorker(), socket)

        await session.handle({"type": "speak", "id": "voice-1", "text": "Hello"})
        await asyncio.wait_for(socket.audio_started.wait(), timeout=1)
        await session.handle({"type": "interrupt"})

        assert socket.messages[-1] == {
            "type": "tts_stopped",
            "id": "voice-1",
            "reason": "interrupted",
        }

    asyncio.run(check())


def test_guarded_import_fallbacks_report_capabilities(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "SileroModel", None)
        monkeypatch.setattr(server, "Kokoro", None)
        monkeypatch.setattr(server, "WhisperModel", None)
        monkeypatch.setattr(server, "optional_module", lambda _: False)
        socket = Socket()
        session = server.VoiceSession(server.VoiceWorker(), socket)

        await session.ready()
        await session.handle({"type": "speak", "id": "voice-1", "text": "Hello"})
        await asyncio.sleep(0)

        assert socket.messages == [
            {
                "type": "ready",
                "vad": "energy",
                "tts": "unavailable",
                "engines": {"stt": [], "tts": []},
            },
            {"type": "tts_stopped", "id": "voice-1", "reason": "unavailable"},
        ]

    asyncio.run(check())


def test_ready_lists_importable_engines(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "SileroModel", None)
        monkeypatch.setattr(server, "WhisperModel", object)
        monkeypatch.setattr(server, "Kokoro", FakeKokoro)
        monkeypatch.setattr(server, "optional_module", lambda name: name in {"nemo", "piper"})
        socket = Socket()
        session = server.VoiceSession(server.VoiceWorker(), socket)

        await session.ready()

        assert socket.messages == [
            {
                "type": "ready",
                "vad": "energy",
                "tts": "kokoro",
                "engines": {"stt": ["faster-whisper", "parakeet"], "tts": ["kokoro", "piper"]},
            }
        ]

    asyncio.run(check())


def test_optional_module_detection_never_raises() -> None:
    assert server.optional_module("json") is True
    assert server.optional_module("definitely_not_a_module_xyz") is False
    assert server.optional_module("") is False


def test_t13_listen_stop_finalizes_without_waiting_for_silence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "SileroModel", None)
        worker = server.VoiceWorker()
        heard: list[bytes] = []

        def transcribe(pcm_data: bytes) -> str:
            heard.append(pcm_data)
            return "what is a channel ack"

        monkeypatch.setattr(worker, "transcribe_pcm", transcribe)
        socket = Socket()
        session = server.VoiceSession(worker, socket)

        await session.handle({"type": "listen_start"})
        speech = pcm([800] * 1_600)
        await session.handle({"type": "audio", "pcm_b16": server.encode_audio(speech)})
        # Only 100 ms of trailing silence: far below the 600 ms auto-finalize window.
        await session.handle({"type": "audio", "pcm_b16": server.encode_audio(pcm([0] * 1_600))})
        assert message_types(socket) == ["vad"]

        await session.handle({"type": "listen_stop"})

        assert message_types(socket) == ["vad", "vad", "transcript"]
        assert socket.messages[-1] == {
            "type": "transcript",
            "final": True,
            "text": "what is a channel ack",
        }
        assert heard == [speech + pcm([0] * 1_600)]
        assert session.listening is False

        # Capture has stopped: later audio is ignored and produces nothing.
        await session.handle({"type": "audio", "pcm_b16": server.encode_audio(speech)})
        assert message_types(socket) == ["vad", "vad", "transcript"]

    asyncio.run(check())


def test_listen_stop_with_empty_buffer_emits_empty_final_transcript(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "SileroModel", None)
        worker = server.VoiceWorker()
        calls: list[bytes] = []
        monkeypatch.setattr(worker, "transcribe_pcm", lambda data: calls.append(data) or "x")
        socket = Socket()
        session = server.VoiceSession(worker, socket)

        await session.handle({"type": "listen_start"})
        await session.handle({"type": "audio", "pcm_b16": server.encode_audio(pcm([0] * 1_600))})
        await session.handle({"type": "listen_stop"})

        assert socket.messages == [{"type": "transcript", "final": True, "text": ""}]
        assert calls == []

    asyncio.run(check())


def test_audio_base64_round_trip() -> None:
    raw = pcm([-32768, -1, 0, 1, 32767])

    assert server.decode_audio(server.encode_audio(raw)) == raw
    assert base64.b64decode(server.encode_audio(raw)) == raw


def test_speak_applies_voice_options(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(server, "Kokoro", FakeKokoro)
    FakeKokoro.calls.clear()

    server.VoiceWorker().synthesize(
        "Hello", {"voice": "af_sky", "speed": 1.2, "language": "en"}
    )

    _, options = FakeKokoro.calls[-1]
    assert options == {"voice": "af_sky", "speed": 1.2, "lang": "en-us"}


def test_synthesize_normalizes_azure_and_unknown_voice_names(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(server, "Kokoro", FakeKokoro)
    monkeypatch.setenv("KOKORO_VOICE", "af_sky")
    FakeKokoro.calls.clear()
    worker = server.VoiceWorker()

    worker.synthesize("Hello", {"voice": "en-US-AriaNeural"})
    assert FakeKokoro.calls[-1][1]["voice"] == "af_heart"

    worker.synthesize("Hello", {"voice": "not-a-kokoro-voice"})
    assert FakeKokoro.calls[-1][1]["voice"] == "af_sky"
    assert "Unknown Kokoro voice" in caplog.text

    worker.synthesize("Hello", {"voice": "am_adam"})
    assert FakeKokoro.calls[-1][1]["voice"] == "am_adam"


def test_tts_emits_first_sentence_before_synthesizing_later_sentences() -> None:
    class ChunkWorker:
        tts_available = True

        def __init__(self) -> None:
            self.calls: list[str] = []

        def synthesize(self, text: str, voice: object) -> bytes:
            self.calls.append(text)
            return b"\x00\x00"

    async def check() -> None:
        worker = ChunkWorker()
        socket = Socket(block_audio=True)
        session = server.VoiceSession(worker, socket)
        text = f"{'first ' * 30}. {'second ' * 30}."
        task = asyncio.create_task(session.speak("voice-1", text))

        await asyncio.wait_for(socket.audio_started.wait(), timeout=1)
        assert len(worker.calls) == 1
        socket.release_audio.set()
        await task

    asyncio.run(check())


def test_speak_text_cap_rejects_oversized_text(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "Kokoro", FakeKokoro)
        socket = Socket()
        session = server.VoiceSession(server.VoiceWorker(), socket)

        await session.handle({"type": "speak", "id": "voice-1", "text": "x" * 2_001})
        await asyncio.sleep(0)

        assert socket.messages == [{"type": "error", "message": "text exceeds 2000 characters"}]

    asyncio.run(check())


def test_audio_frame_cap_reports_error_and_ignores_frame(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "SileroModel", None)
        socket = Socket()
        session = server.VoiceSession(server.VoiceWorker(), socket)

        await session.handle({"type": "listen_start"})
        await session.handle(
            {
                "type": "audio",
                "pcm_b16": server.encode_audio(b"\x01\x02" * (server.MAX_AUDIO_BYTES // 2 + 1)),
            }
        )

        assert socket.messages == [{"type": "error", "message": "pcm_b16 exceeds 160 KiB"}]
        assert session.listening is True
        assert len(session.segment) == 0

    asyncio.run(check())


def test_speech_segment_cap_drops_audio_and_reports_once(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "SileroModel", None)
        worker = server.VoiceWorker()
        monkeypatch.setattr(worker, "transcribe_pcm", lambda _: "heard")
        socket = Socket()
        session = server.VoiceSession(worker, socket)

        # Frames under the 160 KiB frame cap accumulate past the 30s segment cap.
        frame = server.MAX_AUDIO_BYTES // 2  # ~10.24s of samples per frame
        await session.handle({"type": "listen_start"})
        for _ in range(6):
            await session.handle(
                {"type": "audio", "pcm_b16": server.encode_audio(pcm([800] * frame))}
            )
        await session.handle({"type": "audio", "pcm_b16": server.encode_audio(pcm([0] * 9_600))})

        errors = [message for message in socket.messages if message["type"] == "error"]
        assert errors == [
            {"type": "error", "message": "speech segment exceeds 30 seconds; dropping audio"}
        ]
        assert socket.messages[-1] == {"type": "transcript", "final": True, "text": "heard"}
        assert len(session.segment) == 0  # finish_speech cleared the capped buffer

    asyncio.run(check())


def test_speak_supersede_cancels_previous_speech(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        monkeypatch.setattr(server, "Kokoro", FakeKokoro)
        socket = Socket(block_audio=True)
        session = server.VoiceSession(server.VoiceWorker(), socket)

        await session.handle({"type": "speak", "id": "voice-1", "text": "first"})
        await asyncio.wait_for(socket.audio_started.wait(), timeout=1)
        await session.handle({"type": "speak", "id": "voice-2", "text": "second"})
        socket.release_audio.set()  # unblock the cancelled first task's pending send
        await asyncio.wait_for(session.tts_task, timeout=1)

        assert {"type": "tts_stopped", "id": "voice-1", "reason": "superseded"} in socket.messages
        assert socket.messages[-1] == {"type": "tts_stopped", "id": "voice-2", "reason": "complete"}

    asyncio.run(check())


class Closed(Exception):
    pass


class FakeConnection:
    """Mimics the websockets connection surface used by run_websocket."""

    def __init__(
        self, path: str, incoming: list[str], headers: dict[str, str] | None = None
    ) -> None:
        self.request = type("Request", (), {"path": path, "headers": headers or {}})()
        self.incoming = incoming
        self.messages: list[dict[str, object]] = []
        self.closes: list[tuple[int, str]] = []

    async def send(self, raw: str) -> None:
        if self.closes:
            raise Closed
        self.messages.append(json.loads(raw))

    async def close(self, code: int, reason: str) -> None:
        self.closes.append((code, reason))

    def __aiter__(self) -> FakeConnection:
        return self

    async def __anext__(self) -> str:
        if not self.incoming:
            raise Closed  # a live connection blocks awaiting the next frame
        message = self.incoming.pop(0)
        if isinstance(message, _Raise):
            raise message.error


class ParkedConnection(FakeConnection):
    """A connection that stays open, awaiting its next frame forever."""

    async def __anext__(self) -> str:
        if not self.incoming:
            await asyncio.Event().wait()
        message = self.incoming.pop(0)
        return message


class _Raise:
    def __init__(self, error: BaseException) -> None:
        self.error = error


class FakeServer:
    def __init__(self) -> None:
        self.port = 8_879

    async def __aenter__(self) -> FakeServer:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None


class FakeWebsockets:
    def __init__(self) -> None:
        self.serve_args: tuple[Any, ...] | None = None

    def serve(self, handler: Any, *args: Any, **kwargs: Any) -> FakeServer:
        self.handler = handler
        self.serve_args = args
        self.serve_kwargs = kwargs
        return FakeServer()


class ServeStop(Exception):
    pass


async def drive_handlers(
    monkeypatch: pytest.MonkeyPatch, token: str | None, connections: list[FakeConnection]
) -> list[FakeConnection]:
    """Run run_websocket against fake connections; returns them after all handlers settle."""
    monkeypatch.delenv("SIDECAR_VOICE_TOKEN", raising=False)
    if token is not None:
        monkeypatch.setenv("SIDECAR_VOICE_TOKEN", token)
    fake = FakeWebsockets()
    monkeypatch.setitem(sys.modules, "websockets", fake)
    task = asyncio.create_task(server.run_websocket(server.VoiceWorker()))

    async def stopper() -> None:
        raise ServeStop

    for _ in range(10):
        await asyncio.sleep(0)
    for connection in connections:
        handler_task = asyncio.create_task(fake.handler(connection))
        for _ in range(20):
            await asyncio.sleep(0)
        if connection.closes or connection.incoming:
            handler_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Closed):
                await handler_task
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, ServeStop):
        await task
    return connections


def test_handshake_accepts_valid_token_and_defers_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        connection = FakeConnection("/?token=secret-token", [])
        await drive_handlers(monkeypatch, "secret-token", [connection])

        assert connection.closes == []
        assert message_types(connection) == ["ready"]  # type: ignore[arg-type]

    asyncio.run(check())


def test_handshake_rejects_wrong_token_before_any_messages(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        connection = FakeConnection("/?token=wrong", [])
        await drive_handlers(monkeypatch, "secret-token", [connection])
        assert connection.closes == [(1008, "invalid voice token")]
        assert connection.messages == [
            {"type": "error", "message": "invalid voice token"}
        ]

    asyncio.run(check())


def test_handshake_rejects_missing_token(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        connection = FakeConnection("/", [])
        await drive_handlers(monkeypatch, "secret-token", [connection])
        assert connection.closes == [(1008, "invalid voice token")]
        assert connection.messages == [
            {"type": "error", "message": "invalid voice token"}
        ]

    asyncio.run(check())


def test_handshake_accepts_bearer_authorization(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        connection = FakeConnection(
            "/", [], {"Authorization": "Bearer secret-token"}
        )
        await drive_handlers(monkeypatch, "secret-token", [connection])

        assert connection.closes == []
        assert message_types(connection) == ["ready"]  # type: ignore[arg-type]

    asyncio.run(check())


def test_second_connection_closed_busy(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        token = "secret-token"
        monkeypatch.setenv("SIDECAR_VOICE_TOKEN", token)
        fake = FakeWebsockets()
        monkeypatch.setitem(sys.modules, "websockets", fake)
        task = asyncio.create_task(server.run_websocket(server.VoiceWorker()))
        for _ in range(10):
            await asyncio.sleep(0)

        first = ParkedConnection(f"/?token={token}", [])
        second = FakeConnection(f"/?token={token}", [])
        first_task = asyncio.create_task(fake.handler(first))
        for _ in range(10):
            await asyncio.sleep(0)

        busy_handler = fake.handler(second)
        assert busy_handler is not None
        await busy_handler

        assert second.closes == [(1013, "voice worker is busy")]
        assert second.messages == []

        first_task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Closed):
            await first_task
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(check())


def test_oversized_text_frame_closes_1009(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        huge = json.dumps({"type": "interrupt", "pad": "x" * server.MAX_TEXT_MESSAGE_BYTES})
        connection = ParkedConnection("/?token=secret-token", [huge])
        await drive_handlers(monkeypatch, "secret-token", [connection])

        assert connection.closes == [(1009, "message too large")]

    asyncio.run(check())


def test_voice_token_uses_env_when_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SIDECAR_VOICE_TOKEN", "env-token")
    assert server.voice_token() == "env-token"


def test_voice_token_generates_and_prints_when_env_missing(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.delenv("SIDECAR_VOICE_TOKEN", raising=False)
    token = server.voice_token()
    output = capsys.readouterr().out
    assert output == f"voice token: {token}\n"

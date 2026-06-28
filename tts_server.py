#!/usr/bin/env python3
"""
Real-time TTS WebSocket server for Jellyfin Web book reader.

Usage:
    python tts_server.py [--engine gtts|edge] [--voice VOICE] [--port 7878]

Protocol:
    Client → Server:
        {"type": "speak", "sentences": ["...", ...], "startIndex": 0}
        {"type": "stop"}

    Server → Client:
        {"type": "sentence_start", "index": N, "text": "..."}
        {"type": "done"}
        {"type": "ready"}
"""
import argparse
import asyncio
import json
import sys
import threading


def make_engine(engine_name: str, voice: str | None):
    if engine_name == "edge":
        from RealtimeTTS import EdgeEngine
        engine = EdgeEngine()
        if voice:
            engine.set_voice(voice)
        return engine

    from RealtimeTTS import GTTSEngine
    return GTTSEngine()


class TTSSession:
    def __init__(self, engine):
        self.engine = engine
        self.stop_event = threading.Event()
        self.current_stream = None
        self.thread = None

    def play(self, sentences, on_sentence_cb, on_done_cb, loop):
        """Start per-sentence blocking TTS playback in a background thread.

        Fires sentence_start RIGHT BEFORE each sentence plays (not when yielded into
        a batch generator). This keeps highlight timing in sync with audio and makes
        stop/pause interrupt at the current-sentence boundary.
        """
        self.stop_event.clear()

        def _fire(coro):
            try:
                asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=5)
            except Exception:
                pass

        def run():
            from RealtimeTTS import TextToAudioStream

            for i, sentence in enumerate(sentences):
                if self.stop_event.is_set():
                    return

                _fire(on_sentence_cb(i, sentence))

                if self.stop_event.is_set():
                    return

                stream = TextToAudioStream(self.engine)
                self.current_stream = stream
                stream.feed(iter([sentence + ' ']))
                try:
                    stream.play()
                except Exception as exc:
                    if not self.stop_event.is_set():
                        print(f"[TTS] playback error: {exc}", file=sys.stderr)
                self.current_stream = None

                if self.stop_event.is_set():
                    return

            if not self.stop_event.is_set():
                _fire(on_done_cb())

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        stream = self.current_stream
        if stream is not None:
            try:
                stream.stop()
            except Exception:
                pass


async def handler(websocket, engine):
    session: TTSSession | None = None
    loop = asyncio.get_event_loop()

    try:
        await websocket.send(json.dumps({"type": "ready"}))

        async for raw in websocket:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "speak":
                if session is not None:
                    old = session
                    session = None
                    old.stop()
                    if old.thread and old.thread.is_alive():
                        await asyncio.to_thread(old.thread.join, 1.0)

                sentences = msg.get("sentences", [])
                start_index = msg.get("startIndex", 0)
                sentences = sentences[start_index:]

                if not sentences:
                    continue

                async def on_sentence(i: int, text: str):
                    try:
                        await websocket.send(
                            json.dumps({"type": "sentence_start", "index": i, "text": text})
                        )
                    except Exception:
                        pass

                async def on_done():
                    try:
                        await websocket.send(json.dumps({"type": "done"}))
                    except Exception:
                        pass

                session = TTSSession(engine)
                session.play(sentences, on_sentence, on_done, loop)

            elif msg.get("type") == "stop":
                if session is not None:
                    session.stop()
                    session = None

    except Exception:
        pass
    finally:
        if session is not None:
            session.stop()


async def main(engine, port):
    try:
        import websockets
    except ImportError:
        print("Install websockets: pip install websockets", file=sys.stderr)
        sys.exit(1)

    async with websockets.serve(
        lambda ws: handler(ws, engine),
        "localhost",
        port,
        ping_interval=20,
        ping_timeout=60,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="TTS WebSocket server for Jellyfin book reader")
    parser.add_argument("--engine", choices=["gtts", "edge"], default="edge")
    parser.add_argument("--voice", help="Voice name (EdgeEngine only)")
    parser.add_argument("--port", type=int, default=7878)
    parsed = parser.parse_args()

    # Build the engine before entering the asyncio event loop — EdgeEngine.set_voice()
    # internally calls asyncio.run(), which cannot be nested inside a running loop.
    engine = make_engine(parsed.engine, parsed.voice)

    print(f"[TTS] Starting server on ws://localhost:{parsed.port}")
    print(f"[TTS] Engine: {parsed.engine}" + (f", voice: {parsed.voice}" if parsed.voice else ""))

    asyncio.run(main(engine, parsed.port))

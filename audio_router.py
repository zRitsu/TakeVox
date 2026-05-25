from __future__ import annotations

import queue
import threading
from dataclasses import dataclass
from typing import Any

import numpy as np
import sounddevice as sd


SAMPLE_RATE = 48000
DEFAULT_CHANNELS = 1
STREAM_BLOCK_SIZE = 1024
MIN_START_CHUNKS = 2


@dataclass
class AudioRouteState:
    enabled: bool
    device_id: int | None
    device_name: str | None
    channels: int
    last_error: str | None


class AudioDriverRouter:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._queue: queue.Queue[np.ndarray] = queue.Queue(maxsize=256)
        self._stream: sd.OutputStream | None = None
        self._current_chunk: np.ndarray | None = None
        self._current_offset = 0
        self._device_id: int | None = None
        self._device_name: str | None = None
        self._channels = DEFAULT_CHANNELS
        self._last_error: str | None = None
        self._primed = False
        self._writer_thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._use_callback_stream = False

    @staticmethod
    def _is_preferred_virtual_device(name: str) -> bool:
        normalized = name.lower()
        return "cable input" in normalized or "cable in" in normalized or "vb-audio" in normalized

    @staticmethod
    def _device_priority(name: str, hostapi_name: str) -> tuple[int, int, str]:
        normalized_name = name.lower()
        normalized_hostapi = hostapi_name.lower()
        is_virtual = 0 if ("vb-audio" in normalized_name or "cable" in normalized_name) else 1
        hostapi_rank = 3
        if "wasapi" in normalized_hostapi:
            hostapi_rank = 0
        elif "wdm" in normalized_hostapi:
            hostapi_rank = 1
        elif "directsound" in normalized_hostapi:
            hostapi_rank = 2
        return (is_virtual, hostapi_rank, normalized_name)

    def list_output_devices(self) -> list[dict[str, Any]]:
        devices = sd.query_devices()
        hostapis = sd.query_hostapis()
        items: list[dict[str, Any]] = []
        for idx, device in enumerate(devices):
            if int(device["max_output_channels"]) < 1:
                continue
            hostapi_index = int(device["hostapi"])
            hostapi_name = hostapis[hostapi_index]["name"] if 0 <= hostapi_index < len(hostapis) else "Unknown"
            items.append(
                {
                    "id": idx,
                    "name": str(device["name"]),
                    "hostapi": hostapi_name,
                    "maxOutputChannels": int(device["max_output_channels"]),
                    "defaultSampleRate": float(device["default_samplerate"]),
                    "preferred": self._is_preferred_virtual_device(str(device["name"])),
                }
            )
        virtual_items = [item for item in items if bool(item["preferred"])]
        virtual_items.sort(key=lambda item: self._device_priority(str(item["name"]), str(item["hostapi"])))
        return virtual_items

    def get_state(self) -> AudioRouteState:
        with self._lock:
            return AudioRouteState(
                enabled=self._stream is not None,
                device_id=self._device_id,
                device_name=self._device_name,
                channels=self._channels,
                last_error=self._last_error,
            )

    def enable(self, device_id: int, channels: int = DEFAULT_CHANNELS) -> AudioRouteState:
        self.disable()
        try:
            normalized_channels = 2 if int(channels) >= 2 else 1
            device_info = sd.query_devices(device_id, "output")
            hostapis = sd.query_hostapis()
            hostapi_index = int(device_info["hostapi"])
            hostapi_name = str(hostapis[hostapi_index]["name"]) if 0 <= hostapi_index < len(hostapis) else "Unknown"
            max_output_channels = int(device_info["max_output_channels"])
            if normalized_channels > max_output_channels:
                raise ValueError(f"O device suporta no máximo {max_output_channels} canal(is).")
            sd.check_output_settings(device=device_id, channels=normalized_channels, dtype="float32", samplerate=SAMPLE_RATE)
            prefers_callback = "wdm-ks" in hostapi_name.lower()
            try:
                stream = self._open_stream(device_id, normalized_channels, use_callback=prefers_callback)
            except Exception:
                stream = self._open_stream(device_id, normalized_channels, use_callback=not prefers_callback)
            with self._lock:
                self._stream = stream
                self._device_id = int(device_id)
                self._device_name = str(device_info["name"])
                self._channels = normalized_channels
                self._last_error = None
                self._primed = False
                self._use_callback_stream = getattr(stream, "_takevox_use_callback", False)
                if self._use_callback_stream:
                    self._writer_thread = None
                else:
                    self._stop_event.clear()
                    self._writer_thread = threading.Thread(target=self._writer_loop, name="takevox-audio-router", daemon=True)
                    self._writer_thread.start()
            return self.get_state()
        except Exception as exc:
            with self._lock:
                self._last_error = str(exc)
                self._stream = None
                self._device_id = None
                self._device_name = None
                self._channels = DEFAULT_CHANNELS
                self._use_callback_stream = False
            return self.get_state()

    def disable(self) -> AudioRouteState:
        with self._lock:
            stream = self._stream
            self._stream = None
            self._device_id = None
            self._device_name = None
            self._channels = DEFAULT_CHANNELS
            self._current_chunk = None
            self._current_offset = 0
            self._primed = False
            writer_thread = self._writer_thread
            self._writer_thread = None
            self._use_callback_stream = False
        self._stop_event.set()
        if writer_thread is not None and writer_thread.is_alive():
            writer_thread.join(timeout=1.0)
        if stream is not None:
            try:
                stream.stop()
            finally:
                stream.close()
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        return self.get_state()

    def feed_pcm_bytes(self, data: bytes) -> None:
        state = self.get_state()
        if not state.enabled:
            return
        chunk = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        if chunk.size == 0:
            return
        try:
            self._queue.put_nowait(chunk)
        except queue.Full:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._queue.put_nowait(chunk)
            except queue.Full:
                pass

    def _build_output_block(self, frames: int, channels: int) -> np.ndarray:
        outdata = np.zeros((frames, channels), dtype=np.float32)

        if not self._primed:
            if self._queue.qsize() < MIN_START_CHUNKS:
                return outdata
            self._primed = True

        mono = outdata[:, 0]
        written = 0

        while written < frames:
            if self._current_chunk is None or self._current_offset >= len(self._current_chunk):
                try:
                    self._current_chunk = self._queue.get_nowait()
                    self._current_offset = 0
                except queue.Empty:
                    self._current_chunk = None
                    self._current_offset = 0
                    self._primed = False
                    break

            remaining = len(self._current_chunk) - self._current_offset
            needed = frames - written
            take = min(remaining, needed)
            mono[written : written + take] = self._current_chunk[self._current_offset : self._current_offset + take]
            written += take
            self._current_offset += take

        if channels > 1:
            for channel_index in range(1, channels):
                outdata[:, channel_index] = mono

        return outdata

    def _writer_loop(self) -> None:
        while not self._stop_event.is_set():
            with self._lock:
                stream = self._stream
                channels = self._channels

            if stream is None:
                break

            try:
                block = self._build_output_block(STREAM_BLOCK_SIZE, channels)
                stream.write(block)
            except Exception as exc:
                with self._lock:
                    self._last_error = str(exc)
                break

    def _open_stream(self, device_id: int, channels: int, use_callback: bool) -> sd.OutputStream:
        if use_callback:
            stream = sd.OutputStream(
                samplerate=SAMPLE_RATE,
                blocksize=STREAM_BLOCK_SIZE,
                device=device_id,
                channels=channels,
                dtype="float32",
                callback=self._callback,
            )
            setattr(stream, "_takevox_use_callback", True)
        else:
            stream = sd.OutputStream(
                samplerate=SAMPLE_RATE,
                blocksize=STREAM_BLOCK_SIZE,
                device=device_id,
                channels=channels,
                dtype="float32",
            )
            setattr(stream, "_takevox_use_callback", False)
        stream.start()
        return stream

    def _callback(self, outdata: np.ndarray, frames: int, _time: Any, status: sd.CallbackFlags) -> None:
        if status:
            with self._lock:
                self._last_error = str(status)
        outdata[:] = self._build_output_block(frames, outdata.shape[1])

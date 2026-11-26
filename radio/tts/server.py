#!/usr/bin/env python3
"""Prayer Dome Radio — free Piper TTS microservice.

Generates presenter announcements with Piper (https://github.com/rhasspy/piper),
a fully free, open-source, CPU-friendly neural TTS engine. No API key, no
subscription, no usage fees. Runs anywhere Python runs: the same always-on
machine as the Icecast/Liquidsoap stack, an Oracle Always Free VM, or a PC.

The Vercel function `/api/radio?op=announce` (POST) proxies to this service
via the TTS_SERVICE_URL env var, then caches the MP3/WAV in Cloudflare R2
under radio/announcements/ so each announcement is generated exactly once.
If this service is offline, the website falls back to the browser's built-in
speech voices and, failing that, simply keeps playing music.

Setup (one time):
    pip install piper-tts flask
    # Download the voice models used by assets/pd-radio-announcements.js:
    python -m piper.download_voices en_GB-amy-medium en_GB-ryan-high \
        en_US-lessac-medium en_GB-alan-medium en_US-amy-medium en_GB-northern_english_male-medium

Run:
    PD_RADIO_TOKEN=<same token as Vercel RADIO_ADMIN_TOKEN> python server.py
"""
import hashlib
import io
import os
import subprocess
import tempfile
import wave

from flask import Flask, jsonify, request, send_file

app = Flask(__name__)

TOKEN = os.environ.get("PD_RADIO_TOKEN", "")
VOICES_DIR = os.environ.get("PIPER_VOICES_DIR", os.path.expanduser("~/.local/share/piper"))
ALLOWED_MODELS = {
    "en_GB-amy-medium",
    "en_GB-ryan-high",
    "en_US-lessac-medium",
    "en_GB-alan-medium",
    "en_US-amy-medium",
    "en_GB-northern_english_male-medium",
}
MAX_TEXT = 2000


def find_model(name: str) -> str:
    for root, _dirs, files in os.walk(VOICES_DIR):
        for f in files:
            if f == f"{name}.onnx":
                return os.path.join(root, f)
    raise FileNotFoundError(f"Voice model {name} not downloaded")


@app.get("/health")
def health():
    return jsonify({"ok": True, "engine": "piper", "models": sorted(ALLOWED_MODELS)})


@app.post("/synthesize")
def synthesize():
    if TOKEN and request.headers.get("x-radio-token", "") != TOKEN:
        return jsonify({"error": "unauthorised"}), 401
    body = request.get_json(silent=True) or {}
    text = str(body.get("text", "")).strip()[:MAX_TEXT]
    model = str(body.get("model", "en_GB-amy-medium"))
    if not text:
        return jsonify({"error": "text required"}), 400
    if model not in ALLOWED_MODELS:
        return jsonify({"error": "unknown model"}), 400
    try:
        model_path = find_model(model)
    except FileNotFoundError as err:
        return jsonify({"error": str(err)}), 503

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as out:
        wav_path = out.name
    try:
        proc = subprocess.run(
            ["piper", "--model", model_path, "--output_file", wav_path],
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=120,
        )
        if proc.returncode != 0:
            return jsonify({"error": proc.stderr.decode()[:400]}), 500
        with open(wav_path, "rb") as fh:
            data = fh.read()
        # Sanity-check the WAV so a broken render never reaches the station.
        with wave.open(io.BytesIO(data)) as w:
            if w.getnframes() == 0:
                return jsonify({"error": "empty audio"}), 500
        digest = hashlib.sha1((model + "|" + text).encode()).hexdigest()[:16]
        return send_file(
            io.BytesIO(data),
            mimetype="audio/wav",
            download_name=f"announcement-{digest}.wav",
        )
    finally:
        try:
            os.unlink(wav_path)
        except OSError:
            pass


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5005")))

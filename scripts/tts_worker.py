#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-voice-horn 常驻 TTS worker：stdin 收任务、流式合成、MCI 播放。
避免每次 spawn 新 python 进程的 ~0.8s 开销，复用解释器与 edge_tts 模块。

协议：每行一个 JSON 请求 {"id":..,"text":..,"voice":..,"rate":..,"volume":..,"pitch":..,"cache":bool}
响应：每行一个 JSON {"id":..,"stage":"synth-start|synth-done|play-start|done|error",...}
"""
import asyncio
import ctypes
import json
import os
import sys
import tempfile
import time
import uuid

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_winmm = None


def mci(cmd):
    global _winmm
    if _winmm is None:
        _winmm = ctypes.windll.winmm
    buf = ctypes.create_unicode_buffer(1024)
    return int((_winmm.mciSendStringW(cmd, buf, 1024, 0) or 0) & 0xFFFF), buf.value


def play_media(path, timeout_s=600.0):
    ap = os.path.abspath(path)
    alias = "vh" + uuid.uuid4().hex[:12]
    ext = os.path.splitext(ap)[1].lower()
    devices = ["waveaudio"] if ext == ".wav" else ["mpegvideo", "waveaudio"]
    err = -1
    for dev in devices:
        err, _ = mci('open "%s" type %s alias %s' % (ap, dev, alias))
        if err == 0:
            break
    if err != 0:
        return False, "mci-open err=%d" % err
    err, _ = mci("play %s" % alias)
    if err != 0:
        mci("close %s" % alias)
        return False, "mci-play err=%d" % err
    deadline = time.time() + timeout_s
    time.sleep(0.15)
    while time.time() < deadline:
        e, mode = mci("status %s mode" % alias)
        if e != 0 or mode.lower() in ("stopped", "paused"):
            break
        time.sleep(0.12)
    mci("close %s" % alias)
    return True, ""


CACHE_DIR = os.path.join(tempfile.gettempdir(), "dsh_voice_horn_cache")
CACHE_MAX = 40


def cache_key(text, voice):
    import hashlib
    return hashlib.sha1((voice + "|" + text).encode("utf-8")).hexdigest()[:16]


def cache_path(text, voice):
    return os.path.join(CACHE_DIR, cache_key(text, voice) + ".mp3")


def cache_get(text, voice):
    p = cache_path(text, voice)
    return p if os.path.exists(p) and os.path.getsize(p) > 200 else None


def cache_put(text, voice, tmp):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        dst = cache_path(text, voice)
        with open(tmp, "rb") as f:
            data = f.read()
        with open(dst, "wb") as f:
            f.write(data)
        # 简单 LRU：超过上限删最旧的
        files = [os.path.join(CACHE_DIR, x) for x in os.listdir(CACHE_DIR) if x.endswith(".mp3")]
        if len(files) > CACHE_MAX:
            files.sort(key=os.path.getmtime)
            for old in files[: len(files) - CACHE_MAX]:
                try:
                    os.remove(old)
                except OSError:
                    pass
    except Exception:
        pass


async def synth_to(text, voice, out, rate, volume, pitch):
    import edge_tts
    kwargs = {}
    if rate:
        kwargs["rate"] = rate
    if volume:
        kwargs["volume"] = volume
    # 流式落盘：边收边写，减少内存与等待
    with open(out, "wb") as f:
        async for chunk in edge_tts.Communicate(text, voice, **kwargs).stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def handle(req):
    rid = req.get("id")
    text = (req.get("text") or "").strip()
    voice = req.get("voice") or "zh-CN-XiaoxiaoNeural"
    if not text:
        emit({"id": rid, "stage": "error", "error": "empty-text"})
        return
    use_cache = req.get("cache", True)

    # 命中缓存 → 直接播
    hit = cache_get(text, voice) if use_cache else None
    if hit:
        emit({"id": rid, "stage": "cache-hit", "file": hit})
        ok, warn = play_media(hit)
        emit({"id": rid, "stage": "done" if ok else "error", "cached": True, "error": "" if ok else warn})
        return

    out = os.path.join(tempfile.gettempdir(), "vh_%s_%d.mp3" % (uuid.uuid4().hex[:8], int(time.time() * 1000)))
    t0 = time.time()
    emit({"id": rid, "stage": "synth-start"})
    try:
        asyncio.run(synth_to(text, voice, out, req.get("rate"), req.get("volume"), req.get("pitch")))
    except Exception as e:
        emit({"id": rid, "stage": "error", "error": "synth: %s" % e})
        return
    synth_ms = int((time.time() - t0) * 1000)
    if not os.path.exists(out) or os.path.getsize(out) < 200:
        emit({"id": rid, "stage": "error", "error": "audio-missing"})
        return
    emit({"id": rid, "stage": "synth-done", "synthMs": synth_ms})

    if use_cache:
        cache_put(text, voice, out)

    ok, warn = play_media(out)
    emit({"id": rid, "stage": "done" if ok else "error", "synthMs": synth_ms, "error": "" if ok else warn})
    try:
        os.remove(out)
    except OSError:
        pass


def main():
    emit({"id": None, "stage": "ready", "pid": os.getpid()})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            emit({"id": None, "stage": "error", "error": "bad-json"})
            continue
        if req.get("cmd") == "exit":
            break
        try:
            handle(req)
        except Exception as e:
            emit({"id": req.get("id"), "stage": "error", "error": str(e)})


if __name__ == "__main__":
    main()

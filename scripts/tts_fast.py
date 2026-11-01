#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""极简快速 TTS：合成 + 立即播放，砍掉一切冗余逻辑。
专为试听设计——无缓存目录扫描、无文件保留、无复杂错误码。
"""
import asyncio
import ctypes
import json
import os
import sys
import tempfile
import uuid

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

CACHE_DIR = os.path.join(tempfile.gettempdir(), "dsh_vh_cache")


def mci(cmd):
    buf = ctypes.create_unicode_buffer(1024)
    try:
        return int((ctypes.windll.winmm.mciSendStringW(cmd, buf, 1024, 0) or 0) & 0xFFFF), buf.value
    except Exception:
        return -1, ""


async def synth(text, voice, out):
    import edge_tts
    with open(out, "wb") as f:
        async for ch in edge_tts.Communicate(text, voice).stream():
            if ch["type"] == "audio":
                f.write(ch["data"])


def play(path):
    ap = os.path.abspath(path)
    alias = "vf" + uuid.uuid4().hex[:10]
    e, _ = mci('open "%s" type mpegvideo alias %s' % (ap, alias))
    if e != 0:
        e, _ = mci('open "%s" type waveaudio alias %s' % (ap, alias))
    if e != 0:
        return False, "open-%d" % e
    e, _ = mci("play %s" % alias)
    if e != 0:
        mci("close %s" % alias)
        return False, "play-%d" % e
    import time
    deadline = time.time() + 600
    time.sleep(0.12)
    while time.time() < deadline:
        ee, mode = mci("status %s mode" % alias)
        if ee != 0 or mode.lower() in ("stopped", "paused"):
            break
        time.sleep(0.1)
    mci("close %s" % alias)
    return True, ""


def cache_key(text, voice):
    import hashlib
    return hashlib.sha1((voice + "|" + text).encode("utf-8")).hexdigest()[:16]


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "usage: tts_fast.py TEXT VOICE"}, ensure_ascii=False))
        sys.exit(2)
    text = sys.argv[1].strip()[:2000]
    voice = sys.argv[2].strip() or "zh-CN-XiaoxiaoNeural"
    if not text:
        print(json.dumps({"ok": False, "error": "empty"}, ensure_ascii=False))
        sys.exit(2)

    os.makedirs(CACHE_DIR, exist_ok=True)
    cp = os.path.join(CACHE_DIR, cache_key(text, voice) + ".mp3")
    cached = os.path.exists(cp) and os.path.getsize(cp) > 200
    if not cached:
        tmp = cp + ".part"
        asyncio.run(synth(text, voice, tmp))
        if not os.path.exists(tmp) or os.path.getsize(tmp) < 200:
            print(json.dumps({"ok": False, "error": "audio-missing"}, ensure_ascii=False))
            sys.exit(3)
        os.replace(tmp, cp)
    ok, warn = play(cp)
    print(json.dumps({"ok": ok, "voice": voice, "cached": cached, "error": "" if ok else warn}, ensure_ascii=False))
    if not ok:
        sys.exit(4)


if __name__ == "__main__":
    main()

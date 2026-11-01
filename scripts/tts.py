#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-voice-horn 语音合成器：edge-tts 合成 + 本机 WinMM(MCI) 静默播放。

- 全程零前台窗口：进程由插件服务端以 windowsHide 拉起，音频走 MCI 直接出扬声器，
  不弹 PowerShell、不开播放器窗口。
- --voice 传任意 edge-tts 女声即可换音色（默认 zh-CN-XiaoxiaoNeural，备选 zh-CN-XiaoyiNeural）。
- CosyVoice 本地克隆接口（预留）：--provider cosyvoice --clone-cmd <可执行...> [--sample 样音]
  会把 --text/--voice/--out/--sample 传给该命令，由本地推理产出音频后仍走本机静默播放。

输出单行 JSON：{"ok": true/false, ...}；失败时非零退出码。
"""
import argparse
import asyncio
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
import uuid

try:  # 宿主管道里输出中文 JSON 不炸编码
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def emit(obj, code=0):
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


# ---------------------------------------------------------------- edge-tts
async def _edge_synth(edge_tts, text, out, voice, kwargs):
    await edge_tts.Communicate(text, voice, **kwargs).save(out)


def synth_edge(text, out, voice, rate, volume, pitch, proxy):
    try:
        import edge_tts
    except ImportError as e:
        raise RuntimeError("edge-tts 未安装（python -m pip install edge-tts）: %s" % e)
    kwargs = {}
    if rate:
        kwargs["rate"] = rate
    if volume:
        kwargs["volume"] = volume
    if proxy:
        kwargs["proxy"] = proxy
    if pitch:
        try:  # 旧版 edge-tts 可能没有 pitch 参数，降级重试
            asyncio.run(_edge_synth(edge_tts, text, out, voice, {**kwargs, "pitch": pitch}))
            return
        except TypeError:
            pass
    asyncio.run(_edge_synth(edge_tts, text, out, voice, kwargs))


# ---------------------------------------------------------------- CosyVoice 预留接口
def synth_cosyvoice(text, out, voice, sample, clone_cmd, timeout):
    if not clone_cmd:
        emit({"ok": False, "error": "cosyvoice-adapter-not-configured：需要 --clone-cmd 指向本地推理入口"}, 3)
    cmd = list(clone_cmd) + ["--text", text, "--voice", voice, "--out", out]
    if sample:
        cmd += ["--sample", sample]
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    try:
        r = subprocess.run(cmd, timeout=timeout, creationflags=flags)
    except subprocess.TimeoutExpired:
        emit({"ok": False, "error": "cosyvoice-inference-timeout"}, 4)
    except Exception as e:
        emit({"ok": False, "error": "cosyvoice-adapter: %s" % e}, 4)
    if r.returncode != 0:
        emit({"ok": False, "error": "cosyvoice-adapter-exit-%s" % r.returncode}, 4)


# ---------------------------------------------------------------- 静默播放（WinMM MCI）
_winmm = None


def _mci(cmd):
    global _winmm
    if _winmm is None:
        _winmm = ctypes.windll.winmm
    buf = ctypes.create_unicode_buffer(1024)
    err = _winmm.mciSendStringW(cmd, buf, 1024, 0)
    return int(err & 0xFFFF), buf.value


def play_media(path, timeout_s=600.0):
    """MCI 静默播放，播完返回 (True, '')；失败返回 (False, 原因)。"""
    ap = os.path.abspath(path)
    alias = "vh" + uuid.uuid4().hex[:12]
    ext = os.path.splitext(ap)[1].lower()
    devices = ["waveaudio"] if ext == ".wav" else ["mpegvideo", "waveaudio"]
    err = -1
    for dev in devices:
        err, _ = _mci('open "%s" type %s alias %s' % (ap, dev, alias))
        if err == 0:
            break
    if err != 0:
        return False, "mci-open-失败 err=%d（常见音频解码器缺失）" % err
    err, _ = _mci("play %s" % alias)
    if err != 0:
        _mci("close %s" % alias)
        return False, "mci-play-失败 err=%d" % err
    deadline = time.time() + timeout_s
    time.sleep(0.25)
    while time.time() < deadline:
        e, mode = _mci("status %s mode" % alias)
        if e != 0 or mode.lower() in ("stopped", "paused"):
            break
        time.sleep(0.15)
    _mci("close %s" % alias)
    return True, ""


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description="dsh-voice-horn 静默 TTS")
    ap.add_argument("--text", required=True)
    ap.add_argument("--voice", default="zh-CN-XiaoxiaoNeural")
    ap.add_argument("--rate", default="+5%")
    ap.add_argument("--volume", default="+8%")
    ap.add_argument("--pitch", default="+2Hz")
    ap.add_argument("--proxy", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--provider", default="edge", choices=["edge", "cosyvoice"])
    ap.add_argument("--sample", default="", help="CosyVoice 样音路径（本地克隆用）")
    ap.add_argument("--clone-cmd", nargs="*", default=[], help="CosyVoice 本地推理命令（预留接口）")
    ap.add_argument("--dry-run", action="store_true", help="只合成不播放")
    ap.add_argument("--keep", action="store_true", help="保留音频文件")
    ap.add_argument("--timeout", type=float, default=180.0, help="合成+播放总预算秒")
    a = ap.parse_args()

    text = (a.text or "").strip()[:4000]
    if not text:
        emit({"ok": False, "error": "empty-text"}, 2)
    if os.name != "nt":
        emit({"ok": False, "error": "仅支持 Windows 本机播放"}, 2)

    suffix = ".wav" if a.provider == "cosyvoice" and a.out.lower().endswith(".wav") else ".mp3"
    out = a.out or os.path.join(tempfile.gettempdir(), "dsh_voice_horn_%d_%d%s" % (os.getpid(), int(time.time() * 1000), suffix))

    if a.provider == "cosyvoice":
        synth_cosyvoice(text, out, a.voice, a.sample, a.clone_cmd, a.timeout)
    else:
        try:
            synth_edge(text, out, a.voice, a.rate, a.volume, a.pitch, a.proxy)
        except Exception as e:
            emit({"ok": False, "error": "edge-tts: %s" % e}, 5)

    if not os.path.exists(out) or os.path.getsize(out) < 200:
        emit({"ok": False, "error": "音频产物缺失或过小: " + out}, 6)

    played, warn = (True, "") if a.dry_run else play_media(out, max(10.0, a.timeout - 5))
    if not a.keep:
        try:
            os.remove(out)
        except OSError:
            pass
    if not played:
        emit({"ok": False, "error": "播放失败: " + warn, "file": None, "synth": "done"}, 7)
    emit({
        "ok": True,
        "provider": a.provider,
        "voice": a.voice,
        "chars": len(text),
        "played": bool(played),
        "dryRun": bool(a.dry_run),
        "file": out if a.keep else None,
    })


if __name__ == "__main__":
    main()

#!/usr/bin/env python
"""QQ 桥的语音转文字入口（自包含，不依赖工作区文件存活）。

接口：stt.py <音频> [语言|auto] [模型|small] -> 一行 JSON（UTF-8）。

!! 这个文件和工作区里另一套 ASR 脚本是**两份独立实现**，
!! 故意不共享代码：插件要能脱离工作区单独活着。改一处必须同步改另一处。

三个必须保留的补丁（都踩过，别删）：
1. PyAV 19.0.2 不接受 faster-whisper 1.2.x 传的 metadata_errors 参数，这里 shim 掉；
   19.0.2 已是 PyPI 最新，没有可降的版本。
2. Windows 下 stdout 默认 GBK，index.js 按 UTF-8 解码会得到乱码，这里强制 UTF-8。
3. 模型权重放工作区 models/whisper/ 下，不要放 _stems 之类的临时目录（2026-10-27 被清掉过一次）。
"""
import json
import os
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# plugins/qq-bridge/tools/stt.py -> tools -> qq-bridge -> plugins -> 工作区
WORKSPACE = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
)
MODEL_ROOT = os.path.join(WORKSPACE, "models", "whisper")


def patch_av() -> None:
    """吞掉 PyAV 不认的 metadata_errors。"""
    try:
        import av
    except Exception:
        return
    if getattr(av, "_dsh_metadata_shim", False):
        return
    original = av.open

    def _open(*args, **kwargs):
        kwargs.pop("metadata_errors", None)
        return original(*args, **kwargs)

    av.open = _open
    av._dsh_metadata_shim = True


def resolve_model(size: str) -> str:
    """优先本地快照，别让 faster-whisper 走下载路径。"""
    explicit = os.environ.get("WHISPER_MODEL")
    if explicit and os.path.exists(explicit):
        return explicit
    if os.path.isdir(size):
        return size

    local = os.path.join(MODEL_ROOT, f"faster-whisper-{size}")
    if os.path.isfile(os.path.join(local, "model.bin")):
        return local

    cache = os.environ.get("WHISPER_CACHE") or os.path.join(
        os.path.expanduser("~"), ".cache", "huggingface", "hub"
    )
    snapshots = os.path.join(cache, f"models--Systran--faster-whisper-{size}", "snapshots")
    if os.path.isdir(snapshots):
        found = [
            os.path.join(snapshots, name)
            for name in sorted(os.listdir(snapshots))
            if os.path.isfile(os.path.join(snapshots, name, "model.bin"))
        ]
        if found:
            return found[-1]
    return size


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "no audio path"}, ensure_ascii=False))
        return 2

    audio = sys.argv[1]
    lang_arg = (sys.argv[2] if len(sys.argv) > 2 else "auto") or "auto"
    size = (sys.argv[3] if len(sys.argv) > 3 else "small") or "small"
    language = None if lang_arg.lower() in ("auto", "") else lang_arg

    if not os.path.isfile(audio):
        print(json.dumps({"error": f"file not found: {audio}"}, ensure_ascii=False))
        return 2

    try:
        patch_av()
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(json.dumps({"error": f"faster_whisper unavailable: {exc}"}, ensure_ascii=False))
        return 3

    try:
        model = WhisperModel(
            resolve_model(size),
            device="cpu",
            compute_type="int8",
            download_root=os.environ.get("WHISPER_CACHE") or None,
        )
        segments, info = model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = "".join(seg.text for seg in segments).strip()
        print(
            json.dumps(
                {
                    "text": text,
                    "lang": getattr(info, "language", language or ""),
                    "seconds": round(float(getattr(info, "duration", 0.0)), 2),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:  # 转写失败要能报出去，不能崩
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())

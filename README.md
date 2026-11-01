# dsh-voice-horn · DSH 语音播报喇叭

DeepSeek Harness（DSH）桌面端独立 TTS 语音播报插件：AI 回复完成后，在后台静默朗读回复摘要，全程不弹黑框、不打开播放器窗口；每个对话独立记忆开关状态，新对话默认关闭。

## 功能

- 对话右下角悬浮喇叭按钮，一键开启/关闭播报
- 内置 14 个 edge-tts 中文音色，支持收藏置顶、语速/音调/音量独立调节
- 四种播报模式：摘要 / 全文 / 手动触发 / 关键词触发
- 自定义过滤词（静默跳过或替换），播报历史本地留存，支持重播/复制/删除
- 预留 CosyVoice 本地音色克隆扩展接口
- 配置与历史仅保存在本机 `~/.dsh/voice-horn.json`，不上传任何对话内容

## 环境要求

- Windows（本机静音播放使用 WinMM/MCI 接口）
- Python 3.9+，并安装 `edge-tts`：

```bash
python -m pip install edge-tts -i https://pypi.tuna.tsinghua.edu.cn/simple
```

## 安装

完整三步注册（包体 + profile dependencies + profile bundles + patch 登记）见仓库内 `安装说明.md`。

## 技术说明

- 宿主侧 `index.js`：负责任务队列、状态持久化、Python 进程调度、看板娘联动事件
- 前端 `client.js`：注入对话界面的喇叭按钮与控制面板
- `scripts/`：edge-tts 合成脚本（单次合成、试听缓存、常驻 worker）
- Python 解释器按「插件设置 → `VH_PYTHON` 环境变量 → 系统常见安装目录 → `python` / `py` 命令」顺序自动探测

## 安全与隐私

- 全部运行于本机；唯一外部网络请求为调用微软 edge-tts 在线语音合成服务
- 不收集、不上传对话内容；播报历史只存本地
- 代理地址、Python 路径等均在面板内按本机需要填写，不写入代码仓库

## 许可

MIT

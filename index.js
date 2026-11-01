import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VOICE_CATALOG, GROUP_LABELS, RECOMMENDED, PARAM_SPEC } from './lib/voices.js'

/** 允许按会话独立保存的配置字段 */
const SID_CFG_FIELDS = ['voice', 'rate', 'pitch', 'volume', 'mode', 'keywords', 'filterWords', 'filterMode', 'filterReplaceWith']

const HERE = dirname(fileURLToPath(import.meta.url))
const TTS_SCRIPT = join(HERE, 'scripts', 'tts.py')

/** 状态与设置的落盘位置（与 DSH_HOME 同盘，重启保留） */
function stateHome() {
  const fromEnv = process.env.HOME || process.env.USERPROFILE
  const base = typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv : homedir()
  return join(base, '.dsh')
}
const STATE_PATH = (() => {
  try {
    const dir = stateHome()
    mkdirSync(dir, { recursive: true })
    return join(dir, 'voice-horn.json')
  } catch {
    return join(HERE, 'voice-horn.json')
  }
})()

const DEFAULT_SETTINGS = {
  provider: 'edge', // edge | cosyvoice（预留本地音色克隆）
  voice: 'zh-CN-XiaoyiNeural',
  rate: '+5%',
  volume: '+8%',
  pitch: '+2Hz',
  proxy: '',
  python: '',
  cloneCmd: [],
  sample: '',
  maxSpeakChars: 170,
  // ---- P0 新增 ----
  favorites: [], // 收藏音色 id 数组，界面置顶
  mode: 'summary', // summary=摘要 | full=全文 | manual=手动 | keyword=关键词触发
  keywords: [], // keyword 模式下触发的关键词
  filterWords: [], // 自定义过滤词
  filterMode: 'skip', // skip=静默跳过 | replace=替换
  filterReplaceWith: '……',
  // ---- P2 看板娘联动 ----
  linkage: true, // 总开关：是否向桌面宠物发事件
  linkageBubble: true, // 播报时显示气泡文字
  linkageAnim: true, // 播报触发角色动画
  // ---- P1 新增 ----
  hotkey: 'Space', // 打断快捷键（默认空格，可在面板自定义）
  hotkeyEnabled: true,
  hotkeyModifier: 'Shift', // Space 需要组合修饰键才不误触输入框：Shift+Space
  historyEnabled: true,
  historyLimit: 100, // 最多存 100 条，超出淘汰最早的
}

function loadState() {
  let raw = null
  try { raw = JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { /* fresh */ }
  return {
    enabled: raw && raw.enabled && typeof raw.enabled === 'object' ? raw.enabled : {},
    // perSession: { [sessionId]: { voice, rate, pitch, volume, mode } } —— 会话独立配置
    perSession: raw && raw.perSession && typeof raw.perSession === 'object' ? raw.perSession : {},
    favorites: Array.isArray(raw && raw.favorites) ? raw.favorites : [],
    history: Array.isArray(raw && raw.history) ? raw.history : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw && raw.settings && typeof raw.settings === 'object' ? raw.settings : {}) },
  }
}

/** 取某会话的有效语音配置：会话覆盖 > 全局默认 */
function effectiveSettings(state, sid) {
  const base = state.settings
  const per = (sid && state.perSession && state.perSession[sid]) || {}
  return {
    ...base,
    voice: per.voice || base.voice,
    rate: per.rate || base.rate,
    pitch: per.pitch || base.pitch,
    volume: per.volume || base.volume,
    mode: per.mode || base.mode,
    favorites: state.favorites && state.favorites.length ? state.favorites : base.favorites,
  }
}
function saveState(state) {
  try {
    const clean = {
      enabled: state.enabled || {},
      perSession: state.perSession || {},
      favorites: Array.isArray(state.favorites) ? state.favorites : [],
      history: Array.isArray(state.history) ? state.history.slice(-200) : [],
      settings: state.settings || {},
    }
    writeFileSync(STATE_PATH, JSON.stringify(clean, null, 2))
  } catch { /* best effort */ }
}

const log = (ctx, level, msg) => { try { ctx.logger?.[level]?.('[dsh-voice-horn] ' + msg) } catch { /* noop */ } }

// ---------------------------------------------------------------- 摘要提取
function messageText(data) {
  const content = data && data.message && data.message.content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** 把回复正文变成适合念的摘要：去代码/围栏/链接/表格，截到句子边界。 */
export function summarize(text, maxChars, opts) {
  if (!text) return ''
  let t = String(text)
  t = t.replace(/```[\s\S]*?(```|$)/g, ' ') // 代码块（未闭合时吞到文末）
  t = t.replace(/`[^`\n]*`/g, ' ') // 行内代码
  t = t.replace(/https?:\/\/\S+/g, ' ') // 链接
  t = t.replace(/^\s*[-+*]\s+/gm, '') // 列表符
  t = t.replace(/^\s*#{1,6}\s+/gm, '') // 标题符
  t = t.replace(/\*\*?|__|~~/g, '') // 强调符
  t = t.replace(/^\s*\|.*$/gm, ' ') // 表格行
  t = t.replace(/^\s*>+\s?/gm, '') // 引用符
  t = t.replace(/([ \t\u3000]+)\n/g, '$1') // 段内软换行不念出来
  t = t.replace(/[ \t\u3000]+/g, ' ').replace(/\n{2,}/g, '\n').replace(/\n/g, '，')
  t = t.replace(/([。，！？；：、])(?=[。，！？；：、])/g, '') // 标点粘连只留一个
  t = t.replace(/^[，。；：、\s]+/, '')
  // ---- 增强过滤：emoji / 数学公式 / 自定义过滤词 ----
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, ' ')
  t = t.replace(/\$\$[\s\S]*?\$\$/g, ' ')
  t = t.replace(/\$[^$\n]{1,200}\$/g, ' ')
  if (opts && Array.isArray(opts.filterWords) && opts.filterWords.length) {
    const mode = opts.filterMode || 'skip'
    const repl = typeof opts.filterReplaceWith === 'string' ? opts.filterReplaceWith : '……'
    for (const raw of opts.filterWords) {
      const w = String(raw || '').trim()
      if (!w || w.length > 60) continue
      const safe = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      t = t.replace(new RegExp(safe, 'gi'), mode === 'replace' ? repl : ' ')
    }
  }
  t = t.replace(/[ \t\u3000]+/g, ' ').replace(/\s{2,}/g, ' ')
  t = t.trim()
  if (!t) return ''
  if (t.length <= maxChars) return t
  const cut = t.slice(0, maxChars)
  // 回退到最后一个句子边界
  const m = Math.max(
    cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'),
    cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'),
    cut.lastIndexOf('，'), cut.lastIndexOf('；'), cut.lastIndexOf('\n'),
  )
  return (m >= 40 ? cut.slice(0, m + 1) : cut + '……').trim()
}

// ---------------------------------------------------------------- python 定位与探针
function pythonCandidates() {
  const s = loadState().settings
  const list = []
  if (s.python) list.push(s.python)
  if (process.env.VH_PYTHON) list.push(process.env.VH_PYTHON)
  // 常见 Windows 安装位置（按系统环境变量动态拼接，不绑定任何本机盘符）
  const pf = process.env['ProgramFiles']
  const pf86 = process.env['ProgramFiles(x86)']
  const localApp = process.env['LOCALAPPDATA']
  if (pf) list.push(join(pf, 'Python311', 'python.exe'), join(pf, 'Python312', 'python.exe'), join(pf, 'Python313', 'python.exe'))
  if (pf86) list.push(join(pf86, 'Python311', 'python.exe'), join(pf86, 'Python312', 'python.exe'))
  if (localApp) list.push(join(localApp, 'Programs', 'Python', 'Python311', 'python.exe'), join(localApp, 'Programs', 'Python', 'Python312', 'python.exe'), join(localApp, 'Programs', 'Python', 'Python313', 'python.exe'))
  list.push('python')
  list.push('py')
  return list
}

let pythonProbe = null // {exe, edgeOk, at}
async function resolvePython() {
  const now = Date.now()
  if (pythonProbe && now - pythonProbe.at < 60000) return pythonProbe
  for (const exe of pythonCandidates()) {
    if (!exe) continue
    if (exe !== 'python' && exe !== 'py' && !existsSync(exe)) continue
    try {
      const edgeOk = await new Promise((resolve) => {
        const child = spawn(exe, ['-c', 'import edge_tts'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
        const timer = setTimeout(() => { try { child.kill() } catch { /* noop */ } resolve(false) }, 12000)
        child.on('error', () => { clearTimeout(timer); resolve(false) })
        child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
      })
      pythonProbe = { exe, edgeOk, at: now }
      return pythonProbe
    } catch { /* next candidate */ }
  }
  pythonProbe = { exe: '', edgeOk: false, at: now }
  return pythonProbe
}

// ---------------------------------------------------------------- 看板娘联动事件队列（P2）
// 服务端只记录事件，客户端轮询后按开关决定是否 window.postMessage 给桌面宠物。
// 一段语音只产生 1 个 start + 1 个 end（或 stop），天然防抖，不流式刷屏。
let voiceEvents = [] // [{seq, sessionId, type:'start'|'end'|'stop', text, voice, rate, pitch, volume, at}]
let voiceEventSeq = 0
const VOICE_EVENT_MAX = 50

/** 记录一条联动事件 */
function pushVoiceEvent(sid, type, payload) {
  try {
    voiceEventSeq += 1
    voiceEvents.push({
      seq: voiceEventSeq,
      sessionId: String(sid || ''),
      type,
      at: Date.now(),
      ...(payload || {}),
    })
    if (voiceEvents.length > VOICE_EVENT_MAX) {
      voiceEvents = voiceEvents.slice(-VOICE_EVENT_MAX)
    }
  } catch { /* best effort */ }
}

// ---------------------------------------------------------------- P1 播报打断 / 防重叠
// 打断 = 杀掉当前 python 子进程（进程死亡时 Windows 自动释放其 MCI 音频资源）。
// speakToken 用于让排队中的旧任务自动失效，避免打断后又冒出残留播报。
let currentChild = null
let speakToken = 0
let interrupting = false

/** 终止当前正在播放的子进程；返回是否真的终止了什么 */
function killCurrentChild() {
  const child = currentChild
  currentChild = null
  if (!child) return false
  try {
    child.kill('SIGTERM')
  } catch { /* 已退出 */ }
  // Windows 下 SIGTERM 可能无效，补一刀
  try {
    setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, 800)
  } catch { /* noop */ }
  return true
}

/** 主动打断：杀子进程 + 作废旧 token + 通知联动事件 */
function interruptSpeak(ctx, sid, reason) {
  interrupting = true
  speakToken += 1
  const killed = killCurrentChild()
  const target = sid || lastActiveSession || ''
  for (const k of Array.from(activeSpeak.keys())) activeSpeak.delete(k)
  pushVoiceEvent(target, 'stop', { reason: reason || 'manual' })
  try { log(ctx, 'info', 'speak interrupted (' + (reason || 'manual') + '), killed=' + killed) } catch { /* noop */ }
  return { killed, sessionId: target, token: speakToken }
}

// ---------------------------------------------------------------- 播报队列（串行，一次一句）
let queue = Promise.resolve()
const activeSpeak = new Map() // sessionId -> 引用计数（同会话可排队多条）

function runTts(text, settings, timeoutMs) {
  return new Promise((resolve) => {
    resolvePython().then((py) => {
      if (!py.exe) { resolve({ ok: false, error: '未找到本机 Python（可在 voice-horn.json 的 settings.python 指定路径）' }); return }
      if (settings.provider === 'edge' && !py.edgeOk) { resolve({ ok: false, error: 'edge-tts 未安装：python -m pip install edge-tts' }); return }
      const args = [TTS_SCRIPT, '--text', text, '--provider', settings.provider, '--voice', settings.voice,
        '--rate', settings.rate, '--volume', settings.volume, '--timeout', String(Math.round(timeoutMs / 1000))]
      if (settings.provider === 'edge') {
        if (settings.pitch) args.push('--pitch', settings.pitch)
        if (settings.proxy) args.push('--proxy', settings.proxy)
      } else {
        if (settings.sample) args.push('--sample', settings.sample)
        if (Array.isArray(settings.cloneCmd) && settings.cloneCmd.length) args.push('--clone-cmd', ...settings.cloneCmd)
      }
      const child = spawn(py.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      currentChild = child
      let stdout = ''
      let stderr = ''
      const killer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, timeoutMs + 5000)
      child.stdout.on('data', (d) => { stdout += String(d) })
      child.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-4000) })
      child.on('error', (e) => {
        clearTimeout(killer)
        if (currentChild === child) currentChild = null
        resolve({ ok: false, error: 'spawn: ' + (e?.message || e) })
      })
      child.on('exit', (code) => {
        clearTimeout(killer)
        if (currentChild === child) currentChild = null
        let parsed = null
        try { parsed = JSON.parse(stdout.trim().split('\n').pop() || 'null') } catch { /* fallthrough */ }
        if (parsed && typeof parsed === 'object') resolve(parsed)
        else resolve({ ok: code === 0, error: code === 0 ? '' : 'exit ' + code + (stderr ? ': ' + stderr.slice(-200) : '') })
      })
    })
  })
}

function speak(ctx, sid, text) {
  const state = loadState()
  if (!text) return
  const bump = (delta) => {
    const n = (activeSpeak.get(sid) || 0) + delta
    if (n > 0) activeSpeak.set(sid, n)
    else activeSpeak.delete(sid)
  }
  bump(1)
  const cfg = effectiveSettings(state, sid)
  // 防重叠：发起新播报前，若已有语音在播，立刻掐断旧的并发 stop 事件
  const hadActive = activeSpeak.size > 0 && Array.from(activeSpeak.keys()).some((k) => k !== sid)
  if (hadActive || (activeSpeak.get(sid) || 0) > 1) {
    const prevSid = Array.from(activeSpeak.keys()).find((k) => k !== sid) || sid
    if (hadActive) {
      killCurrentChild()
      pushVoiceEvent(prevSid, 'stop', { reason: 'superseded' })
    }
  }
  const myToken = ++speakToken
  queue = queue
    .then(() => {
      // 排队期间被新的打断/新任务作废了 → 直接跳过，不播
      if (myToken !== speakToken) return { ok: true, skipped: true }
      // 播报真正开始这一刻：发 start（看板娘触发说话动画+气泡）
      pushVoiceEvent(sid, 'start', {
        text: String(text || '').slice(0, 300),
        voice: cfg.voice || '',
        rate: cfg.rate || '',
        pitch: cfg.pitch || '',
        volume: cfg.volume || '',
      })
      return runTts(text, cfg, 60000)
    })
    .then((res) => {
      if (res && res.skipped) return // 被作废的排队任务：不发任何事件
      if (!res || res.ok !== true) {
        log(ctx, 'warn', 'speak failed: ' + String(res?.error || res || 'unknown'))
        const entry = sid && lastSpeak.get(sid)
        if (entry) entry.lastError = String(res?.error || 'unknown')
        pushVoiceEvent(sid, 'end', { error: String(res?.error || 'unknown') })
      } else {
        const entry = sid && lastSpeak.get(sid)
        if (entry) entry.lastError = ''
        // 整段播完：发 end（看板娘切回待机）
        pushVoiceEvent(sid, 'end', {})
      }
    })
    .catch((e) => {
      log(ctx, 'error', 'speak queue: ' + String(e))
      pushVoiceEvent(sid, 'end', { error: String(e) })
    })
    .finally(() => { bump(-1) })
}

/**
 * 重播：用指定的音色参数播放给定文本（不写历史、不走摘要、不发 start/end 外的额外事件）
 * 与 speak 共用队列与 token 机制，因此打断同样有效。
 */
function replaySpeak(ctx, sid, text, cfg) {
  if (!text) return
  const bump = (delta) => {
    const n = (activeSpeak.get(sid) || 0) + delta
    if (n > 0) activeSpeak.set(sid, n)
    else activeSpeak.delete(sid)
  }
  bump(1)
  const myToken = ++speakToken
  queue = queue
    .then(() => {
      if (myToken !== speakToken) return { ok: true, skipped: true }
      pushVoiceEvent(sid, 'start', {
        text: String(text).slice(0, 300),
        voice: cfg.voice || '',
        rate: cfg.rate || '',
        pitch: cfg.pitch || '',
        volume: cfg.volume || '',
      })
      return runTts(text, cfg, 60000)
    })
    .then((res) => {
      if (res && res.skipped) return
      pushVoiceEvent(sid, 'end', { error: (!res || res.ok !== true) ? String(res && res.error || 'unknown') : '' })
    })
    .catch((e) => {
      log(ctx, 'error', 'replay queue: ' + String(e))
      pushVoiceEvent(sid, 'end', { error: String(e) })
    })
    .finally(() => { bump(-1) })
}

/** 播报历史：追加并按上限截断（带完整音色参数，便于原参重播） */
function pushHistory(state, entry) {
  try {
    if (!Array.isArray(state.history)) state.history = []
    state.history.push({
      id: 'h' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      at: Date.now(),
      sessionId: String(entry.sid || ''),
      text: String(entry.text || '').slice(0, 2000),
      voice: String(entry.voice || ''),
      rate: String(entry.rate || ''),
      pitch: String(entry.pitch || ''),
      volume: String(entry.volume || ''),
      mode: String(entry.mode || 'summary'),
    })
    const lim = Number(state.settings && state.settings.historyLimit) || 100
    if (state.history.length > lim) state.history = state.history.slice(-lim)
    saveState(state)
  } catch { /* best effort */ }
}


/** 试听专用：直接起 tts_fast.py，不经过摘要/队列/会话逻辑 */
function runFastPreview(exe, text, voice) {
  return new Promise((resolve, reject) => {
    const fast = join(HERE, 'scripts', 'tts_fast.py')
    const child = spawn(exe, [fast, text, voice], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const killer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, 45000)
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('error', (e) => { clearTimeout(killer); reject(e) })
    child.on('exit', () => {
      clearTimeout(killer)
      try { resolve(JSON.parse(out.trim().split('\n').pop() || '{}')) } catch (e) { reject(e) }
    })
  })
}

// 每会话回合文本
const turnBuffer = new Map() // sessionId -> string
const lastSpeak = new Map() // sessionId -> { lastError }
// 最近活跃会话：前端拿不到 sessionId 时的兜底来源
let lastActiveSession = ''

function sessionKey(session) {
  try { return String(session?.id || session?.header?.id || '') } catch { return '' }
}
function isSubagent(session) {
  try { return session?.header?.origin === 'subagent' } catch { return false }
}

function makeHandler(ctx) {
  async function readBody(req) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    raw = raw.slice(0, 64 * 1024)
    try { return JSON.parse(raw || '{}') } catch { return null }
  }
  const json = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(obj))
    } catch { /* 已断线 */ }
  }

  return async function handle(req, res) {
    try {
      const full = String(req.url || '').split('?')[0]
      const path = (full.replace(/^\/api\/dsh-voice-horn/, '') || '/').toLowerCase()
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method' }); return }
      const body = await readBody(req)
      if (body === null) { json(res, 400, { ok: false, error: 'bad-json' }); return }
      const state = loadState()
      const sid = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 128) : ''

      if (path === '/voices') {
        // 音色库：全量中文音色 + 分组 + 收藏标记
        const favs = Array.isArray(state.favorites) ? state.favorites : []
        json(res, 200, {
          ok: true,
          voices: VOICE_CATALOG.map((v) => ({ ...v, favorite: favs.includes(v.id) })),
          groups: GROUP_LABELS,
          favorites: favs,
          recommended: RECOMMENDED,
          paramSpec: PARAM_SPEC,
          current: effectiveSettings(state, sid || lastActiveSession),
        })
        return
      }
      if (path === '/favorite') {
        const vid = typeof body.voice === 'string' ? body.voice : ''
        if (!vid) { json(res, 200, { ok: false, error: 'no-voice' }); return }
        if (!Array.isArray(state.favorites)) state.favorites = []
        const on = body.favorite !== false
        const has = state.favorites.includes(vid)
        if (on && !has) state.favorites.push(vid)
        else if (!on && has) state.favorites = state.favorites.filter((x) => x !== vid)
        saveState(state)
        json(res, 200, { ok: true, favorites: state.favorites })
        return
      }
      if (path === '/session-config') {
        const eff = sid || lastActiveSession
        if (!eff) { json(res, 200, { ok: false, error: 'no-session' }); return }
        if (SID_CFG_FIELDS.some((f) => body[f] !== undefined)) {
          // 写入会话独立配置
          if (!state.perSession) state.perSession = {}
          const cur = state.perSession[eff] || {}
          for (const f of SID_CFG_FIELDS) {
            if (body[f] === undefined) continue
            if (f === 'voice' && typeof body[f] === 'string') cur[f] = body[f]
            else if (typeof body[f] === 'string') cur[f] = body[f]
            else if (typeof body[f] === 'number') cur[f] = body[f]
            else if (Array.isArray(body[f])) cur[f] = body[f]
          }
          state.perSession[eff] = cur
          // 防膨胀
          const ks = Object.keys(state.perSession)
          if (ks.length > 300) {
            for (const k of ks.slice(0, ks.length - 300)) delete state.perSession[k]
          }
          saveState(state)
        }
        json(res, 200, { ok: true, sessionId: eff, settings: effectiveSettings(state, eff) })
        return
      }
      if (path === '/history') {
        const list = Array.isArray(state.history) ? state.history : []
        json(res, 200, { ok: true, history: body.clear === true ? [] : list.slice(-80) })
        if (body.clear === true) { state.history = []; saveState(state) }
        return
      }
      if (path === '/linkage-get') {
        json(res, 200, {
          ok: true,
          linkage: {
            enabled: state.settings.linkage !== false,
            bubble: state.settings.linkageBubble !== false,
            anim: state.settings.linkageAnim !== false,
          },
        })
        return
      }
      if (path === '/linkage-set') {
        if (body.enabled !== undefined) state.settings.linkage = body.enabled === true
        if (body.bubble !== undefined) state.settings.linkageBubble = body.bubble === true
        if (body.anim !== undefined) state.settings.linkageAnim = body.anim === true
        saveState(state)
        json(res, 200, {
          ok: true,
          linkage: {
            enabled: state.settings.linkage !== false,
            bubble: state.settings.linkageBubble !== false,
            anim: state.settings.linkageAnim !== false,
          },
        })
        return
      }
      if (path === '/interrupt') {
        // 打断当前播报：杀子进程 + 作废 token + 发 stop 事件给看板娘
        const r = interruptSpeak(ctx, sid || lastActiveSession, (typeof body.reason === 'string' && body.reason) || 'manual')
        json(res, 200, { ok: true, ...r })
        return
      }
      if (path === '/history-list') {
        const all = Array.isArray(state.history) ? state.history : []
        const onlySid = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : ''
        const filtered = onlySid ? all.filter((h) => h.sessionId === onlySid) : all
        json(res, 200, {
          ok: true,
          history: filtered.slice().reverse(), // 最新在前
          total: all.length,
          enabled: state.settings.historyEnabled !== false,
          limit: Number(state.settings.historyLimit) || 100,
        })
        return
      }
      if (path === '/history-replay') {
        const id = typeof body.id === 'string' ? body.id : ''
        const all = Array.isArray(state.history) ? state.history : []
        const rec = all.find((h) => h.id === id)
        if (!rec) { json(res, 200, { ok: false, error: 'not-found' }); return }
        // 用历史记录当时的音色参数重播，不读当前面板参数
        const replayCfg = {
          ...effectiveSettings(state, rec.sessionId),
          voice: rec.voice || state.settings.voice,
          rate: rec.rate || state.settings.rate,
          pitch: rec.pitch || state.settings.pitch,
          volume: rec.volume || state.settings.volume,
        }
        if (!lastSpeak.has(rec.sessionId)) lastSpeak.set(rec.sessionId, { lastError: '' })
        replaySpeak(ctx, rec.sessionId, rec.text, replayCfg)
        json(res, 200, { ok: true, playing: true })
        return
      }
      if (path === '/history-delete') {
        const id = typeof body.id === 'string' ? body.id : ''
        if (body.clear === true) {
          state.history = []
        } else if (id) {
          state.history = (Array.isArray(state.history) ? state.history : []).filter((h) => h.id !== id)
        } else {
          json(res, 200, { ok: false, error: 'no-target' }); return
        }
        saveState(state)
        json(res, 200, { ok: true, total: (state.history || []).length })
        return
      }
      if (path === '/hotkey-set') {
        if (typeof body.hotkey === 'string') state.settings.hotkey = body.hotkey.slice(0, 40)
        if (body.enabled !== undefined) state.settings.hotkeyEnabled = body.enabled === true
        saveState(state)
        json(res, 200, { ok: true, hotkey: state.settings.hotkey, enabled: state.settings.hotkeyEnabled !== false })
        return
      }
      if (path === '/state') {
        // 前端可能拿不到 sessionId（GUI 是端口形式 URL，无会话段）→ 用最近活跃会话兜底
        const eff = sid || lastActiveSession
        // 联动事件：只回 seq > 客户端上次所见 的增量
        const sinceSeq = Number(body.sinceSeq) || 0
        const fresh = voiceEvents
          .filter((e) => e.seq > sinceSeq)
          .map((e) => ({ seq: e.seq, sessionId: e.sessionId, type: e.type, text: e.text, voice: e.voice, rate: e.rate, pitch: e.pitch, volume: e.volume, at: e.at, error: e.error }))
        json(res, 200, {
          ok: true,
          sessionId: eff,
          fallback: !sid && Boolean(lastActiveSession),
          enabled: Boolean(eff && state.enabled[eff]),
          speaking: activeSpeak.has(eff),
          lastError: (lastSpeak.get(eff) && lastSpeak.get(eff).lastError) || '',
          events: fresh,
          eventSeq: voiceEventSeq,
        })
        return
      }
      if (path === '/enable') {
        const on = body.enabled === true
        const eff = sid || lastActiveSession
        if (!eff) { json(res, 200, { ok: false, error: 'no-session' }); return }
        if (on) {
          const py = await resolvePython()
          if (!py.exe || (state.settings.provider === 'edge' && !py.edgeOk)) {
            json(res, 200, { ok: false, error: py.exe ? 'edge-tts 未安装：python -m pip install edge-tts' : '未找到本机 Python' })
            return
          }
        }
        if (on) state.enabled[eff] = true
        else delete state.enabled[eff]
        // 缓存防膨胀：会话开关记录只留最近 500 个
        const keys = Object.keys(state.enabled)
        if (keys.length > 500) {
          for (const k of keys.slice(0, keys.length - 500)) delete state.enabled[k]
        }
        saveState(state)
        if (on && !lastSpeak.has(eff)) lastSpeak.set(eff, { lastError: '' })
        if (on) speak(ctx, eff, '哼，语音播报打开了。才、才不是想让你听本鱼的声音呢……回复念摘要就好了啦。')
        json(res, 200, { ok: true, enabled: on, sessionId: eff })
        return
      }
      if (path === '/toggle') {
        // 最小接口：读状态 → 取反 → 写状态，不做任何 TTS 动作
        const eff = (typeof body.sessionId === 'string' && body.sessionId) || lastActiveSession
        if (!eff) { json(res, 200, { ok: false, error: 'no-session', sessionId: '' }); return }
        const cur = Boolean(state.enabled[eff])
        const next = cur === false
        if (next) state.enabled[eff] = true
        else delete state.enabled[eff]
        saveState(state)
        json(res, 200, { ok: true, sessionId: eff, enabled: next, wasEnabled: cur })
        return
      }
      if (path === '/config') {
        const allowed = ['provider', 'voice', 'rate', 'volume', 'pitch', 'proxy', 'python', 'cloneCmd', 'sample', 'maxSpeakChars']
        for (const key of allowed) if (body[key] !== undefined) state.settings[key] = body[key]
        saveState(state)
        pythonProbe = null
        json(res, 200, { ok: true, settings: state.settings })
        return
      }
      if (path === '/preview') {
        // 轻量试听通道：只传 text+voice，跳过摘要提取/会话校验/heartbeat 那一套
        const py = await resolvePython()
        if (!py.exe) { json(res, 200, { ok: false, error: 'no-python' }); return }
        if (!py.edgeOk) { json(res, 200, { ok: false, error: 'edge-tts 未安装' }); return }
        const text = (typeof body.text === 'string' ? body.text : '').slice(0, 500) || '试听一下，本鱼的声音。'
        const voice = (typeof body.voice === 'string' && body.voice) || loadState().settings.voice
        const t0 = Date.now()
        runFastPreview(py.exe, text, voice).then((out) => {
          json(res, 200, { ok: true, elapsedMs: Date.now() - t0, result: out })
        }).catch((e) => {
          json(res, 200, { ok: false, error: String(e && e.message || e) })
        })
        return
      }
      if (path === '/test') {
        const py = await resolvePython()
        if (!py.exe || (state.settings.provider === 'edge' && !py.edgeOk)) {
          json(res, 200, { ok: false, error: py.exe ? 'edge-tts 未安装' : '未找到 Python' })
          return
        }
        if (!lastSpeak.has(sid || '_test')) lastSpeak.set(sid || '_test', { lastError: '' })
        speak(ctx, sid || '_test', summarize(typeof body.text === 'string' ? body.text : '测试一下，本鱼的嗓子和音响都通啦，嘿嘿。', 200))
        json(res, 200, { ok: true, speaking: true })
        return
      }
      json(res, 404, { ok: false, error: 'not-found' })
    } catch (e) {
      json(res, 500, { ok: false, error: String(e?.message || e) })
    }
  }
}

export const name = 'dsh-voice-horn'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const st = loadState()
  // 设置优先级：插件 config 行 > voice-horn.json 里用户/接口改过的 > 默认值
  const merged = { ...DEFAULT_SETTINGS, ...(st.settings || {}), ...(config && typeof config === 'object' ? config : {}) }
  st.settings = merged
  saveState(st)

  const handler = makeHandler(ctx)
  let registered = false
  let attempts = 0
  const tryRegister = () => {
    if (registered) return
    attempts += 1
    let ws
    try { ws = ctx.get?.('webServer') ?? ctx.webServer } catch { ws = undefined }
    if (ws && typeof ws.register === 'function') {
      try {
        const dispose = ws.register({ kind: 'prefix', path: '/api/dsh-voice-horn', handler })
        registered = true
        log(ctx, 'info', 'routes registered at /api/dsh-voice-horn/* (attempt ' + attempts + ')')
        if (typeof dispose === 'function') ctx.effect?.(() => dispose)
      } catch (e) {
        log(ctx, 'error', 'route registration failed: ' + String(e?.message || e))
      }
    }
    if (!registered && attempts < 20) setTimeout(tryRegister, 1000)
    else if (!registered) log(ctx, 'warn', 'webServer 未就绪，路由未注册')
  }
  tryRegister()

  // 回合文本积累 + 结束后播报
  ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event.type !== 'string') return
      const sid = sessionKey(session)
      if (!sid || isSubagent(session)) return
      lastActiveSession = sid // 记录最近活跃会话，供前端兜底
      if (event.type === 'user/message') {
        const source = event.data && event.data.source
        if (!source || source.kind === 'user') turnBuffer.set(sid, '') // 真人发言（含转向注入）开新回合
        return
      }
      if (event.type === 'assistant/message') {
        const prev = turnBuffer.get(sid) || ''
        turnBuffer.set(sid, (prev + '\n' + messageText(event.data)).slice(-16000))
        return
      }
      if (event.type === 'turn/end') {
        const text = turnBuffer.get(sid) || ''
        turnBuffer.delete(sid)
        const state = loadState()
        if (!state.enabled[sid]) return
        const eff = effectiveSettings(state, sid)
        const mode = eff.mode || 'summary'
        if (mode === 'manual') return
        if (mode === 'keyword') {
          const kws = Array.isArray(eff.keywords) ? eff.keywords : []
          if (!kws.length) return
          const hit = kws.some((k) => k && String(k).length && text.includes(String(k)))
          if (!hit) return
        }
        const maxChars = mode === 'full' ? 6000 : (Number(eff.maxSpeakChars) || DEFAULT_SETTINGS.maxSpeakChars)
        const summary = summarize(text, maxChars, {
          filterWords: eff.filterWords,
          filterMode: eff.filterMode,
          filterReplaceWith: eff.filterReplaceWith,
        })
        if (!summary || summary.length < 4) return
        if (!lastSpeak.has(sid)) lastSpeak.set(sid, { lastError: '' })
        pushHistory(state, {
          sid,
          text: summary.slice(0, 2000),
          voice: eff.voice,
          rate: eff.rate,
          pitch: eff.pitch,
          volume: eff.volume,
          mode,
        })
        speak(ctx, sid, summary)
      }
    } catch (e) {
      log(ctx, 'warn', 'event: ' + String(e?.message || e))
    }
  }, { global: true })

  log(ctx, 'info', 'dsh-voice-horn loaded; state file: ' + STATE_PATH)
}

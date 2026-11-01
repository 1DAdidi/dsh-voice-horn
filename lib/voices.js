// dsh-voice-horn 音色库：全部中文音色 + 分类标签（独立模块，不影响主链路）

export const VOICE_CATALOG = [
  // ---------- 女声 · 大陆普通话 ----------
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: 'female', region: 'cn', tags: ['温柔', '甜糯', '通用'], note: '最自然流畅，日常首选' },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: 'female', region: 'cn', tags: ['软萌', '少女', '傲娇'], note: '偏软偏嫩，适合二次元少女感' },
  // ---------- 男声 · 大陆普通话 ----------
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: 'male', region: 'cn', tags: ['青年', '阳光'], note: '年轻男声，语气轻快' },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: 'male', region: 'cn', tags: ['沉稳', '解说'], note: '低沉，适合旁白' },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: 'male', region: 'cn', tags: ['播音', '新闻'], note: '标准播音腔' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: 'male', region: 'cn', tags: ['少年', '童声'], note: '少年音，偏稚嫩' },
  // ---------- 方言女声 ----------
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北', gender: 'female', region: 'dialect', tags: ['东北话', '爽利'], note: '东北口音，带点辣味' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮', gender: 'female', region: 'dialect', tags: ['陕西话', '中原'], note: '陕西口音' },
  // ---------- 港台 ----------
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳', gender: 'female', region: 'hk', tags: ['粤语', '温柔'], note: '粤语女声' },
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼', gender: 'female', region: 'hk', tags: ['粤语', '成熟'], note: '粤语女声，偏成熟' },
  { id: 'zh-HK-WanLungNeural', name: '雲龍', gender: 'male', region: 'hk', tags: ['粤语', '低沉'], note: '粤语男声' },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻', gender: 'female', region: 'tw', tags: ['台湾腔', '清亮'], note: '台湾女声' },
  { id: 'zh-TW-HsiaoYuNeural', name: '曉雨', gender: 'female', region: 'tw', tags: ['台湾腔', '柔'], note: '台湾女声，偏柔' },
  { id: 'zh-TW-YunJheNeural', name: '雲哲', gender: 'male', region: 'tw', tags: ['台湾腔', '男声'], note: '台湾男声' },
]

export const CATEGORY_LABELS = {
  news: '女声·大陆',
  male: '男声·大陆',
  dialect: '方言',
  hk: '粤语',
  female: '女声·港台',
  tw: '台湾',
}

/** 按「性别+地区」给音色归组，用于界面分类展示 */
export function groupVoices(list) {
  const g = { cn_female: [], cn_male: [], dialect: [], hk: [], tw: [] }
  for (const v of list) {
    if (v.region === 'cn' && v.gender === 'female') g.cn_female.push(v)
    else if (v.region === 'cn' && v.gender === 'male') g.cn_male.push(v)
    else if (v.region === 'dialect') g.dialect.push(v)
    else if (v.region === 'hk') g.hk.push(v)
    else if (v.region === 'tw') g.tw.push(v)
  }
  return g
}

export const GROUP_LABELS = {
  cn_female: '♀ 女声 · 大陆普通话',
  cn_male: '♂ 男声 · 大陆普通话',
  dialect: '🗣 方言',
  hk: '🇭🇰 粤语',
  tw: '🇹🇼 台湾',
}

/** 默认推荐（用户偏好：软乎乎傲娇少女感女声） */
export const RECOMMENDED = ['zh-CN-XiaoyiNeural', 'zh-CN-XiaoxiaoNeural']

/** 参数默认值与范围 */
export const PARAM_SPEC = {
  rate: { min: -50, max: 100, def: 5, unit: '%', label: '语速' },
  pitch: { min: -50, max: 50, def: 2, unit: 'Hz', label: '音调' },
  volume: { min: 0, max: 100, def: 88, unit: '%', label: '音量' },
}

/** 数值 → edge-tts 参数字符串，如 5 → "+5%"、-20 → "-20%"、0 → "+0%" */
export function fmtParam(kind, value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return '+0%'
  const spec = PARAM_SPEC[kind]
  if (!spec) return '+0%'
  const clamped = Math.max(spec.min, Math.min(spec.max, n))
  const sign = clamped >= 0 ? '+' : '-'
  return sign + Math.abs(clamped) + spec.unit
}

/** 已有配置 → 界面数值（" +8% " → 8） */
export function parseParam(str) {
  if (typeof str !== 'string') return 0
  const m = str.match(/(-?\d+)/)
  return m ? Number(m[1]) : 0
}

window.__ModuleLoader__.load({
  id: "dsh-voice-horn",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const COPY = {
      hintOn: "AI 回复完成后，会从音响念给你听（点我关闭）",
      hintOff: "点这里：进入语音喇叭设置",
      fail: "喇叭没出声：",
    };

    const KEY = "dsh-voice-horn";
    const DEFAULT_VOICE = "zh-CN-XiaoyiNeural";

    const INPUT_STYLE = {
      width: "100%",
      padding: "6px 10px",
      borderRadius: "6px",
      border: "1px solid rgba(140,160,200,.4)",
      background: "rgba(10,16,34,.6)",
      color: "inherit",
      fontSize: "12px",
      boxSizing: "border-box",
    };

    const PARAM_DEFS = [
      { key: "rate", label: "语速", min: -50, max: 100 },
      { key: "pitch", label: "音调", min: -50, max: 50 },
      { key: "volume", label: "音量", min: 0, max: 100 },
    ];

    function parseNum(s) {
      const m = String(s || "").match(/(-?\d+)/);
      return m ? Number(m[1]) : 0;
    }

    function fmtNum(k, v) {
      const n = Math.round(Number(v) || 0);
      const unit = k === "pitch" ? "Hz" : "%";
      return (n >= 0 ? "+" : "-") + Math.abs(n) + unit;
    }

    function api(path, body) {
      return fetch("/api/dsh-voice-horn/" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      })
        .then(function (r) { return r.json(); })
        .catch(function () { return { ok: false, error: "network" }; });
    }

    let activeSession = "";

    function looksLikeSid(v) {
      if (typeof v !== "string") return false;
      const s = v.trim().replace(/^["']|["']$/g, "");
      if (s.length < 8 || s.length > 128) return false;
      if (!/^[A-Za-z0-9_-]+$/.test(s)) return false;
      if (/^(true|false|null|undefined|default|session|active|current)$/i.test(s)) return false;
      if (/^\d+$/.test(s)) return false;
      return true;
    }

    function probeSid() {
      if (activeSession && looksLikeSid(activeSession)) return activeSession;
      try {
        if (typeof localStorage !== "undefined") {
          const cand = [];
          for (let i = 0; i < localStorage.length; i += 1) {
            const k = localStorage.key(i);
            if (!k) continue;
            const v = localStorage.getItem(k) || "";
            if (looksLikeSid(v)) {
              cand.push([/session/i.test(k) ? 100 : 50, v.trim().replace(/^["']|["']$/g, "")]);
              continue;
            }
            try {
              const o = JSON.parse(v);
              if (o && typeof o === "object") {
                const keys = ["id", "sessionId", "currentSessionId", "activeSessionId"];
                for (const kk of keys) {
                  if (looksLikeSid(o[kk])) {
                    cand.push([/session/i.test(k) ? 100 : 60, String(o[kk])]);
                    break;
                  }
                }
              }
            } catch (e2) {}
          }
          if (cand.length) {
            cand.sort(function (a, b) { return b[0] - a[0]; });
            return cand[0][1];
          }
        }
      } catch (e3) {}
      try {
        const attrs = ["data-session-id", "data-sessionid", "data-active-session", "data-session"];
        for (const a of attrs) {
          const el = document.querySelector("[" + a + "]");
          if (el) {
            const v = el.getAttribute(a);
            if (looksLikeSid(v)) return v.trim();
          }
        }
      } catch (e4) {}
      return "";
    }

    let hornEl = null;
    let horn = { on: false, speaking: false, lastError: "" };
    let pollTimer = 0;
    let hornRetry = 0;

    function paint() {
      if (!hornEl) return;
      hornEl.textContent = horn.on || horn.speaking ? "🔊" : "🔇";
      hornEl.style.background = horn.speaking
        ? "linear-gradient(135deg,#ffcf6e,#ff9ecb)"
        : horn.on
        ? "linear-gradient(135deg,#7de8ff,#57d8ff)"
        : "rgba(22,30,52,.82)";
      hornEl.style.color = horn.on ? "#04121f" : "#9fb0c9";
      hornEl.style.border = horn.on ? "1px solid rgba(255,255,255,.55)" : "1px solid rgba(140,160,200,.35)";
      hornEl.title = horn.speaking ? "正在念……" : horn.on ? COPY.hintOn : COPY.hintOff;
    }

    function ensureHorn() {
      if (hornEl && document.body && document.body.contains(hornEl)) return hornEl;
      if (typeof document === "undefined" || !document.body) {
        if (hornRetry < 40) {
          hornRetry += 1;
          setTimeout(function () {
            try { ensureHorn(); } catch (e) {}
          }, 100);
        }
        return null;
      }
      hornEl = document.createElement("button");
      hornEl.type = "button";
      hornEl.setAttribute("data-dsh-voice-horn", "");
      hornEl.setAttribute("data-horn-btn", "1");
      hornEl.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:80px",
        "z-index:2147483000",
        "width:42px",
        "height:42px",
        "border-radius:50%",
        "cursor:pointer",
        "font-size:19px",
        "display:flex",
        "align-items:center",
        "justify-content:center",
        "box-shadow:0 4px 18px rgba(0,0,0,.35)",
        "opacity:.9",
        "padding:0",
        "transition:background .25s,transform .15s",
      ].join(";");
      hornEl.addEventListener("mouseenter", function () { hornEl.style.opacity = "1"; });
      hornEl.addEventListener("mouseleave", function () { hornEl.style.opacity = ".9"; });
      try {
        document.body.appendChild(hornEl);
      } catch (e) {
        hornEl = null;
        return null;
      }
      paint();
      return hornEl;
    }

    function stopPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = 0;
      }
    }

    function startPollingIfNeeded() {
      if (pollTimer) return;
      pollTimer = setInterval(function () {
        if (!activeSession || (!horn.on && !horn.speaking)) {
          stopPolling();
          return;
        }
        api("state", { sessionId: activeSession, sinceSeq: linkageSeq }).then(function (res) {
          if (!res || !res.ok || activeSession !== res.sessionId) return;
          const wasSpeaking = horn.speaking;
          horn = { on: Boolean(res.enabled), speaking: Boolean(res.speaking), lastError: res.lastError || "" };
          paint();
          if (wasSpeaking && !horn.speaking && horn.lastError) cornerNote(COPY.fail + horn.lastError);
          // 联动事件
          if (typeof res.eventSeq === "number") {
            const evs = Array.isArray(res.events) ? res.events : [];
            for (const ev of evs) handleLinkageEvent(ev);
            const maxSeq = evs.reduce(function (m, e) { return Math.max(m, Number(e.seq) || 0); }, 0);
            if (maxSeq > linkageSeq) linkageSeq = maxSeq;
            if (res.eventSeq > linkageSeq) linkageSeq = res.eventSeq;
          }
          if (!horn.speaking && !horn.on) stopPolling();
        });
      }, 2500);
    }

    // ---------------------------------------------------------- P2 看板娘联动
    // 独立事件泵：轮询 /state 取增量事件，按开关决定是否 postMessage 给桌面宠物。
    // 与播报主逻辑完全解耦——关掉联动只停这个泵，播报/音色/滑块/过滤全部不受影响。
    const LINKAGE = { enabled: true, bubble: true, anim: true };
    // 桌宠 id：dsh-pet 的默认宠物为 "main"（可在面板后续开放自定义）
    let PET_ID = "main";
    let linkageSeq = 0;
    let linkageTimer = 0;

    /**
     * 把事件派发给桌面宠物。
     * Electron 下各插件是独立窗口，postMessage 跨窗口不通 → 主通道改用
     * dsh-pet 官方 HTTP 接口 POST /dsh-pet-7340/broadcast（写气泡 + anim 控制动画），
     * postMessage 仅作同窗口场景的兜底。
     */
    function emitToPet(name, payload) {
      const data = payload || {};
      try {
        console.log("[voice-horn] emitToPet:", name, JSON.stringify(data).slice(0, 400));
      } catch (e0) {}

      if (name === "voice_horn:start") {
        const text = data.text || "";
        if (text) {
          fetch("/dsh-pet-7340/broadcast?pet=" + encodeURIComponent(PET_ID) + "&surface=any", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "🎤 " + text, duration: 12000, anim: LINKAGE.anim !== false }),
          })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              try { console.log("[voice-horn] broadcast 响应:", JSON.stringify(res).slice(0, 300)); } catch (e1) {}
            })
            .catch(function (e2) {
              try { console.warn("[voice-horn] broadcast 失败:", e2 && e2.message); } catch (e3) {}
            });
        }
      } else {
        fetch("/dsh-pet-7340/bubble/clear?pet=" + encodeURIComponent(PET_ID) + "&surface=any", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
          .then(function (r) { return r.json(); })
          .then(function (res) {
            try { console.log("[voice-horn] bubble/clear 响应:", JSON.stringify(res).slice(0, 200)); } catch (e4) {}
          })
          .catch(function (e5) {
            try { console.warn("[voice-horn] bubble/clear 失败:", e5 && e5.message); } catch (e6) {}
          });
      }

      try {
        const msg = { type: name, source: "dsh-voice-horn" };
        for (const k in data) msg[k] = data[k];
        window.postMessage(msg, "*");
        try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*"); } catch (e7) {}
        try { if (window.top && window.top !== window) window.top.postMessage(msg, "*"); } catch (e8) {}
      } catch (e9) {
        try { console.warn("[voice-horn] postMessage 失败:", e9 && e9.message); } catch (e10) {}
      }
    }

    /** 处理一条服务端事件，按开关分发 */
    function handleLinkageEvent(ev) {
      if (!LINKAGE.enabled || !ev || !ev.type) return;
      if (ev.type === "start") {
        if (!LINKAGE.anim) return;
        const payload = { sessionId: ev.sessionId || "", voiceName: ev.voice || "", rate: ev.rate || "", pitch: ev.pitch || "", volume: ev.volume || "" };
        if (LINKAGE.bubble) payload.text = ev.text || "";
        emitToPet("voice_horn:start", payload);
      } else if (ev.type === "end") {
        emitToPet("voice_horn:end", { sessionId: ev.sessionId || "" });
      } else if (ev.type === "stop") {
        emitToPet("voice_horn:stop", { sessionId: ev.sessionId || "" });
      }
    }

    /** 轮询增量事件（有播报时才跑，静默运行） */
    function pollLinkage() {
      if (!LINKAGE.enabled) return;
      api("state", { sessionId: probeSid(), sinceSeq: linkageSeq }).then(function (res) {
        if (!res || !res.ok) return;
        if (typeof res.eventSeq === "number") {
          const evs = Array.isArray(res.events) ? res.events : [];
          for (const ev of evs) handleLinkageEvent(ev);
          // 更新游标，避免重复派发
          if (evs.length) {
            const maxSeq = evs.reduce(function (m, e) { return Math.max(m, Number(e.seq) || 0); }, 0);
            if (maxSeq > linkageSeq) linkageSeq = maxSeq;
          }
          if (res.eventSeq > linkageSeq) linkageSeq = res.eventSeq;
        }
      }).catch(function () {});
    }

    function startLinkagePump() {
      if (linkageTimer) return;
      if (!LINKAGE.enabled) return;
      linkageTimer = setInterval(pollLinkage, 1200);
    }

    function stopLinkagePump() {
      if (linkageTimer) {
        clearInterval(linkageTimer);
        linkageTimer = 0;
      }
    }

    /** 读联动配置 */
    function loadLinkageCfg() {
      api("linkage-get", {}).then(function (r) {
        if (r && r.ok && r.linkage) {
          LINKAGE.enabled = Boolean(r.linkage.enabled);
          LINKAGE.bubble = Boolean(r.linkage.bubble);
          LINKAGE.anim = Boolean(r.linkage.anim);
        }
      }).catch(function () {});
    }

    /** 存联动配置 */
    function saveLinkageCfg() {
      api("linkage-set", { enabled: LINKAGE.enabled, bubble: LINKAGE.bubble, anim: LINKAGE.anim }).catch(function () {});
    }

    function refreshState(sid) {
      const useSid = sid || probeSid();
      api("state", { sessionId: useSid, sinceSeq: linkageSeq }).then(function (res) {
        if (!res || !res.ok) return;
        const eff = String(res.sessionId || useSid || "");
        if (eff && !activeSession) activeSession = eff;
        horn = { on: Boolean(res.enabled), speaking: Boolean(res.speaking), lastError: res.lastError || "" };
        paint();
        if (horn.on) startPollingIfNeeded();
        // 联动：处理本次拿到的增量事件
        if (typeof res.eventSeq === "number") {
          const evs = Array.isArray(res.events) ? res.events : [];
          for (const ev of evs) handleLinkageEvent(ev);
          const maxSeq = evs.reduce(function (m, e) { return Math.max(m, Number(e.seq) || 0); }, 0);
          if (maxSeq > linkageSeq) linkageSeq = maxSeq;
          if (res.eventSeq > linkageSeq) linkageSeq = res.eventSeq;
        }
      });
    }

    // ---------------------------------------------------------- P1 打断
    let interrupting = false;

    /** 打断当前播报：调后端 → 杀子进程 → 发 stop 事件 → 清本地状态 */
    function doInterrupt(reason) {
      if (interrupting) return false;
      interrupting = true;
      api("interrupt", { sessionId: probeSid(), reason: reason || "manual" }).then(function (res) {
        interrupting = false;
        if (res && res.ok) {
          horn = { on: horn.on, speaking: false, lastError: "" };
          paint();
          stopPolling();
          if (res.killed) cornerNote("已打断播报");
        }
      }).catch(function () {
        interrupting = false;
      });
      return true;
    }

    /** 悬浮按钮：播报中=打断，空闲=切换开关 */
    function onHornClick() {
      if (horn.speaking) {
        doInterrupt("button");
      } else {
        toggleHorn();
      }
    }

    // ---- 全局快捷键：默认 Shift+Space，可在面板自定义 ----
    let hotkeyCfg = { enabled: true, key: "Space" };

    function loadHotkey() {
      api("hotkey-set", {}) // 传空 body 只读取
        .then(function (r) {
          // 该接口首次调用会原样返回当前值（不写盘也能读）
        }).catch(function () {});
    }

    /** 判断按键是否是配置的快捷键 */
    function isHotkey(ev) {
      if (!hotkeyCfg.enabled) return false;
      const key = hotkeyCfg.key || "Space";
      const pressed = ev.key === key || (key === "Space" && ev.code === "Space") || ev.code === key;
      if (!pressed) return false;
      // Space 单独按会误触输入框，要求带修饰键
      if (key === "Space") return ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey;
      // 其他键允许带 ctrl/alt
      return true;
    }

    function installHotkey() {
      if (window.__DSH_VOICE_HORN_HOTKEY__) return;
      window.__DSH_VOICE_HORN_HOTKEY__ = true;
      document.addEventListener("keydown", function (ev) {
        try {
          if (!isHotkey(ev)) return;
          // 输入框里按也不打断（除非在播报中且确属快捷键组合）
          const tag = (ev.target && ev.target.tagName || "").toUpperCase();
          if (tag === "INPUT" || tag === "TEXTAREA") {
            if (!ev.shiftKey && !ev.ctrlKey && !ev.altKey) return;
          }
          if (!horn.speaking) return; // 没在播就不拦截
          ev.preventDefault();
          doInterrupt("hotkey");
          cornerNote("快捷键已打断播报");
        } catch (e) {}
      }, true);
    }

    let toggling = false;

    function toggleHorn() {
      if (toggling) return;
      toggling = true;
      const sid = probeSid();

      function finish(on, note) {
        toggling = false;
        horn = { on: on, speaking: false, lastError: "" };
        paint();
        if (on) startPollingIfNeeded();
        else stopPolling();
        cornerNote(note);
      }

      api("toggle", { sessionId: sid }).then(function (res) {
        if (res && res.ok === true) {
          finish(Boolean(res.enabled), res.enabled ? "语音播报已开启" : "语音播报已关闭");
          if (res.sessionId && !activeSession) activeSession = String(res.sessionId);
          return;
        }
        const next = !horn.on;
        if (!sid) {
          toggling = false;
          cornerNote("拿不到当前对话编号，先发一条消息再点喇叭。");
          return;
        }
        api("enable", { sessionId: sid, enabled: next }).then(function (res2) {
          if (res2 && res2.ok === true) {
            finish(next, next ? "语音播报已开启" : "语音播报已关闭");
          } else {
            toggling = false;
            cornerNote(COPY.fail + ((res2 && res2.error) || (res && res.error) || "unknown"));
          }
        }).catch(function () {
          toggling = false;
          cornerNote(COPY.fail + "network");
        });
      }).catch(function () {
        toggling = false;
        cornerNote(COPY.fail + "network");
      });
    }

    function cornerNote(msg) {
      let el = document.getElementById("vh-corner-note");
      if (!el) {
        el = document.createElement("div");
        el.id = "vh-corner-note";
        el.style.cssText = "position:fixed;right:14px;bottom:130px;z-index:2147483001;max-width:380px;background:rgba(10,16,34,.94);border:1px solid #57d8ff;border-radius:10px;padding:9px 13px;font-size:12px;color:#cdd9f2;box-shadow:0 6px 24px rgba(0,0,0,.5);white-space:pre-wrap;word-break:break-all;pointer-events:none;opacity:0;transition:opacity .3s";
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.opacity = "1";
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.style.opacity = "0"; }, 6500);
    }

    const ZERO = h("span", { style: { display: "none" } });

    function SessionProbe(props) {
      const sid = props && props.sessionId;
      React.useEffect(function () {
        if (sid && String(sid) !== activeSession) {
          activeSession = String(sid);
          refreshState(activeSession);
        }
      }, [sid]);
      return ZERO;
    }

    function HornPanelIcon(props) {
      const size = (props && props.size) || 16;
      return h("svg", {
        viewBox: "0 0 16 16",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: "1.3",
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
        h("path", { key: "a", d: "M6.2 9.4h1.9l2.6 2V4.6l-2.6 2H6.2z" }),
        h("path", { key: "b", d: "M11.6 6.1a2.4 2.4 0 0 1 0 3.8", opacity: horn.on ? "0.95" : "0.35" }),
        h("path", { key: "c", d: "M13.1 4.4a4.6 4.6 0 0 1 0 7.2", opacity: horn.on ? "0.95" : "0.25" })
      );
    }

    function HornPanelPage() {
      const stSs = React.useState({
        on: false,
        voice: DEFAULT_VOICE,
        rate: 5,
        pitch: 2,
        volume: 88,
        mode: "summary",
        keywords: "",
        filterWords: "",
        filterMode: "skip",
        msg: "",
        tab: "voice",
        linkage: true,
        linkageBubble: true,
        linkageAnim: true,
        history: [],
        historyTotal: 0,
        historyOnlySid: false,
        hotkey: "Space",
        hotkeyEnabled: true,
      });
      const st = stSs[0];
      const setSt = stSs[1];

      const vSs = React.useState([]);
      const voices = vSs[0];
      const setVoices = vSs[1];

      const gSs = React.useState({});
      const groups = gSs[0];
      const setGroups = gSs[1];

      const fSs = React.useState([]);
      const favs = fSs[0];
      const setFavs = fSs[1];

      const lSs = React.useState(true);
      const loading = lSs[0];
      const setLoading = lSs[1];

      function patch(obj) {
        setSt(function (p) {
          const n = {};
          for (const k in p) n[k] = p[k];
          for (const k2 in obj) n[k2] = obj[k2];
          return n;
        });
      }

      function loadAll() {
        api("state", { sessionId: probeSid() }).then(function (s) {
          if (s && s.ok) patch({ on: Boolean(s.enabled) });
        }).catch(function () {});
        api("voices", { sessionId: probeSid() }).then(function (v) {
          if (v && v.ok) {
            setVoices(v.voices || []);
            setGroups(v.groups || {});
            setFavs(v.favorites || []);
            const c = v.current || {};
            patch({
              voice: c.voice || DEFAULT_VOICE,
              rate: parseNum(c.rate),
              pitch: parseNum(c.pitch),
              volume: parseNum(c.volume),
              mode: c.mode || "summary",
              keywords: Array.isArray(c.keywords) ? c.keywords.join("，") : "",
              filterWords: Array.isArray(c.filterWords) ? c.filterWords.join("，") : "",
              filterMode: c.filterMode || "skip",
            });
          }
          setLoading(false);
        }).catch(function () {
          setLoading(false);
        });
      }

      React.useEffect(function () {
        loadAll();
        loadHistory(false);
        api("hotkey-set", {}).then(function (r) {
          if (r && r.ok) {
            patch({ hotkey: r.hotkey || "Space", hotkeyEnabled: r.enabled !== false });
            hotkeyCfg.key = r.hotkey || "Space";
            hotkeyCfg.enabled = r.enabled !== false;
          }
        }).catch(function () {});
        api("linkage-get", {}).then(function (r) {
          if (r && r.ok && r.linkage) {
            patch({
              linkage: Boolean(r.linkage.enabled),
              linkageBubble: Boolean(r.linkage.bubble),
              linkageAnim: Boolean(r.linkage.anim),
            });
          }
        }).catch(function () {});
      }, []);

      function save(key, val) {
        const body = { sessionId: probeSid() };
        body[key] = val;
        api("session-config", body).then(function (r) {
          if (r && r.ok) patch({ msg: "已保存" });
          else patch({ msg: "保存失败：" + ((r && r.error) || "?") });
        }).catch(function () {
          patch({ msg: "网络错误" });
        });
      }

      function doToggle() {
        api("toggle", { sessionId: probeSid() }).then(function (r) {
          if (r && r.ok) {
            patch({ on: Boolean(r.enabled), msg: r.enabled ? "已开启" : "已关闭" });
            horn = { on: Boolean(r.enabled), speaking: false, lastError: "" };
            paint();
            if (r.enabled) startPollingIfNeeded();
            else stopPolling();
          } else {
            patch({ msg: "切换失败" });
          }
        }).catch(function () {
          patch({ msg: "网络错误" });
        });
      }

      function saveLinkage(k, v) {
        const body = {};
        body[k] = v;
        api("linkage-set", body).then(function (r) {
          if (r && r.ok) patch({ msg: "联动设置已保存" });
          else patch({ msg: "保存失败" });
        }).catch(function () { patch({ msg: "网络错误" }); });
      }

      function toggLinkage(k, v) {
        const o = {};
        o[k] = v;
        patch(o);
        saveLinkage(k, v);
        // 同步到客户端的 LINKAGE 常量（API 路径名映射）
        if (k === "linkage") { LINKAGE.enabled = v; if (v) startLinkagePump(); else stopLinkagePump(); }
        else if (k === "linkageBubble") LINKAGE.bubble = v;
        else if (k === "linkageAnim") LINKAGE.anim = v;
      }

      function loadHistory(onlySid) {
        const body = {};
        if (onlySid) body.sessionId = probeSid();
        api("history-list", body).then(function (r) {
          if (r && r.ok) {
            patch({ history: r.history || [], historyTotal: r.total || 0 });
          }
        }).catch(function () {});
      }

      function replayItem(id) {
        api("history-replay", { id: id }).then(function (r) {
          if (r && r.ok) patch({ msg: "正在重播（使用当时的音色参数）" });
          else patch({ msg: "重播失败：" + ((r && r.error) || "?") });
        }).catch(function () { patch({ msg: "网络错误" }); });
      }

      function deleteItem(id) {
        api("history-delete", { id: id }).then(function (r) {
          if (r && r.ok) { patch({ msg: "已删除" }); loadHistory(st.historyOnlySid); }
        }).catch(function () {});
      }

      function clearHistory() {
        api("history-delete", { clear: true }).then(function (r) {
          if (r && r.ok) { patch({ msg: "历史已清空" }); loadHistory(st.historyOnlySid); }
        }).catch(function () {});
      }

      function copyItem(text) {
        try {
          navigator.clipboard.writeText(text).then(function () {
            patch({ msg: "已复制到剪贴板" });
          }).catch(function () { patch({ msg: "复制失败（浏览器限制）" }); });
        } catch (e) { patch({ msg: "复制失败" }); }
      }

      function pickVoice(id) {
        patch({ voice: id, msg: "音色已切换" });
        save("voice", id);
      }

      function toggleFav(id) {
        const isFav = favs.indexOf(id) >= 0;
        api("favorite", { voice: id, favorite: !isFav }).then(function (r) {
          if (r && r.ok) {
            const nf = r.favorites || [];
            setFavs(nf);
            setVoices(voices.map(function (v) {
              const nv = {};
              for (const k in v) nv[k] = v[k];
              nv.favorite = nf.indexOf(v.id) >= 0;
              return nv;
            }));
          }
        }).catch(function () {});
      }

      function doPreview() {
        const t0 = Date.now();
        patch({ msg: "合成中…" });
        api("preview", { text: "哼，这是试听，本鱼的嗓子还不错吧，嘿嘿。", voice: st.voice })
          .then(function (r) {
            const ms = Date.now() - t0;
            if (r && r.ok) {
              patch({ msg: "已播放（" + (r.result && r.result.cached ? "缓存" : "合成") + " " + ms + "ms）" });
            } else {
              patch({ msg: "试听失败：" + ((r && r.error) || "?") });
            }
          }).catch(function () {
            patch({ msg: "网络错误" });
          });
      }

      function btnStyle(active) {
        const base = {
          cursor: "pointer",
          borderRadius: "8px",
          fontSize: "12px",
          padding: "6px 12px",
          color: "inherit",
        };
        if (active) {
          base.border = "1px solid rgba(87,216,255,.6)";
          base.background = "rgba(87,216,255,.22)";
        } else {
          base.border = "1px solid rgba(140,160,200,.45)";
          base.background = "transparent";
        }
        return base;
      }

      function tabBtn(k, label) {
        const s = btnStyle(st.tab === k);
        s.flex = 1;
        return h("button", {
          key: k,
          type: "button",
          onClick: function () { patch({ tab: k }); },
          style: s,
        }, label);
      }

      function voiceBtn(v) {
        const isFav = favs.indexOf(v.id) >= 0;
        return h("button", {
          key: "vb-" + v.id,
          type: "button",
          onClick: function () { pickVoice(v.id); },
          title: v.note || "",
          style: btnStyle(st.voice === v.id),
        }, (isFav ? "* " : "") + v.name);
      }

      function favBtn(v) {
        const isFav = favs.indexOf(v.id) >= 0;
        return h("button", {
          key: "fb-" + v.id,
          type: "button",
          onClick: function () { toggleFav(v.id); },
          title: isFav ? "取消收藏" : "收藏",
          style: {
            cursor: "pointer",
            background: "transparent",
            border: "none",
            fontSize: "13px",
            marginRight: "8px",
            padding: "0 2px",
            color: isFav ? "#ffcf6e" : "rgba(160,175,200,.5)",
          },
        }, isFav ? "★" : "☆");
      }

      function voiceRow(v) {
        return h("span", {
          key: "vr-" + v.id,
          style: { display: "inline-block", whiteSpace: "nowrap" },
        }, voiceBtn(v), favBtn(v));
      }

      function voiceList() {
        const out = [];

        const favVoices = voices.filter(function (v) { return favs.indexOf(v.id) >= 0; });
        if (favVoices.length) {
          out.push(h("div", { key: "favsec", style: { marginBottom: "10px" } },
            h("div", { key: "fh", style: { fontSize: "11px", opacity: .6, marginBottom: "6px" } }, "★ 收藏（置顶）"),
            h("div", { key: "fl" }, favVoices.map(voiceRow))
          ));
        }

        const defs = [
          { k: "cn_female", fn: function (v) { return v.region === "cn" && v.gender === "female"; } },
          { k: "cn_male", fn: function (v) { return v.region === "cn" && v.gender === "male"; } },
          { k: "dialect", fn: function (v) { return v.region === "dialect"; } },
          { k: "hk", fn: function (v) { return v.region === "hk"; } },
          { k: "tw", fn: function (v) { return v.region === "tw"; } },
        ];

        for (const d of defs) {
          const list = voices.filter(d.fn);
          if (!list.length) continue;
          out.push(h("div", { key: "sec-" + d.k, style: { marginBottom: "10px" } },
            h("div", { key: "h-" + d.k, style: { fontSize: "11px", opacity: .6, marginBottom: "6px" } }, groups[d.k] || d.k),
            h("div", { key: "l-" + d.k }, list.map(voiceRow))
          ));
        }
        return out;
      }

      function slider(def) {
        return h("div", { key: "sl-" + def.key, style: { marginBottom: "12px" } },
          h("div", { key: "slh-" + def.key, style: { display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "4px" } },
            h("span", { key: "lb", style: { opacity: .7 } }, def.label),
            h("span", { key: "vl", style: { color: "#7de8ff", fontWeight: 600 } }, fmtNum(def.key, st[def.key])
          )),
          h("input", {
            key: "in-" + def.key,
            type: "range",
            min: def.min,
            max: def.max,
            step: 1,
            value: st[def.key],
            onChange: function (e) {
              const o = {};
              o[def.key] = Number(e.target.value);
              patch(o);
            },
            onMouseUp: function () {
              save(def.key, fmtNum(def.key, st[def.key]));
            },
            style: { width: "100%", accentColor: "#57d8ff", cursor: "pointer" },
          })
        );
      }

      const MODE_OPTS = [
        { k: "summary", t: "摘要" },
        { k: "full", t: "全文" },
        { k: "manual", t: "手动" },
        { k: "keyword", t: "关键词" },
      ];

      function historyPane() {
        const fmtTime = function (t) {
          try {
            const d = new Date(t);
            const pad = function (n) { return (n < 10 ? "0" : "") + n; };
            return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
          } catch (e) { return "?"; }
        };

        const smallBtn = function (label, fn, color) {
          return h("button", {
            key: "sb-" + label,
            type: "button",
            onClick: fn,
            style: {
              cursor: "pointer",
              fontSize: "11px",
              padding: "2px 8px",
              marginRight: "4px",
              borderRadius: "5px",
              border: "1px solid rgba(140,160,200,.4)",
              background: "transparent",
              color: color || "inherit",
            },
          }, label);
        };

        const items = (st.history || []).map(function (rec) {
          const sidShort = String(rec.sessionId || "").slice(-8) || "?";
          const line = h("div", {
            key: "meta-" + rec.id,
            style: { fontSize: "10px", opacity: .55, marginBottom: "3px" },
          }, fmtTime(rec.at) + " · " + sidShort + " · " + (rec.voice || "?") + " · " + (rec.rate || "") + "/" + (rec.pitch || "") + " · " + (rec.mode || "?"));

          const textEl = h("div", {
            key: "txt-" + rec.id,
            style: { fontSize: "12px", lineHeight: 1.5, marginBottom: "5px", wordBreak: "break-all" },
          }, (rec.text || "").slice(0, 160) + ((rec.text || "").length > 160 ? "……" : ""));

          const btns = h("div", { key: "btn-" + rec.id },
            smallBtn("重播", function () { replayItem(rec.id); }, "#7de8ff"),
            smallBtn("复制", function () { copyItem(rec.text || ""); }),
            smallBtn("删除", function () { deleteItem(rec.id); }, "#ff9ecb")
          );

          return h("div", {
            key: "rec-" + rec.id,
            style: { padding: "8px 0", borderBottom: "1px solid rgba(140,160,200,.16)" },
          }, line, textEl, btns);
        });

        const header = h("div", { key: "hh", style: { display: "flex", alignItems: "center", gap: "6px", marginBottom: "8px" } },
          h("span", { key: "cnt", style: { fontSize: "11px", opacity: .6 } }, "共 " + (st.historyTotal || 0) + " 条"),
          h("span", { key: "sp", style: { flex: 1 } }),
          smallBtn(st.historyOnlySid ? "看全部会话" : "只看本对话", function () {
            const next = !st.historyOnlySid;
            patch({ historyOnlySid: next });
            loadHistory(next);
          }),
          smallBtn("清空", clearHistory, "#ff9ecb")
        );

        const list = items.length
          ? h("div", { key: "hl" }, items)
          : h("div", { key: "empty", style: { fontSize: "12px", opacity: .5, padding: "12px 0" } }, "还没有播报记录。开启语音播报后，每次播报都会记在这里。");

        const hotkeyBox = h("div", { key: "hk", style: { marginTop: "12px", paddingTop: "10px", borderTop: "1px solid rgba(140,160,200,.2)" } },
          h("div", { key: "hkb", style: { fontSize: "11px", opacity: .6, marginBottom: "6px" } }, "打断快捷键"),
          h("div", { key: "hkc", style: { display: "flex", alignItems: "center", gap: "6px" } },
            h("input", {
              key: "hki",
              type: "text",
              value: st.hotkey,
              onChange: function (e) { patch({ hotkey: e.target.value }); },
              onBlur: function () {
                const k = st.hotkey.trim() || "Space";
                hotkeyCfg.key = k;
                api("hotkey-set", { hotkey: k }).then(function () { patch({ msg: "快捷键已设为 " + k }); }).catch(function () {});
              },
              style: { width: "90px", padding: "4px 8px", borderRadius: "5px", border: "1px solid rgba(140,160,200,.4)", background: "rgba(10,16,34,.6)", color: "inherit", fontSize: "11px" },
            }),
            smallBtn(st.hotkeyEnabled ? "已启用" : "已禁用", function () {
              const next = !st.hotkeyEnabled;
              patch({ hotkeyEnabled: next });
              hotkeyCfg.enabled = next;
              api("hotkey-set", { enabled: next }).catch(function () {});
            })
          ),
          h("div", { key: "hkt", style: { fontSize: "10px", opacity: .5, marginTop: "4px", lineHeight: 1.5 } },
            "默认 Space，需配合 Shift/Ctrl/Alt 使用（避免误触输入框）。播报中按下立即打断。")
        );

        return h("div", { key: "histSection" }, header, list, hotkeyBox);
      }

      function linkagePane() {
        const row = function (key, label, desc, val) {
          const cb = h("input", {
            key: "cb-" + key,
            type: "checkbox",
            checked: Boolean(val),
            onChange: function (e) { toggLinkage(key, e.target.checked); },
            style: { cursor: "pointer", accentColor: "#57d8ff", width: "16px", height: "16px" },
          });
          return h("div", {
            key: "row-" + key,
            style: { display: "flex", alignItems: "flex-start", gap: "8px", padding: "8px 0", borderBottom: "1px solid rgba(140,160,200,.16)" },
          }, cb, h("div", { key: "txt", style: { flex: 1 } },
            h("div", { key: "l", style: { fontSize: "12px", fontWeight: 600 } }, label),
            h("div", { key: "d", style: { fontSize: "11px", opacity: .6, marginTop: "2px", lineHeight: 1.5 } }, desc)
          ));
        };

        return h("div", { key: "linkageSection" },
          h("div", { key: "lh", style: { fontSize: "11px", opacity: .6, marginBottom: "4px" } }, "桌面看板宠物联动"),
          row("linkage", "启用看板娘联动", "开启后播报时向桌面宠物发送事件（voice_horn:start / end / stop）", st.linkage),
          st.linkage ? row("linkageAnim", "播报触发角色动画", "开始播报→说话动画，播完→待机，打断→惊讶动作", st.linkageAnim) : null,
          st.linkage ? row("linkageBubble", "播报时显示气泡文字", "看板娘气泡同步展示正在朗读的短句", st.linkageBubble) : null,
          h("div", { key: "testbtn", style: { marginTop: "10px" } },
            h("button", {
              key: "tb",
              type: "button",
              onClick: function () {
                emitToPet("voice_horn:start", {
                  sessionId: probeSid(),
                  text: "这是一条联动测试消息，看板娘应该出现气泡",
                  voiceName: "测试音色",
                  rate: "+0%",
                  pitch: "+0Hz",
                  volume: "100%",
                });
                patch({ msg: "已发送测试事件，请看控制台 [voice-horn] 日志与桌宠气泡" });
              },
              style: { cursor: "pointer", padding: "6px 14px", borderRadius: "8px", fontSize: "12px", border: "1px solid rgba(87,216,255,.6)", background: "rgba(87,216,255,.18)", color: "inherit", width: "100%" },
            }, "发送测试联动事件")
          ),
          h("div", { key: "tip", style: { fontSize: "11px", opacity: .5, marginTop: "10px", lineHeight: 1.6 } },
            "通道：主通道走 dsh-pet 的 broadcast HTTP 接口（Electron 跨窗口 postMessage 不通）；postMessage 仅作同窗口兜底。日志前缀 [voice-horn]。")
        );
      }

      function modePane() {
        const modeBtns = MODE_OPTS.map(function (o) {
          return h("button", {
            key: "md-" + o.k,
            type: "button",
            onClick: function () { patch({ mode: o.k }); save("mode", o.k); },
            style: btnStyle(st.mode === o.k),
          }, o.t);
        });

        const kwBox = st.mode === "keyword"
          ? h("div", { key: "kwsection" },
              h("div", { key: "kwl", style: { fontSize: "11px", opacity: .6, marginBottom: "4px" } }, "触发关键词（逗号分隔）"),
              h("input", {
                key: "kwi",
                type: "text",
                value: st.keywords,
                placeholder: "例如：报错，紧急，注意",
                onChange: function (e) { patch({ keywords: e.target.value }); },
                onBlur: function () {
                  const arr = st.keywords.split(/[，,]/).map(function (x) { return x.trim(); }).filter(Boolean);
                  save("keywords", arr);
                },
                style: INPUT_STYLE,
              })
            )
          : null;

        return h("div", { key: "modeSection" },
          h("div", { key: "mh", style: { fontSize: "11px", opacity: .6, marginBottom: "8px" } }, "播报模式"),
          h("div", { key: "mb", style: { display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" } }, modeBtns),
          kwBox
        );
      }

      function filterPane() {
        return h("div", { key: "filterSection" },
          h("div", { key: "fh1", style: { fontSize: "11px", opacity: .6, marginBottom: "6px" } }, "自动过滤（始终生效）"),
          h("div", { key: "fauto", style: { fontSize: "11px", opacity: .5, marginBottom: "12px", lineHeight: 1.7 } }, "代码块 · 行内代码 · 链接 · markdown符号 · 表格 · emoji · 数学公式"),
          h("div", { key: "fh2", style: { fontSize: "11px", opacity: .6, marginBottom: "6px" } }, "自定义过滤词（逗号分隔）"),
          h("input", {
            key: "finput",
            type: "text",
            value: st.filterWords,
            placeholder: "例如：密码，密钥，token",
            onChange: function (e) { patch({ filterWords: e.target.value }); },
            onBlur: function () {
              const arr = st.filterWords.split(/[，,]/).map(function (x) { return x.trim(); }).filter(Boolean);
              save("filterWords", arr);
            },
            style: INPUT_STYLE,
          }),
          h("div", { key: "fh3", style: { fontSize: "11px", opacity: .6, margin: "10px 0 6px" } }, "过滤方式"),
          h("div", { key: "fbtns", style: { display: "flex", gap: "6px" } },
            h("button", {
              key: "fm1",
              type: "button",
              onClick: function () { patch({ filterMode: "skip" }); save("filterMode", "skip"); },
              style: btnStyle(st.filterMode === "skip"),
            }, "静默跳过"),
            h("button", {
              key: "fm2",
              type: "button",
              onClick: function () { patch({ filterMode: "replace" }); save("filterMode", "replace"); },
              style: btnStyle(st.filterMode === "replace"),
            }, "替换成……")
          )
        );
      }

      let body;
      if (loading) {
        body = h("div", { key: "ld", style: { opacity: .6, fontSize: "12px" } }, "加载音色库…");
      } else if (st.tab === "voice") {
        body = h("div", { key: "paneVoice" }, voiceList());
      } else if (st.tab === "param") {
        body = h("div", { key: "paneParam" },
          PARAM_DEFS.map(slider),
          h("div", { key: "pn", style: { fontSize: "11px", opacity: .55, lineHeight: 1.6 } }, "拖动调整，松手自动保存到当前对话。")
        );
      } else if (st.tab === "mode") {
        body = modePane();
      } else if (st.tab === "filter") {
        body = filterPane();
      } else {
        body = linkagePane();
      }
      if (st.tab === "history") {
        body = historyPane();
      }

      const head = h("div", { key: "head", style: { fontSize: "15px", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px" } },
        h("span", { key: "hi" }, st.on ? "🔊" : "🔇"),
        h("span", { key: "ht" }, "语音喇叭"),
        h("span", { key: "hs", style: { flex: 1 } }),
        h("button", { key: "htg", type: "button", onClick: doToggle, style: btnStyle(st.on) }, st.on ? "关闭" : "开启"),
        h("button", { key: "hpv", type: "button", onClick: doPreview, style: btnStyle(false) }, "试听")
      );

      const tabs = h("div", { key: "tabs", style: { display: "flex", gap: "6px" } },
        tabBtn("voice", "音色"),
        tabBtn("param", "参数"),
        tabBtn("mode", "播报"),
        tabBtn("filter", "过滤"),
        tabBtn("linkage", "联动"),
        tabBtn("history", "历史")
      );

      const msgEl = st.msg ? h("div", { key: "msgBox", style: { fontSize: "12px", color: "#7de8ff" } }, st.msg) : null;

      const foot = h("div", { key: "foot", style: { fontSize: "11px", opacity: .5, lineHeight: 1.6 } }, "开关与配置按对话独立保存，新建对话默认关闭。");

      return h("div", {
        "data-dsh-voice-horn-panel": "",
        style: {
          padding: "14px 16px",
          display: "flex",
          flexDirection: "column",
          gap: "10px",
          fontSize: "13px",
          height: "100%",
          overflowY: "auto",
          boxSizing: "border-box",
        },
      }, head, tabs, body, msgEl, foot);
    }

    function HornSettingsCard() {
      const sSs = React.useState({ on: horn.on });
      const st = sSs[0];
      const setSt = sSs[1];

      React.useEffect(function () {
        setSt({ on: horn.on });
      }, [horn.on]);

      function doToggleCard() {
        toggleHorn();
        setSt({ on: !horn.on });
      }

      function testVoice() {
        api("preview", { text: "试听一下，本鱼的声音。" });
      }

      const btn = {
        cursor: "pointer",
        padding: "3px 10px",
        borderRadius: "6px",
        border: "1px solid rgba(140,160,200,.45)",
        background: "transparent",
        color: "inherit",
        fontSize: "12px",
      };

      const head = h("div", { key: "ch", style: { display: "flex", alignItems: "center", gap: "8px", fontWeight: 600 } },
        h("span", { key: "ci" }, st.on ? "🔊" : "🔇"),
        h("span", { key: "cl" }, "语音喇叭 · 回复播报"),
        h("span", { key: "cs", style: { flex: 1 } }),
        h("button", { key: "cb", type: "button", onClick: doToggleCard, style: btn }, st.on ? "关闭" : "开启"),
        h("button", { key: "cp", type: "button", onClick: testVoice, style: btn }, "试听")
      );

      const hint = h("div", { key: "chint", style: { opacity: .7, lineHeight: 1.5 } }, "开启后：AI 回复完成时，后台静默用软糯女声念摘要，全程无弹窗。");

      return h("div", {
        "data-dsh-voice-horn-card": "",
        style: {
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          padding: "10px 12px",
          borderRadius: "10px",
          border: "1px solid rgba(140,160,200,.35)",
          background: "rgba(22,30,52,.55)",
          fontSize: "12px",
        },
      }, head, hint);
    }

    function apply(ctx) {
      try {
        applyInner(ctx);
      } catch (e) {
        console.warn("[dsh-voice-horn] apply failed:", e);
      }
    }

    function applyInner(ctx) {
      try {
        if (!window.__DSH_VOICE_HORN_DELEGATED__) {
          window.__DSH_VOICE_HORN_DELEGATED__ = true;
          document.addEventListener("click", function (ev) {
            try {
              const path = ev.composedPath ? ev.composedPath() : [];
              let hit = false;
              for (const el of path) {
                if (el && el.getAttribute && el.getAttribute("data-horn-btn") === "1") {
                  hit = true;
                  break;
                }
              }
              if (hit) onHornClick();
            } catch (e1) {}
          }, true);
        }
      } catch (e2) {}

      try {
        installHotkey();
      } catch (eHot) {}

      try {
        ensureHorn();
      } catch (e3) {
        console.warn("[dsh-voice-horn] ensureHorn failed:", e3);
      }

      try {
        if (!window.__DSH_VOICE_HORN_HEARTBEAT__) {
          window.__DSH_VOICE_HORN_HEARTBEAT__ = setInterval(function () {
            try {
              if (document.body && !document.body.contains(hornEl)) ensureHorn();
            } catch (e4) {}
          }, 500);
        }
      } catch (e5) {}

      try {
        if (typeof document !== "undefined") {
          if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", function () {
              try { ensureHorn(); refreshState(probeSid()); } catch (e6) {}
            }, { once: true });
          }
          window.addEventListener("load", function () {
            try { ensureHorn(); } catch (e7) {}
          }, { once: true });
        }
      } catch (e8) {}

      const slots = ctx && ctx.slots;
      if (!slots || typeof slots.inject !== "function") return;

      try {
        slots.inject("conversation.chat.assistant-actions", function () {
          return slots.register({
            name: "conversation.chat.assistant-actions",
            id: KEY,
            order: 95,
            inject: function (sessionId) { return { sessionId: sessionId }; },
          }, SessionProbe);
        });
      } catch (e9) {
        console.warn("[dsh-voice-horn] assistant-actions slot failed:", e9);
      }

      try {
        slots.inject("sidebar.panellist", function () {
          return slots.register({
            name: "sidebar.panellist",
            id: KEY,
            order: 900,
            label: function () { return horn.on ? "语音喇叭 (开)" : "语音喇叭 (关)"; },
          }, HornPanelIcon);
        });
      } catch (e10) {
        console.warn("[dsh-voice-horn] sidebar slot failed:", e10);
      }

      try {
        slots.inject("main", function () {
          return slots.register({
            name: "main",
            key: KEY,
            inject: function () { return {}; },
          }, HornPanelPage);
        });
      } catch (e11) {
        console.warn("[dsh-voice-horn] main slot failed:", e11);
      }

      try {
        slots.inject("settings.plugin.item", function () {
          return slots.register({ name: "settings.plugin.item", key: KEY }, HornSettingsCard);
        });
      } catch (e12) {}

      if (typeof ctx.effect === "function") {
        ctx.effect(function () {
          stopPolling();
          try { if (hornEl) hornEl.remove(); } catch (e13) {}
          hornEl = null;
        }, "dsh-voice-horn: cleanup");
      }
    }

    return { inject: ["slots"], apply: apply };
  },
});

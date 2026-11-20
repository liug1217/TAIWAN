/* 台灣 1:1 — 玩法: 天氣 (雨、霧、雨刷、濕路面)、全螢幕、測速照相 / 區間測速、國道地名里程牌、導航、任務
 * 依賴 app.js 的 window.TW 與 features.js 的 window.TWX。
 * 資料: tiles/n/nav.bin (scripts/build_nav.mjs 路網 + 目的地)、extra-cameras (OSM 測速照相)、extra-distsigns (里程牌)
 */
(function () {
'use strict';
const TW = window.TW, TWX = window.TWX;
if (!TW || !TWX) return;
const T = TW.T, S = TW.S, $ = (id) => document.getElementById(id);
const extra = (id) => { const el = $('extra-' + id); try { return el ? JSON.parse(el.textContent) : null; } catch (e) { return null; } };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
};
const kmh = () => Math.abs(S.v) * 3.6;
const fmtD = (m) => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + ' 公里' : Math.max(10, Math.round(m / 10) * 10) + ' 公尺';
const fmtT = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m >= 60 ? Math.floor(m / 60) + ' 小時 ' + (m % 60) + ' 分' : m + ':' + String(s % 60).padStart(2, '0'); };
const TEST = TW.params.has('t');

// ======================================================================= 共用: 介面、語音、音效
const css = document.createElement('style');
css.textContent = `
  #gp-btns { position: fixed; right: 18px; top: 22px; display: flex; gap: 6px; z-index: 6; }
  #gp-btns button { height: 32px; min-width: 32px; padding: 0 9px; border-radius: 9px; border: 1px solid rgba(255,255,255,.3); background: rgba(10,14,20,.6); color: #fff; font-size: 13px; cursor: pointer; }
  #gp-btns button:hover { background: rgba(255,255,255,.2); }
  body.touch #gp-btns { display: none; }
  #nav-box { position: fixed; top: 108px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; padding: 8px 16px 8px 10px; border-radius: 12px; background: rgba(20,92,180,.92); box-shadow: 0 4px 16px rgba(0,0,0,.35); z-index: 5; max-width: 80vw; }
  #nav-box .arr { font-size: 34px; width: 44px; text-align: center; line-height: 1; }
  #nav-box b { display: block; font-size: 20px; } #nav-box span { font-size: 13px; opacity: .9; }
  #nav-box small { display: block; font-size: 12px; opacity: .75; }
  body.touch #nav-box { top: 72px; left: 150px; transform: none; padding: 4px 10px 4px 6px; max-width: calc(100vw - 430px); }
  body.touch #nav-box .arr { font-size: 22px; width: 28px; } body.touch #nav-box b { font-size: 14px; } body.touch #nav-box span, body.touch #nav-box small { font-size: 10px; }
  #exit-box { position: fixed; top: 108px; left: 50%; transform: translateX(-50%); padding: 4px 12px; border-radius: 8px; background: rgba(11,96,52,.88); border: 2px solid #fff; font-size: 14px; white-space: nowrap; z-index: 4; }
  #cam-box { position: fixed; right: 22px; bottom: 132px; padding: 8px 12px; border-radius: 12px; background: rgba(15,15,18,.85); border: 3px solid #f2c200; font-size: 15px; text-align: center; z-index: 5; min-width: 150px; }
  #cam-box b { font-size: 22px; display: block; } #cam-box.over { border-color: #ff3b2f; animation: gpblink .5s infinite alternate; }
  @keyframes gpblink { from { background: rgba(15,15,18,.85); } to { background: rgba(170,20,15,.85); } }
  body.touch #cam-box { right: auto; left: 50%; transform: translateX(-50%); bottom: calc(80px + env(safe-area-inset-bottom)); font-size: 12px; padding: 4px 10px; min-width: 0; }
  body.touch #cam-box b { font-size: 15px; display: inline; }
  #flash { position: fixed; inset: 0; background: #fff; opacity: 0; pointer-events: none; z-index: 25; transition: opacity .35s; }
  #mission-box { position: fixed; right: 18px; top: 64px; width: 250px; padding: 10px 14px; border-radius: 12px; background: rgba(10,14,20,.8); box-shadow: 0 4px 18px rgba(0,0,0,.4); font-size: 13px; z-index: 5; line-height: 1.55; }
  #mission-box h4 { margin: 0 0 4px; font-size: 15px; } #mission-box .big { font-size: 20px; font-weight: 800; }
  #mission-box .bar { height: 6px; border-radius: 3px; background: rgba(255,255,255,.15); overflow: hidden; margin: 4px 0; } #mission-box .bar i { display: block; height: 100%; background: #3fd07a; }
  #mission-box button { margin-top: 6px; padding: 4px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,.3); background: rgba(255,255,255,.1); color: #fff; cursor: pointer; font-size: 12px; }
  body.touch #mission-box { top: calc(104px + env(safe-area-inset-top)); bottom: auto; right: 10px; width: 190px; font-size: 11px; padding: 6px 10px; }
  @media (orientation: portrait) { body.touch #mission-box { top: auto; bottom: calc(268px + env(safe-area-inset-bottom)); } body.touch #nav-box { top: 262px; left: 10px; max-width: calc(100vw - 20px); } }
  #wiper { position: fixed; inset: 0; pointer-events: none; z-index: 3; }
  #menu .gp input[type=search] { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.08); color: #fff; font-size: 15px; margin-bottom: 8px; }
  #menu .gp .list { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 6px; max-height: 240px; overflow: auto; margin-bottom: 12px; }
  #menu .gp .list button small { opacity: .6; margin-left: 4px; }
  #menu .gp .note { font-size: 12px; opacity: .7; margin: -4px 0 10px; }
  #menu .gp .wallet { font-size: 14px; margin-bottom: 8px; }
  #touch .tb.gp-man { display: none; width: 52px; height: 40px; border-radius: 12px; font-size: 12px; bottom: calc(26px + env(safe-area-inset-bottom)); } body.manual #touch .tb.gp-man { display: flex; }
  #touch .tb.gp-up, #touch .tb.gp-dn { right: calc(240px + env(safe-area-inset-right)); } #touch .tb.gp-up { bottom: calc(76px + env(safe-area-inset-bottom)); }
  @media (orientation: portrait) { #touch .tb.gp-up, #touch .tb.gp-dn { right: calc(37px + env(safe-area-inset-right)); } #touch .tb.gp-up { bottom: calc(186px + env(safe-area-inset-bottom)); } #touch .tb.gp-dn { bottom: calc(140px + env(safe-area-inset-bottom)); } }
`;
document.head.appendChild(css);
const el = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); Object.assign(e, attrs); if (html) e.innerHTML = html; return e; };
const box = (id) => { const e = el('div', { id, className: 'hidden' }); document.body.appendChild(e); return e; };
const navBox = box('nav-box'), exitBox = box('exit-box'), camBox = box('cam-box'), missionBox = box('mission-box');
const flash = el('div', { id: 'flash' }); document.body.appendChild(flash);

// 語音 (神盾 / 導航)
const voice = {
  on: store.get('tw_voice', true),
  say(t, force) {
    if ((!this.on && !force) || TEST || !window.speechSynthesis) return;
    try { const u = new SpeechSynthesisUtterance(t); u.lang = 'zh-TW'; u.rate = 1.08; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (_) {}
  },
};
// 音效 (自己的 AudioContext；要等使用者按過鍵才會啟動)
const sfx = (() => {
  let ac = null, rainG = null, nb = null;
  const init = () => {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return; }
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return; }
    nb = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // 雨聲: 白噪音 -> 高通 + 低通 (細雨沙沙聲)，加一點低頻 (打在車頂)
    const src = ac.createBufferSource(); src.buffer = nb; src.loop = true;
    const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
    rainG = ac.createGain(); rainG.gain.value = 0;
    src.connect(hp); hp.connect(lp); lp.connect(rainG); rainG.connect(ac.destination); src.start();
  };
  window.addEventListener('keydown', init); window.addEventListener('pointerdown', init);
  // 切到別的分頁時雨聲不要一直下 (畫面停了，雨量不會再更新)
  document.addEventListener('visibilitychange', () => {
    if (!ac) return;
    if (document.visibilityState === 'hidden') { if (ac.state === 'running') ac.suspend(); } else if (ac.state === 'suspended') ac.resume();
  });
  function tone(f, t0, dur, vol = 0.12, type = 'sine') {
    if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + t0;
    o.type = type; o.frequency.value = f; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  function sweep(f0, f1, t0, dur, vol, type = 'sine') {   // 頻率滑動的音 (閃光燈充電的高音)
    if (!ac) return;
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + t0;
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.02); g.gain.setValueAtTime(vol, t + dur * 0.8); g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g); g.connect(ac.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(t0, dur, f, vol) {
    if (!ac) return;
    const s = ac.createBufferSource(); s.buffer = nb; const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 1.2;
    const g = ac.createGain(), t = ac.currentTime + t0; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    s.connect(bp); bp.connect(g); g.connect(ac.destination); s.start(t); s.stop(t + dur + 0.05);
  }
  return {
    chime() { tone(1318, 0, 0.25); tone(988, 0.18, 0.4); },            // 測速提醒「叮咚」
    warn() { tone(1760, 0, 0.09, 0.1, 'square'); tone(1760, 0.14, 0.09, 0.1, 'square'); },
    // 測速器的接近嗶聲: 平常是短促的「嗶」，超速時換成高音的急促雙響
    radar(over) {
      if (over) { tone(2093, 0, 0.05, 0.09, 'square'); tone(2093, 0.075, 0.05, 0.09, 'square'); }
      else tone(1568, 0, 0.07, 0.07, 'triangle');
    },
    // 被拍: 快門「喀」→ 閃光燈充電的高音 → 第二聲「嚓」
    shutter() { noise(0, 0.035, 3200, 0.6); noise(0.04, 0.05, 1500, 0.35); sweep(2400, 7200, 0.08, 0.35, 0.025); noise(0.46, 0.04, 2600, 0.4); },
    coin() { tone(1046, 0, 0.12, 0.1); tone(1568, 0.1, 0.35, 0.1); },
    beep() { tone(2093, 0, 0.12, 0.07, 'triangle'); },                  // ETC 車機「嗶」
    wipe(v) { noise(0, 0.12, 380, 0.09 * v); },
    rain(v, inside) { if (rainG) rainG.gain.setTargetAtTime(v * (inside ? 0.22 : 0.12), ac.currentTime, 0.4); },
  };
})();

// ======================================================================= 天氣
// 模式: 即時 (Open-Meteo 目前天氣) / 晴 / 陰 / 小雨 / 大雨 / 起霧 / 雨霧
const WMODES = [['即時', null], ['晴', [0, 0, 0]], ['陰', [0.8, 0, 0]], ['小雨', [0.85, 0.35, 0.05]], ['大雨', [1, 1, 0.15]], ['起霧', [0.55, 0, 1]], ['雨霧', [0.95, 0.5, 0.7]]];
const weather = (() => {
  const W = TW.WEATHER;
  let mode = store.get('tw_weather', 0), live = [0, 0, 0], liveAt = 0, liveTxt = '', cur = [0, 0, 0], liveX = 0, liveY = 0;
  if (TW.params.get('weather')) { const i = WMODES.findIndex((m) => m[0] === TW.params.get('weather')); if (i >= 0) mode = i; }
  const target = () => WMODES[mode][1] || live;
  async function fetchLive() {
    if (TEST) return;
    liveAt = performance.now(); liveX = S.x; liveY = S.y;
    try {
      const [lat, lon] = TWX.gpsSync.toLatLon(S.x, S.y);
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=precipitation,cloud_cover,visibility,weather_code`;
      const j = await (await fetch(u)).json(), c = j.current || {};
      const pr = c.precipitation || 0, vis = c.visibility == null ? 20000 : c.visibility, code = c.weather_code || 0;
      live = [Math.min(1, (c.cloud_cover || 0) / 100), Math.min(1, pr / 5), (code === 45 || code === 48) ? 0.8 : Math.max(0, Math.min(1, (2000 - vis) / 1700))];
      liveTxt = pr > 0.1 ? `雨量 ${pr} mm` : (code === 45 || code === 48) ? '有霧' : `雲量 ${c.cloud_cover || 0}%`;
    } catch (e) { liveTxt = '讀不到天氣'; }
  }
  function set(i, quiet) {
    mode = (i + WMODES.length) % WMODES.length; store.set('tw_weather', mode);
    if (!quiet) TW.toast('🌦 天氣：' + WMODES[mode][0] + (mode === 0 ? '（照現在當地天氣' + (liveTxt ? '，' + liveTxt : '') + '）' : ''));
    if (mode === 0 && performance.now() - liveAt > 60000) fetchLive();
  }
  // ---- 雨滴: 攝影機周圍一圈落下的線段 (相對攝影機移動拉長，車速快時往後斜)
  const N = TW.MOBILE ? 1600 : 5200, R = 32, H = 22;
  const pos = new Float32Array(N * 6), seed = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { seed[i * 3] = (Math.random() * 2 - 1) * R; seed[i * 3 + 1] = Math.random() * H; seed[i * 3 + 2] = (Math.random() * 2 - 1) * R; }
  const geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3));
  const mat = new T.LineBasicMaterial({ color: new T.Color(0.62, 0.66, 0.72), transparent: true, opacity: 0, depthWrite: false, fog: false });
  const lines = new T.LineSegments(geo, mat); lines.frustumCulled = false; lines.visible = false; TW.scene.add(lines);
  const lastCam = new T.Vector3(), cv = new T.Vector3();
  // ---- 擋風玻璃: 第一人稱時畫雨珠與雨刷
  const wcv = el('canvas', { id: 'wiper' }); wcv.style.display = 'none'; document.body.appendChild(wcv);
  const wx = wcv.getContext('2d');
  let drops = [], wang = 0, wdir = 1, wpause = 0, wspeed = 0;
  function frame(dt) {
    const tg = target();
    for (let k = 0; k < 3; k++) cur[k] += (tg[k] - cur[k]) * Math.min(1, dt * (k === 1 ? 0.5 : 0.25));
    const [over, rain, fog] = cur;
    // 下雨慢慢變濕，停雨慢慢變乾
    W.wet.value = Math.max(0, Math.min(1, W.wet.value + (rain > 0.05 ? (0.04 + rain * 0.25) * dt : -0.012 * dt)));
    if (Math.abs(W.over - over) > 0.01 || Math.abs(W.fog - fog) > 0.01 || Math.abs(W.rain - rain) > 0.01) { W.over = over; W.fog = fog; W.rain = rain; W.dirty = true; }
    // 即時天氣: 10 分鐘更新一次；傳送 / 開到 20 km 外 (例如台北 → 宜蘭) 就提早重抓 (至少隔 1 分鐘)
    if (mode === 0 && (performance.now() - liveAt > 600000 || (performance.now() - liveAt > 60000 && Math.hypot(S.x - liveX, S.y - liveY) > 20000))) fetchLive();
    // 雨滴
    const cam = TW.camera.position;
    cv.copy(cam).sub(lastCam).divideScalar(Math.max(dt, 1e-3)); lastCam.copy(cam);
    if (cv.length() > 80) cv.set(0, 0, 0);
    lines.visible = rain > 0.02;
    if (lines.visible) {
      mat.opacity = Math.min(0.5, rain * 0.6) * (1 - 0.72 * TW.NIGHT.value);
      const fall = 10 * dt, k = 0.085;   // 雨絲長度 = 相對速度 × 曝光時間
      const vx = -cv.x * k, vy = (-10 - cv.y) * k, vz = -cv.z * k, n = Math.floor(N * Math.min(1, 0.25 + rain));
      for (let i = 0; i < N; i++) {
        let y = seed[i * 3 + 1] - fall; if (y < 0) y += H; seed[i * 3 + 1] = y;
        let x = seed[i * 3] - cv.x * dt, z = seed[i * 3 + 2] - cv.z * dt;   // 攝影機移動: 雨滴相對往後
        if (x < -R) x += 2 * R; else if (x > R) x -= 2 * R; if (z < -R) z += 2 * R; else if (z > R) z -= 2 * R;
        seed[i * 3] = x; seed[i * 3 + 2] = z;
        const o = i * 6, on = i < n ? 1 : 0;
        pos[o] = cam.x + x; pos[o + 1] = cam.y - 4 + y; pos[o + 2] = cam.z + z;
        pos[o + 3] = pos[o] - vx * on; pos[o + 4] = pos[o + 1] - vy * on; pos[o + 5] = pos[o + 2] - vz * on;
        if (!on) { pos[o + 3] = pos[o]; pos[o + 4] = pos[o + 1]; pos[o + 5] = pos[o + 2]; }
      }
      geo.attributes.position.needsUpdate = true;
    }
    // 雨聲 (車內聽到雨打在車頂比較大聲)
    sfx.rain(rain, TW.camMode === 1);
    // 雨刷 (第一人稱)
    const inside = TW.camMode === 1 && (rain > 0.03 || drops.length);
    wcv.style.display = inside ? '' : 'none';
    if (inside) wiperFrame(dt, rain);
  }
  function wiperFrame(dt, rain) {
    // 畫布大小有變才重設 (每幀設 width 會重新配置整張畫布)
    const Wd = Math.round(window.innerWidth / 2), Hd = Math.round(window.innerHeight / 2);
    if (wcv.width !== Wd || wcv.height !== Hd) { wcv.width = Wd; wcv.height = Hd; wcv.style.width = '100%'; wcv.style.height = '100%'; }
    // 雨珠: 雨越大、車越快越多
    const rate = rain * (60 + kmh() * 1.2);
    for (let k = 0; k < rate * dt; k++) if (drops.length < 500) drops.push({ x: Math.random() * Wd, y: Math.random() * Hd * 0.92, r: 1.2 + Math.random() * 3.2 * (0.5 + rain), a: 0 });
    // 雨刷: 小雨間歇、大雨快速
    const period = rain > 0.6 ? 0.85 : 1.35;
    wspeed = rain > 0.03 ? Math.PI * 0.62 / (period / 2) : 0;
    if (wpause > 0) wpause -= dt;
    else if (wspeed) {
      const prev = wang;
      wang += wdir * wspeed * dt;
      if (wang > Math.PI * 0.62) { wang = Math.PI * 0.62; wdir = -1; sfx.wipe(0.8); }
      if (wang < 0) { wang = 0; wdir = 1; sfx.wipe(0.6); if (rain < 0.25) wpause = 2.6 - rain * 6; }
      // 掃過的扇形裡的雨珠擦掉
      const lo = Math.min(prev, wang), hi = Math.max(prev, wang);
      for (const [px, L] of [[Wd * 0.3, Hd * 0.62], [Wd * 0.72, Hd * 0.62]]) {
        drops = drops.filter((d) => {
          const dx = d.x - px, dy = (Hd + 10) - d.y, rr = Math.hypot(dx, dy), ang = Math.PI - Math.atan2(dy, dx);
          return !(rr < L && ang >= Math.PI - hi - 0.06 && ang <= Math.PI - lo + 0.06);
        });
      }
    }
    wx.clearRect(0, 0, Wd, Hd);
    for (const d of drops) {
      d.a = Math.min(1, d.a + dt * 4);
      if (kmh() > 60) d.y -= kmh() * 0.02 * dt * 10;   // 高速時雨珠往上流
      wx.globalAlpha = 0.5 * d.a;
      const g = wx.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, 0, d.x, d.y, d.r);
      g.addColorStop(0, 'rgba(255,255,255,0.9)'); g.addColorStop(0.5, 'rgba(200,210,220,0.35)'); g.addColorStop(1, 'rgba(40,50,60,0.25)');
      wx.fillStyle = g; wx.beginPath(); wx.arc(d.x, d.y, d.r, 0, Math.PI * 2); wx.fill();
    }
    drops = drops.filter((d) => d.y > -5);
    wx.globalAlpha = 1;
    // 兩支雨刷 (從下緣的轉軸往上掃)
    for (const px of [Wd * 0.3, Wd * 0.72]) {
      const L = Hd * 0.62;
      const bx = px - Math.cos(wang) * L, by = Hd + 10 - Math.sin(wang) * L;
      wx.strokeStyle = 'rgba(8,8,10,0.97)'; wx.lineWidth = 6; wx.lineCap = 'round';   // 雨刷臂
      wx.beginPath(); wx.moveTo(px, Hd + 10); wx.lineTo(px - Math.cos(wang) * L * 0.6, Hd + 10 - Math.sin(wang) * L * 0.6); wx.stroke();
      wx.strokeStyle = 'rgba(20,20,22,0.95)'; wx.lineWidth = 3.5; wx.beginPath();   // 雨刷片
      wx.moveTo(px - Math.cos(wang) * L * 0.2, Hd + 10 - Math.sin(wang) * L * 0.2); wx.lineTo(bx, by); wx.stroke();
    }
  }
  if (mode === 0) setTimeout(fetchLive, 3000);
  return { frame, set, cycle: () => set(mode + 1), get mode() { return mode; }, get name() { return WMODES[mode][0]; } };
})();

// ======================================================================= 全螢幕
function toggleFullscreen() {
  const d = document, on = d.fullscreenElement || d.webkitFullscreenElement;
  if (on) { (d.exitFullscreen || d.webkitExitFullscreen).call(d); return; }
  const e = d.documentElement, req = e.requestFullscreen || e.webkitRequestFullscreen;
  if (!req) { TW.toast('這個瀏覽器不支援全螢幕；iPhone 請用 Safari「分享 → 加入主畫面」', 3500); return; }
  Promise.resolve(req.call(e, { navigationUI: 'hide' })).then(() => {
    if (TW.MOBILE && screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
  }).catch(() => TW.toast('無法切換全螢幕'));
}

// ======================================================================= 測速照相 / 區間測速
const cams = (() => {
  const D = extra('cameras') || { cams: [], sections: [] };
  const list = D.cams.map(([x, y, z, h, max]) => ({ x, y, z, h, max, model: null, sign: null, warned: false, passedF: 1e9 }));
  const secs = D.sections.map(([name, max, fx, fy, tx, ty, h, fz, tz]) => ({ name, max, fx, fy, tx, ty, h, fz, tz }));
  const GC = 600, grid = new Map();
  for (const c of list) { const k = Math.floor(c.x / GC) * 100003 + Math.floor(c.y / GC); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(c); }
  const near = (x, y) => { const out = [], cx = Math.floor(x / GC), cy = Math.floor(y / GC); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const c of grid.get((cx + i) * 100003 + cy + j) || []) out.push(c); return out; };
  let on = store.get('tw_camwarn', true), tickets = store.get('tw_tickets', []), active = null, sec = null, clock = 0, odo = 0, gt = 0, camDist = 1e9, beepT = 0;
  const fineOf = (over) => over <= 20 ? 3000 : over <= 40 ? 4000 : over <= 60 ? 6000 : 12000;   // 參考: 國道超速罰鍰級距 (簡化)
  function ticket(spd, max, where) {
    const f = fineOf(spd - max);
    tickets.push({ t: Date.now(), spd: Math.round(spd), max, f, where }); if (tickets.length > 50) tickets.shift();
    store.set('tw_tickets', tickets);
    flash.style.transition = 'none'; flash.style.opacity = 0.85; requestAnimationFrame(() => { flash.style.transition = 'opacity .5s'; flash.style.opacity = 0; });
    sfx.shutter();
    TW.toast(`📸 超速被拍！限速 ${max}，你開 ${Math.round(spd)} km/h，罰鍰約 NT$${f.toLocaleString()}`, 4000);
    if (missions.active) missions.active.tickets++;
  }
  // ---- 模型: 灰色桿子 + 懸臂 + 相機箱 (面向來車)；前方 300 m 「測速取締」警告牌
  const matPole = new T.MeshStandardMaterial({ color: 0x8a8f94, metalness: 0.6, roughness: 0.45 });
  const matBox = new T.MeshStandardMaterial({ color: 0xd8dadc, metalness: 0.2, roughness: 0.4 });
  const matLens = new T.MeshStandardMaterial({ color: 0x050608, metalness: 0.3, roughness: 0.15 });
  const signTex = (() => {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 320; const x = cv.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, 256, 320); x.lineWidth = 16; x.strokeStyle = '#d6201c'; x.strokeRect(8, 8, 240, 304);
    x.fillStyle = '#111'; x.fillRect(58, 70, 140, 80); x.beginPath(); x.arc(128, 110, 30, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill();
    x.beginPath(); x.arc(128, 110, 20, 0, Math.PI * 2); x.fillStyle = '#111'; x.fill(); x.fillStyle = '#111'; x.fillRect(90, 56, 40, 16);
    x.font = '700 50px ' + TWX.sign.ZH_FONT; x.textAlign = 'center'; x.fillText('測速', 128, 220); x.fillText('取締', 128, 280);
    const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; return t;
  })();
  const matSign = new T.MeshStandardMaterial({ map: signTex, emissiveMap: signTex, emissive: new T.Color(0.3, 0.3, 0.3), roughness: 0.5 });
  // 幾何共用 (模型移除時不必 dispose，也不會每建一次就多佔一份 GPU 記憶體)
  const GEO = {
    pole: new T.CylinderGeometry(0.12, 0.15, 6.2, 10), arm: new T.BoxGeometry(2.2, 0.12, 0.12), box: new T.BoxGeometry(0.5, 0.42, 0.75),
    lens: new T.CylinderGeometry(0.11, 0.11, 0.06, 14), flash: new T.BoxGeometry(0.34, 0.2, 0.06),
    post: new T.CylinderGeometry(0.05, 0.05, 2.6, 8), plate: new T.PlaneGeometry(0.8, 1.0), back: new T.BoxGeometry(0.8, 1.0, 0.04),
  };
  function camModel() {
    const g = new T.Group();
    const pole = new T.Mesh(GEO.pole, matPole); pole.position.set(0, 3.1, 0); g.add(pole);
    const arm = new T.Mesh(GEO.arm, matPole); arm.position.set(-1.05, 5.9, 0); g.add(arm);
    const bx = new T.Mesh(GEO.box, matBox); bx.position.set(-1.9, 5.55, 0); g.add(bx);
    const lens = new T.Mesh(GEO.lens, matLens); lens.rotation.x = Math.PI / 2; lens.position.set(-1.9, 5.55, 0.4); g.add(lens);
    const fl = new T.Mesh(GEO.flash, matLens); fl.position.set(-1.9, 5.92, 0.36); g.add(fl);
    return g;
  }
  function signModel() {
    const g = new T.Group();
    const post = new T.Mesh(GEO.post, matPole); post.position.y = 1.3; g.add(post);
    const pl = new T.Mesh(GEO.plate, matSign); pl.position.set(0, 2.6, 0.06); g.add(pl);
    const back = new T.Mesh(GEO.back, matPole); back.position.set(0, 2.6, 0.02); g.add(back);
    return g;
  }
  // 放在行進方向右側路肩: 物件 +z 面向來車
  function placeRoadside(obj, x, y, h, zRef, extraOff = 1.4) {
    const r = TW.roadAt(x, y, zRef + 3, 0, 8); if (!r) return false;
    const rx = Math.sin(h), ry = -Math.cos(h);   // 行進方向右手邊
    // 從路面中心往右推到路緣外
    const w = r.w, nx = w.nx[r.i], ny = w.ny[r.i], cxp = x - nx * r.lat, cyp = y - ny * r.lat;
    const side = Math.sign(rx * nx + ry * ny) || 1;   // 右手邊在左法向的哪一側
    const off = side > 0 ? w.hw + (w.eL ? w.eL[r.i] : 0) + extraOff : -(TW.rightEdge(w, r.i) + extraOff);   // 國道右側路肩有加寬
    const px = cxp + nx * off, py = cyp + ny * off;
    obj.position.set(px, r.z, -py); obj.rotation.y = h - Math.PI / 2;   // +z 面向來車、-x 伸向路面
    return true;
  }
  function frame(dt) {
    odo += Math.abs(S.v) * dt; gt += dt;
    // 接近嗶聲 (300 m 內): 300 m 約 1.3 秒一聲、越近越密；超速時每 0.22 秒急促雙響
    camDist -= Math.abs(S.v) * dt; beepT -= dt;
    if (on && active && active.warned && camDist > 0 && camDist < 300 && beepT <= 0) {
      const over = kmh() > active.max;
      sfx.radar(over);
      beepT = over ? 0.22 : 0.22 + (camDist / 300) * 1.1;
    }
    clock -= dt; if (clock > 0) return; clock = 0.2;
    const fx = Math.cos(S.h), fy = Math.sin(S.h);
    let best = null, bf = 1e9;
    for (const c of near(S.x, S.y)) {
      const dx = c.x - S.x, dy = c.y - S.y, d = Math.hypot(dx, dy);
      // 模型: 400 m 內、路段已載入才建
      if (!c.model && d < 450 && c.h != null) {
        const m = camModel(); if (placeRoadside(m, c.x, c.y, c.h, c.z)) { TW.scene.add(m); c.model = m; }
        // 警告牌只蓋一次 (相機那段路還沒載入時，下一輪會再試相機，但不能每 0.2 秒多蓋一面牌子)
        if (!c.sign) { const sx = c.x - Math.cos(c.h) * 300, sy = c.y - Math.sin(c.h) * 300, s = signModel();
          if (placeRoadside(s, sx, sy, c.h, c.z, 1.0)) { TW.scene.add(s); c.sign = s; } }
      } else if ((c.model || c.sign) && d > 700) { if (c.model) TW.scene.remove(c.model); if (c.sign) TW.scene.remove(c.sign); c.model = c.sign = null; }
      if (Math.abs(c.z - S.z) > 8) continue;
      if (c.h != null && Math.cos(c.h - S.h) < 0.6) continue;           // 拍的是對向車道
      const f = dx * fx + dy * fy, l = Math.abs(-dx * fy + dy * fx);
      if (l > 30 + Math.max(0, f) * 0.12) { c.passedF = 1e9; continue; }
      // 剛經過: 超過速限 10 km/h 以上就被拍
      if (c.passedF > 0 && f <= 0 && c.passedF < 60) { if (kmh() > c.max + 10) ticket(kmh(), c.max, '測速照相'); c.warned = false; }
      c.passedF = f;
      if (f > 0 && f < 600 && f < bf) { bf = f; best = c; }
    }
    if (best && on) {
      if (!best.warned && bf < 520) {
        best.warned = true; sfx.chime();
        voice.say(`前方${bf > 350 ? '五百' : bf > 150 ? '三百' : ''}公尺，有測速照相，限速${best.max}`);
      }
      if (best.warned) {
        const over = kmh() > best.max;
        camBox.className = over ? 'over' : '';
        camBox.innerHTML = `📷 測速照相 <b>${Math.round(bf)} m</b>限速 ${best.max}${over ? ' · 超速！' : ''}`;

      }
    } else if (!sec) camBox.className = 'hidden';
    active = best; camDist = best ? bf : 1e9;
    // ---- 區間測速
    if (!sec) {
      for (const q of secs) {
        if (Math.hypot(q.fx - S.x, q.fy - S.y) < 40 && Math.abs(q.fz - S.z) < 8 && Math.cos(q.h - S.h) > 0.5) {
          sec = { q, t0: gt, o0: odo };
          if (on) { sfx.chime(); voice.say(`進入區間測速路段，限速${q.max}`); }
          break;
        }
      }
    } else {
      const q = sec.q, t = gt - sec.t0, dist = odo - sec.o0, avg = dist / Math.max(t, 1) * 3.6;
      const left = Math.hypot(q.tx - S.x, q.ty - S.y);
      if (on && !best) { camBox.className = avg > q.max ? 'over' : ''; camBox.innerHTML = `⏱ 區間測速 限速 ${q.max}<b>平均 ${Math.round(avg)}</b>剩 ${fmtD(left)}`; }
      if (left < 40 && Math.abs(q.tz - S.z) < 8) {
        if (avg > q.max + 10) ticket(avg, q.max, '區間測速');
        else if (on) voice.say(`離開區間測速，平均時速${Math.round(avg)}`);
        sec = null;
      } else if (t > 1800 || dist > 3 * Math.hypot(q.tx - q.fx, q.ty - q.fy) + 2000) sec = null;   // 走別條路離開
    }
  }
  // 小地圖: 測速照相紅點
  TW.HOOKS.minimap.push((c, s) => {
    for (const q of near(S.x, S.y)) {
      c.beginPath(); c.arc(q.x - S.x, q.y - S.y, 4.5 / s, 0, Math.PI * 2); c.fillStyle = '#ff3b2f'; c.fill();
      c.beginPath(); c.arc(q.x - S.x, q.y - S.y, 2 / s, 0, Math.PI * 2); c.fillStyle = '#fff'; c.fill();
    }
  });
  return { frame, get tickets() { return tickets; }, get on() { return on; }, set on(v) { on = v; store.set('tw_camwarn', v); }, list, secs };
})();

// ======================================================================= 國道地名里程牌 + 下一個出口
const distSigns = (() => {
  const D = (extra('distsigns') || []).map(([gid, idx, list, ref]) => ({ gid, idx, list, ref, model: null }));
  const G = TWX.sign;
  function panel(list) {
    const nameW = Math.max(...list.map(([n]) => G.textW(n, G.zhFont(0.72), G.ZH_SP)));
    const P = G.SGN.px, rowH = 1.0, W = Math.max(3.6, 0.3 + nameW + 0.7 + 1.0 + 0.35), H = 0.35 + rowH * list.length + 0.55;
    const p = G.panelBase(W, H), x = p.x;
    x.fillStyle = '#fff';
    list.forEach(([name, km], i) => {
      const y = (0.35 + rowH * (i + 0.78)) * P;
      x.font = G.zhFont(0.72); x.textAlign = 'left'; G.drawSpaced(x, name, (0.3 + G.textW(name, G.zhFont(0.72), G.ZH_SP) / 2) * P, y, G.ZH_SP);
      x.font = G.enFont(0.72); x.textAlign = 'right'; x.fillText(String(km), (W - 0.35) * P, y);
    });
    x.font = G.enFont(0.36); x.textAlign = 'right'; x.fillText('km', (W - 0.35) * P, (H - 0.18) * P);
    return p;
  }
  function build(d) {
    const w = TW.wayByGid(d.gid); if (!w) return null;
    const root = new T.Group(), p = panel(d.list);
    const X = TW.rightEdge(w, d.idx) + 1.0 + p.w / 2, Y0 = 2.4;
    const m = new T.Mesh(new T.PlaneGeometry(p.w, p.h), G.signMat(p.cv)); m.position.set(X, Y0 + p.h / 2, 0.05); root.add(m);
    const b = new T.Mesh(new T.BoxGeometry(p.w, p.h, 0.06), G.backMat); b.position.set(X, Y0 + p.h / 2, 0.0); root.add(b);
    for (const px of [X - p.w * 0.32, X + p.w * 0.32]) { const post = new T.Mesh(new T.CylinderGeometry(0.08, 0.08, Y0 + p.h, 10), G.backMat); post.position.set(px, (Y0 + p.h) / 2, -0.08); root.add(post); }
    G.placeOnWay(root, w, d.idx);
    TW.scene.add(root);
    return root;
  }
  // 移除牌子: 幾何、牌面貼圖與材質都要釋放 (每面牌子各有一張 CanvasTexture；共用的 backMat 不動)
  function drop(d) {
    TW.scene.remove(d.model);
    d.model.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material !== G.backMat) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
    d.model = null;
  }
  let clock = 0, exClock = 0;
  function frame(dt) {
    clock -= dt;
    if (clock <= 0) {
      clock = 0.6; let built = 0;
      for (const d of D) {
        const w = TW.wayByGid(d.gid);
        if (!w) { if (d.model) drop(d); continue; }
        const dd = Math.hypot(w.P[d.idx * 3] - S.x, w.P[d.idx * 3 + 1] - S.y);
        if (!d.model && dd < 1200 && built < 2) { d.model = build(d); built++; }
        else if (d.model && dd > 1800) drop(d);
      }
    }
    // 下一個出口 (國道主線): 沿路往前找出口指示牌 (指示牌在分岔前 230 m)
    exClock -= dt;
    if (exClock > 0) return;
    exClock = 1;
    const r = S.road;
    if (!r || r.w.city || r.w.link || navActive()) { exitBox.classList.add('hidden'); return; }
    let w = r.w, from = r.i, dist = -(r.t * (w.s[Math.min(r.i + 1, w.n - 1)] - w.s[r.i])), found = null, guard = 0;
    while (w && dist < 8000 && guard++ < 30 && !found) {
      for (const g of TWX.GUIDES) if (g.gid === w.gid && g.idx >= from && g.name) { const d = dist + w.s[g.idx] - w.s[from] + 230; if (d > 50 && (!found || d < found.d)) found = { d, g }; }
      if (found) break;
      dist += w.s[w.n - 1] - w.s[from];
      const opts = TW.nextOptions(w, w.n - 1).filter((o) => !o.o.link && !o.o.city && o.dir > 0);
      const nx = opts.find((o) => o.o.ref === w.ref) || opts[0];
      w = nx ? nx.o : null; from = nx ? nx.i : 0;
    }
    if (found) { exitBox.classList.remove('hidden'); exitBox.textContent = `下一個出口　${found.g.ref ? found.g.ref + ' ' : ''}${found.g.name}　${fmtD(found.d)}`; }
    else exitBox.classList.add('hidden');
  }
  return { frame, count: D.length };
})();

// ======================================================================= 導航
let NAV = null, navLoading = null;
async function loadNav() {
  if (NAV) return NAV;
  if (!navLoading) navLoading = (async () => {
    const buf = await TW.tileBuf('n', 'nav');
    const jl = new DataView(buf).getUint32(0, true);
    const hd = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
    let o = 4 + jl;
    const A = (C, n) => { const a = new C(buf, o, n); o += n * C.BYTES_PER_ELEMENT; return a; };
    const nw = hd.nw, nn = hd.nn, ne = hd.ne;
    NAV = { nw, nn, ne, dest: hd.dest,
      wXY: A(Int16Array, nw * 4), wNode: A(Uint32Array, nw * 2), nOff: A(Uint32Array, nn + 1), eWay: A(Uint32Array, ne),
      wLen: A(Uint16Array, nw), eS: A(Uint16Array, ne), eI: A(Uint16Array, ne),
      wFlag: A(Uint8Array, nw), wSpd: A(Uint8Array, nw), wCls: A(Uint8Array, nw), wHd: A(Int8Array, nw * 2), eHd: A(Int8Array, ne) };
    return NAV;
  })();
  return navLoading;
}
/** 路段行駛時間 (秒): 依速限；巷道、小路加權 (盡量走大路) */
function tcost(N, g, L) {
  const f = N.wFlag[g], cls = N.wCls[g];
  const mult = (f & 1) ? (cls === 5 ? 1.8 : cls === 4 ? 1.2 : 1) : 0.95;
  return L / (Math.max(N.wSpd[g], 20) / 3.6) * mult;
}
// 二元堆積 (A*)
class Heap {
  constructor() { this.k = []; this.v = []; }
  push(k, v) { const K = this.k, V = this.v; let i = K.length; K.push(k); V.push(v); while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= k) break; K[i] = K[p]; V[i] = V[p]; i = p; } K[i] = k; V[i] = v; }
  pop() {
    const K = this.k, V = this.v, top = V[0], last = K.length - 1, lk = K[last], lv = V[last]; K.pop(); V.pop();
    if (last > 0) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= last) break; if (c + 1 < last && K[c + 1] < K[c]) c++; if (K[c] >= lk) break; K[i] = K[c]; V[i] = V[c]; i = c; } K[i] = lk; V[i] = lv; }
    return top;
  }
  get size() { return this.k.length; }
}
/** 從 (gid, s, dir) 規劃到目標 (gid, s)。回傳 steps: [{ g, dir, sIn, sOut, e (接上這段的接續) }] */
function plan(N, g0, s0, d0, tg, ts) {
  const nw = N.nw, dist = new Float64Array(nw * 2).fill(Infinity), prev = new Int32Array(nw * 2).fill(-1), prevE = new Int32Array(nw * 2).fill(-1);
  const tx = (N.wXY[tg * 4] + N.wXY[tg * 4 + 2]) * 2.5, ty = (N.wXY[tg * 4 + 1] + N.wXY[tg * 4 + 3]) * 2.5;
  const hOf = (g, d) => { const j = d > 0 ? 2 : 0; return Math.hypot(N.wXY[g * 4 + j] * 5 - tx, N.wXY[g * 4 + j + 1] * 5 - ty) / (115 / 3.6); };
  const heap = new Heap();
  let best = Infinity, bestState = -1, bestE = -1;
  const ahead = (d, sFrom, sTo) => d > 0 ? sTo >= sFrom - 1 : sTo <= sFrom + 1;
  // 起點: 目標就在同一條路前方
  if (g0 === tg && ahead(d0, s0, ts)) { best = tcost(N, g0, Math.abs(ts - s0)); bestState = -2; }
  const st0 = g0 * 2 + (d0 < 0 ? 1 : 0);
  dist[st0] = tcost(N, g0, d0 > 0 ? N.wLen[g0] - s0 : s0);
  heap.push(dist[st0] + hOf(g0, d0), st0);
  let iter = 0;
  while (heap.size && iter++ < 600000) {
    const st = heap.pop(), g = st >> 1, d = (st & 1) ? -1 : 1, gs = dist[st];
    if (gs + hOf(g, d) * 0.999 >= best) break;
    const node = N.wNode[g * 2 + (d > 0 ? 1 : 0)];
    if (node === 0xffffffff) continue;
    const hA = N.wHd[g * 2 + (d > 0 ? 1 : 0)], cityA = N.wFlag[g] & 1;
    for (let e = N.nOff[node]; e < N.nOff[node + 1]; e++) {
      const raw = N.eWay[e], o = raw & 0x7fffffff, od = raw & 0x80000000 ? -1 : 1;
      if (o === g) continue;
      const dot = Math.cos((N.eHd[e] - hA) * Math.PI / 128);
      if (dot < ((cityA || (N.wFlag[o] & 1)) ? -0.2 : 0.3)) continue;   // 跟遊戲 chooseNext 一樣的轉彎限制
      const pen = dot < 0.25 ? 9 : dot < 0.8 ? 5 : 0;                   // 路口轉彎要等
      const sE = N.eS[e];
      if (o === tg && ahead(od, sE, ts)) {
        const c = gs + pen + tcost(N, o, Math.abs(ts - sE));
        if (c < best) { best = c; bestState = st; bestE = e; }
      }
      const so = o * 2 + (od < 0 ? 1 : 0), c = gs + pen + tcost(N, o, od > 0 ? N.wLen[o] - sE : sE);
      if (c < dist[so]) { dist[so] = c; prev[so] = st; prevE[so] = e; heap.push(c + hOf(o, od), so); }
    }
  }
  if (bestState === -1) return null;
  // 還原路線
  const steps = [];
  if (bestState === -2) steps.push({ g: g0, dir: d0, sIn: s0, sOut: ts, e: -1 });
  else {
    steps.push({ g: tg, dir: (N.eWay[bestE] & 0x80000000) ? -1 : 1, sIn: N.eS[bestE], sOut: ts, e: bestE });
    let st = bestState;
    while (st >= 0) {
      const g = st >> 1, d = (st & 1) ? -1 : 1, pe = prevE[st];
      steps.push({ g, dir: d, sIn: pe >= 0 ? N.eS[pe] : s0, sOut: d > 0 ? N.wLen[g] : 0, e: pe });
      st = prev[st];
    }
    steps.reverse();
  }
  for (const s of steps) s.len = Math.abs(s.sOut - s.sIn);
  return { steps, time: best, len: steps.reduce((a, s) => a + s.len, 0) };
}
/** 玩家目前所在: { g, s, dir } */
function playerPos() {
  const r = S.road; if (!r) return null;
  const w = r.w, s = w.s[r.i] + r.t * (w.s[Math.min(r.i + 1, w.n - 1)] - w.s[r.i]);
  const dir = (w.city && !w.oneway && Math.cos(S.h) * r.tx + Math.sin(S.h) * r.ty < 0) ? -1 : 1;
  return { g: w.gid, s, dir, w };
}
const route = { dest: null, r: null, cur: 0, off: 0, said: {}, lastPlan: 0, onArrive: null, color: 0x2f9bff };
const navActive = () => !!route.r;
async function navigateTo(dest, opts = {}) {
  const N = await loadNav();
  route.dest = dest; route.onArrive = opts.onArrive || null; route.color = opts.color || 0x2f9bff; route.quiet = !!opts.quiet;
  return replan(true);
}
function replan(first) {
  const N = NAV, p = playerPos();
  if (!N || !p || !route.dest) return false;
  route.lastPlan = performance.now();
  const t0 = performance.now();
  let r = plan(N, p.g, p.s, p.dir, route.dest.g, route.dest.s);
  if (!r && route.dest.x != null) {
    // 目的地剛好在開不進去的路段上 (例如國3 起點前面沒有路接、資料斷掉的單行道): 改用 400 m 內開得到的其他路段當終點
    const dx = route.dest.x, dy = route.dest.y, cand = [];
    for (let g = 0; g < N.nw; g++) {
      if (g === route.dest.g) continue;
      const ax = N.wXY[g * 4] * 5, ay = N.wXY[g * 4 + 1] * 5, bx = N.wXY[g * 4 + 2] * 5, by = N.wXY[g * 4 + 3] * 5;
      const L = Math.hypot(bx - ax, by - ay) || 1, t = Math.max(0, Math.min(1, ((dx - ax) * (bx - ax) + (dy - ay) * (by - ay)) / (L * L)));
      const d = Math.hypot(ax + (bx - ax) * t - dx, ay + (by - ay) * t - dy);
      if (d < 400) cand.push([d, g, t * N.wLen[g]]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    for (const [, g, s] of cand.slice(0, 10)) { r = plan(N, p.g, p.s, p.dir, g, s); if (r) { route.dest.g = g; route.dest.s = s; break; } }
  }
  if (!r) { TW.toast('⚠ 找不到可以到達的路線'); route.r = null; route.dest = null; ribbon.clear(); return false; }
  route.r = r; route.cur = 0; route.off = 0; route.said = {};
  ribbon.dirty = true;
  if (TW.params.has('navdbg')) console.log('[nav] plan', r.steps.length, 'steps', (r.len / 1000).toFixed(1), 'km', (r.time / 60).toFixed(1), 'min', (performance.now() - t0).toFixed(0), 'ms');
  if (!route.quiet) {
    if (first) { voice.say(`開始導航，全程${(r.len / 1000).toFixed(r.len > 10000 ? 0 : 1)}公里`); TW.toast(`🧭 導航到 ${route.dest.name}：${(r.len / 1000).toFixed(1)} 公里，約 ${Math.max(1, Math.round(r.time / 60))} 分鐘`, 3000); }
    else voice.say('重新規劃路線');
  }
  return true;
}
function stopNav(msg) {
  route.r = null; route.dest = null; ribbon.clear(); navBox.classList.add('hidden');
  if (msg) TW.toast(msg);
}
// 自動駕駛在路口優先走導航路線的下一段
TW.HOOKS.navBias = (w, o) => {
  const r = route.r; if (!r) return 0;
  for (let j = Math.max(0, route.cur - 1); j < Math.min(r.steps.length - 1, route.cur + 4); j++) {
    if (r.steps[j].g !== w.gid) continue;
    const nx = r.steps[j + 1];
    if (nx.g === o.o.gid && nx.dir === o.dir) return 40;
  }
  return 0;
};
// 轉彎方式: 抵達方位 -> 接續方位
function maneuver(k) {
  const N = NAV, r = route.r, a = r.steps[k - 1], b = r.steps[k];
  if (!a || !b || b.e < 0) return null;
  const hA = N.wHd[a.g * 2 + (a.dir > 0 ? 1 : 0)];
  let dlt = (N.eHd[b.e] - hA) * Math.PI / 128; dlt = Math.atan2(Math.sin(dlt), Math.cos(dlt));   // 正 = 左
  const deg = dlt * 180 / Math.PI, fa = N.wFlag[a.g], fb = N.wFlag[b.g];
  const city = (fa & 1) || (fb & 1), toLink = !(fa & 4) && (fb & 4) && !(fb & 1), fromLink = (fa & 4) && !(fb & 4) && !(fb & 1);
  const L = deg > 0;
  const w = TW.wayByGid(b.g), name = w ? TW.roadLabel(w) : '';
  if (toLink && !(fa & 1)) return { arr: L ? '↖' : '↗', txt: L ? '靠左 駛出' : '靠右 駛出', name: (w && w.name) || '出口', big: true };
  if (fromLink && !(fa & 1)) return { arr: '⬆', txt: '併入主線', name, big: false };
  const ad = Math.abs(deg);
  if (ad < 22) {
    if (city && w && TW.wayByGid(a.g) && w.name && w.name !== TW.wayByGid(a.g).name && ad > 8) return { arr: L ? '↖' : '↗', txt: L ? '靠左' : '靠右', name, big: false };
    return null;
  }
  if (ad < 60) return { arr: L ? '↖' : '↗', txt: L ? '靠左' : '靠右', name, big: city };
  if (ad < 140) return { arr: L ? '⬅' : '➡', txt: L ? '左轉' : '右轉', name, big: true };
  return { arr: '↩', txt: '迴轉', name, big: true };
}
const zhNum = (m) => m >= 1000 ? (m / 1000).toFixed(m >= 2000 ? 0 : 1).replace('.0', '') + '公里' : (Math.round(m / 50) * 50) + '公尺';
let navClock = 0;
function navFrame(dt) {
  ribbon.frame(dt);
  const r = route.r; if (!r) return;
  navClock -= dt; if (navClock > 0) return; navClock = 0.25;
  const p = playerPos(); if (!p) return;
  // 目前在路線的第幾段
  let found = -1;
  for (let j = route.cur; j < Math.min(r.steps.length, route.cur + 5); j++) if (r.steps[j].g === p.g && (r.steps[j].dir === p.dir || !p.w.city)) { found = j; break; }
  if (found >= 0) { if (found !== route.cur) ribbon.dirty = true; route.cur = found; route.off = 0; }
  else {
    route.off += 0.25;
    if (route.off > 2.5 && performance.now() - route.lastPlan > 3000) { replan(false); return; }
  }
  const st = r.steps[route.cur];
  const sNow = found >= 0 ? p.s : st.sIn;
  const leftOnStep = Math.max(0, st.dir > 0 ? st.sOut - sNow : sNow - st.sOut);
  let total = leftOnStep, rest = 0;
  for (let j = route.cur + 1; j < r.steps.length; j++) rest += r.steps[j].len;
  total += rest;
  // 抵達
  if (route.cur === r.steps.length - 1 && leftOnStep < 25) {
    const cb = route.onArrive, name = route.dest.name;
    stopNav(); voice.say('已抵達目的地'); TW.toast('🏁 已抵達：' + name);
    if (TW.autopilot) TW.autopilot = false;
    if (cb) cb();
    return;
  }
  // 下一個要轉彎的地方
  let m = null, md = leftOnStep, mk = -1;
  for (let k = route.cur + 1; k < r.steps.length && md < 30000; k++) { m = maneuver(k); if (m) { mk = k; break; } md += r.steps[k].len; }
  navBox.classList.remove('hidden');
  const eta = (r.time * total / Math.max(r.len, 1));
  if (m) {
    navBox.innerHTML = `<div class="arr">${m.arr}</div><div><b>${fmtD(md)}　${m.txt}</b><span>${m.name ? (m.txt.includes('駛出') ? '往 ' : '進入 ') + m.name : ''}</span><small>剩 ${fmtD(total)} · 約 ${Math.max(1, Math.round(eta / 60))} 分 · ${route.dest.name}</small></div>`;
    // 語音: 國道 1 km / 300 m，一般道路 300 / 80 m
    const fw = !(NAV.wFlag[r.steps[mk].g] & 1) || !(NAV.wFlag[r.steps[mk - 1].g] & 1);
    const marks = fw ? [1000, 300] : [300, 80];
    for (const mk2 of marks) {
      const key = mk + ':' + mk2;
      if (md < mk2 && md > mk2 * 0.4 && !route.said[key]) { route.said[key] = 1; if (!route.quiet) voice.say(`前方${zhNum(md)}，${m.txt}${m.name ? '，' + (m.txt.includes('駛出') ? '往' : '進入') + m.name : ''}`); }
    }
  } else navBox.innerHTML = `<div class="arr">⬆</div><div><b>繼續直行 ${fmtD(total)}</b><small>約 ${Math.max(1, Math.round(eta / 60))} 分 · ${route.dest.name}</small></div>`;
}
// ---- 路線地面引導線 (青藍色箭頭帶，鋪在行進方向車道中央，只畫前方 1.2 km 已載入的路段)
const ribbon = (() => {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
  const x = cv.getContext('2d'); x.fillStyle = 'rgba(255,255,255,0.55)'; x.fillRect(0, 0, 64, 128);
  x.fillStyle = '#fff'; x.beginPath(); x.moveTo(8, 100); x.lineTo(32, 40); x.lineTo(56, 100); x.lineTo(44, 100); x.lineTo(32, 70); x.lineTo(20, 100); x.closePath(); x.fill();
  const tex = new T.CanvasTexture(cv); tex.wrapS = tex.wrapT = T.RepeatWrapping; tex.colorSpace = T.SRGBColorSpace;
  const mat = new T.MeshBasicMaterial({ map: tex, color: 0x2f9bff, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false });
  let mesh = null, lastX = 0, lastY = 0, beam = null;
  const beamMat = new T.MeshBasicMaterial({ color: 0x2f9bff, transparent: true, opacity: 0.35, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, toneMapped: false });
  function clear() { if (mesh) { TW.scene.remove(mesh); mesh.geometry.dispose(); mesh = null; } if (beam) { TW.scene.remove(beam); beam = null; } }
  function rebuild() {
    clear();
    const r = route.r; if (!r) return;
    mat.color.setHex(route.color); beamMat.color.setHex(route.color);
    const pts = [], p = playerPos();
    let budget = 1200;
    for (let j = route.cur; j < r.steps.length && budget > 0; j++) {
      const st = r.steps[j], w = TW.wayByGid(st.g); if (!w) break;
      const lc = TW.laneCount(w);
      const off = w.city ? (w.oneway ? 0 : (st.dir > 0 ? -1 : 1) * w.width / 4) : (w.link && w.lanes === 1 ? 0 : w.hw - w.ls - TW.LANE_W * lc / 2);
      let sFrom = st.sIn; if (j === route.cur && p && p.g === st.g) sFrom = p.s;
      const sTo = st.sOut, d = st.dir;
      const lo = Math.min(sFrom, sTo), hi = Math.max(sFrom, sTo);
      const idx = []; for (let i = 0; i < w.n; i++) if (w.s[i] > lo && w.s[i] < hi) idx.push(i);
      if (d < 0) idx.reverse();
      const at = (s) => { let i = 0; while (i < w.n - 2 && w.s[i + 1] < s) i++; const t = (s - w.s[i]) / ((w.s[i + 1] - w.s[i]) || 1); return [i, t]; };
      const push = (i, t) => {
        const P = w.P, i2 = Math.min(i + 1, w.n - 1);
        const X = P[i * 3] + (P[i2 * 3] - P[i * 3]) * t, Y = P[i * 3 + 1] + (P[i2 * 3 + 1] - P[i * 3 + 1]) * t, Z = P[i * 3 + 2] + (P[i2 * 3 + 2] - P[i * 3 + 2]) * t;
        const nx = w.nx[i] + (w.nx[i2] - w.nx[i]) * t, ny = w.ny[i] + (w.ny[i2] - w.ny[i]) * t;
        const q = [X + nx * off, Y + ny * off, Z + 0.14];
        const L = pts.length ? Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) : 0;
        if (pts.length && L < 0.5) return;
        pts.push(q); budget -= L;
      };
      push(...at(sFrom));
      for (const i of idx) { push(i, 0); if (budget <= 0) break; }
      push(...at(sTo));
    }
    if (pts.length >= 2) {
      const pos = [], uv = [], ind = [];
      let u = 0;
      for (let k = 0; k < pts.length; k++) {
        const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
        let tx = b[0] - a[0], ty = b[1] - a[1]; const L = Math.hypot(tx, ty) || 1; tx /= L; ty /= L;
        if (k) u += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        const hw = 0.55, [X, Y, Z] = pts[k];
        pos.push(X - ty * hw, Z, -(Y + tx * hw), X + ty * hw, Z, -(Y - tx * hw));
        uv.push(0, u / 2.4, 1, u / 2.4);
        if (k) { const o = (k - 1) * 2; ind.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.setIndex(ind);
      mesh = new T.Mesh(g, mat); mesh.frustumCulled = false; mesh.renderOrder = 2; TW.scene.add(mesh);
    }
    // 目的地光柱
    const dw = TW.wayByGid(route.dest.g);
    if (dw) {
      let i = 0; while (i < dw.n - 2 && dw.s[i + 1] < route.dest.s) i++;
      beam = new T.Mesh(new T.CylinderGeometry(2.5, 2.5, 220, 16, 1, true), beamMat);
      beam.position.set(dw.P[i * 3], dw.P[i * 3 + 2] + 110, -dw.P[i * 3 + 1]); TW.scene.add(beam);
    }
  }
  let clock = 0;
  const o = { dirty: false, clear, frame(dt) {
    tex.offset.y -= dt * 0.9;
    clock -= dt;
    if (!route.r) return;
    if (o.dirty || (clock <= 0 && Math.hypot(S.x - lastX, S.y - lastY) > 40)) { o.dirty = false; clock = 0.5; lastX = S.x; lastY = S.y; rebuild(); }
  } };
  return o;
})();
// 小地圖: 路線 (已載入的路段照實際路形，還沒載入的用端點連線) + 目的地
TW.HOOKS.minimap.push((c, s) => {
  const r = route.r; if (!r || !NAV) return;
  c.strokeStyle = '#' + route.color.toString(16).padStart(6, '0'); c.lineWidth = 5 / s; c.lineCap = 'round'; c.lineJoin = 'round';
  c.beginPath(); let started = false;
  const lt = (x, y) => { if (!started) { c.moveTo(x - S.x, y - S.y); started = true; } else c.lineTo(x - S.x, y - S.y); };
  for (let j = route.cur; j < r.steps.length; j++) {
    const st = r.steps[j], w = TW.wayByGid(st.g);
    if (w) {
      const lo = Math.min(st.sIn, st.sOut), hi = Math.max(st.sIn, st.sOut), idx = [];
      for (let i = 0; i < w.n; i++) if (w.s[i] >= lo - 1 && w.s[i] <= hi + 1) idx.push(i);
      if (st.dir < 0) idx.reverse();
      for (const i of idx) lt(w.P[i * 3], w.P[i * 3 + 1]);
    } else {
      const a = st.dir > 0 ? 0 : 2, b = st.dir > 0 ? 2 : 0;
      lt(NAV.wXY[st.g * 4 + a] * 5, NAV.wXY[st.g * 4 + a + 1] * 5); lt(NAV.wXY[st.g * 4 + b] * 5, NAV.wXY[st.g * 4 + b + 1] * 5);
    }
  }
  c.stroke();
  const d = route.dest;
  c.beginPath(); c.arc(d.x - S.x, d.y - S.y, 7 / s, 0, Math.PI * 2); c.fillStyle = '#ff4b3a'; c.fill(); c.lineWidth = 2 / s; c.strokeStyle = '#fff'; c.stroke();
});
// 點小地圖設定目的地
$('minimap').addEventListener('click', async (e) => {
  const rc = e.currentTarget.getBoundingClientRect(), R = TW.MAP_PX / 2;
  const xs = (e.clientX - rc.left) / rc.width * TW.MAP_PX - R, ys = (e.clientY - rc.top) / rc.height * TW.MAP_PX - R;
  if (Math.hypot(xs, ys) > R) return;
  const s = TW.mapScale, sh = Math.sin(S.h), ch = Math.cos(S.h);
  const wx = S.x + (sh * xs - ch * ys) / s, wy = S.y - (ch * xs + sh * ys) / s;
  // 最近的已載入路段
  let best = null, bd = 60 * 60;
  for (const w of TW.WAYS) {
    if (w.bb[2] < wx - 60 || w.bb[0] > wx + 60 || w.bb[3] < wy - 60 || w.bb[1] > wy + 60) continue;
    for (let i = 0; i < w.n; i++) { const d = (w.P[i * 3] - wx) ** 2 + (w.P[i * 3 + 1] - wy) ** 2; if (d < bd) { bd = d; best = [w, i]; } }
  }
  if (!best) { TW.toast('那裡沒有道路，點靠近道路的地方'); return; }
  const [w, i] = best;
  TW.toast('🧭 規劃路線中…');
  await navigateTo({ g: w.gid, s: w.s[Math.min(i, w.n - 1)], x: w.P[i * 3], y: w.P[i * 3 + 1], name: TW.roadLabel(w) || '地圖上的點' });
});

// ======================================================================= 任務
const missions = (() => {
  let wallet = store.get('tw_wallet', 0), done = store.get('tw_done', 0), active = null;
  let gt = 0;   // 遊戲時間 (切到別的分頁、畫面卡頓時不會白白扣送貨時間)
  const pay = (n, why) => { wallet += n; store.set('tw_wallet', wallet); if (n > 0) { sfx.coin(); done++; store.set('tw_done', done); } TW.toast(`${n >= 0 ? '💰 +' : '💸 '}NT$${Math.abs(n).toLocaleString()}　${why}`, 3500); };
  const bumps = () => (TWX.stats.bumps || 0);
  async function pickDest(minKm, maxKm, kinds) {
    const N = await loadNav();
    const c = N.dest.filter((d) => kinds.includes(d[1]) && Math.hypot(d[4] - S.x, d[5] - S.y) > minKm * 1000 && Math.hypot(d[4] - S.x, d[5] - S.y) < maxKm * 1000);
    if (!c.length) return null;
    const d = c[(Math.random() * c.length) | 0];
    return { name: d[0], g: d[2], s: 0, i: d[3], x: d[4], y: d[5], kind: d[1] };
  }
  // 目的地在路段上的距離 s: nav 沒存每個點，用目的地座標投影到路段起訖連線上估
  function fixS(d) {
    const N = NAV, g = d.g, ax = N.wXY[g * 4] * 5, ay = N.wXY[g * 4 + 1] * 5, bx = N.wXY[g * 4 + 2] * 5, by = N.wXY[g * 4 + 3] * 5;
    const L = Math.hypot(bx - ax, by - ay) || 1, t = Math.max(0, Math.min(1, ((d.x - ax) * (bx - ax) + (d.y - ay) * (by - ay)) / (L * L)));
    d.s = t * N.wLen[g]; return d;
  }
  async function start(kind) {
    if (active) abort(true);
    if (!S.road) { TW.toast('先回到路上 (R)'); return; }
    TW.toggleMenu(false);
    if (kind === 'deliver') {
      const d = await pickDest(4, 25, ['place', 'station', 'exit', 'services']);
      if (!d) { TW.toast('附近找不到目的地'); return; }
      fixS(d);
      const a = active = { kind, title: '📦 送貨', dest: d, t0: gt, b0: bumps(), tickets: 0 };
      const ok = await navigateTo(d, { onArrive: finish, color: 0x3fd07a });
      if (active !== a) return;   // 算路線途中按了放棄 / 開了別的任務
      if (!ok || !route.r) { active = null; render(); return; }
      a.limit = route.r.time * 1.4 + 60; a.t0 = gt;
      a.km = route.r.len / 1000;
      voice.say(`送貨任務，送到${d.name}，限時${Math.round(a.limit / 60)}分鐘`);
    } else if (kind === 'taxi') {
      // 乘客在附近 (已載入的一般道路，前方 200~1200 m)
      const cand = [];
      for (const w of TW.WAYS) {
        if (!w.city || w.cls > 4 || w.cls < 2) continue;
        const i = Math.floor(w.n / 2), dx = w.P[i * 3] - S.x, dy = w.P[i * 3 + 1] - S.y, d = Math.hypot(dx, dy);
        if (d > 250 && d < 1300 && Math.abs(w.P[i * 3 + 2] - S.z) < 20) cand.push([w, i]);
      }
      if (!cand.length) { TW.toast('附近沒有乘客，開到市區再試'); return; }
      await loadNav();
      const [w, i] = cand[(Math.random() * cand.length) | 0];
      const pk = { g: w.gid, s: w.s[i], x: w.P[i * 3], y: w.P[i * 3 + 1], name: '乘客 (' + (w.name || '路邊') + ')' };
      active = { kind, title: '🚕 計程車載客', stage: 'pickup', pk, t0: performance.now(), b0: bumps(), tickets: 0, odo: 0, slow: 0, hold: 0 };
      if (S.vtype !== 'taxi') TW.toast('提示：按 G 或選單換成計程車更有感覺', 2500);
      const a = active;
      await navigateTo(pk, { color: 0xf2c200, quiet: true });
      if (active !== a) return;
      voice.say('有乘客叫車，請到路邊載客');
    } else if (kind === 'legal') {
      active = { kind, title: '👮 守法駕駛', need: 8000, odo: 0, over: 0, b0: bumps(), tickets: 0, t0: performance.now() };
      voice.say('守法駕駛挑戰，連續八公里不超速、不碰撞');
    }
    render();
  }
  function finish() {
    const a = active; if (!a) return;
    if (a.kind === 'deliver') {
      const t = gt - a.t0, left = a.limit - t, hits = bumps() - a.b0;
      if (left < 0) { pay(0, '送貨超時，沒有報酬'); }
      else pay(Math.max(100, Math.round(300 + a.km * 60 + left * 2 - hits * 80 - a.tickets * 500)), `送達 ${a.dest.name}（剩 ${fmtT(left)}，碰撞 ${hits}）`);
      active = null;
    } else if (a.kind === 'taxi' && a.stage === 'ride') {
      const hits = bumps() - a.b0, fare = taxiFare(a), tip = hits === 0 && a.tickets === 0 ? Math.round(fare * 0.15 / 5) * 5 : 0;
      voice.say(`到了，車資${fare}元`);
      pay(fare + tip, `車資 ${fare} 元${tip ? ' + 小費 ' + tip : ''}`);
      active = null;
    }
    render();
  }
  const taxiFare = (a) => { const km = a.odo / 1000; return 85 + Math.max(0, Math.ceil((km - 1.25) / 0.2)) * 5 + Math.floor(a.slow / 100) * 5; };   // 台北市費率 (簡化)
  function abort(silent) { if (!active) return; if (navActive()) stopNav(); active = null; if (!silent) TW.toast('任務已放棄'); render(); }
  let clock = 0;
  function frame(dt) {
    gt += dt;
    const a = active; if (!a) return;
    if (a.kind === 'taxi') {
      if (a.stage === 'ride') { a.odo += Math.abs(S.v) * dt; if (kmh() < 5) a.slow += dt; }
      if (a.stage === 'pickup') {
        const d = Math.hypot(a.pk.x - S.x, a.pk.y - S.y);
        a.hold = d < 18 && kmh() < 5 ? a.hold + dt : 0;
        if (a.hold > 1.5) {
          a.stage = 'boarding'; stopNav();
          pickDest(2, 12, ['place', 'station']).then((dd) => {
            if (!dd || active !== a) { abort(true); return; }
            fixS(dd); a.dest = dd; a.stage = 'ride'; a.odo = 0; a.slow = 0;
            voice.say(`乘客上車，要去${dd.name}`); TW.toast('🚕 乘客上車：要去 ' + dd.name, 3000);
            navigateTo(dd, { onArrive: finish, color: 0xf2c200 });
          });
        }
      }
    }
    if (a.kind === 'legal') {
      a.odo += Math.abs(S.v) * dt;
      const lim = S.road ? TW.speedLimit(S.road.w) : 100;
      a.over = kmh() > lim + 5 ? a.over + dt : 0;
      if (a.over > 3 || bumps() > a.b0 || a.tickets) { TW.toast('❌ 守法駕駛失敗：' + (a.over > 3 ? '超速' : a.tickets ? '被測速照相拍到' : '發生碰撞')); voice.say('挑戰失敗'); active = null; render(); return; }
      if (a.odo >= a.need) { active = null; pay(600, '守法駕駛 8 公里完成'); render(); return; }
    }
    clock -= dt; if (clock <= 0) { clock = 0.3; render(); }
  }
  function render() {
    const a = active;
    if (!a) { missionBox.classList.add('hidden'); missionBox._for = null; return; }
    missionBox.classList.remove('hidden');
    let body = '';
    if (a.kind === 'deliver') {
      const t = gt - a.t0, left = a.limit ? a.limit - t : 0;
      body = !a.limit ? `送到 <b>${a.dest.name}</b><br>規劃路線中…` : `送到 <b>${a.dest.name}</b><div class="big" style="color:${left < 30 ? '#ff5a4a' : '#fff'}">${fmtT(left)}</div>碰撞 ${bumps() - a.b0}　罰單 ${a.tickets}`;
    } else if (a.kind === 'taxi') {
      body = a.stage === 'pickup' ? `到路邊載客：<b>${a.pk.name}</b><br>靠近後停車 (時速 5 以下)`
        : a.stage === 'boarding' ? '乘客上車中…' : `送乘客到 <b>${a.dest.name}</b><div class="big">NT$ ${taxiFare(a)}</div>${(a.odo / 1000).toFixed(2)} 公里`;
    } else if (a.kind === 'legal') {
      body = `連續 8 公里不超速 (速限 +5 內)、不碰撞<div class="bar"><i style="width:${Math.min(100, a.odo / a.need * 100)}%"></i></div>${(a.odo / 1000).toFixed(2)} / 8 公里${a.over > 0 ? '　<b style="color:#ff5a4a">超速！</b>' : ''}`;
    }
    if (missionBox._for !== a) {
      missionBox._for = a;
      missionBox.innerHTML = `<h4>${a.title}</h4><div id="ms-body"></div><button id="ms-abort">放棄任務</button>`;
      $('ms-abort').onclick = () => abort();
    }
    $('ms-body').innerHTML = body;
  }
  // ETC 等扣款: 不算完成任務、不跳金額提示 (由呼叫端自己顯示)
  const charge = (n) => { wallet -= n; store.set('tw_wallet', wallet); };
  return { start, frame, abort, charge, get active() { return active; }, get wallet() { return wallet; }, get done() { return done; } };
})();

// ======================================================================= ETC 通行費 (國道計程收費)
// 費率 (高公局現行): 小型車 1.2 元/km、大型車 1.5、聯結車 1.8；每車每日前 20 公里免費，超過 200 公里的部分打 75 折。
// 每座門架收「它負責的那一段」: 用同一條國道、同方向的前一座門架到這一座的距離 (資料: live.json etc，m = 里程公尺)。
const etc = (() => {
  const L = extra('live'), list = (L && L.etc) || [], byWay = new Map(), seg = new Map();
  for (const g of list) { if (!byWay.has(g.way)) byWay.set(g.way, []); byWay.get(g.way).push(g); }
  // 每座門架負責的路段長
  const grp = new Map();
  for (const g of list) { const k = g.road + g.dir; if (!grp.has(k)) grp.set(k, []); grp.get(k).push(g); }
  for (const arr of grp.values()) {
    arr.sort((a, b) => a.m - b.m);
    const inc = !/N|W/.test(arr[0].dir);   // 南下 / 東向里程遞增
    arr.forEach((g, i) => { const p = inc ? arr[i - 1] : arr[i + 1]; seg.set(g.id, p ? Math.min(15000, Math.max(500, Math.abs(g.m - p.m))) : 2000); });
  }
  const RATE = { small: [1.2, 0.9], big: [1.5, 1.13], trailer: [1.8, 1.35] };
  // 車種 (高公局): 小型車 = 小客車、小貨車 (3.5 噸貨車總重 3.5 噸以下算小貨車)；大型車 = 大客車、大貨車；聯結車 = 聯結車
  const cls = () => ['citybus', 'coach', 'minibus', 'bigtruck'].includes(S.vtype) ? 'big' : S.vtype === 'semi' ? 'trailer' : 'small';
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  let day = store.get('tw_etc', null);
  const fresh = () => { if (!day || day.d !== today()) day = { d: today(), km: { small: 0, big: 0, trailer: 0 }, paid: 0, n: 0 }; return day; };
  function feeOf(d) {   // 今日應付總額 (各車種分開算，四捨五入到元)
    let f = 0;
    for (const c of Object.keys(RATE)) {
      const km = d.km[c] || 0, [r1, r2] = RATE[c];
      f += Math.max(0, Math.min(km, 200) - 20) * r1 + Math.max(0, km - 200) * r2;
    }
    return Math.round(f);
  }
  let last = null;   // { gid, s } 上一格的位置
  const recent = new Map();   // 門架 id -> 上次收費的里程 (同一座 2 公里內不重複收；在門架下倒車、來回也不會一直扣)
  let odo = 0;
  function frame() {
    const r = S.road;
    if (!r || r.w.city || S.vtype === 'scooter') { last = null; return; }
    const w = r.w, s = w.s[r.i] + (w.s[r.i + 1] - w.s[r.i]) * r.t, gs = byWay.get(w.gid);
    if (last && last.gid === w.gid) odo += Math.abs(s - last.s);
    if (gs && last && last.gid === w.gid && Math.abs(s - last.s) < 60 && s > last.s) {   // 只算順向通過
      for (const g of gs) {
        // 門架剛好在路段頭尾: 車子在端點附近就會換到下一段路，夾到離端點 3 公尺內才收得到
        const len = w.s[w.n - 1], e = Math.min(3, len / 2), at = Math.min(Math.max(w.s[Math.min(g.idx, w.n - 1)], e), len - e);
        if (last.s < at && s >= at && !(odo - (recent.get(g.id) ?? -1e9) < 2000)) { recent.set(g.id, odo); pass(g); }
      }
    }
    last = { gid: w.gid, s };
  }
  function pass(g) {
    const d = fresh(), c = cls(), km = seg.get(g.id) / 1000;
    d.km[c] += km; d.n++;
    const due = feeOf(d), add = due - d.paid; d.paid = due;
    store.set('tw_etc', d);
    if (add > 0) missions.charge(add);
    sfx.beep();
    const tot = Object.values(d.km).reduce((a, b) => a + b, 0);
    if (TEST) console.log('[etc]', g.id, km.toFixed(1), 'km; today', tot.toFixed(1), 'km NT$' + due, 'wallet', missions.wallet);
    TW.toast(`🛣 ETC 嗶　門架 ${g.id}　本段 ${km.toFixed(1)} 公里　今日 ${tot.toFixed(1)} 公里 · NT$${due}${tot <= 20 ? '（前 20 公里免費）' : ''}`, 2600);
  }
  return { frame, get today() { return fresh(); }, feeOf, count: list.length };
})();

// ======================================================================= 選單: 導航 / 任務 / 駕駛與天氣
(() => {
  const menu = $('menu'); if (!menu) return;
  const sec = el('div', { className: 'gp' });
  sec.innerHTML = `
    <h2>🧭 導航</h2>
    <input type="search" id="nav-q" placeholder="搜尋地名、交流道、車站、服務區… (也可以直接點小地圖)" autocomplete="off">
    <div class="list" id="nav-list"></div>
    <div class="grid"><button id="nav-stop">取消導航</button></div>
    <h2>🎯 任務</h2>
    <div class="wallet" id="ms-wallet"></div>
    <div class="grid">
      <button data-ms="deliver">📦 送貨：限時送到 4~25 公里外</button>
      <button data-ms="taxi">🚕 計程車：載附近的乘客，照表收費</button>
      <button data-ms="legal">👮 守法駕駛：8 公里不超速、不碰撞</button>
    </div>
    <h2>🚗 駕駛</h2>
    <div class="grid">
      <button id="gp-man"></button><button id="gp-cruise">定速巡航 (I)</button><button id="gp-fs">⛶ 全螢幕</button>
      <button id="gp-weather"></button><button id="gp-voice"></button><button id="gp-cam"></button>
    </div>
    <div class="note" id="gp-tickets"></div>`;
  menu.insertBefore(sec, menu.children[1]);
  const icon = { place: '🏙', station: '🚉', services: '⛽', exit: '↗', spot: '📍' };
  async function fill() {
    const q = $('nav-q').value.trim(), list = $('nav-list');
    if (!NAV) { list.innerHTML = '<p class="note">載入路網中…</p>'; await loadNav().catch(() => { list.innerHTML = '<p class="note">路網載入失敗</p>'; }); if (!NAV) return; }
    let items = NAV.dest.map((d) => [d, Math.hypot(d[4] - S.x, d[5] - S.y)]);
    if (q) items = items.filter(([d]) => d[0].includes(q));
    items.sort((a, b) => (q ? (a[0][0].startsWith(q) ? 0 : 1) - (b[0][0].startsWith(q) ? 0 : 1) : 0) || a[1] - b[1]);
    list.innerHTML = '';
    for (const [d, dist] of items.slice(0, 40)) {
      const b = el('button', {}, `${icon[d[1]] || '📍'} ${d[0]}<small>${(dist / 1000).toFixed(dist < 10000 ? 1 : 0)} km</small>`);
      b.onclick = async () => {
        TW.toggleMenu(false);
        const dd = { name: d[0], g: d[2], i: d[3], x: d[4], y: d[5], s: 0 };
        const N = NAV, g = dd.g, ax = N.wXY[g * 4] * 5, ay = N.wXY[g * 4 + 1] * 5, bx = N.wXY[g * 4 + 2] * 5, by = N.wXY[g * 4 + 3] * 5;
        const L = Math.hypot(bx - ax, by - ay) || 1; dd.s = Math.max(0, Math.min(1, ((dd.x - ax) * (bx - ax) + (dd.y - ay) * (by - ay)) / (L * L))) * N.wLen[g];
        if (!S.road) { TW.toast('先回到路上 (R)'); return; }
        await navigateTo(dd);
      };
      list.appendChild(b);
    }
    if (!items.length) list.innerHTML = '<p class="note">找不到符合的地點</p>';
  }
  $('nav-q').addEventListener('input', fill);
  $('nav-q').addEventListener('keydown', (e) => e.stopPropagation());
  $('nav-stop').onclick = () => { stopNav('導航已取消'); TW.toggleMenu(false); };
  for (const b of sec.querySelectorAll('[data-ms]')) b.onclick = () => missions.start(b.dataset.ms);
  const sync = () => {
    $('gp-man').textContent = '⚙️ ' + (S.manual ? '手排 (B 切換)' : '自排 (B 切換)');
    $('gp-weather').textContent = '🌦 天氣：' + weather.name + ' (Y)';
    $('gp-voice').textContent = '🔊 語音提示：' + (voice.on ? '開' : '關');
    $('gp-cam').textContent = '📷 測速提醒：' + (cams.on ? '開' : '關');
    const ed = etc.today, ekm = Object.values(ed.km).reduce((a, b) => a + b, 0);
    $('ms-wallet').innerHTML = `💰 NT$ ${missions.wallet.toLocaleString()}　完成任務 ${missions.done} 個<br><small style="opacity:.7">🛣 今日 ETC：${ekm.toFixed(1)} 公里，通行費 NT$${ed.paid}（每日前 20 公里免費）</small>`;
    const tk = cams.tickets;
    $('gp-tickets').textContent = tk.length ? `罰單 ${tk.length} 張，共 NT$${tk.reduce((a, t) => a + t.f, 0).toLocaleString()}（最近：${tk[tk.length - 1].where} 限速 ${tk[tk.length - 1].max} 開 ${tk[tk.length - 1].spd}）` : '目前沒有罰單 👍';
  };
  $('gp-man').onclick = () => { TW.toggleManual(); sync(); };
  $('gp-cruise').onclick = () => { TW.toggleMenu(false); TW.toggleCruise(); };
  $('gp-fs').onclick = () => { toggleFullscreen(); };
  $('gp-weather').onclick = () => { weather.cycle(); sync(); };
  $('gp-voice').onclick = () => { voice.on = !voice.on; store.set('tw_voice', voice.on); sync(); if (voice.on) voice.say('語音提示開啟', true); };
  $('gp-cam').onclick = () => { cams.on = !cams.on; sync(); };
  // 選單打開時更新
  new MutationObserver(() => { if (!menu.classList.contains('hidden')) { sync(); fill(); } }).observe(menu, { attributes: true, attributeFilter: ['class'] });
})();

// 右上角按鈕 (電腦) 與觸控列
(() => {
  const bar = el('div', { id: 'gp-btns' });
  bar.innerHTML = '<button id="gp-b-ctrl" title="操控設定">🛞 操控</button><button id="gp-b-w" title="天氣 (Y)">🌦</button><button id="gp-b-fs" title="全螢幕">⛶</button>';
  document.body.appendChild(bar);
  $('gp-b-ctrl').onclick = () => TWX.controls.openGuide();
  $('gp-b-w').onclick = () => weather.cycle();
  $('gp-b-fs').onclick = toggleFullscreen;
  const row = document.querySelector('#touch .row');
  if (row) {
    const add = (html, fn, cls = '', parent = row) => { const b = el('div', { className: 'tb ' + cls }, html); b.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); }); parent.appendChild(b); return b; };
    add('全螢幕', toggleFullscreen); add('天氣', () => weather.cycle()); add('定速', () => TW.toggleCruise());
    // 手排的升 / 降檔放在煞車正上方 (右手拇指順手，也不會被任務框蓋住)
    add('升檔 ▲', () => TW.shift(1), 'gp-man gp-up', row.parentNode); add('降檔 ▼', () => TW.shift(-1), 'gp-man gp-dn', row.parentNode);
  }
})();
TW.HOOKS.key.push((e) => {
  if (e.code === 'KeyY') weather.cycle();
  if (e.code === 'F11' && (document.documentElement.requestFullscreen)) { e.preventDefault(); toggleFullscreen(); }
});

// ======================================================================= 掛上主程式
TW.HOOKS.frame.push((dt) => {
  weather.frame(dt); cams.frame(dt); distSigns.frame(dt); navFrame(dt); missions.frame(dt);
  document.body.classList.toggle('manual', !!S.manual && S.vtype !== 'scooter');
});
if (!TW.params.has('noetc')) TW.HOOKS.update.push(() => etc.frame());   // 物理更新後檢查有沒有通過 ETC 門架 (測試模式 ?t 也會跑)
// 測試: ?navtest=目的地名稱 自動規劃並開自動駕駛；?weather=大雨
if (TW.params.get('navtest')) setTimeout(async () => {
  const N = await loadNav(), q = TW.params.get('navtest');
  const d = N.dest.find((x) => x[0].includes(q));
  if (!d) { console.log('[navtest] no dest', q); return; }
  const dd = { name: d[0], g: d[2], i: d[3], x: d[4], y: d[5], s: 0 };
  const g = dd.g, ax = N.wXY[g * 4] * 5, ay = N.wXY[g * 4 + 1] * 5, bx = N.wXY[g * 4 + 2] * 5, by = N.wXY[g * 4 + 3] * 5;
  const L = Math.hypot(bx - ax, by - ay) || 1; dd.s = Math.max(0, Math.min(1, ((dd.x - ax) * (bx - ax) + (dd.y - ay) * (by - ay)) / (L * L))) * N.wLen[g];
  const t0 = performance.now(); const ok = await navigateTo(dd);
  console.log('[navtest]', d[0], 'ok', ok, route.r ? route.r.steps.length + ' steps ' + (route.r.len / 1000).toFixed(1) + ' km ' + (route.r.time / 60).toFixed(1) + ' min' : '', (performance.now() - t0).toFixed(0) + 'ms');
}, 4000);
window.TWG = { weather, cams, etc, distSigns, missions, route, navigateTo, stopNav, loadNav, plan, toggleFullscreen, voice };
})();

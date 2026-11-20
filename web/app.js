/* 台灣 1:1 — 國道台北段 駕駛模擬
 * 材質與 Blender 版 (scripts/build_freeway_blender.py) 使用相同公式與顏色 (線性色彩空間)。
 * 座標: 資料 (x 東, y 北, z 上) 公尺 -> three.js (x, z, -y)
 */
(function () {
'use strict';
const T = window.THREE;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const setStatus = (s) => { const el = $('loading-msg'); if (el) el.textContent = s; };

// ======================================================================= 資料 (分區載入)
// tiles/index.json: 全域資訊；tiles/t/*.bin: 地形；tiles/d/*.bin: 路段 + 橋墩 + 建築 (scripts/tile_web.py)
// 單檔 台灣.html 把分區內嵌成 <script id="tile-d-x_y">；GitHub Pages 版 (index.html) 用到才下載
function b64buf(str) {
  const bin = atob(str.trim());
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
const INDEX = JSON.parse($('tile-index').textContent);
const TS = INDEX.ts, TC = INDEX.tc, TSTEP = INDEX.step, TN = TC + 3;   // 地形分區含 1 格外框
const TGI = INDEX.terrain;                                               // 全域地形格點範圍 (J = x / 30, I = y / 30)
// 直接雙擊開 台灣.html (file://) 時，沒內嵌的分區從 GitHub Pages 下載
const TILE_BASE = (params.get('tiles') || (location.protocol === 'file:' ? 'https://liug1217.github.io/TAIWAN/tiles/' : 'tiles/')).replace(/\/?$/, '/');
const tkey = (tx, ty) => tx + '_' + ty;
/** 內嵌的分區直接解碼 (同步)，否則下載 (回傳 Promise) */
function tileBuf(kind, key) {
  const el = document.getElementById('tile-' + kind + '-' + key);
  if (el) { const b = b64buf(el.textContent); el.remove(); return b; }
  return limitedFetch(TILE_BASE + kind + '/' + key + '.bin');
}
// 同時最多 8 個下載 (一次要幾十區時，不會塞爆伺服器)
let fetching = 0;
const fetchQueue = [];
function limitedFetch(url) {
  return new Promise((resolve, reject) => {
    const run = () => {
      fetching++;
      fetch(url).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(resolve, reject).finally(() => { fetching--; if (fetchQueue.length) fetchQueue.shift()(); });
    };
    if (fetching < 8) run(); else fetchQueue.push(run);
  });
}

const LANE_W = 3.75;
const WAYS = [];            // 依載入順序；w.k = 索引，w.gid = 全域編號 (live.json、傳送地點用)
const GID = new Map();
const wayByGid = (g) => { const k = GID.get(g); return k == null ? null : WAYS[k]; };
const ptKey = (x, y) => Math.round(x * 10) + ',' + Math.round(y * 10);
const PT_INDEX = new Map(); // 座標 -> [[way, idx], ...]
const RAMP_PENDING = [];     // 還沒接上的匝道 (見 resolveRamps)
// 空間索引 (路段線段)
const CELL = 40;
const GRID = new Map();
const cellKey = (cx, cy) => cx * 100003 + cy;
function indexWay(w) {
  for (let i = 0; i < w.n; i++) {
    const key = ptKey(w.P[i * 3], w.P[i * 3 + 1]);
    let a = PT_INDEX.get(key); if (!a) PT_INDEX.set(key, a = []); a.push([w.k, i]);
  }
  for (let i = 0; i < w.n - 1; i++) {
    const ax = w.P[i * 3], ay = w.P[i * 3 + 1], bx = w.P[i * 3 + 3], by = w.P[i * 3 + 4];
    const r = w.hw + 2;
    const cx0 = Math.floor((Math.min(ax, bx) - r) / CELL), cx1 = Math.floor((Math.max(ax, bx) + r) / CELL);
    const cy0 = Math.floor((Math.min(ay, by) - r) / CELL), cy1 = Math.floor((Math.max(ay, by) + r) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const key = cellKey(cx, cy);
      let a = GRID.get(key); if (!a) GRID.set(key, a = []); a.push(w.k, i);
    }
  }
}
function makeWay(w) {
  const n = w.n = w.P.length / 3;
  w.k = WAYS.length; w.hw = w.width / 2;
  if (!w.U) w.U = new Float32Array(n);
  if (!w.M) w.M = new Uint8Array(n);
  // 左法向與累積距離
  w.nx = new Float32Array(n); w.ny = new Float32Array(n); w.s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1);
    const dx = w.P[b * 3] - w.P[a * 3], dy = w.P[b * 3 + 1] - w.P[a * 3 + 1];
    const L = Math.hypot(dx, dy) || 1;
    w.nx[i] = -dy / L; w.ny[i] = dx / L;
    if (i > 0) {
      const ex = w.P[i * 3] - w.P[i * 3 - 3], ey = w.P[i * 3 + 1] - w.P[i * 3 - 2], ez = w.P[i * 3 + 2] - w.P[i * 3 - 1];
      w.s[i] = w.s[i - 1] + Math.hypot(ex, ey, ez);
    }
  }
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (let i = 0; i < n; i++) {
    const x = w.P[i * 3], y = w.P[i * 3 + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  w.bb = [x0 - w.hw, y0 - w.hw, x1 + w.hw, y1 + w.hw];
  WAYS.push(w);
  GID.set(w.gid, w.k);
  indexWay(w);
  return w;
}
/** 高度 Int16 (0.1 m) 解碼: 3276.8 m 以上 (合歡山、雪山) 存的時候會繞回負數，小於 -500 m 的值加 65536 換回來 */
const Z16 = (v) => (v < -5000 ? v + 65536 : v) * 0.1;
/** 細節分區 -> 路段 (加入 WAYS)、橋墩、建築。格式見 scripts/tile_web.py pack_detail */
function ingestDetail(buf) {
  const jl = new DataView(buf).getUint32(0, true);
  const hd = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, jl)));
  let o = 4 + jl;
  const f32 = (n) => { const a = new Float32Array(buf, o, n); o += n * 4; return a; };
  const i16 = (n) => { const a = new Int16Array(buf, o, n); o += n * 2; return a; };
  const ncw = hd.cw.length;
  const fP = f32(hd.np * 3), fU = f32(hd.np), piers = f32(hd.npier * 9), rxy0 = f32(ncw * 2);
  const bxy0 = f32(hd.nb * 2), bbase = f32(hd.nb), bh = f32(hd.nb);
  const roff = i16(hd.cnp * 2), rz = i16(hd.cnp), boff = i16(hd.nbv * 2);
  const bcnt = new Uint16Array(buf, o, hd.nb); o += hd.nb * 2;
  const emask = new Uint8Array(buf, o, hd.np); o += hd.np;   // bit0 左路緣、bit1 右路緣落在別條路面上
  const bcol = new Uint8Array(buf, o, hd.nb);
  const ways = [];
  let p = 0;
  for (let q = 0; q < hd.fw.length; q++) {   // 國道 / 快速道路
    const m = hd.fw[q], n = hd.fc[q];
    ways.push(makeWay({
      gid: m[0], ref: m[1], name: m[2], lanes: m[3], ls: m[4], rs: m[5], width: m[6],
      bridge: !!(m[7] & 1), tunnel: !!(m[7] & 2), link: !!(m[7] & 4), oneway: !!(m[7] & 8),
      maxspeed: m[8], trunk: !!m[9], cls: m[9] ? 1 : 0,
      P: fP.subarray(p * 3, (p + n) * 3), U: fU.subarray(p, p + n), M: emask.subarray(p, p + n),
    }).k);
    p += n;
  }
  // 一般道路: 第一點 + 0.1 m 相對座標
  const cp = new Float32Array(hd.cnp * 3);
  for (let k = 0, v = 0; k < ncw; k++) for (let i = 0; i < hd.cc[k]; i++, v++) {
    cp[v * 3] = rxy0[k * 2] + roff[v * 2] * 0.1; cp[v * 3 + 1] = rxy0[k * 2 + 1] + roff[v * 2 + 1] * 0.1; cp[v * 3 + 2] = Z16(rz[v]);
  }
  p = 0;
  for (let q = 0; q < ncw; q++) {
    const m = hd.cw[q], n = hd.cc[q];
    // 雙向一般道路 (非巷道) 被標成 1 線道 (OSM lanes=1，例如中壢中山東路一段有一小段): 兩個方向的車道中心只差 1.6 m，
    // 對向車每台都會擦撞。至少當 2 線道 (每向 1 線)、寬 7.1 m；巷道另有 6 m 下限 (city_web.py)
    let lanes = m[2], width = m[4];
    if (!m[3] && m[1] <= 4 && lanes < 2) { lanes = 2; width = Math.max(width, 7.1); }
    ways.push(makeWay({ gid: m[0], ref: '', name: m[6], cls: m[1], lanes, oneway: !!m[3], width, bridge: !!m[5], tunnel: false,
      link: m[1] === 6, ls: 0.3, rs: 0.3, maxspeed: 0, city: true, P: cp.subarray(p * 3, (p + n) * 3) }).k);
    p += n;
  }
  // 建築頂點 (第一點 + 0.1 m 相對座標)
  const bxy = new Float32Array(hd.nbv * 2);
  for (let b = 0, v = 0; b < hd.nb; b++) for (let i = 0; i < bcnt[b]; i++, v++) {
    bxy[v * 2] = bxy0[b * 2] + boff[v * 2] * 0.1; bxy[v * 2 + 1] = bxy0[b * 2 + 1] + boff[v * 2 + 1] * 0.1;
  }
  if (hd.ramp) { for (const r of hd.ramp) RAMP_PENDING.push(r); resolveRamps(); }
  return { ways, piers, bld: hd.nb ? { bxy, bbase, bh, bcnt, bcol, nb: hd.nb } : null };
}
// 匝道接主線 (scripts/fix_clip.mjs 步驟 0): 匝道端點已移到主線外側，記錄 [匝道 gid, 端點, 在主線哪一側, 主線 gid, 原本重合的主線點]。
// 兩條路都載入後把它們在路網上接起來 (nextOptions 用 PT_INDEX 找下一段路)，並讓匝道知道要畫槽化區。
function resolveRamps() {
  for (let j = RAMP_PENDING.length - 1; j >= 0; j--) {
    const [gid, e, side, mgid, mi] = RAMP_PENDING[j];
    const w = wayByGid(gid), m = wayByGid(mgid);
    if (!w || !m) continue;
    (w.ramps ||= []).push({ e, side, mgid });
    if (mi >= 0 && mi < m.n) {
      const add = (key, k, i) => { let a = PT_INDEX.get(key); if (!a) PT_INDEX.set(key, a = []); if (!a.some(([kk, ii]) => kk === k && ii === i)) a.push([k, i]); };
      add(ptKey(w.P[e * 3], w.P[e * 3 + 1]), m.k, mi);
      add(ptKey(m.P[mi * 3], m.P[mi * 3 + 1]), w.k, e);
    }
    RAMP_PENDING.splice(j, 1);
  }
}

/** 找 (x,y) 處、高度不高於 zRef+climb 的最高路面。margin: 距路緣保留寬度 */
function roadAt(x, y, zRef, margin, climb = 1.3) {
  const a = GRID.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (!a) return null;
  let best = null;
  for (let q = 0; q < a.length; q += 2) {
    const w = WAYS[a[q]], i = a[q + 1], P = w.P;
    const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2];
    const bx = P[i * 3 + 3], by = P[i * 3 + 4], bz = P[i * 3 + 5];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    if (L < 1e-3) continue;
    const t = ((x - ax) * dx + (y - ay) * dy) / (L * L);
    const ext = 1.5 / L;
    if (t < -ext || t > 1 + ext) continue;
    const lat = ((x - ax) * -dy + (y - ay) * dx) / L;
    const tc = Math.min(Math.max(t, 0), 1);
    if (w.eL) {   // 國道主線兩側多鋪的路肩
      if (lat > w.hw + w.eL[i] + (w.eL[i + 1] - w.eL[i]) * tc - margin || -lat > w.hw + w.eR[i] + (w.eR[i + 1] - w.eR[i]) * tc - margin) continue;
    } else if (Math.abs(lat) > w.hw - margin) continue;
    const z = az + (bz - az) * tc;
    if (z > zRef + climb) continue;
    if (!best || z > best.z) best = { z, w, i, t: tc, lat, tx: dx / L, ty: dy / L };
  }
  return best;
}

const TERR = new Map();       // 地形分區 key -> Int16Array (TN x TN, 0.1 m)
const LCLS = new Map();       // 地形分區 key -> Uint8Array 地表分類 (0 未知 1 水 2 沙 3 砂石 4 濕地 5 都市 6 農田 7 森林 8 草地)
/** (x,y) 的地表分類 (最近的格點)；沒有資料回 0 */
function landcoverAt(x, y) {
  const J = Math.round(x / TSTEP), I = Math.round(y / TSTEP), tx = Math.floor(J / TC), ty = Math.floor(I / TC);
  const a = LCLS.get(tkey(tx, ty));
  return a ? a[(I - ty * TC + 1) * TN + (J - tx * TC + 1)] : 0;
}
function terrainAt(x, y) {
  const J = Math.min(Math.max(x / TSTEP, TGI.J0), TGI.J0 + TGI.w - 1.001), I = Math.min(Math.max(y / TSTEP, TGI.I0), TGI.I0 + TGI.h - 1.001);
  const j = Math.floor(J), i = Math.floor(I), u = J - j, v = I - i;
  const tx = Math.floor(j / TC), ty = Math.floor(i / TC);
  const a = TERR.get(tkey(tx, ty));
  if (!a) return 0;
  const lj = j - tx * TC + 1, li = i - ty * TC + 1;
  const h = (ii, jj) => Z16(a[ii * TN + jj]);
  return (1 - v) * ((1 - u) * h(li, lj) + u * h(li, lj + 1)) + v * ((1 - u) * h(li + 1, lj) + u * h(li + 1, lj + 1));
}

// ======================================================================= 渲染器
const renderer = new T.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
// 手機 (觸控裝置) 省電模式: 解析度、陰影降低，建築只畫附近
const MOBILE = params.get('touch') === '1' || (params.get('touch') !== '0' && window.matchMedia && matchMedia('(pointer: coarse)').matches);
renderer.setPixelRatio(MOBILE ? Math.min(window.devicePixelRatio, 1) : Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = T.SRGBColorSpace;
// 色調: 預設 ACES (對比、飽和度高，白天比較鮮明)；?tone=agx 用原本與 Blender 相同的 AgX、?tone=neutral 用 Khronos 中性
const TONE = new URLSearchParams(location.search).get('tone');
renderer.toneMapping = TONE === 'agx' ? T.AgXToneMapping : TONE === 'neutral' ? T.NeutralToneMapping : T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
$('app').appendChild(renderer.domElement);

const scene = new T.Scene();
const camera = new T.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 45000);

// 太陽方向: 與 Blender 太陽 (rotation 58°, 0, 35°) 相同 -> 指向太陽的單位向量 (three 座標)
const SUN_DIR = new T.Vector3(0.486, 0.530, 0.695).normalize();
const HORIZON = new T.Color(0.62, 0.70, 0.80);
const NIGHT = { value: 0 };   // 0 白天 .. 1 夜晚: 路燈、大樓窗戶、車燈共用
// 天氣 (gameplay.js 設定): wet 路面濕度 0..1、over 陰天 0..1、fog 起霧 0..1、rain 雨量 0..1 (大雨 1)
const WEATHER = { wet: { value: 0 }, over: 0, fog: 0, rain: 0, dirty: false };

// ---- 天空 (方向漸層 + 太陽光暈 + 積雲；黃昏有晚霞、夜晚有星星) -> 背景與環境光。太陽移動時重畫
const SKY_U = { sunDir: { value: SUN_DIR }, uDay: { value: 1 }, uSet: { value: 0 }, uOver: { value: 0 } };
const skyMat = new T.ShaderMaterial({
  side: T.BackSide, depthWrite: false, uniforms: SKY_U,
  vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `
    varying vec3 vDir; uniform vec3 sunDir; uniform float uDay; uniform float uSet; uniform float uOver;
    float h3(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
    float n3(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
      return mix(mix(mix(h3(i),h3(i+vec3(1,0,0)),f.x), mix(h3(i+vec3(0,1,0)),h3(i+vec3(1,1,0)),f.x),f.y),
                 mix(mix(h3(i+vec3(0,0,1)),h3(i+vec3(1,0,1)),f.x), mix(h3(i+vec3(0,1,1)),h3(i+vec3(1,1,1)),f.x),f.y), f.z); }
    float fbm(vec3 p){ float a=0.5, s=0.0; for(int i=0;i<6;i++){ s+=a*n3(p); p*=2.03; a*=0.5; } return s; }
    void main(){
      vec3 d = normalize(vDir);
      float e = d.y, s = max(dot(d, sunDir), 0.0);
      vec3 zenith = mix(vec3(0.0004, 0.0005, 0.0012), vec3(0.13, 0.27, 0.58), uDay);   // 夜晚天空接近全黑
      vec3 horizon = mix(vec3(0.0035, 0.003, 0.0035), vec3(0.66, 0.73, 0.82), uDay);   // 地平線只剩一點城市光
      zenith = mix(zenith, vec3(0.30, 0.32, 0.35) * uDay + 0.0006, uOver * 0.85);       // 陰天: 整片灰
      horizon = mix(horizon, vec3(0.46, 0.48, 0.5) * uDay + 0.003, uOver * 0.85);
      vec2 dh = normalize(d.xz + vec2(1e-5)), sh = normalize(sunDir.xz + vec2(1e-5));
      horizon = mix(horizon, vec3(1.0, 0.52, 0.25), uSet * (0.35 + 0.65 * pow(max(dot(dh, sh), 0.0), 2.0)));
      vec3 ground = mix(vec3(0.01, 0.012, 0.015), vec3(0.10, 0.11, 0.10), uDay);
      vec3 col = e > 0.0 ? mix(horizon, zenith, pow(e, 0.5)) : mix(horizon, ground, pow(min(-e*4.0,1.0),0.6));
      col += mix(vec3(1.0,0.85,0.6), vec3(1.0,0.5,0.2), uSet) * (pow(s, 8.0) * 0.25 + pow(s, 64.0) * 0.6) * smoothstep(-0.12, 0.02, sunDir.y) * (1.0 - 0.9 * uOver);
      col = mix(col, horizon * 1.05, exp(-max(e, 0.0) * 18.0) * 0.6);
      if (e > 0.0) {
        vec3 q = floor(d * 420.0);
        float st = step(0.9975, h3(q)) * (1.0 - uDay) * smoothstep(0.05, 0.3, e) * (1.0 - uOver);   // 星星 (陰天看不到)
        col += vec3(0.8, 0.85, 1.0) * st * (0.4 + 0.6 * h3(q + 3.1));
        vec2 uv = d.xz / (e + 0.12) * 1.6;
        float c = fbm(vec3(uv, 0.0) * 1.3) * 0.8 + fbm(vec3(uv * 4.0, 1.7)) * 0.25;
        float cov = mix(smoothstep(0.52, 0.78, c), smoothstep(0.2, 0.5, c), uOver) * smoothstep(0.02, 0.2, e);
        float lit = 0.75 + 0.35 * fbm(vec3(uv * 4.0 + sunDir.xz * 0.3, 3.1)) + 0.25 * pow(s, 4.0);
        vec3 cloud = mix(vec3(0.55, 0.58, 0.63), vec3(1.0, 0.98, 0.95), clamp(lit - 0.35, 0.0, 1.0));
        cloud = mix(cloud, vec3(1.0, 0.6, 0.38) * (0.6 + 0.5 * lit), uSet * 0.8);   // 晚霞
        cloud = mix(cloud, vec3(0.24, 0.25, 0.27) * (0.8 + 0.3 * c), uOver);   // 雨雲: 暗灰
        cloud *= mix(0.008, 1.0, uDay);
        col = mix(col, cloud, cov * 0.92);
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const skyScene = new T.Scene();
skyScene.add(new T.Mesh(new T.SphereGeometry(10, 64, 32), skyMat));
const skyRT = new T.WebGLCubeRenderTarget(512, { type: T.HalfFloatType });
const skyCam = new T.CubeCamera(0.1, 100, skyRT);
const skyPM = new T.PMREMGenerator(renderer);
let skyEnv = null;
function renderSky() {
  skyCam.update(renderer, skyScene);
  scene.background = skyRT.texture;
  const env = skyPM.fromCubemap(skyRT.texture).texture;
  if (skyEnv) skyEnv.dispose();
  skyEnv = env;
  scene.environment = env;
  // environmentIntensity 由 updateDayNight 依日夜設定
}
renderSky();
scene.fog = new T.FogExp2(HORIZON.clone(), 0.000045);

const sun = new T.DirectionalLight(0xffffff, 3.2);   // 與 Blender 太陽強度相同
sun.castShadow = true;
sun.shadow.mapSize.set(MOBILE ? 1024 : 4096, MOBILE ? 1024 : 4096);
const SC = sun.shadow.camera; SC.left = -90; SC.right = 90; SC.top = 90; SC.bottom = -90; SC.near = 1; SC.far = 1500;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

// ======================================================================= 日夜: 依台灣真實時間算太陽位置 (O 鍵切換 即時 / 清晨 / 中午 / 黃昏 / 夜晚)
const TIME_MODES = [['即時', null], ['清晨', 6.1], ['中午', 12.5], ['黃昏', 17.55], ['夜晚', 21.0]];
let timeMode = 0;
{
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(params.get('time') || '');
  if (m) { TIME_MODES.push(['測試 ' + params.get('time'), +m[1] + (+(m[2] || 0)) / 60]); timeMode = TIME_MODES.length - 1; }
}
/** 今天 (台灣日期) 的某個台灣時間；h = null 表示現在 */
function taiwanTime(h) {
  const now = new Date();
  if (h == null) return now;
  const tw = new Date(now.getTime() + 8 * 3600e3);
  return new Date(Date.UTC(tw.getUTCFullYear(), tw.getUTCMonth(), tw.getUTCDate()) - 8 * 3600e3 + h * 3600e3);
}
/** 太陽高度角、方位角 (弧度；方位由北往東)，NOAA 簡化公式，誤差 < 1° */
function sunPos(date, lat = 24.6, lon = 121.0) {
  const rad = Math.PI / 180, n = date.getTime() / 86400000 - 10957.5;
  const L = (280.460 + 0.9856474 * n) % 360, g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad, eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)), dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
  const ha = (gmst * 15 + lon) * rad - ra, phi = lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { el, az };
}
const SKY_SUN = new T.Vector3().copy(SUN_DIR);
SKY_U.sunDir.value = SKY_SUN;
const MOON_DIR = new T.Vector3(-0.35, 0.82, 0.45).normalize();
const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let dnClock = 0, dnSkyEl = 1e9, dnMode = -1;
function updateDayNight(dt) {
  if ((dnClock -= dt) > 0 && dnMode === timeMode && !WEATHER.dirty) return;
  dnClock = 2;
  const ov = WEATHER.over, fg = WEATHER.fog;
  const { el, az } = sunPos(taiwanTime(TIME_MODES[timeMode][1]));
  const e = el * 180 / Math.PI;
  SKY_SUN.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
  const day = smooth01(-7, 6, e), set = (1 - smooth01(2, 16, e)) * smooth01(-8, 0, e);
  NIGHT.value = 1 - smooth01(-6, 3, e);
  if (e > -2) {
    SUN_DIR.copy(SKY_SUN);
    if (SUN_DIR.y < 0.05) { SUN_DIR.y = 0.05; SUN_DIR.normalize(); }
    const k = smooth01(0, 25, e);
    sun.intensity = 3.2 * smooth01(-2, 10, e) * (1 - 0.82 * ov);   // 陰天、下雨: 沒有直射陽光
    sun.color.setRGB(1, 0.62 + 0.38 * k, 0.42 + 0.58 * k);
  } else {   // 夜晚: 月光 (淡藍、從高處照)
    SUN_DIR.copy(MOON_DIR);
    sun.intensity = 0.07 * (1 - 0.9 * ov);   // 月光很弱 (陰天幾乎沒有)
    sun.color.setRGB(0.55, 0.65, 1.0);
  }
  renderer.toneMappingExposure = 1 + 0.2 * NIGHT.value;
  scene.environmentIntensity = 0.55 * (1 - 0.75 * NIGHT.value) * (1 + 0.25 * ov);   // 夜晚天空光很少；陰天散射光比較多 (補直射光)
  // 霧色 = 地平線顏色
  const hz = [0.003 + 0.657 * day, 0.003 + 0.727 * day, 0.004 + 0.816 * day];   // 夜晚霧色接近黑
  scene.fog.color.setRGB(hz[0] + (1.0 - hz[0]) * set * 0.35, hz[1] + (0.55 - hz[1]) * set * 0.35, hz[2] + (0.3 - hz[2]) * set * 0.35);
  // 陰天 / 起霧: 霧變灰、變濃 (起霧 1 = 能見度約 250 m)
  const gk = Math.max(ov * 0.8, fg), gray = 0.003 + 0.5 * day;
  scene.fog.color.lerp(new T.Color(gray, gray * 1.02, gray * 1.06), gk);
  scene.fog.density = 0.000045 + ov * 0.00022 + WEATHER.rain * 0.0006 + fg * 0.0115;
  if (Math.abs(e - dnSkyEl) > 0.4 || dnMode !== timeMode || Math.abs(SKY_U.uOver.value - ov) > 0.04) {
    dnSkyEl = e; dnMode = timeMode;
    SKY_U.uDay.value = day; SKY_U.uSet.value = set; SKY_U.uOver.value = ov;
    renderSky();
  }
  WEATHER.dirty = false;
  matLampHead.emissiveIntensity = 5 * NIGHT.value;
  GLOW_LAMP_TEX_HOOK();
  GLOW_LAMP.opacity = NIGHT.value; GLOW_LAMP.visible = NIGHT.value > 0.02;
}
const timeToast = document.createElement('div');
timeToast.style.cssText = 'position:fixed;top:120px;left:50%;transform:translateX(-50%);background:rgba(10,14,12,.8);color:#fff;padding:8px 16px;border-radius:10px;font-size:15px;z-index:20;pointer-events:none;opacity:0;transition:opacity .4s';
document.body.appendChild(timeToast);
function cycleTime() {
  timeMode = (timeMode + 1) % TIME_MODES.length;
  const [name, h] = TIME_MODES[timeMode];
  timeToast.textContent = '🕒 時間：' + name + (h == null ? '（照台灣現在時間）' : '');
  timeToast.style.opacity = 1;
  clearTimeout(cycleTime.t); cycleTime.t = setTimeout(() => { timeToast.style.opacity = 0; }, 1800);
  dnClock = 0;
}
// 發光點 (路燈燈頭、車燈) 用的圓形光暈貼圖
const GLOW_TEX = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.8)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; return t;
})();
const GLOW_LAMP_TEX_HOOK = () => { matRetroGlow.uniforms.map.value = GLOW_TEX; matRetroGlow.uniforms.uScale.value = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360)); };
const HPS = [1.0, 0.3, 0.035];   // 國道路燈 = 高壓鈉燈 (約 2000 K、色度 x≈0.53 y≈0.415 → 線性 sRGB，畫面上約 #FF9535 橘色)
const GLOW_LAMP = new T.PointsMaterial({ map: GLOW_TEX, color: new T.Color(...HPS), size: 4.5, sizeAttenuation: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, opacity: 0, toneMapped: false, fog: false });
const matLampPole = new T.MeshStandardMaterial({ color: new T.Color(0.42, 0.44, 0.46), metalness: 0.6, roughness: 0.45 });
// 隔音牆: 下半實心板 (灰綠)、上半透明壓克力 (淡青)，H 型鋼柱
const matSoundWall = new T.MeshStandardMaterial({ color: new T.Color(0.2, 0.25, 0.22), roughness: 0.85, metalness: 0.1 });
const matSoundGlass = new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.72, 0.72), roughness: 0.12, metalness: 0.15, transparent: true, opacity: 0.32, depthWrite: false, side: T.DoubleSide });
// 路邊廣告看板 (內容都是虛構的)：一張 3×2 格的貼圖集，每面看板取一格
const BILLBOARD_TEX = (() => {
  const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 1024; const x = cv.getContext('2d');
  const F = (n) => `900 ${n}px "PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif`;
  const ads = [
    ['#ffd400', '#111', '廣告招租', '本看板出租・歡迎洽詢', '#c8102e'],
    ['#0b3d2e', '#f5e6c4', '雲河苑', '近交流道・三房車位熱銷中', '#d4af37'],
    ['#e9eef2', '#0a2a66', '汽車美容', '鍍膜・打蠟・內裝清潔', '#e4002b'],
    ['#003a8c', '#ffffff', '疲勞勿開車', '休息一下　平安回家', '#ffd400'],
    ['#b3001b', '#fff3d6', '夜市小吃', '下交流道 3 分鐘', '#ffd400'],
    ['#ffffff', '#00695c', '健康檢查', '早期發現　早期治療', '#00a3a3'],
  ];
  ads.forEach(([bg, fg, big, small, acc], i) => {
    const X = (i % 3) * 682, Y = Math.floor(i / 3) * 512, W = 682, H = 512;
    x.fillStyle = bg; x.fillRect(X, Y, W, H);
    x.fillStyle = acc; x.fillRect(X, Y + H - 70, W, 70); x.fillRect(X, Y, W, 18);
    x.fillStyle = fg; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = F(150); x.fillText(big, X + W / 2, Y + 190, W - 40);
    x.font = F(64); x.fillText(small, X + W / 2, Y + 340, W - 40);
    x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 10; x.strokeRect(X + 5, Y + 5, W - 10, H - 10);
  });
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8; return t;
})();
const matBillboard = new T.MeshStandardMaterial({ map: BILLBOARD_TEX, emissiveMap: BILLBOARD_TEX, emissive: new T.Color(0.35, 0.35, 0.35), roughness: 0.6, side: T.DoubleSide });
const matBillboardBack = new T.MeshStandardMaterial({ color: new T.Color(0.32, 0.33, 0.34), roughness: 0.7, metalness: 0.4 });
const matLampHead = new T.MeshStandardMaterial({ color: new T.Color(0.08, 0.08, 0.08), emissive: new T.Color(...HPS), emissiveIntensity: 0, roughness: 0.4 });

// ======================================================================= 材質 (移植自 Blender)
const GLSL_NOISE = `
  float fwyHash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
  float fwyVNoise(vec3 x){ vec3 i=floor(x); vec3 f=fract(x); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(fwyHash(i),fwyHash(i+vec3(1,0,0)),f.x), mix(fwyHash(i+vec3(0,1,0)),fwyHash(i+vec3(1,1,0)),f.x),f.y),
               mix(mix(fwyHash(i+vec3(0,0,1)),fwyHash(i+vec3(1,0,1)),f.x), mix(fwyHash(i+vec3(0,1,1)),fwyHash(i+vec3(1,1,1)),f.x),f.y), f.z); }
  float fwyFbm(vec3 p, int oct){ float a=0.5, s=0.0, t=0.0; for(int i=0;i<8;i++){ if(i>=oct) break; s+=a*fwyVNoise(p); t+=a; p*=2.02; a*=0.5; } return s/t; }
`;

function patch(mat, { vert = '', vmain = '', frag = '', color = '', rough = '', normal = '', emis = '', uniforms = null }) {
  // 每個材質注入的程式碼不同，必須有自己的快取 key；否則 three.js 會讓它們共用第一個編譯好的著色器
  const key = 'fwy:' + vert + '|' + vmain + '|' + frag + '|' + color + '|' + rough + '|' + normal + '|' + emis;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    if (uniforms) Object.assign(sh.uniforms, uniforms);
    if (rough) sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + rough);
    if (emis) sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + emis);
    if (normal) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + normal);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;\n' + vert)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObj = vec3(position.x, -position.z, position.y);\n' + vmain);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObj;\n' + GLSL_NOISE + frag)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + color);
  };
  return mat;
}

// 真實瀝青: Poly Haven「Asphalt 04」實景掃描 (CC0，一張 4.04 m)；顏色、法線、粗糙度三張貼圖
// 用世界座標貼 (不靠 UV)，再疊一層旋轉 + 縮放的取樣與大範圍明暗，看不出重複
function texFrom(id, srgb) {
  const el = $(id);
  const img = new Image();
  const t = new T.Texture(img);
  t.wrapS = t.wrapT = T.RepeatWrapping;
  t.colorSpace = srgb ? T.SRGBColorSpace : T.NoColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  img.onload = () => { t.needsUpdate = true; };
  if (el) img.src = 'data:image/jpeg;base64,' + el.textContent.trim();
  return t;
}
const ASPH_U = {
  tAsD: { value: texFrom('tex-asphalt_diff', true) },
  tAsN: { value: texFrom('tex-asphalt_nor_gl', false) },
  tAsR: { value: texFrom('tex-asphalt_rough', false) },
  uNight: NIGHT, uWet: WEATHER.wet,
};
const ASPH_DECL = `uniform sampler2D tAsD; uniform sampler2D tAsN; uniform sampler2D tAsR; uniform float uNight; uniform float uWet; float gPud; float gMark; vec2 gUv1; vec2 gUv2; float gMix;
  void asphUv(vec3 p) {
    gUv1 = p.xy / 4.04;
    gUv2 = mat2(0.866, -0.5, 0.5, 0.866) * p.xy / 5.3 + vec2(0.37, 0.71);
    gMix = smoothstep(0.35, 0.65, fwyFbm(p * 0.035, 3));
  }
  vec3 asphColor() { return mix(texture2D(tAsD, gUv1).rgb, texture2D(tAsD, gUv2).rgb, gMix); }`;
// 法線: 路面接近水平，把貼圖的切線方向擾動 (資料 x 東、y 北 -> three x、-z) 加到幾何法線上
const ASPH_NORMAL = `{
  vec3 tn = mix(texture2D(tAsN, gUv1).rgb, texture2D(tAsN, gUv2).rgb, gMix) * 2.0 - 1.0;
  vec3 dw = vec3(tn.x, 0.0, -tn.y) * (0.75 * (1.0 - gMark)) * (1.0 - 0.9 * gPud * uWet);   // 積水處水面是平的
  normal = normalize(normal + mat3(viewMatrix) * dw);
}`;
const ASPH_ROUGH = `roughnessFactor = mix(mix(0.72, 0.98, mix(texture2D(tAsR, gUv1).r, texture2D(tAsR, gUv2).r, gMix)), 0.55, gMark);
  gPud = 0.0;
  if (uWet > 0.001) {   // 下雨: 路面變暗、變光滑；低窪處 (雜訊) 積水接近鏡面
    gPud = smoothstep(0.56, 0.68, fwyFbm(vObj * 0.11, 3)) * smoothstep(0.35, 0.9, uWet);
    roughnessFactor = mix(roughnessFactor, mix(0.3, 0.035, gPud), uWet);
    diffuseColor.rgb *= mix(1.0, mix(0.55, 0.32, gPud), uWet * (1.0 - 0.5 * gMark));
  }`;

// 瀝青路面 + 標線 (內側黃實線、外側白實線、車道白虛線 畫4m空6m, 線寬15cm)
const matAsphalt = patch(new T.MeshStandardMaterial({ roughness: 0.85, metalness: 0 }), {
  vert: 'attribute vec2 aUv; attribute float aLs; attribute float aLanes; varying vec2 vRUv; varying float vLs; varying float vLanes;',
  vmain: 'vRUv = aUv; vLs = aLs; vLanes = aLanes;',
  frag: 'varying vec2 vRUv; varying float vLs; varying float vLanes; float gTun;' + ASPH_DECL,
  uniforms: ASPH_U, normal: ASPH_NORMAL, rough: ASPH_ROUGH,
  emis: `totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.58, 0.26) * (0.5 + 0.12 * sin(vRUv.y * 2.094)) * gTun;   // 隧道燈 (暖橘)
  if (uNight > 0.01 && gTun < 0.5) {   // 夜晚: 中央分隔島路燈照在路面 (每 40 m 一盞)
    float ds = (fract((vRUv.y - 2.0) / 40.0 + 0.5) - 0.5) * 40.0, du = vRUv.x - 1.0;
    float L = exp(-(ds * ds * 0.5 + du * du * 0.7) / 90.0) + 0.01;   // 燈下一圈光，燈與燈之間是暗的
    totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.3, 0.035) * L * 1.5 * uNight;   // 高壓鈉燈橘光
  }`,
  color: `{
    float tun = step(50.0, vLs), ls = vLs - tun * 100.0;
    gTun = tun;
    float k = (vRUv.x - ls) / ${LANE_W.toFixed(2)};
    float kr = floor(k + 0.5);
    float dist = abs(k - kr) * ${LANE_W.toFixed(2)};
    float fw = max(fwidth(dist), 1e-4);
    float onLine = 1.0 - smoothstep(0.075 - fw, 0.075 + fw, dist);
    float isLeft = step(abs(kr), 0.1);
    float isRight = step(abs(kr - vLanes), 0.1);
    float inner = step(0.5, kr) * (1.0 - step(vLanes - 0.5, kr));
    float ph = fract(vRUv.y / 10.0);
    float fv = max(fwidth(vRUv.y / 10.0), 1e-4);
    float dash = 1.0 - smoothstep(0.4 - fv, 0.4 + fv, ph);
    float white = onLine * max(isRight, inner * dash);
    float yellow = onLine * isLeft;
    if (tun > 0.5) {   // 隧道: 車道線是雙白實線 (禁止變換車道)、左側邊線白色
      float dd = abs(dist - 0.14), onD = 1.0 - smoothstep(0.055 - fw, 0.055 + fw, dd);
      white = max(onLine * max(isRight, isLeft), onD * inner);
      yellow = 0.0;
    }
    asphUv(vObj);
    vec3 base = asphColor() * (0.62 + 0.22 * fwyFbm(vObj * 0.012, 3));
    // 輪跡: 每個車道中心左右約 0.85 m 被輪胎磨得較暗、較平滑；車道中央有一點油漬
    float lo = abs(fract(k) - 0.5) * ${LANE_W.toFixed(2)};
    float inLane = step(0.0, k) * step(k, vLanes);
    float wheel = (1.0 - smoothstep(0.25, 0.5, abs(lo - 0.85))) * inLane;
    float oil = (1.0 - smoothstep(0.0, 0.35, lo)) * inLane;
    base *= 1.0 - 0.10 * wheel - 0.06 * oil * fwyFbm(vObj * 0.6, 3);
    vec3 c = mix(base, vec3(0.8,0.8,0.78), white);
    c = mix(c, vec3(0.85,0.6,0.05), yellow);
    gMark = max(white, yellow);
    diffuseColor.rgb = c;
  }`,
});
function concreteLike(color, rough, amt, scale = 0.3) {
  const c = color.map((v) => v.toFixed(4)).join(',');
  return patch(new T.MeshStandardMaterial({ roughness: rough, metalness: 0, side: T.DoubleSide }), {
    color: `diffuseColor.rgb = mix(vec3(${c})*${(1 - amt).toFixed(3)}, vec3(${c}), fwyFbm(vObj*${scale}, 4));`,
  });
}
const matConcrete = concreteLike([0.5, 0.49, 0.46], 0.85, 0.25);
// 風化混凝土護欄 (照街景): 灰色帶斑駁、垂直雨痕、底部較髒、每 6 m 一道接縫、每 3 m 一個底部排水孔
// 紐澤西護欄: Poly Haven 實景掃描混凝土 (CC0) — 底層 dirty_concrete (淺灰、真實孔洞與污點)，
// 水漬層 concrete_wall_006 (深色老舊混凝土)，照國道街景: 大片深色水漬 (下半部多)、頂部往下流的雨痕、底部最髒、頂部平台乾淨
const BAR_U = {
  tBD: { value: texFrom('tex-barrier_diff', true) },
  tBS: { value: texFrom('tex-barrier_stain', true) },
  tBN: { value: texFrom('tex-barrier_nor_gl', false) },
};
const matBarrier = patch(new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0, side: T.DoubleSide }), {
  vert: 'attribute vec2 aUv; varying vec2 vRUv;',
  vmain: 'vRUv = aUv;',
  frag: 'varying vec2 vRUv; uniform sampler2D tBD; uniform sampler2D tBS; uniform sampler2D tBN; vec2 gBuv; float gStain;',
  uniforms: BAR_U,
  color: `{
    #define STR(x) clamp(((x) - 0.5) * 2.4 + 0.5, 0.0, 1.0)
    float s = vRUv.x, h = vRUv.y;
    float fw = max(fwidth(s), 1e-4);
    float seg = floor(s / 6.0);
    float r1 = fract(sin(seg * 12.9898 + 4.1) * 43758.5453), r2 = fract(sin(seg * 78.233 + 1.3) * 24634.6345);
    gBuv = vec2(s, h * 1.2) / 2.2 + vec2(r1 * 0.37, r2 * 0.61);                               // 每節各自偏移，看不出重複
    vec3 base = texture2D(tBD, gBuv).rgb * mix(0.68, 0.92, r1);                              // 每節新舊不同
    vec3 stain = texture2D(tBS, gBuv * 0.8 + vec2(0.31, 0.17)).rgb * mix(0.9, 1.25, r2);
    float m1 = STR(fwyFbm(vec3(s * 0.33, h * 1.25, r2 * 7.0), 5));
    float drip = STR(fwyFbm(vec3(s * 4.5, h * 0.38, 1.7), 3));
    float mask = smoothstep(0.4, 0.66, m1 + 0.6 * (0.42 - h) + 0.3 * (r2 - 0.45));             // 大片水漬，越下面越多 (上半部多露出淺灰)
    mask = max(mask, smoothstep(0.58, 0.82, drip) * smoothstep(0.86, 0.55, h) * 0.85);        // 頂部往下流的雨痕
    mask = max(mask, 1.0 - smoothstep(0.04, 0.22, h));                                        // 底部輪胎濺起的泥污
    gStain = clamp(mask, 0.0, 1.0);
    vec3 c = mix(base, stain, gStain);
    c = mix(c, base * 1.12, smoothstep(0.82, 0.865, h) * 0.65);                               // 頂部平台比較乾淨
    float jd = abs(fract(s / 6.0 + 0.5) - 0.5) * 6.0;                                         // 到接縫的距離 (m)
    c *= mix(0.25, 1.0, smoothstep(0.01, 0.01 + fw * 1.5, jd));                              // 接縫黑線
    c *= mix(0.7, 1.0, smoothstep(0.03, 0.12, jd));                                           // 接縫邊角髒
    float dd = abs(fract(s / 3.0) - 0.5) * 3.0;
    float slot = (1.0 - smoothstep(0.15, 0.15 + fw, dd)) * (1.0 - smoothstep(0.085, 0.1, h));   // 底部排水孔
    diffuseColor.rgb = mix(c, vec3(0.01), slot);
  }`,
  rough: 'roughnessFactor = mix(0.86, 0.98, gStain);',
  // 法線貼圖: 護欄沒有切線，用螢幕導數算 (跟 three.js 內建 perturbNormal2Arb 同法)
  normal: `{
    vec3 tn = texture2D(tBN, gBuv).rgb * 2.0 - 1.0; tn.xy *= 1.1;
    vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition); vec2 st0 = dFdx(gBuv), st1 = dFdy(gBuv);
    vec3 N = normal, q1p = cross(q1, N), q0p = cross(N, q0);
    vec3 Tg = q1p * st0.x + q0p * st1.x, Bg = q1p * st0.y + q0p * st1.y;
    float det = max(dot(Tg, Tg), dot(Bg, Bg)), sc = det == 0.0 ? 0.0 : inversesqrt(det);
    normal = normalize(Tg * (tn.x * sc) + Bg * (tn.y * sc) + N * tn.z);
  }`,
});
// 匝道槽化區: 舊瀝青 + 兩側白實線 + 斜向白色斑馬紋 (aUv.x = 沿線距離、aUv.y = 離主線路緣距離、aLs = 該處寬度)
const matGore = patch(new T.MeshStandardMaterial({ roughness: 0.88, metalness: 0, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), {
  vert: 'attribute vec2 aUv; attribute float aLs; varying vec2 vRUv; varying float vW;',
  vmain: 'vRUv = aUv; vW = aLs;',
  frag: 'varying vec2 vRUv; varying float vW;' + ASPH_DECL,
  uniforms: ASPH_U, normal: ASPH_NORMAL, rough: ASPH_ROUGH,
  color: `{
    float u = vRUv.x, v = vRUv.y, W = max(vW, 0.0), fw = max(fwidth(v), 1e-4);
    asphUv(vObj);
    vec3 c = asphColor() * (0.6 + 0.25 * fwyFbm(vObj * 0.015, 3));
    float edge = min(v, W - v);
    float line = 1.0 - smoothstep(0.12, 0.12 + fw, edge);
    float d = (u - v * 1.25) / 3.2, fd = max(fwidth(d), 1e-4);
    float st = abs(fract(d) - 0.5);
    float chev = (1.0 - smoothstep(0.07, 0.07 + fd * 1.5, st)) * step(0.6, W) * step(0.2, edge);
    gMark = max(line, chev);
    diffuseColor.rgb = mix(c, vec3(0.78, 0.78, 0.74), gMark);
  }`,
});
const matPost = new T.MeshStandardMaterial({ color: 0xff7a12, roughness: 0.5, metalness: 0 });          // 橘色導桿
const matPostBand = new T.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.3, metalness: 0.1, emissive: 0x222222 });   // 反光帶
const matDrum = new T.MeshStandardMaterial({ color: 0xf2c200, roughness: 0.55, metalness: 0 });         // 黃色緩衝桶
const matDrumBand = new T.MeshStandardMaterial({ color: 0x151515, roughness: 0.6, metalness: 0 });
// 中央分隔護欄上的綠色防眩板 (照街景: 綠色鋼板、略褪色、底部有灰塵)
const matGlare = patch(new T.MeshStandardMaterial({ roughness: 0.55, metalness: 0.25, side: T.DoubleSide }), {
  color: 'diffuseColor.rgb = vec3(0.045, 0.24, 0.085) * (0.8 + 0.35 * fwyFbm(vObj * 3.0, 3));',
});
// 市區道路: 路緣白實線、雙向中央雙黃線、同向車道白虛線；巷道 (代碼 0) 無標線
const matCityRoad = patch(new T.MeshStandardMaterial({ roughness: 0.88, metalness: 0 }), {
  vert: 'attribute vec2 aUv; attribute float aLs; attribute float aLanes; varying vec2 vRUv; varying float vW; varying float vCode;',
  vmain: 'vRUv = aUv; vW = aLs; vCode = aLanes;',
  frag: 'varying vec2 vRUv; varying float vW; varying float vCode;' + ASPH_DECL,
  uniforms: ASPH_U, normal: ASPH_NORMAL, rough: ASPH_ROUGH,
  emis: `if (uNight > 0.01) {   // 夜晚: 市區路燈 (兩側每 30 m)
    float ds = (fract(vRUv.y / 30.0) - 0.5) * 30.0, du = min(vRUv.x, max(vW - vRUv.x, 0.0));
    float L = exp(-(ds * ds * 0.6 + du * du) / 70.0) + 0.015;
    totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.8, 0.5) * L * 1.3 * uNight;
  }`,
  color: `{
    float u = vRUv.x, W = vW, fw = max(fwidth(u), 1e-4);
    asphUv(vObj);
    gMark = 0.0;
    vec3 c = asphColor() * (0.55 + 0.25 * fwyFbm(vObj * 0.015, 3));   // 市區路面較舊、補丁多
    if (abs(vCode) > 0.5) {
      float two = step(vCode, -0.5), L = abs(vCode);
      float edge = min(abs(u - 0.3), abs(u - (W - 0.3)));
      float white = 1.0 - smoothstep(0.06, 0.06 + fw, edge);
      float yellow = 0.0;
      float ld = two > 0.5 ? max(1.0, floor(L / 2.0)) : L;
      float halfW = two > 0.5 ? (W * 0.5 - 0.3) : (W - 0.6);
      float pos = two > 0.5 ? (u < W * 0.5 ? (u - 0.3) : (W - 0.3 - u)) : (u - 0.3);
      float x = pos / (halfW / ld), kr = floor(x + 0.5), dd = abs(x - kr) * (halfW / ld);
      float dash = 1.0 - smoothstep(0.4, 0.4 + max(fwidth(vRUv.y / 10.0), 1e-4), fract(vRUv.y / 10.0));
      if (kr > 0.5 && kr < ld - 0.5) white = max(white, (1.0 - smoothstep(0.06, 0.06 + fw, dd)) * dash);
      if (two > 0.5) { float cd = abs(abs(u - W * 0.5) - 0.12); yellow = 1.0 - smoothstep(0.05, 0.05 + fw, cd); }
      c = mix(c, vec3(0.75, 0.75, 0.72), white);
      c = mix(c, vec3(0.85, 0.6, 0.05), yellow);
      gMark = max(white, yellow);
    }
    diffuseColor.rgb = c;
  }`,
});
// 建築牆面: 外牆色 + 每層窗戶 (樓高 3.2 m、窗距 2.6 m)，一樓是店面
const matWall = patch(new T.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05, side: T.DoubleSide }), {
  vert: 'attribute vec3 aUv3; attribute vec3 aCol; varying vec3 vB; varying vec3 vCol;',
  vmain: 'vB = aUv3; vCol = aCol;',
  frag: 'varying vec3 vB; varying vec3 vCol; uniform float uNight; float gWin; float gShop;',
  uniforms: { uNight: NIGHT },
  emis: 'totalEmissiveRadiance += (vec3(1.0, 0.8, 0.52) * gWin * 1.6 + vec3(0.95, 0.95, 1.0) * gShop * 1.1) * uNight;',
  color: `{
    float u = vB.x, v = vB.y, h = vB.z;
    vec3 c = vCol * (0.85 + 0.3 * fwyFbm(vec3(u * 0.3, v * 0.5, 3.1), 4));
    float fl = fract(v / 3.2), wx = fract(u / 2.6);
    float win = step(0.3, fl) * step(fl, 0.82) * step(0.16, wx) * step(wx, 0.84) * step(3.4, v) * step(v, h - 0.8);
    float hw = fwyHash(vec3(floor(u / 2.6), floor(v / 3.2), floor(h)));
    float lit = step(0.82, hw);
    gWin = win * step(0.55, hw);   // 夜晚約 45% 的窗戶亮燈
    vec3 glass = mix(vec3(0.03, 0.04, 0.05), vec3(0.08, 0.09, 0.1), lit);
    c = mix(c, glass, win);
    float shop = step(v, 3.2) * step(0.4, v) * step(0.06, wx) * step(wx, 0.94);
    c = mix(c, vec3(0.025, 0.03, 0.035), shop * 0.85);
    gShop = shop * step(0.3, fwyHash(vec3(floor(u / 7.0), 1.0, floor(h))));   // 一樓店面燈
    diffuseColor.rgb = c;
  }`,
});
const matRoof = patch(new T.MeshStandardMaterial({ roughness: 0.9, metalness: 0, side: T.DoubleSide }), {
  vert: 'attribute vec3 aCol; varying vec3 vCol;',
  vmain: 'vCol = aCol;',
  frag: 'varying vec3 vCol;',
  color: 'diffuseColor.rgb = vCol * (0.8 + 0.4 * fwyFbm(vObj * 0.2, 3));',
});
// 伸縮縫: 鋼板 + 橡膠縫
const matJointSteel = new T.MeshStandardMaterial({ color: new T.Color(0.32, 0.33, 0.34), metalness: 0.85, roughness: 0.38 });
const matJointRubber = new T.MeshStandardMaterial({ color: new T.Color(0.01, 0.01, 0.012), roughness: 0.9 });
const matReflR = new T.MeshBasicMaterial({ color: new T.Color(0.75, 0.02, 0.02), toneMapped: false, side: T.DoubleSide });
const matReflBlack = new T.MeshStandardMaterial({ color: new T.Color(0.012, 0.012, 0.013), roughness: 0.45, metalness: 0 });   // 黑色塑膠外框、支柱、底座
// 黃色稜鏡反光面: 蜂巢狀微稜鏡紋 + 中央鉚釘；回歸反射 = 視線越正對反光面越亮 (光源和眼睛幾乎同方向時最亮)，晚上被車燈照到時大幅變亮
const matRetro = patch(new T.MeshStandardMaterial({ roughness: 0.3, metalness: 0, side: T.DoubleSide }), {
  vert: 'attribute vec2 aUv; varying vec2 vRU;',
  vmain: 'vRU = aUv;',
  frag: 'varying vec2 vRU; uniform float uNight; float gRet;',
  uniforms: { uNight: NIGHT },
  emis: 'totalEmissiveRadiance += vec3(1.0, 0.5, 0.0) * gRet * (0.25 + 0.75 * uNight) / (1.0 + pow(length(vViewPosition) / 140.0, 2.0));',   // 夜晚亮成飽和的黃，不過曝
  color: `{
    vec2 q = vRU * 10.0, rr = vec2(1.0, 1.7320508), hh = rr * 0.5;
    vec2 a = mod(q, rr) - hh, b = mod(q - hh, rr) - hh, gv = dot(a, a) < dot(b, b) ? a : b;
    float hx = max(dot(abs(gv), vec2(0.5, 0.8660254)), abs(gv.x));
    float facet = smoothstep(0.38, 0.5, hx);
    float rad = length(vRU);
    vec3 c = vec3(0.96, 0.62, 0.015) * (1.0 - 0.32 * facet) * (0.9 + 0.2 * fract(sin(dot(floor(q), vec2(12.9, 78.2))) * 43758.5));
    c = mix(c, vec3(0.7, 0.7, 0.68), 1.0 - smoothstep(0.07, 0.1, rad));      // 中央鉚釘
    c = mix(c, c * 0.75, smoothstep(0.9, 1.0, rad));                          // 外圈壓邊
    diffuseColor.rgb = c;
    gRet = pow(abs(dot(normalize(vNormal), normalize(vViewPosition))), 12.0);
  }`,
});
// 遠處的反光點: 只有正對攝影機 (= 車燈照得到) 的那些會亮，晚上才明顯；對向車道的反光片背對你所以不亮
const matRetroGlow = new T.ShaderMaterial({
  transparent: true, depthWrite: false, blending: T.AdditiveBlending,
  uniforms: { map: { value: null }, uNight: NIGHT, uScale: { value: 600 } },
  vertexShader: `#include <common>
    #include <logdepthbuf_pars_vertex>
    attribute vec3 aN; uniform float uNight; uniform float uScale; varying float vA;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vec3 toCam = normalize(cameraPosition - wp.xyz);
      float f = pow(max(dot(normalize(aN), toCam), 0.0), 14.0);
      vec4 mv = viewMatrix * wp;
      float d = -mv.z;
      vA = f * uNight * smoothstep(40.0, 80.0, d) * (1.0 - smoothstep(600.0, 900.0, d));   // 只在晚上、反光片本體小到看不見的距離才補光點
      gl_PointSize = clamp(0.45 * uScale / max(d, 1.0), 1.5, 5.0);
      gl_Position = projectionMatrix * mv;
      #include <logdepthbuf_vertex>
    }`,
  fragmentShader: `#include <common>
    #include <logdepthbuf_pars_fragment>
    uniform sampler2D map; varying float vA;
    void main() {
      #include <logdepthbuf_fragment>
      float a = texture2D(map, gl_PointCoord).a * vA; if (a < 0.01) discard; gl_FragColor = vec4(vec3(1.0, 0.7, 0.1) * a * 3.0, a);
    }`,
});
const matReflY = new T.MeshBasicMaterial({ color: new T.Color(0.85, 0.55, 0.02), toneMapped: false, side: T.DoubleSide });
// 隧道內壁 (照國道 3 號隧道街景): 下半部米白磁磚牆 (2.4 m 一格)、上半部拱頂灰色混凝土 (有燻黑)，整體被暖橘隧道燈照亮
const matTunnelWall = patch(new T.MeshStandardMaterial({ roughness: 0.75, metalness: 0, side: T.DoubleSide }), {
  vert: 'attribute vec2 aUv; varying vec2 vTU;',
  vmain: 'vTU = aUv;',
  frag: 'varying vec2 vTU; float gLit;',
  emis: 'totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.58, 0.26) * gLit;',
  color: `{
    float s = vTU.x, h = vTU.y, n = fwyFbm(vObj * 0.35, 4);
    float fw = max(fwidth(s), 1e-3);
    vec3 c;
    if (h < 0.3) { c = vec3(0.3, 0.29, 0.27) * (0.85 + 0.3 * n); gLit = 0.45; }                       // 檢修步道、路緣
    else if (h < 2.9) {                                                                            // 米白磁磚牆
      c = vec3(0.58, 0.56, 0.5) * (0.92 + 0.12 * n);
      float jx = abs(fract(s / 2.4 + 0.5) - 0.5) * 2.4, jy = abs(fract((h - 0.3) / 0.65 + 0.5) - 0.5) * 0.65;
      c *= mix(0.72, 1.0, smoothstep(0.012, 0.012 + fw * 1.5, min(jx, jy)));
      c *= mix(0.75, 1.0, smoothstep(0.3, 0.9, h));                                                  // 底部較髒
      gLit = 0.5 + 0.15 * smoothstep(1.5, 2.9, h);
    } else {                                                                                       // 拱頂混凝土
      c = vec3(0.16, 0.155, 0.15) * (0.75 + 0.45 * n);
      gLit = 0.3;
    }
    diffuseColor.rgb = c;
  }`,
});
const matTunnel = concreteLike([0.55, 0.53, 0.48], 0.6, 0.2, 1.5);
const matCabinet = new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.03, 0.03), roughness: 0.45, metalness: 0.3 });   // 消防箱
const matRail = new T.MeshStandardMaterial({ color: new T.Color(0.32, 0.34, 0.33), roughness: 0.5, metalness: 0.7 });       // 洞口欄杆
// 洞口兩側翼牆 (沿道路): 面向道路那一面白底彩色波浪 (綠、黃、紫、藍)，波浪沿道路方向起伏；頂面、背面灰色混凝土
const matPortal = patch(new T.MeshStandardMaterial({ roughness: 0.8, metalness: 0, side: T.DoubleSide }), {
  vert: 'attribute vec2 aUv; varying float vFace; varying float vTop;',
  vmain: 'vFace = aUv.x; vTop = aUv.y;',
  frag: 'varying float vFace; varying float vTop;',
  color: `{
    float u = -vObj.y, y = vObj.z, n = fwyFbm(vObj * 0.4, 4);
    vec3 c = vec3(0.42, 0.41, 0.38) * (0.8 + 0.35 * n);
    if (vFace > 0.5 && y > -0.25) {   // 路面以下 (接到地面的牆腳) 是素混凝土
      c = vec3(0.82, 0.82, 0.78) * (0.93 + 0.1 * n);
      float b1 = 2.75 + 0.75 * sin(u * 0.21 + 0.3), b2 = 2.1 + 0.6 * sin(u * 0.19 + 1.4);
      float b3 = 1.45 + 0.5 * sin(u * 0.17 + 2.5), b4 = 0.8 + 0.45 * sin(u * 0.15 + 3.3);
      float e = 0.03;
      c = mix(c, vec3(0.04, 0.44, 0.36), smoothstep(b1 - 0.5 - e, b1 - 0.5 + e, y) * (1.0 - smoothstep(b1 - e, b1 + e, y)));
      c = mix(c, vec3(0.86, 0.67, 0.16), smoothstep(b2 - 0.5 - e, b2 - 0.5 + e, y) * (1.0 - smoothstep(b2 - e, b2 + e, y)));
      c = mix(c, vec3(0.44, 0.31, 0.62), smoothstep(b3 - 0.55 - e, b3 - 0.55 + e, y) * (1.0 - smoothstep(b3 - e, b3 + e, y)));
      c = mix(c, vec3(0.32, 0.53, 0.8), 1.0 - smoothstep(b4 - e, b4 + e, y));
      c *= mix(0.72, 1.0, smoothstep(0.0, 0.5, y));                 // 底部濺髒
      c = mix(c, vec3(0.5, 0.49, 0.46), smoothstep(-0.12, 0.0, y - vTop));   // 牆頂壓頂
    }
    diffuseColor.rgb = c;
  }`,
});
const matTunnelLight = new T.MeshStandardMaterial({ color: 0x000000, emissive: new T.Color(1.0, 0.5, 0.12), emissiveIntensity: 1.7 });   // 暖橘隧道燈
// 水面: 海 (藍綠) / 河、湖 (帶泥的綠褐)；法線用會流動的雜訊做波紋，低粗糙度反射天空與太陽
const WATER_T = { value: 0 };
const matWater = patch(new T.MeshStandardMaterial({ roughness: 0.07, metalness: 0, color: 0xffffff }), {
  vert: 'attribute vec2 aUv; varying float vSea;',
  vmain: 'vSea = aUv.x;',
  frag: 'varying float vSea; uniform float uWT;',
  uniforms: { uWT: WATER_T },
  color: 'diffuseColor.rgb = mix(vec3(0.035, 0.06, 0.045), vec3(0.012, 0.05, 0.07), vSea) * (0.85 + 0.3 * fwyFbm(vObj * 0.01, 3));',
  normal: `{
    vec2 p = vObj.xy; float t = uWT;
    float sc = mix(0.12, 0.05, vSea), e = 0.8;
    vec3 o = vec3(t * 0.06, t * 0.04, t * 0.15);
    float h0 = fwyFbm(vec3(p * sc, 0.0) + o, 3), hx = fwyFbm(vec3((p + vec2(e, 0.0)) * sc, 0.0) + o, 3), hy = fwyFbm(vec3((p + vec2(0.0, e)) * sc, 0.0) + o, 3);
    vec3 dw = vec3(-(hx - h0), 0.0, (hy - h0)) * mix(4.0, 7.0, vSea);
    normal = normalize(normal + mat3(viewMatrix) * dw);
  }`,
});
// 地形: 依坡度與高度上色 — 平地是田野、草地拼塊，山坡是闊葉林 (近看有一叢叢樹冠)，陡坡露岩，高山 (2500 m 以上) 是箭竹草原
const TERRAIN_SPEC = {
  vert: 'varying vec3 vTN; attribute vec4 aLc0; attribute vec4 aLc1; varying vec4 vLc0; varying vec4 vLc1;',
  vmain: 'vTN = normal; vLc0 = aLc0; vLc1 = aLc1;',
  frag: 'varying vec3 vTN; varying vec4 vLc0; varying vec4 vLc1;',
  color: `{
    float slope = 1.0 - clamp(normalize(vTN).y, 0.0, 1.0);          // 0 平地 .. 1 垂直
    float z = vObj.z;
    float n1 = fwyFbm(vObj * 0.004, 5), n2 = fwyFbm(vObj * 0.0012 + 7.3, 4);
    float camD = length(vViewPosition);
    float near = 1.0 - smoothstep(250.0, 900.0, camD);               // 細節只在近處 (遠處會閃)
    // 平地: 田野拼塊 (約 60 m 一塊) + 草地 + 灰色 (村落、空地)
    vec2 cell = floor(vObj.xy / vec2(70.0, 48.0) + n1 * 1.5);
    float fh = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    vec3 field = fh < 0.35 ? vec3(0.085, 0.11, 0.045) : fh < 0.6 ? vec3(0.06, 0.09, 0.035) : fh < 0.8 ? vec3(0.11, 0.105, 0.06) : vec3(0.075, 0.075, 0.068);
    vec3 flat_ = mix(mix(vec3(0.07, 0.085, 0.05), vec3(0.09, 0.1, 0.06), n1), field, 0.55 * (1.0 - smoothstep(150.0, 400.0, z)));
    // 山坡: 闊葉林，近看有樹冠 (亮綠頂、暗綠縫)
    float canopy = fwyFbm(vObj * 0.11, 3);
    vec3 forest = mix(vec3(0.018, 0.045, 0.016), vec3(0.04, 0.078, 0.028), n1 * 0.7 + n2 * 0.3);
    forest *= mix(1.0, 0.55 + 0.9 * canopy, near);
    vec3 rock = mix(vec3(0.09, 0.085, 0.075), vec3(0.13, 0.12, 0.1), n2);
    vec3 alpine = mix(vec3(0.075, 0.085, 0.04), vec3(0.11, 0.1, 0.055), n1);
    float fw = smoothstep(0.006, 0.045, slope + (n2 - 0.5) * 0.02) * (1.0 - smoothstep(40.0, 10.0, z) * 0.6);   // 坡度 6°~17° 漸變成森林
    fw = max(fw, smoothstep(250.0, 500.0, z) * 0.85);
    vec3 c = mix(flat_, forest, fw);
    c = mix(c, rock, smoothstep(0.45, 0.62, slope + (n1 - 0.5) * 0.1));   // 57° 以上的陡崖才露岩
    c = mix(c, alpine, smoothstep(2400.0, 2900.0, z + (n2 - 0.5) * 300.0) * (1.0 - smoothstep(0.6, 0.8, slope)));
    // OSM 地表分類 (有資料的地方蓋過自動上色)
    float sp = fwyFbm(vObj * 0.9, 2);
    vec3 cUrban = mix(vec3(0.085, 0.085, 0.082), vec3(0.13, 0.125, 0.115), n1) * (0.85 + 0.3 * fwyHash(floor(vObj / 9.0)));
    vec3 cFarm = mix(field, vec3(0.05, 0.1, 0.035), 0.25);
    vec3 cGrass = mix(vec3(0.06, 0.11, 0.035), vec3(0.09, 0.14, 0.05), n1);
    vec3 cSand = mix(vec3(0.33, 0.29, 0.21), vec3(0.42, 0.37, 0.27), n2) * (0.92 + 0.16 * sp);
    vec3 cGravel = mix(vec3(0.17, 0.165, 0.15), vec3(0.26, 0.25, 0.23), sp) * (0.85 + 0.3 * fwyFbm(vObj * 0.05, 3));
    vec3 cWet = mix(vec3(0.035, 0.05, 0.03), vec3(0.06, 0.07, 0.045), n1);
    vec3 cBed = vec3(0.05, 0.055, 0.045);
    c = mix(c, cBed, vLc0.x); c = mix(c, cSand, vLc0.y); c = mix(c, cGravel, vLc0.z); c = mix(c, cWet, vLc0.w);
    c = mix(c, cUrban, vLc1.x); c = mix(c, cFarm, vLc1.y); c = mix(c, forest, vLc1.z); c = mix(c, cGrass, vLc1.w);
  #ifdef USE_MAP
    // 國土測繪中心正射影像 (真的田、聚落、河床、山林)；近處再疊一點原本的細節雜訊，解析度不夠的地方才不會糊成一片
    vec3 ph = texture2D(map, vMapUv).rgb;
    ph = max(mix(vec3(dot(ph, vec3(0.3, 0.59, 0.11))), ph, 1.25), 0.0) * 0.8;   // 航照偏灰: 飽和度 +25%
    ph *= mix(1.0, 0.8 + 0.4 * canopy, near * fw);
    ph *= mix(1.0, 0.9 + 0.2 * n1, near);
    c = mix(c, ph, 0.92);
  #endif
    diffuseColor.rgb = c;
  }`,
};
const matTerrain = patch(new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0 }), TERRAIN_SPEC);

// ======================================================================= 幾何建構
class GB {
  // mode: '' 只有位置；'uv' 加 aUv；'road' 加 aUv + 車道屬性
  constructor(mode = '') { this.p = []; this.i = []; this.extra = mode === 'road'; if (mode) this.uv = []; if (this.extra) { this.ls = []; this.ln = []; } this.nrm = null; }
  get n() { return this.p.length / 3; }
  v(x, y, z) { this.p.push(x, z, -y); return this.n - 1; }  // 資料座標 -> three
  q(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  mesh(mat, opts = {}) {
    if (!this.i.length) return null;
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(this.p, 3));
    if (this.uv) g.setAttribute('aUv', new T.Float32BufferAttribute(this.uv, 2));
    if (this.extra) {
      g.setAttribute('aLs', new T.Float32BufferAttribute(this.ls, 1));
      g.setAttribute('aLanes', new T.Float32BufferAttribute(this.ln, 1));
    }
    g.setIndex(this.n > 65535 ? new T.Uint32BufferAttribute(this.i, 1) : new T.Uint16BufferAttribute(this.i, 1));
    if (this.nrm) g.setAttribute('normal', new T.Float32BufferAttribute(this.nrm, 3)); else g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new T.Mesh(g, mat);
    m.castShadow = !!opts.cast; m.receiveShadow = opts.receive !== false;
    m.matrixAutoUpdate = false; m.updateMatrix();
    return m;
  }
}

// 混凝土護欄斷面 (照街景: 底部小斜趾、上半近乎垂直、平頂)；[橫向 m, 高 m]
const BARRIER = [[-0.32, 0], [-0.3, 0.07], [-0.2, 0.16], [-0.11, 0.84], [-0.08, 0.87], [0.08, 0.87], [0.11, 0.84], [0.2, 0.16], [0.3, 0.07], [0.32, 0]];
const BARRIER_INSET = 0.35;

// ---- 國道主線路肩 (照實際尺寸): 內側黃線到中央護欄面約 2 m、外側白線到外側護欄面 3 m、中央只有一道護欄
// 原始資料: 黃線到路面左緣 1.0 m、右側路肩 3.3 m、兩方向路面間距中位數 1.4 m。
// 路線中心線與 hw 都不動 (接點、匝道、隧道、AI 全部照舊)；車道整體往右移 0.6 m (ls 1.0 → 1.6)，
// 路面逐點往左 (eL) / 往右 (eR) 多鋪一點: 右邊 0.97 m → 外側路肩 3 m (旁邊有匝道就縮)；
// 左邊有對向路面 → 鋪到兩條路面正中間、在那裡放一道共用的護欄；沒有對向 → 多鋪 1.07 m、護欄放在新路緣
const BAR_HALF = 0.32, LS_FWY = 1.6, ER_MAX = 0.97, EL_MAX = 1.07, PAIR_MAX = 3.0;
const isFwyMain = (w) => !w.city && !w.trunk && !w.link && w.oneway && w.lanes >= 2;
/** 第 i 點左右兩側最近的其他路面: 路緣到路緣的間距 gL / gR (m)，左側最近的是不是對向國道主線 */
function sideProbe(w, i) {
  const x = w.P[i * 3], y = w.P[i * 3 + 1], z = w.P[i * 3 + 2], nx = w.nx[i], ny = w.ny[i], tx = ny, ty = -nx, R = w.hw + 8;
  let gL = null, gR = null, oL = null, seen = new Set();
  for (let cx = Math.floor((x - R) / CELL); cx <= Math.floor((x + R) / CELL); cx++) for (let cy = Math.floor((y - R) / CELL); cy <= Math.floor((y + R) / CELL); cy++) {
    const a = GRID.get(cellKey(cx, cy)); if (!a) continue;
    for (let j = 0; j < a.length; j += 2) {
      const o = WAYS[a[j]], si = a[j + 1];
      if (!o || o === w || o.city) continue;
      const id = a[j] * 100000 + si; if (seen.has(id)) continue; seen.add(id);
      const ax = o.P[si * 3], ay = o.P[si * 3 + 1], bx = o.P[si * 3 + 3], by = o.P[si * 3 + 4], L = Math.hypot(bx - ax, by - ay);
      if (L < 1e-3) continue;
      const ux = (bx - ax) / L, uy = (by - ay) / L, dot = ux * tx + uy * ty;
      if (Math.abs(dot) < 0.7) continue;   // 交叉的路不算
      const t = (x - ax) * ux + (y - ay) * uy; if (t < -0.5 || t > L + 0.5) continue;
      const tc = Math.min(L, Math.max(0, t)), qx = ax + ux * tc, qy = ay + uy * tc;
      const qz = o.P[si * 3 + 2] + (o.P[si * 3 + 5] - o.P[si * 3 + 2]) * (tc / L);
      if (Math.abs(qz - z) > 2) continue;   // 上下層不算
      const lat = (qx - x) * nx + (qy - y) * ny, g = Math.abs(lat) - w.hw - o.hw;
      if (g > 8 || Math.abs(lat) < 0.5) continue;
      if (lat > 0) { if (gL == null || g < gL) { gL = g; oL = { o, opp: dot < -0.85 && isFwyMain(o) && !o.tunnel }; } }
      else if (gR == null || g < gR) gR = g;
    }
  }
  return { gL, gR, oL };
}
function setupShoulders(w) {
  if (w.shoulder !== undefined) return;
  w.shoulder = false;
  if (!isFwyMain(w) || params.has('oldshoulder')) return;
  w.ls = LS_FWY;   // 隧道也一樣 (車道跟洞外對齊)
  if (w.tunnel) return;
  const n = w.n, gL = new Array(n), gR = new Array(n), pair = new Uint8Array(n), opp = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const p = sideProbe(w, i); gL[i] = p.gL; gR[i] = p.gR;
    if (p.oL && p.oL.opp && p.gL < PAIR_MAX) { pair[i] = 1; opp[i] = p.oL.o; }
  }
  // 零星一點沒配到 / 只配到一點: 補起來 / 拿掉
  for (let i = 1; i < n - 1; i++) if (!pair[i] && pair[i - 1] && pair[i + 1]) { pair[i] = 1; opp[i] = opp[i - 1]; gL[i] = (gL[i - 1] + gL[i + 1]) / 2; }
  for (let i = 0; i < n; i++) if (pair[i] && !(i > 0 && pair[i - 1]) && !(i < n - 1 && pair[i + 1])) pair[i] = 0;
  // 平滑視窗在兩端縮小 (端點用原值): 前後兩條路段在接點量到的是同一個位置，才接得上
  const avg = (arr, i, ok) => { const h = Math.min(3, i, n - 1 - i); let sum = 0, k = 0; for (let j = i - h; j <= i + h; j++) if (ok(j)) { sum += arr[j]; k++; } return k ? sum / k : arr[i]; };
  const capL = new Float32Array(n), capR = new Float32Array(n), mid = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (pair[i]) mid[i] = avg(gL, i, (j) => pair[j]) / 2;   // 中央護欄中心 = 路緣外 g/2 (平滑)
    capL[i] = pair[i] ? Math.max(0, mid[i]) : (gL[i] == null ? EL_MAX : Math.min(EL_MAX, Math.max(0, gL[i] / 2 - 0.05)));
    capR[i] = gR[i] == null ? ER_MAX : Math.min(ER_MAX, Math.max(0, gR[i] - 0.05));
  }
  const eL = new Float32Array(n), eR = new Float32Array(n), bc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    eL[i] = pair[i] ? capL[i] : Math.min(capL[i], avg(capL, i, (j) => !pair[j]));
    eR[i] = Math.min(capR[i], avg(capR, i, () => true));
    bc[i] = pair[i] ? w.hw + mid[i] : w.hw + eL[i] - BARRIER_INSET;
  }
  Object.assign(w, { shoulder: true, eL, eR, bc, pair, oppL: opp });
}
/** 門架 / 看板左側立柱位置 (左法向偏移): 國道主線立在中央護欄上 */
function leftPost(w, i) { setupShoulders(w); return w.bc ? w.bc[Math.min(Math.max(i | 0, 0), w.n - 1)] : w.hw + 0.6; }
/** 右側路緣 (加寬後) */
function rightEdge(w, i) { setupShoulders(w); return w.hw + (w.eR ? w.eR[Math.min(Math.max(i | 0, 0), w.n - 1)] : 0); }

// GB('uv') 的貼圖座標存在 aUv (給自訂著色器)；用標準材質的 map 時要複製一份成 uv
const withUv = (m) => { if (m) m.geometry.setAttribute('uv', m.geometry.getAttribute('aUv')); return m; };
/** (x, y) 這個 40 m 格子裡有沒有一般道路 (判斷國道旁邊是不是市區用) */
function cityAt(x, y) {
  const a = GRID.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (a) for (let j = 0; j < a.length; j += 2) { const w = WAYS[a[j]]; if (w && w.city) return true; }
  return false;
}
/** 國道外側路邊設施: 市區段的隔音牆 (下半實心、上半壓克力、4 m 一根柱子) 與約每 1.2 km 一面廣告看板 */
function roadside(c, w, oAt, inward) {
  const { P, nx, ny, s, n, hw, M } = w, L = s[n - 1];
  if (L < 30) return;
  const at = (d) => { let k = 0; while (k < n - 2 && s[k + 1] < d) k++; const t = Math.min(1, Math.max(0, (d - s[k]) / ((s[k + 1] - s[k]) || 1)));
    return { k, x: P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * t, y: P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * t, z: P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t }; };
  const out = -inward;   // 外側方向 (乘在左法向上)
  // 每 20 m 判一次旁邊是不是市區，前後各延伸 40 m (隔音牆會一路延伸過市區邊緣，不會一段一段)
  const step = 20, ns = Math.ceil(L / step) + 1, urb = new Uint8Array(ns);
  for (let q = 0; q < ns; q++) {
    const p = at(q * step), ox = nx[p.k] * out, oy = ny[p.k] * out;
    // 市區: 外側 35 / 60 / 90 m 有一般道路，或地表分類是市區 (台北盆地大部分沒有土地分類資料，只看分類會判不到)
    let u = 0;
    for (const dd of [35, 60, 90]) { const xx = p.x + ox * (hw + dd), yy = p.y + oy * (hw + dd); if (landcoverAt(xx, yy) === 5 || cityAt(xx, yy)) { u = 1; break; } }
    urb[q] = u;
  }
  const wall = new Uint8Array(ns);
  for (let q = 0; q < ns; q++) if (urb[q]) for (let r = Math.max(0, q - 2); r <= Math.min(ns - 1, q + 2); r++) wall[r] = 1;
  // 隔音牆 (4 m 一片)
  for (let d = 2; d < L - 2; d += 4) {
    if (!wall[Math.min(ns - 1, Math.round(d / step))]) continue;
    const p = at(d); if ((M[p.k] | M[p.k + 1]) & 2) continue;
    const tx = ny[p.k], ty = -nx[p.k], ox = nx[p.k] * out, oy = ny[p.k] * out;
    const o = oAt(p.k), cx = p.x + nx[p.k] * o + ox * 0.18, cy = p.y + ny[p.k] * o + oy * 0.18;
    box(c.swall, cx, cy, tx, ty, 2.0, 0.07, p.z + 0.86, p.z + 2.3);
    box(c.sglass, cx, cy, tx, ty, 1.97, 0.03, p.z + 2.3, p.z + 4.2);
    box(c.spost, cx - tx * 2, cy - ty * 2, tx, ty, 0.09, 0.11, p.z + 0.86, p.z + 4.35);
    box(c.spost, cx, cy, tx, ty, 2.0, 0.05, p.z + 4.2, p.z + 4.32);   // 頂部壓條
  }
  // 廣告看板: 市區段約每 1.2 km 一面 (位置由 gid 決定，每次載入都一樣)，立在護欄外 9 m，面向來車並往路內轉 18°
  const first = 250 + ((w.gid * 7919) % 900);
  for (let d = first, idx = w.gid; d < L - 60; d += 1200, idx++) {
    if (!urb[Math.min(ns - 1, Math.round(d / step))]) continue;
    const p = at(d); if ((M[p.k] | M[p.k + 1]) & 2) continue;
    const tx = ny[p.k], ty = -nx[p.k], ox = nx[p.k] * out, oy = ny[p.k] * out;
    const o = oAt(p.k), bx = p.x + nx[p.k] * o + ox * 9, by = p.y + ny[p.k] * o + oy * 9;
    const gz = terrainAt(bx, by), base = Math.min(gz, p.z), top = p.z + 13, bot = top - 4.2;
    if (p.z - gz > 25) continue;   // 高架很高的地方不放
    box(c.bpole, bx, by, tx, ty, 0.35, 0.35, base - 0.5, bot + 0.5);
    // 板面: 法向 = -行進方向 (面向來車) 往路內轉 18°
    const a = 0.31, fx = -tx * Math.cos(a) - ox * Math.sin(a), fy = -ty * Math.cos(a) - oy * Math.sin(a);   // 板面朝向
    const ux = -fy, uy = fx;   // 板面水平方向
    const hwB = 6.0, ad = idx % 6, u0 = (ad % 3) / 3, v0 = 1 - Math.floor(ad / 3) / 2;
    const g = c.bboard, i0 = g.n, fxo = fx * 0.12, fyo = fy * 0.12;
    g.v(bx + fxo - ux * hwB, by + fyo - uy * hwB, bot); g.uv.push(u0 + 1 / 3, v0 - 0.5);
    g.v(bx + fxo + ux * hwB, by + fyo + uy * hwB, bot); g.uv.push(u0, v0 - 0.5);
    g.v(bx + fxo + ux * hwB, by + fyo + uy * hwB, top); g.uv.push(u0, v0);
    g.v(bx + fxo - ux * hwB, by + fyo - uy * hwB, top); g.uv.push(u0 + 1 / 3, v0);
    g.q(i0, i0 + 1, i0 + 2, i0 + 3);
    box(c.bback, bx, by, ux, uy, hwB + 0.15, 0.1, bot - 0.15, top + 0.15);   // 背板 + 邊框
    box(c.bpole, bx, by, ux, uy, hwB, 0.08, bot - 0.6, bot - 0.45);           // 下方維修走道
  }
}
function addRoad(c, w) {
  setupShoulders(w);
  const { P, nx, ny, s, n, hw } = w;
  // 兩側路緣 (國道主線多鋪的路肩: 左 eL、右 eR；u 座標仍從原本左路緣起算，標線位置不變)
  const EL = (i) => w.eL ? w.eL[i] : 0, ER = (i) => w.eR ? w.eR[i] : 0;
  // 路面
  const r = c.road, b0 = r.n;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], le = hw + EL(i), re = hw + ER(i);
    const lsT = w.ls + (w.tunnel ? 100 : 0);   // 隧道旗標: 著色器用 aLs >= 50 判斷
    r.v(x + nx[i] * le, y + ny[i] * le, z); r.uv.push(-EL(i), s[i]); r.ls.push(lsT); r.ln.push(w.lanes);
    r.v(x - nx[i] * re, y - ny[i] * re, z); r.uv.push(w.width + ER(i), s[i]); r.ls.push(lsT); r.ln.push(w.lanes);
  }
  for (let i = 0; i < n - 1; i++) { if (w.M[i] & w.M[i + 1] & 4) continue; const a = b0 + i * 2; r.q(a, a + 1, a + 3, a + 2); }   // bit2: 匝道整段在主線路面內 (fix_clip.mjs)，不畫
  // 側面 / 梁底
  const depth = w.bridge ? 2.2 : (w.tunnel ? 0.6 : 2.0);
  const k = c.skirt, s0 = k.n;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const le = hw + EL(i), re = hw + ER(i);
    const lx = x + nx[i] * le, ly = y + ny[i] * le, rx = x - nx[i] * re, ry = y - ny[i] * re;
    k.v(lx, ly, z); k.v(rx, ry, z); k.v(lx, ly, z - depth); k.v(rx, ry, z - depth);
  }
  const M = w.M, PR = (i) => w.pair && w.pair[i];
  for (let i = 0; i < n - 1; i++) {
    const a = s0 + i * 4, bb = a + 4;
    if (!((M[i] | M[i + 1]) & 1) && !(PR(i) && PR(i + 1) && !w.bridge)) k.q(a, bb, bb + 2, a + 2);          // 左側 (落在別條路面上就不做)
    if (!((M[i] | M[i + 1]) & 2)) k.q(a + 1, a + 3, bb + 3, bb + 1);  // 右側
    if (w.bridge) k.q(a + 2, bb + 2, bb + 3, a + 3);                 // 梁底
  }
  // 紐澤西護欄 (左右；分合流處落在別條路面上的段落不放)
  for (const [edge, inward, bit] of (w.tunnel ? [] : [[hw, -1, 1], [-hw, 1, 2]])) {   // 隧道內是檢修步道，不放護欄
    // 每個斷面線段各自一組頂點 (稜角分明)；UV: u = 沿線距離、v = 高度 (給接縫、排水孔、髒污用)
    const g = c.barrier, g0 = g.n, segs = BARRIER.length - 1, per = segs * 2;
    const o = edge + inward * BARRIER_INSET;
    // 護欄中心 (左法向偏移): 國道主線左邊 = 中央護欄 (w.bc)、右邊 = 加寬後路緣往內 0.35 m
    const oAt = (i) => w.bc ? (bit === 1 ? w.bc[i] : -(hw + ER(i)) + BARRIER_INSET) : o;
    // 共用的中央護欄 (左邊有對向路面) 只由 gid 小的那一條建，才不會兩道疊在一起
    const notMine = (i) => bit === 1 && PR(i) && w.oppL[i] && w.oppL[i].gid < w.gid;
    for (let i = 0; i < n; i++) {
      const oi = oAt(i), cx = P[i * 3] + nx[i] * oi, cy = P[i * 3 + 1] + ny[i] * oi, cz = P[i * 3 + 2];
      for (let j = 0; j < segs; j++) for (const [a, h] of [BARRIER[j], BARRIER[j + 1]]) {
        g.v(cx + nx[i] * a, cy + ny[i] * a, cz + h - 0.03); g.uv.push(s[i], h);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      if ((M[i] | M[i + 1]) & bit) continue;
      if (notMine(i) && notMine(i + 1)) continue;
      for (let j = 0; j < segs; j++) { const a = g0 + i * per + j * 2; g.q(a, a + 1, a + 1 + per, a + per); }
    }
    // 防眩板: 國道主線中央分隔護欄 (左側) 頂上每 4 m 一片，板面幾乎垂直路線 (擋對向車燈、側面看得穿)。
    // 雙向兩條路面緊貼時兩邊的護欄並排，只由 gid 較小的那一側放，才不會變兩排
    if (bit === 1 && !w.link && !w.tunnel && w.oneway && !params.has('noglare')) {
      let skip = false;
      for (let d = 2; d < s[n - 1]; d += 4) {
        let k = 0; while (k < n - 2 && s[k + 1] < d) k++;
        if ((M[k] | M[k + 1]) & bit) continue;
        const t = (d - s[k]) / ((s[k + 1] - s[k]) || 1);
        const bx = P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * t, by = P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * t;
        const z = P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t;
        if (w.bc) skip = notMine(k);
        else if (((d - 2) / 4) % 10 === 0) {   // 每 40 m 看一次旁邊是不是緊貼著對向路面
          const pr = roadAt(bx + nx[k] * (hw + 1.6), by + ny[k] * (hw + 1.6), z, 0, 1.5);
          skip = !!(pr && pr.w !== w && !pr.w.city && Math.abs(pr.z - z) < 1.5 && pr.tx * ny[k] + pr.ty * -nx[k] < -0.8 && pr.w.gid < w.gid);
        }
        if (skip) continue;
        const ok = oAt(k), x = bx + nx[k] * ok, y = by + ny[k] * ok, a = 0.21;   // 板面轉 12°
        const tx = ny[k] * Math.cos(a) + nx[k] * Math.sin(a), ty = -nx[k] * Math.cos(a) + ny[k] * Math.sin(a);
        box(c.glare, x, y, tx, ty, 0.022, 0.12, z + 0.84, z + 1.55);
        box(c.glare, x, y, ny[k], -nx[k], 0.03, 0.03, z + 0.8, z + 0.9);   // 底座
      }
    }
    // 隔音牆 + 廣告看板: 國道主線外側 (右邊)，旁邊 30~60 m 是市區的路段
    if (bit === 2 && !w.link && !w.tunnel && w.oneway && !w.city && !params.has('nowall')) roadside(c, w, oAt, inward);
    // 路燈: 國道主線中央分隔島每 40 m 一支雙臂燈 (夜晚燈頭發光、路面有光暈)
    if (bit === 1 && !w.link && !w.tunnel && w.oneway && !params.has('nolamps')) {
      for (let d = 2; d < s[n - 1]; d += 40) {
        let k = 0; while (k < n - 2 && s[k + 1] < d) k++;
        if ((M[k] | M[k + 1]) & bit) continue;
        const t = (d - s[k]) / ((s[k + 1] - s[k]) || 1);
        const bx = P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * t, by = P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * t;
        const z = P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t;
        if (w.bc) { if (notMine(k)) continue; }
        else {
          const pr = roadAt(bx + nx[k] * (hw + 1.6), by + ny[k] * (hw + 1.6), z, 0, 1.5);
          if (pr && pr.w !== w && !pr.w.city && Math.abs(pr.z - z) < 1.5 && pr.tx * ny[k] + pr.ty * -nx[k] < -0.8 && pr.w.gid < w.gid) continue;
        }
        const ok = oAt(k), x = bx + nx[k] * ok, y = by + ny[k] * ok;
        box(c.lampPole, x, y, ny[k], -nx[k], 0.09, 0.09, z + 0.85, z + 10.5);
        box(c.lampPole, x, y, ny[k], -nx[k], 0.05, 2.0, z + 10.3, z + 10.42);
        for (const sd of [-1, 1]) {
          const lx = x + nx[k] * sd * 1.9, ly = y + ny[k] * sd * 1.9;
          box(c.lampHead, lx, ly, ny[k], -nx[k], 0.32, 0.16, z + 10.12, z + 10.3);
          c.glows.push(lx, z + 10.05, -ly);
        }
      }
    }
    // 反光片: 每 24 m 一支 (照實物: 黃色圓形稜鏡反光片、黑色外框、黑色支柱、橢圓底座)，反光面朝來車
    for (let d = 12; d < s[n - 1]; d += 24) {
      let k = 0; while (k < n - 2 && s[k + 1] < d) k++;
      if ((M[k] | M[k + 1]) & bit) continue;
      const t = (d - s[k]) / ((s[k + 1] - s[k]) || 1);
      const ok = oAt(k), x = P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * t + nx[k] * ok, y = P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * t + ny[k] * ok;
      const z = P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t;
      if (bit === 1) continue;   // 中央分隔島 (左側) 不放反光片
      addReflector(c, x, y, z + 0.87, ny[k], -nx[k]);
    }
  }
  if (w.tunnel) addTunnel(c, w);
}

// ======================================================================= 匝道槽化區 (照街景: 白色斑馬紋、兩側白實線、橘色導桿、鼻端黃色緩衝桶)
const GORE_MAX = 9;
/** 最近的同向主線 (投影點、左法向、橫向距離)；搜尋周圍 3x3 格，因為槽化區離主線中心線可能 20 m 以上 */
function projMainRT(x, y, z, tx, ty) {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  let best = null;
  for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
    const a = GRID.get(cellKey(ix, iy)); if (!a) continue;
    for (let q = 0; q < a.length; q += 2) {
      const w = WAYS[a[q]], i = a[q + 1];
      if (w.link || w.city) continue;
      const P = w.P, ax = P[i * 3], ay = P[i * 3 + 1], dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, L = Math.hypot(dx, dy);
      if (L < 1e-3) continue;
      const ux = dx / L, uy = dy / L;
      if (ux * tx + uy * ty < 0.7) continue;
      const t = ((x - ax) * ux + (y - ay) * uy) / L;
      if (t < -0.02 || t > 1.02) continue;
      const tc = Math.min(1, Math.max(0, t)), pz = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * tc;
      if (Math.abs(pz - z) > 3) continue;
      const px = ax + dx * tc, py = ay + dy * tc, lat = (x - px) * -uy + (y - py) * ux;
      if (!best || Math.abs(lat) < Math.abs(best.lat)) best = { w, i, px, py, pz, nx: -uy, ny: ux, lat };
    }
  }
  return best;
}
function addGore(c, w, r) {
  const { P, n } = w, dir = r.e === 0 ? 1 : -1, side = r.side, G = c.gore;
  let along = 0, prevRow = -1, lastPost = -1e9, drums = false, prevGap = null, prevM = null;
  for (let k = r.e; k >= 0 && k < n && along < 450; k += dir) {
    if (k !== r.e) along += Math.hypot(P[k * 3] - P[(k - dir) * 3], P[k * 3 + 1] - P[(k - dir) * 3 + 1]);
    const m = projMainRT(P[k * 3], P[k * 3 + 1], P[k * 3 + 2], w.ny[k], -w.nx[k]);
    if (!m) break;
    const mE = side < 0 ? rightEdge(m.w, m.i) : m.w.hw;   // 主線那一側的路緣 (右側有加寬的路肩)
    const gap = side * m.lat - mE - w.hw;
    if (side * m.lat <= 0 || (prevGap != null && gap < prevGap - 1.5) || (prevM && m.w !== prevM.w && Math.abs(m.lat - prevM.lat) > 4)) break;   // 找到別條主線: 停
    prevGap = gap; prevM = m;
    if (gap < 0.3) { prevRow = -1; continue; }   // 還疊在主線路面上: 槽化區從兩路緣分開的地方才開始
    const ex = m.px + side * m.nx * mE, ey = m.py + side * m.ny * mE, ez = m.pz;
    const lx = P[k * 3] - side * m.nx * w.hw, ly = P[k * 3 + 1] - side * m.ny * w.hw, lz = P[k * 3 + 2];
    const W = Math.max(0, Math.hypot(lx - ex, ly - ey));
    const a = G.v(ex, ey, ez + 0.01); G.uv.push(along, 0); G.ls.push(W); G.ln.push(0);
    G.v(lx, ly, lz + 0.01); G.uv.push(along, W); G.ls.push(W); G.ln.push(0);
    if (prevRow >= 0) G.q(prevRow, prevRow + 1, a + 1, a);
    prevRow = a;
    // 導桿: 槽化區中線，每 2.5 m 一支 (寬度夠才放)
    if (W > 1.2 && along - lastPost >= 2.5) {
      lastPost = along;
      const px = (ex + lx) / 2, py = (ey + ly) / 2, pz = (ez + lz) / 2;
      box(c.gpost, px, py, w.ny[k], -w.nx[k], 0.045, 0.045, pz, pz + 0.75);
      box(c.gband, px, py, w.ny[k], -w.nx[k], 0.05, 0.05, pz + 0.5, pz + 0.62);
    }
    if (gap > GORE_MAX) {
      // 鼻端 (護欄開始處) 放三個黃色緩衝桶
      if (!drums) {
        drums = true;
        for (let d = 0; d < 3; d++) {
          const f = (d + 1) / 4, qx = ex + (lx - ex) * f, qy = ey + (ly - ey) * f, qz = ez + (lz - ez) * f;
          box(c.drum, qx, qy, w.ny[k], -w.nx[k], 0.42, 0.42, qz, qz + 0.95);
          box(c.drumb, qx, qy, w.ny[k], -w.nx[k], 0.43, 0.43, qz + 0.55, qz + 0.68);
        }
      }
      break;
    }
  }
}

// ======================================================================= 伸縮縫 (橋梁接縫)
// 每座橋墩上方與橋頭各一道；車輪壓過時「叩」一聲 (前輪、後輪各一下)
const JOINTS = [], JGRID = new Map(), JCELL = 50;
// 伸縮縫 = { x, y: 路中心線上的點, z, tx, ty: 路線方向, hL, hR: 往左 / 往右到路緣 (含加寬的路肩) }
function addJoint(j) {
  JOINTS.push(j);
  const r = Math.max(j.hL, j.hR) + 2;
  for (let cx = Math.floor((j.x - r) / JCELL); cx <= Math.floor((j.x + r) / JCELL); cx++)
    for (let cy = Math.floor((j.y - r) / JCELL); cy <= Math.floor((j.y + r) / JCELL); cy++) {
      const k = cx * 100003 + cy;
      let a = JGRID.get(k); if (!a) JGRID.set(k, a = []); a.push(j);
    }
}
const JSEEN = new Set();
/** 路段 w 第 i 段上、離 (x, y) 最近的中心線點 -> 伸縮縫 (垂直路線、左右到路緣) */
function jointOn(w, i, x, y) {
  setupShoulders(w);
  const P = w.P, ax = P[i * 3], ay = P[i * 3 + 1], dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, L = Math.hypot(dx, dy) || 1;
  const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (L * L)));
  const lerp = (a) => a ? a[i] + (a[i + 1] - a[i]) * t : 0;
  return { x: ax + dx * t, y: ay + dy * t, z: P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t, tx: dx / L, ty: dy / L,
    hL: w.hw + lerp(w.eL), hR: w.hw + lerp(w.eR), k: w.k };
}
/** 分區的伸縮縫 (需要鄰區資料: 橋頭判斷、橋墩上方路面) */
function computeJoints(rec) {
  const out = [];
  const mk = (j) => {
    const key = j.k + ':' + Math.round(j.x) + ',' + Math.round(j.y);   // 每條路各自一道 (同一座橋墩撐兩個方向時兩邊都要有)
    if (JSEEN.has(key)) return;
    JSEEN.add(key); out.push(j); addJoint(j);
  };
  const A = rec.piers;
  for (let k = 0; k < A.length / 9; k++) {   // 橋墩上方: 帽梁上的每一條橋面 (不只最高那條)
    const x = A[k * 9], y = A[k * 9 + 1], top = A[k * 9 + 6];
    const cells = new Set();
    for (const [ox, oy] of [[0, 0], [-16, 0], [16, 0], [0, -16], [0, 16]]) cells.add(cellKey(Math.floor((x + ox) / CELL), Math.floor((y + oy) / CELL)));
    const best = new Map();   // way -> { d, i }
    for (const ck of cells) {
      const a = GRID.get(ck); if (!a) continue;
      for (let q = 0; q < a.length; q += 2) {
        const w = WAYS[a[q]], i = a[q + 1];
        if (w.city || w.tunnel) continue;
        const P = w.P, ax = P[i * 3], ay = P[i * 3 + 1], dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, L2 = dx * dx + dy * dy;
        if (L2 < 1e-6) continue;
        const t = ((x - ax) * dx + (y - ay) * dy) / L2; if (t < 0 || t > 1) continue;
        const lat = Math.abs(((x - ax) * -dy + (y - ay) * dx) / Math.sqrt(L2)), z = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t;
        if (Math.abs(z - (top + 2.2)) > 1.5 || lat > w.hw + 16) continue;   // 在這座帽梁上 (高度對、橫向在帽梁範圍內)
        const b = best.get(w); if (!b || lat < b.d) best.set(w, { d: lat, i });
      }
    }
    for (const [w, b] of best) mk(jointOn(w, b.i, x, y));
  }
  for (const k of rec.ways) {             // 橋頭 (橋接地面路段處)
    const w = WAYS[k];
    if (!w.bridge || w.city) continue;
    for (const i of [0, w.n - 1]) {
      const others = PT_INDEX.get(ptKey(w.P[i * 3], w.P[i * 3 + 1])) || [];
      if (!others.some(([o]) => o !== w.k && !WAYS[o].bridge)) continue;
      mk(jointOn(w, Math.min(i, w.n - 2), w.P[i * 3], w.P[i * 3 + 1]));
    }
  }
  return out;
}
function jointMeshes(list, group) {
  const steel = new GB(), rubber = new GB();
  for (const j of list) {
    const nx = -j.ty, ny = j.tx, half = (j.hL + j.hR) / 2 - 0.25, off = (j.hL - j.hR) / 2;   // 不對稱: 中心往寬的那邊移
    const cx = j.x + nx * off, cy = j.y + ny * off;
    box(steel, cx + j.tx * 0.17, cy + j.ty * 0.17, j.tx, j.ty, 0.12, half, j.z - 0.03, j.z + 0.012);
    box(steel, cx - j.tx * 0.17, cy - j.ty * 0.17, j.tx, j.ty, 0.12, half, j.z - 0.03, j.z + 0.012);
    box(rubber, cx, cy, j.tx, j.ty, 0.05, half, j.z - 0.03, j.z + 0.004);
  }
  for (const m of [steel.mesh(matJointSteel), rubber.mesh(matJointRubber)]) if (m) group.add(m);
}
/** 車軸從 (ax,ay) 移到 (bx,by) 時有沒有壓過伸縮縫 (左右範圍分開算) */
function crossedJoint(ax, ay, bx, by, z) {
  const a = JGRID.get(Math.floor(bx / JCELL) * 100003 + Math.floor(by / JCELL));
  if (!a) return false;
  for (const j of a) {
    if (Math.abs(z - j.z) > 1.5) continue;
    const d0 = (ax - j.x) * j.tx + (ay - j.y) * j.ty, d1 = (bx - j.x) * j.tx + (by - j.y) * j.ty;
    if (d0 * d1 > 0 || d0 === d1) continue;
    const lat = (bx - j.x) * -j.ty + (by - j.y) * j.tx;
    if (lat <= j.hL && -lat <= j.hR) return true;
  }
  return false;
}

/** 反光片一支: 底座 (橢圓) → 支柱 (含束環) → 黑色圓框 → 黃色反光面 (面向 -t，也就是迎著來車)；(x, y, z0) 是護欄頂 */
function addReflector(c, x, y, z0, tx, ty) {
  const K = c.reflBlack, F = c.reflFace, nx = -ty, ny = tx;
  // 橢圓底座: 12 邊形壓扁
  const b0 = K.n, seg = 12;
  for (const zz of [z0, z0 + 0.018]) for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; K.v(x + tx * Math.cos(a) * 0.085 + nx * Math.sin(a) * 0.055, y + ty * Math.cos(a) * 0.085 + ny * Math.sin(a) * 0.055, zz); }
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; K.q(b0 + i, b0 + j, b0 + seg + j, b0 + seg + i); K.i.push(b0 + seg, b0 + seg + j, b0 + seg + i); }
  box(K, x, y, tx, ty, 0.022, 0.022, z0 + 0.018, z0 + 0.15);            // 支柱
  box(K, x, y, tx, ty, 0.03, 0.03, z0 + 0.07, z0 + 0.11);               // 束環
  const zc = z0 + 0.24;
  disc(K, x, y, zc, tx, ty, 0.1, 0.034, 20);                            // 黑色圓框
  // 黃色反光面 (略突出在圓框前方 = 迎向來車那一面)
  const fx = x - tx * 0.019, fy = y - ty * 0.019, r = 0.083, fs = 24, f0 = F.n;
  F.v(fx, fy, zc); F.uv.push(0, 0);
  for (let i = 0; i < fs; i++) { const a = i / fs * Math.PI * 2; F.v(fx + nx * Math.cos(a) * r, fy + ny * Math.cos(a) * r, zc + Math.sin(a) * r); F.uv.push(Math.cos(a), Math.sin(a)); }
  for (let i = 0; i < fs; i++) F.i.push(f0, f0 + 1 + ((i + 1) % fs), f0 + 1 + i);
  // 遠處的反光點 (位置 + 面向)
  c.rglow.push(fx, zc, -fy); c.rnorm.push(-tx, 0, ty);
}
/** 圓片 (軸沿路線方向 tx,ty，面向來車)：中心 (cx, cy, cz)、半徑 r、厚 th */
function disc(g, cx, cy, cz, tx, ty, r, th, seg = 12) {
  const nx = -ty, ny = tx, b = g.n;
  for (const f of [-1, 1]) {   // 前後兩個圓面 (中心 + 外圈)
    const ox = cx + tx * th * 0.5 * f, oy = cy + ty * th * 0.5 * f;
    g.v(ox, oy, cz);
    for (let i = 0; i < seg; i++) { const a = i / seg * Math.PI * 2; g.v(ox + nx * Math.cos(a) * r, oy + ny * Math.cos(a) * r, cz + Math.sin(a) * r); }
  }
  const back = b, front = b + seg + 1;
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    g.i.push(back, back + 1 + j, back + 1 + i);
    g.i.push(front, front + 1 + i, front + 1 + j);
    g.q(back + 1 + i, back + 1 + j, front + 1 + j, front + 1 + i);   // 側邊
  }
}
function box(g, cx, cy, tx, ty, hx, hy, z0, z1) {
  // tx,ty: 沿線方向；法向 = (-ty, tx)
  const nx = -ty, ny = tx;
  const corner = (sx, sy, z) => g.v(cx + tx * sx * hx + nx * sy * hy, cy + ty * sx * hx + ny * sy * hy, z);
  const faces = [
    [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]].reverse(),
    [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
    [[-1, -1, 0], [1, -1, 0], [1, -1, 1], [-1, -1, 1]],
    [[1, -1, 0], [1, 1, 0], [1, 1, 1], [1, -1, 1]],
    [[1, 1, 0], [-1, 1, 0], [-1, 1, 1], [1, 1, 1]],
    [[-1, 1, 0], [-1, -1, 0], [-1, -1, 1], [-1, 1, 1]],
  ];
  for (const f of faces) {
    const idx = f.map(([sx, sy, zz]) => corner(sx, sy, zz ? z1 : z0));
    g.q(idx[0], idx[1], idx[2], idx[3]);
  }
}

/** 橋墩 (前處理已避開下層道路): 柱子可能往側邊偏移，帽梁延伸過去撐住橋面 */
function addPier(g, A, k) {
  const q = A.subarray(k * 9, k * 9 + 9);
  let [x, y, tx, ty, offL, zg, top, capL, capR] = q;
  const nx = -ty, ny = tx;
  box(g, x + nx * offL, y + ny * offL, tx, ty, 1.0, 1.25, zg - 1.0, top - 1.4);            // 柱
  // 國道路肩加寬後橋面變寬: 帽梁兩端跟著加長 (橋墩方向可能跟路線相反，用左法向判斷哪一端在路面哪一側)
  const r = roadAt(x, y, top + 0.2, -3, 1.0);
  if (r && r.w.eL) {
    const same = r.w.nx[r.i] * nx + r.w.ny[r.i] * ny > 0, eL = r.w.eL[r.i], eR = r.w.eR[r.i];
    if (capL > capR) [capL, capR] = [capR, capL];
    capR += same ? eL : eR; capL -= same ? eR : eL;
  }
  const mid = (capL + capR) / 2;
  box(g, x + nx * mid, y + ny * mid, tx, ty, 0.9, (capR - capL) / 2, top - 1.4, top);      // 帽梁
}

/** 隧道口: 端點沒有接另一段隧道 */
const isTunnelEnd = (w, i) => !(PT_INDEX.get(ptKey(w.P[i * 3], w.P[i * 3 + 1])) || []).some(([k]) => k !== w.k && WAYS[k].tunnel);

/** 隧道內壁斷面 [橫向 (左正), 高度]：路緣 → 檢修步道 → 直牆 2.9 m → 橢圓拱頂 (頂高 7.2 m) → 另一側 */
function tunnelProfile(hw) {
  const a = hw + 0.9, H = 7.2, Hw = 2.9, out = [[-hw, 0], [-hw, 0.25], [-a, 0.25], [-a, Hw]];
  for (let j = 1; j < 20; j++) { const t = Math.PI * j / 20; out.push([-Math.cos(t) * a, Hw + Math.sin(t) * (H - Hw)]); }
  out.push([a, Hw], [a, 0.25], [hw, 0.25], [hw, 0]);
  return { pts: out, a, H, Hw };
}
function addTunnel(c, w) {
  const { P, nx, ny, n, hw, s } = w;
  const { pts, a, H, Hw } = tunnelProfile(hw), M = pts.length;
  const g = c.tunnel, g0 = g.n;
  for (let i = 0; i < n; i++) for (const [lat, up] of pts) {
    g.v(P[i * 3] + nx[i] * lat, P[i * 3 + 1] + ny[i] * lat, P[i * 3 + 2] + up); g.uv.push(s[i], up);
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < M - 1; j++) { const q = g0 + i * M + j; g.q(q, q + M, q + M + 1, q + 1); }
  // 兩排隧道燈 (拱頂兩側 45°)，每 3 m 一盞
  const th = Math.PI / 4, lampLat = Math.sin(th) * a * 0.97, lampUp = Hw + Math.cos(th) * (H - Hw) * 0.97;
  for (let d = 1.5; d < s[n - 1]; d += 3) {
    let k = 0; while (k < n - 2 && s[k + 1] < d) k++;
    const t = (d - s[k]) / ((s[k + 1] - s[k]) || 1);
    const x = P[k * 3] + (P[k * 3 + 3] - P[k * 3]) * t, y = P[k * 3 + 1] + (P[k * 3 + 4] - P[k * 3 + 1]) * t, z = P[k * 3 + 2] + (P[k * 3 + 5] - P[k * 3 + 2]) * t;
    for (const sd of [-1, 1]) box(c.tlight, x + nx[k] * lampLat * sd, y + ny[k] * lampLat * sd, ny[k], -nx[k], 0.6, 0.16, z + lampUp - 0.08, z + lampUp + 0.04);
    if (Math.round(d / 3) % 17 === 0) {   // 消防箱: 每 51 m 一個，右側牆面
      const cx = x - nx[k] * (a - 0.09), cy = y - ny[k] * (a - 0.09);
      box(c.tcab, cx, cy, ny[k], -nx[k], 0.4, 0.09, z + 0.85, z + 1.85);
    }
  }
  for (const i of [0, n - 1]) if (isTunnelEnd(w, i)) c.portals.push([w, i]);
}

/** 隧道洞口 (照國道 3 號街景): 外凸的拱形遮罩 (洞口往外延伸 3.5 m)、上方弧形鐵欄杆、兩側白底彩色波浪擋土牆 */
function portalMesh(w, i) {
  const { pts, a, H } = tunnelProfile(w.hw);
  const LH = 3.5, T0 = 0.7;                        // 遮罩長度、厚度
  const kx = (a + T0) / a, ky = (H + T0) / H;
  const outer = pts.map(([l, u]) => [l * (Math.abs(l) > w.hw + 0.5 ? kx : 1), u * ky]);
  // 區域座標: GB.v(橫向, -外推距離, 高度) -> three (橫向, 高度, 外推)
  const g = new GB(), M = pts.length;
  const ring = (P, zl) => { const b = g.n; for (const [l, u] of P) g.v(l, -zl, u); return b; };
  const i0 = ring(pts, 0), i1 = ring(pts, LH), o0 = ring(outer, -0.4), o1 = ring(outer, LH);
  for (let j = 0; j < M - 1; j++) {
    g.q(i0 + j, i1 + j, i1 + j + 1, i0 + j + 1);   // 內面
    g.q(o0 + j, o0 + j + 1, o1 + j + 1, o1 + j);   // 外面
    g.q(i1 + j, o1 + j, o1 + j + 1, i1 + j + 1);   // 前端環
  }
  const grp = new T.Group();
  const hood = g.mesh(matConcrete, { cast: true }); grp.add(hood);
  // 擋土牆 (梯形，中間挖遮罩的外形)
  const W = a + 10;
  const sh = new T.Shape();
  sh.moveTo(-W, -1.5); sh.lineTo(W, -1.5); sh.lineTo(W, 4.4); sh.lineTo(a + 1.5, H + 2.4); sh.lineTo(-(a + 1.5), H + 2.4); sh.lineTo(-W, 4.4); sh.lineTo(-W, -1.5);
  const hole = new T.Path();
  hole.moveTo(outer[0][0], -0.2);
  for (const [l, u] of outer) hole.lineTo(l, Math.max(u, -0.2));
  hole.lineTo(outer[0][0], -0.2);
  sh.holes.push(hole);
  const fg = new T.ExtrudeGeometry(sh, { depth: 1.0, bevelEnabled: false, curveSegments: 4 });
  fg.translate(0, 0, -1.0);
  const face = new T.Mesh(fg, matConcrete); face.castShadow = face.receiveShadow = true; face.matrixAutoUpdate = false; grp.add(face);
  // 兩側翼牆: 沿道路往外 28 m，洞口處 5 m 高、往外降到 1 m；內面 (面向道路) 畫彩色波浪
  const ww = new GB('uv'), WL = 28, steps = 14;
  const hAt = (zl) => Math.max(1.0, 5.0 - 4.0 * zl / WL);
  // 牆底往下接到地面 (洞口外常直接接高架橋，牆不能懸空)
  const px0 = w.P[i * 3], py0 = w.P[i * 3 + 1], pz0 = w.P[i * 3 + 2], sg = i === 0 ? -1 : 1;
  const Xd = [w.nx[i] * sg, w.ny[i] * sg], Zd = [w.ny[i] * sg, -w.nx[i] * sg];
  const baseAt = (lat, zl) => Math.min(-0.3, terrainAt(px0 + Xd[0] * lat + Zd[0] * zl, py0 + Xd[1] * lat + Zd[1] * zl) - pz0 - 0.5);
  for (const sd of [-1, 1]) {
    const xi = sd * (a + 0.15), xo = sd * (a + 0.7);
    const strip = (x, face, z0) => {
      const b = ww.n;
      for (let k = 0; k <= steps; k++) {
        const zl = WL * k / steps, h = hAt(zl);
        ww.v(x, -zl, Math.max(z0, baseAt(x, zl))); ww.uv.push(face, h);
        ww.v(x, -zl, h); ww.uv.push(face, h);
      }
      return b;
    };
    const fi = strip(xi, 1, -60), fo = strip(xo, 0, -60);
    for (let k = 0; k < steps; k++) {
      ww.q(fi + k * 2, fi + k * 2 + 2, fi + k * 2 + 3, fi + k * 2 + 1);   // 內面
      ww.q(fo + k * 2, fo + k * 2 + 1, fo + k * 2 + 3, fo + k * 2 + 2);   // 外面
      ww.q(fi + k * 2 + 1, fi + k * 2 + 3, fo + k * 2 + 3, fo + k * 2 + 1); // 頂面
    }
    const e = steps * 2;   // 末端封口
    ww.q(fi + e, fo + e, fo + e + 1, fi + e + 1);
  }
  const wing = ww.mesh(matPortal, { cast: true }); if (wing) grp.add(wing);
  // 弧形欄杆: 沿遮罩前端頂部，立柱每 1.1 m、上下兩根橫桿
  const r = new GB();
  const arch = outer.filter(([l, u]) => u > H * 0.55);
  const post = (l, u, zl) => box(r, l, -zl, 1, 0, 0.025, 0.025, u, u + 1.05);
  const beam = (p, q, zl, dz) => {   // p, q: [橫向, 高度] 兩點之間的細桿
    const dl = q[0] - p[0], du = q[1] - p[1], L = Math.hypot(dl, du) || 1;
    const nl = -du / L * 0.022, nu = dl / L * 0.022, b = r.n;
    for (const [aa, bb] of [[p, 0], [q, 0]]) for (const [sl, su, sz] of [[1, 1, 1], [-1, -1, 1], [-1, -1, -1], [1, 1, -1]]) r.v(aa[0] + nl * sl, -(zl + 0.022 * sz), aa[1] + dz + nu * su);
    for (let f = 0; f < 4; f++) { const f2 = (f + 1) % 4; r.q(b + f, b + f2, b + 4 + f2, b + 4 + f); }
  };
  const zl = LH - 0.3;
  let acc = 1e9;
  for (let j = 0; j < arch.length; j++) {
    if (j > 0) { acc += Math.hypot(arch[j][0] - arch[j - 1][0], arch[j][1] - arch[j - 1][1]); beam(arch[j - 1], arch[j], zl, 1.0); beam(arch[j - 1], arch[j], zl, 0.5); }
    if (acc > 1.1) { post(arch[j][0], arch[j][1], zl); acc = 0; }
  }
  const rail = r.mesh(matRail, { cast: true }); if (rail) grp.add(rail);
  // 擺到洞口: 外推方向 = 離開隧道的方向
  const x = w.P[i * 3], y = w.P[i * 3 + 1], z = w.P[i * 3 + 2];
  const sgn = i === 0 ? -1 : 1;
  const Z = new T.Vector3(w.ny[i] * sgn, 0, w.nx[i] * sgn);          // 外推 (three)
  const Y = new T.Vector3(0, 1, 0), X = new T.Vector3().crossVectors(Y, Z);
  const mtx = new T.Matrix4().makeBasis(X, Y, Z); mtx.setPosition(x, z, -y);
  grp.matrixAutoUpdate = false; grp.matrix.copy(mtx);
  return grp;
}

const newChunk = () => ({ road: new GB('road'), city: new GB('road'), skirt: new GB(), barrier: new GB('uv'), glare: new GB(), lampPole: new GB(), lampHead: new GB(), glows: [], reflBlack: new GB(), reflFace: new GB('uv'), rglow: [], rnorm: [], reflR: new GB(), reflY: new GB(),
  gore: new GB('road'), gpost: new GB(), gband: new GB(), drum: new GB(), drumb: new GB(),
  pier: new GB(), tunnel: new GB('uv'), tlight: new GB(), tcab: new GB(), portals: [],
  swall: new GB(), sglass: new GB(), spost: new GB(), bboard: new GB('uv'), bback: new GB(), bpole: new GB() });

/** 一般道路: 鋪在地形上的路面 (市區標線由材質依 aLs=路寬、aLanes=車道代碼 算出)；橋梁加梁身與橋墩 */
function addCityRoad(c, w) {
  const { P, nx, ny, s, n, hw } = w;
  const code = w.cls === 5 ? 0 : (w.oneway ? w.lanes : -w.lanes);   // 0: 巷道無標線；負: 雙向 (中央雙黃線)
  const r = c.city, b0 = r.n;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    r.v(x + nx[i] * hw, y + ny[i] * hw, z); r.uv.push(0, s[i]); r.ls.push(w.width); r.ln.push(code);
    r.v(x - nx[i] * hw, y - ny[i] * hw, z); r.uv.push(w.width, s[i]); r.ls.push(w.width); r.ln.push(code);
  }
  for (let i = 0; i < n - 1; i++) { const a = b0 + i * 2; r.q(a, a + 1, a + 3, a + 2); }
  if (!w.bridge) return;
  const k = c.skirt, s0 = k.n, depth = 1.6;
  for (let i = 0; i < n; i++) {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    k.v(x + nx[i] * hw, y + ny[i] * hw, z); k.v(x - nx[i] * hw, y - ny[i] * hw, z);
    k.v(x + nx[i] * hw, y + ny[i] * hw, z - depth); k.v(x - nx[i] * hw, y - ny[i] * hw, z - depth);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = s0 + i * 4, bb = a + 4;
    k.q(a, bb, bb + 2, a + 2); k.q(a + 1, a + 3, bb + 3, bb + 1); k.q(a + 2, bb + 2, bb + 3, a + 3);
  }
  for (let d = 15; d < s[n - 1] - 5; d += 30) {
    let i = 0; while (i < n - 2 && s[i + 1] < d) i++;
    const x = P[i * 3], y = P[i * 3 + 1], top = P[i * 3 + 2] - depth, g = terrainAt(x, y);
    if (top - g > 3) box(c.pier, x, y, ny[i], -nx[i], 0.7, Math.min(hw * 0.6, 3), g - 1, top);
  }
}

// ======================================================================= 分區串流
// 車子附近: 先下載資料 (DATA_R)，鄰近 8 區的資料都到了才建模型 (MESH_R)，遠了丟掉模型 (資料留著，回來不用重下載)
const MESH_R = +(params.get('meshr') || (MOBILE ? 4200 : 7000));
const DATA_R = MESH_R + TS * 1.45;            // 模型區的鄰區一定已經有資料
const TERR_R = +(params.get('terrr') || (MOBILE ? 9000 : 18000));
const TILES = new Map();                       // 細節分區 key -> { key, tx, ty, state, ways, piers, bld, linked, joints, group, bldChunks }
const TERR_REC = new Map();                    // 地形分區 key -> { state, mesh }
let inflight = 0;
const worldGroup = new T.Group();
scene.add(worldGroup);
function tileDist(tx, ty, x, y) {
  const cx = Math.min(Math.max(x, tx * TS), (tx + 1) * TS), cy = Math.min(Math.max(y, ty * TS), (ty + 1) * TS);
  return Math.hypot(x - cx, y - cy);
}
/** 半徑 R 內的分區 [[key, tx, ty, 距離]]，由近到遠 */
function tilesNear(x, y, R) {
  const out = [];
  for (let tx = Math.floor((x - R) / TS); tx <= Math.floor((x + R) / TS); tx++)
    for (let ty = Math.floor((y - R) / TS); ty <= Math.floor((y + R) / TS); ty++) {
      const d = tileDist(tx, ty, x, y);
      if (d <= R) out.push([tkey(tx, ty), tx, ty, d]);
    }
  return out.sort((a, b) => a[3] - b[3]);
}
function whenBuf(kind, key, onOk, onErr) {
  let b;
  try { b = tileBuf(kind, key); } catch (e) { onErr(e); return null; }
  if (b instanceof ArrayBuffer) { onOk(b); return null; }
  inflight++;
  return b.then(onOk, onErr).finally(() => { inflight--; });
}
function requestDetail(key, tx, ty) {
  if (TILES.has(key) || !INDEX.detail[key]) return null;
  const rec = { key, tx, ty, state: 'loading', ways: [], piers: new Float32Array(0), bld: null, linked: false, joints: [], group: null, bldChunks: [] };
  TILES.set(key, rec);
  return whenBuf('d', key, (buf) => {
    Object.assign(rec, ingestDetail(buf));
    rec.state = 'data';
    // 有隧道: 周圍已建好的地形網格重建 (挖掉穿進隧道的山坡，見 buildTerrainMesh)
    if (rec.ways.some((k) => WAYS[k].tunnel)) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const tr = TERR_REC.get(tkey(tx + dx, ty + dy));
      if (tr && tr.mesh) { if (tr.mesh !== 'none') disposeGroup(tr.mesh); tr.mesh = null; }
    }
    for (const f of HOOKS.tile) f(rec);
  }, (e) => { console.warn('分區載入失敗', key, e); setTimeout(() => TILES.delete(key), 3000); });
}
function requestTerrain(key) {
  if (TERR_REC.has(key) || !INDEX.tiles_t[key]) return null;
  const rec = { state: 'loading', mesh: null };
  TERR_REC.set(key, rec);
  return whenBuf('t', key, (buf) => {
    TERR.set(key, new Int16Array(buf, 0, TN * TN));
    if (buf.byteLength >= TN * TN * 3) LCLS.set(key, new Uint8Array(buf, TN * TN * 2, TN * TN));   // 地表分類 (scripts/landcover.py)
    rec.state = 'data';
  },
    (e) => { console.warn('地形載入失敗', key, e); setTimeout(() => TERR_REC.delete(key), 3000); });
}
function neighborsReady(rec) {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const k = tkey(rec.tx + dx, rec.ty + dy);
    if (!INDEX.detail[k]) continue;
    const r = TILES.get(k);
    if (!r || r.state !== 'data') return false;
  }
  return true;
}
function buildTile(rec) {
  const c = newChunk(), g = new T.Group();
  for (const k of rec.ways) { const w = WAYS[k]; if (w.city) addCityRoad(c, w); else { addRoad(c, w); if (w.ramps && !params.has('nogore')) for (const r of w.ramps) addGore(c, w, r); } }
  for (let k = 0; k < rec.piers.length / 9; k++) addPier(c.pier, rec.piers, k);
  for (const m of [c.road.mesh(matAsphalt, { cast: true }), (params.has('nocr') ? null : c.city.mesh(matCityRoad)), c.skirt.mesh(matConcrete, { cast: true }),
                   c.barrier.mesh(matBarrier, { cast: true }), c.glare.mesh(matGlare, { cast: true }), c.lampPole.mesh(matLampPole, { cast: true }), c.lampHead.mesh(matLampHead), c.pier.mesh(matConcrete, { cast: true }),
                   c.gore.mesh(matGore), c.gpost.mesh(matPost, { cast: true }), c.gband.mesh(matPostBand), c.drum.mesh(matDrum, { cast: true }), c.drumb.mesh(matDrumBand),
                   c.tunnel.mesh(matTunnelWall, { cast: true }), c.tlight.mesh(matTunnelLight, { receive: false }), c.tcab.mesh(matCabinet),
                   c.reflR.mesh(matReflR, { receive: false }), c.reflY.mesh(matReflY, { receive: false }), c.reflBlack.mesh(matReflBlack), c.reflFace.mesh(matRetro, { receive: false }),
                   c.swall.mesh(matSoundWall, { cast: true }), c.sglass.mesh(matSoundGlass, { receive: false }), c.spost.mesh(matLampPole, { cast: true }),
                   withUv(c.bboard.mesh(matBillboard)), c.bback.mesh(matBillboardBack, { cast: true }), c.bpole.mesh(matLampPole, { cast: true })]) if (m) g.add(m);
  for (const [w, i] of c.portals) g.add(portalMesh(w, i));
  if (c.rglow.length && params.has('rglow')) {   // 遠方反光點: 預設關閉 (晚上遠處高架橋看不見時，光點像飄在空中)
    const rg = new T.BufferGeometry();
    rg.setAttribute('position', new T.Float32BufferAttribute(c.rglow, 3)); rg.setAttribute('aN', new T.Float32BufferAttribute(c.rnorm, 3)); rg.computeBoundingSphere();
    const rp = new T.Points(rg, matRetroGlow); rp.matrixAutoUpdate = false; g.add(rp);
  }
  if (c.glows.length) {
    const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.Float32BufferAttribute(c.glows, 3)); pg.computeBoundingSphere();
    const pts = new T.Points(pg, GLOW_LAMP); pts.matrixAutoUpdate = false; g.add(pts);
  }
  jointMeshes(rec.joints, g);
  rec.bldChunks = (rec.bld && !params.has('nobld')) ? buildBuildings(rec.bld, g) : [];   // nobld: 測試用，不建建築
  worldGroup.add(g);
  rec.group = g;
}
function disposeGroup(g) {
  if (g.parent) g.parent.remove(g);
  g.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
}
// ---- 地面正射影像 (國土測繪中心 WMTS，政府資料開放授權，畫面下方標示來源)
// 玩家附近 (電腦 8 km、手機 5 km) 的地形分區各拼一張貼圖；全部圖磚都抓到才換上 (離線、抓不到就維持原本的地表上色)
// 解析度分兩級: 玩家所在 / 相鄰分區 (1.5 km 內) 用高一級 (電腦 z15 ≈ 4.3 m/像素)，再遠用 z14；手機各低一級
const ORTHO = { on: !params.has('noortho'), zNear: MOBILE ? 14 : 15, zFar: MOBILE ? 13 : 14, nearR: 1500, R: MOBILE ? 5000 : 8000, busy: 0, clock: 0 };
const orthoUrl = (z, x, y) => `https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/${z}/${y}/${x}`;
// 地形分區有水面時是「地形 + 水面」的群組: 取出地形那塊網格
const terrPart = (m) => (m && m !== 'none') ? (m.isMesh ? m : m.children.find((o) => o.geometry && o.geometry.attributes.aLc0)) : null;
const merc = (lat, lon, z) => { const n = 2 ** z; return [(lon + 180) / 360 * n, (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n]; };
function orthoApply(r, tx, ty, z) {
  const toLL = window.TWX && TWX.gpsSync && TWX.gpsSync.toLatLon;
  const m = r.mesh;
  if (!toLL || !m || m === 'none') return;
  r.ortho = 'loading'; ORTHO.busy++;
  const x0 = tx * TC * TSTEP, y0 = ty * TC * TSTEP, x1 = x0 + TC * TSTEP, y1 = y0 + TC * TSTEP;
  const c = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => merc(...toLL(x, y), z));
  const mx0 = Math.floor(Math.min(...c.map((p) => p[0]))), mx1 = Math.floor(Math.max(...c.map((p) => p[0])));
  const my0 = Math.floor(Math.min(...c.map((p) => p[1]))), my1 = Math.floor(Math.max(...c.map((p) => p[1])));
  const cols = mx1 - mx0 + 1, rows = my1 - my0 + 1;
  const jobs = [];
  for (let yy = my0; yy <= my1; yy++) for (let xx = mx0; xx <= mx1; xx++) jobs.push(new Promise((ok, no) => {
    const im = new Image(); im.crossOrigin = 'anonymous';
    im.onload = () => ok([im, xx - mx0, yy - my0]); im.onerror = no; im.src = orthoUrl(z, xx, yy);
  }));
  Promise.all(jobs).then((imgs) => {
    ORTHO.busy--;
    if (r.mesh !== m) { r.ortho = null; return; }   // 抓圖途中地形已經丟掉
    const cv = document.createElement('canvas'); cv.width = cols * 256; cv.height = rows * 256;
    const g2 = cv.getContext('2d');
    for (const [im, i, j] of imgs) g2.drawImage(im, i * 256, j * 256);
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace; tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    // 每個頂點的貼圖座標: 分區四角的 Web Mercator 座標雙線性內插 (3.84 km 內誤差 < 1 m)
    const tm = terrPart(m); if (!tm) { r.ortho = 'fail'; return; }
    const p = tm.geometry.attributes.position.array, uv = new Float32Array(p.length / 3 * 2);
    for (let k = 0, q = 0; k < p.length; k += 3, q += 2) {
      const fu = (p[k] - x0) / (x1 - x0), fv = (-p[k + 2] - y0) / (y1 - y0);
      const mx = (c[0][0] * (1 - fu) + c[1][0] * fu) * (1 - fv) + (c[2][0] * (1 - fu) + c[3][0] * fu) * fv;
      const my = (c[0][1] * (1 - fu) + c[1][1] * fu) * (1 - fv) + (c[2][1] * (1 - fu) + c[3][1] * fu) * fv;
      uv[q] = (mx - mx0) / cols; uv[q + 1] = 1 - (my - my0) / rows;
    }
    tm.geometry.setAttribute('uv', new T.BufferAttribute(uv, 2));
    const mat = patch(new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0, map: tex }), TERRAIN_SPEC);
    if (r.prevOrtho) { r.prevOrtho.tex.dispose(); r.prevOrtho.mat.dispose(); r.prevOrtho = null; }   // 換解析度: 新的換上後才丟舊的 (不會閃回原本地表)
    tm.material = mat; r.ortho = { tex, mat, z };
  }).catch((e) => { ORTHO.busy--; r.ortho = r.prevOrtho || 'fail'; r.prevOrtho = null; if ((ORTHO.warned = (ORTHO.warned || 0) + 1) <= 3) console.warn('[ortho] 抓不到正射影像，維持原本地表', e && (e.message || e.type || e)); });   // 抓不到 (離線): 維持原本的地表上色
}
function orthoDrop(r) {
  if (r.prevOrtho) { r.prevOrtho.tex.dispose(); r.prevOrtho.mat.dispose(); r.prevOrtho = null; }
  if (r.ortho && r.ortho.tex) { const tm = terrPart(r.mesh); if (tm) tm.material = matTerrain; r.ortho.tex.dispose(); r.ortho.mat.dispose(); }
  r.ortho = null;
}
function orthoFrame(dt) {
  if (!ORTHO.on || (ORTHO.clock -= dt) > 0) return;
  ORTHO.clock = 0.4;
  let pick = null, pd = 1e9;   // 一次處理一塊: 挑最近、需要換的
  for (const [key, r] of TERR_REC) {
    if (!r.mesh || r.mesh === 'none') continue;
    const [tx, ty] = key.split('_').map(Number);
    const d = tileDist(tx, ty, S.x, S.y);
    if (d > ORTHO.R + 3000) { if (r.ortho && r.ortho !== 'loading') orthoDrop(r); continue; }
    if (d >= ORTHO.R || r.ortho === 'loading' || r.ortho === 'fail') continue;
    const want = d < ORTHO.nearR ? ORTHO.zNear : (r.ortho && r.ortho.z === ORTHO.zNear && d < ORTHO.nearR + 1500) ? ORTHO.zNear : ORTHO.zFar;   // 遲滯: 離開 3 km 才降級
    if ((!r.ortho || r.ortho.z !== want) && d < pd) { pd = d; pick = [r, tx, ty, want]; }
  }
  if (!pick || ORTHO.busy >= 2) return;
  const [r, tx, ty, want] = pick;
  if (r.ortho) r.prevOrtho = r.ortho;   // 換解析度: 新的換上前先用舊的
  orthoApply(r, tx, ty, want);
}

/** 地形分區 (法向由含外框的高度場計算，分區之間沒有接縫) */
function buildTerrainMesh(key, tx, ty) {
  const a = TERR.get(key);
  const ja = Math.max(tx * TC, TGI.J0), jb = Math.min(tx * TC + TC, TGI.J0 + TGI.w - 1);
  const ia = Math.max(ty * TC, TGI.I0), ib = Math.min(ty * TC + TC, TGI.I0 + TGI.h - 1);
  if (!a || jb <= ja || ib <= ia) return null;
  const hh = (I, J) => Z16(a[(I - ty * TC + 1) * TN + (J - tx * TC + 1)]);
  const lc = LCLS.get(key), lcAt = (I, J) => lc ? lc[(I - ty * TC + 1) * TN + (J - tx * TC + 1)] : 0;
  const g = new GB(); g.nrm = [];
  const cols = jb - ja + 1;
  const W0 = [], W1 = [];   // 地表分類 one-hot (內插後邊界自然漸變)
  for (let I = ia; I <= ib; I++) for (let J = ja; J <= jb; J++) {
    const k = lcAt(I, J), z = hh(I, J);
    W0.push(k === 1 ? 1 : 0, k === 2 ? 1 : 0, k === 3 ? 1 : 0, k === 4 ? 1 : 0);
    W1.push(k === 5 ? 1 : 0, k === 6 ? 1 : 0, k === 7 ? 1 : 0, k === 8 ? 1 : 0);
    g.v(J * TSTEP, I * TSTEP, k === 1 ? Math.min(z, 0.4) - (z < 0.6 ? 3 : 1.8) : z);   // 水底壓低，水面才看得到
    const hx = (hh(I, J + 1) - hh(I, J - 1)) / (2 * TSTEP), hy = (hh(I + 1, J) - hh(I - 1, J)) / (2 * TSTEP);
    const L = Math.hypot(hx, hy, 1);
    g.nrm.push(-hx / L, 1 / L, hy / L);
  }
  // 隧道口附近山坡比隧道頂還低的地形方格挖掉 (不然會穿進隧道裡；洞口擋土牆會擋住這個缺口)
  const inTunnel = (x, y, zt) => { const r = roadAt(x, y, zt + 12, -1.5, 0); return r && r.w.tunnel && zt < r.z + 8.6; };
  for (let i = 0; i < ib - ia; i++) for (let j = 0; j < jb - ja; j++) {
    const q = i * cols + j;
    const I = ia + i, J = ja + j, xc = (J + 0.5) * TSTEP, yc = (I + 0.5) * TSTEP;
    let near = false;   // 粗判: 方格中心與四角附近有沒有隧道 (空間索引以 40 m 格存，四角都查才不會漏)
    for (const [px, py] of [[xc, yc], [J * TSTEP, I * TSTEP], [(J + 1) * TSTEP, I * TSTEP], [J * TSTEP, (I + 1) * TSTEP], [(J + 1) * TSTEP, (I + 1) * TSTEP]]) {
      const r = roadAt(px, py, hh(I, J) + 40, -24, 0); if (r && r.w.tunnel) { near = true; break; }
    }
    if (near) {
      let cut = false;   // 細判: 方格內 5x5 點 (7.5 m 間隔)，用雙線性內插的地形高度
      for (let u = 0; u <= 4 && !cut; u++) for (let v = 0; v <= 4 && !cut; v++) {
        const fu = u / 4, fv = v / 4;
        const zt = (hh(I, J) * (1 - fu) + hh(I, J + 1) * fu) * (1 - fv) + (hh(I + 1, J) * (1 - fu) + hh(I + 1, J + 1) * fu) * fv;
        cut = inTunnel((J + fu) * TSTEP, (I + fv) * TSTEP, zt);
      }
      if (cut) continue;
    }
    g.q(q, q + 1, q + cols + 1, q + cols);
  }
  const m = g.mesh(matTerrain);
  m.geometry.setAttribute('aLc0', new T.Float32BufferAttribute(W0, 4));
  m.geometry.setAttribute('aLc1', new T.Float32BufferAttribute(W1, 4));
  if (!lc) return m;
  // 水面: 碰到水格的方格都畫；水格在原地形高度 (海 = 海平面)，旁邊陸地格壓到地面下 → 岸邊自然切出水線
  const wg = new GB('uv'), idx = new Int32Array((ib - ia + 1) * cols).fill(-1);
  const vid = (i, j) => {
    const q = i * cols + j;
    if (idx[q] < 0) {
      const I = ia + i, J = ja + j, z = hh(I, J), water = lcAt(I, J) === 1, sea = z < 0.6;
      idx[q] = wg.v(J * TSTEP, I * TSTEP, water ? (sea ? 0.15 : z - 0.2) : z - 0.8);
      wg.uv.push(sea ? 1 : 0, 0);
    }
    return idx[q];
  };
  for (let i = 0; i < ib - ia; i++) for (let j = 0; j < jb - ja; j++) {
    const I = ia + i, J = ja + j;
    if (lcAt(I, J) !== 1 && lcAt(I, J + 1) !== 1 && lcAt(I + 1, J + 1) !== 1 && lcAt(I + 1, J) !== 1) continue;
    wg.q(vid(i, j), vid(i, j + 1), vid(i + 1, j + 1), vid(i + 1, j));
  }
  const grp = new T.Group(); grp.add(m);
  const wm = wg.mesh(matWater, { receive: true }); if (wm) grp.add(wm);
  grp.matrixAutoUpdate = false;
  return grp;
}
/** opts: x,y (預設車子位置)；all: 不限同時下載數；build: 'all' 全部建 / false 不建 / 預設每次 1 區 */
function streamTick(opts = {}) {
  const x = opts.x != null ? opts.x : S.x, y = opts.y != null ? opts.y : S.y;
  const proms = [];
  const near = tilesNear(x, y, DATA_R);
  for (const [key, tx, ty] of near) {
    if (inflight >= 6 && !opts.all) break;
    const pr = requestDetail(key, tx, ty); if (pr) proms.push(pr);
  }
  const nearT = tilesNear(x, y, TERR_R);
  for (const [key] of nearT) {
    if (inflight >= 8 && !opts.all) break;
    const pr = requestTerrain(key); if (pr) proms.push(pr);
  }
  let budget = opts.build === 'all' ? 1e9 : opts.build === false ? 0 : 1;
  for (const [key, , , d] of near) {
    const rec = TILES.get(key);
    if (!rec || rec.state !== 'data') continue;
    if (!rec.linked && neighborsReady(rec)) { for (const k of rec.ways) setupShoulders(WAYS[k]); rec.joints = computeJoints(rec); rec.linked = true; }   // 路肩先設定，伸縮縫才量得到加寬後的路緣
    if (budget > 0 && rec.linked && !rec.group && d <= MESH_R) { buildTile(rec); budget--; }
  }
  let tb = opts.build === 'all' ? 1e9 : opts.build === false ? 0 : 3;
  for (const [key, tx, ty] of nearT) {
    const r = TERR_REC.get(key);
    if (tb > 0 && r && r.state === 'data' && !r.mesh) {
      const m = buildTerrainMesh(key, tx, ty);
      r.mesh = m || 'none'; if (m) worldGroup.add(m);
      tb--;
    }
  }
  // 丟掉遠處的模型
  for (const rec of TILES.values()) if (rec.group && tileDist(rec.tx, rec.ty, x, y) > MESH_R + 1500) { disposeGroup(rec.group); rec.group = null; rec.bldChunks = []; }
  for (const [key, r] of TERR_REC) if (r.mesh && r.mesh !== 'none') {
    const [tx, ty] = key.split('_').map(Number);
    if (tileDist(tx, ty, x, y) > TERR_R + 2500) { orthoDrop(r); disposeGroup(r.mesh); r.mesh = null; }
  }
  return proms;
}
/** 等 (x,y) 附近的資料到齊、模型建好 (起點與傳送用) */
/** 穿模掃描 (?clipscan): 載入全部分區後檢查路口高低差、地形冒出路面、建築壓路、橋墩插路、立體交叉淨空 */
async function clipScan() {
  const proms = [];
  for (const key of Object.keys(INDEX.detail)) { const [tx, ty] = key.split('_').map(Number); const p = requestDetail(key, tx, ty); if (p) proms.push(p); }
  for (const key of Object.keys(INDEX.tiles_t)) { const p = requestTerrain(key); if (p) proms.push(p); }
  await Promise.all(proms);
  const t0 = performance.now();
  const meshZ = (x, y) => {   // 與 buildTerrainMesh 相同的三角形
    const J = x / TSTEP, I = y / TSTEP, j = Math.floor(J), i = Math.floor(I), u = J - j, v = I - i;
    if (j < TGI.J0 || j >= TGI.J0 + TGI.w - 1 || i < TGI.I0 || i >= TGI.I0 + TGI.h - 1) return -1e9;   // 地形網格外不畫地形
    const h = (ii, jj) => { const tx = Math.floor(jj / TC), ty = Math.floor(ii / TC), a = TERR.get(tkey(tx, ty)); return a ? Z16(a[(ii - ty * TC + 1) * TN + (jj - tx * TC + 1)]) : -1e9; };
    const h00 = h(i, j), h10 = h(i, j + 1), h11 = h(i + 1, j + 1), h01 = h(i + 1, j);
    return u >= v ? h00 + u * (h10 - h00) + v * (h11 - h10) : h00 + v * (h01 - h00) + u * (h11 - h01);
  };
  const nm = (w) => (w.city ? '' : '[' + (w.ref || 'fwy') + ']') + (w.name || '?') + '#' + w.gid;
  const spots = (list, cell = 60) => { const m = new Map(); for (const s of list) { const k = Math.floor(s.x / cell) + ',' + Math.floor(s.y / cell); const o = m.get(k); if (!o || s.d > o.d) m.set(k, s); } return [...m.values()].sort((a, b) => b.d - a.d); };
  const out = {};
  // A. 路口高低差
  const A = [];
  for (const arr of PT_INDEX.values()) {
    if (arr.length < 2) continue;
    let lo = 1e9, hi = -1e9, wl = null, wh = null;
    for (const [k, i] of arr) { const w = WAYS[k], z = w.P[i * 3 + 2]; if (z < lo) { lo = z; wl = w; } if (z > hi) { hi = z; wh = w; } }
    if (hi - lo > 0.4 && wl !== wh) { const [k, i] = arr[0]; A.push({ x: WAYS[k].P[i * 3], y: WAYS[k].P[i * 3 + 1], d: hi - lo, a: nm(wl), b: nm(wh) }); }
  }
  out.junctionStep = A;
  // B. 地形冒出路面 (隧道除外)
  const B = [];
  for (const w of WAYS) {
    if (w.tunnel) continue;
    const P = w.P, e = Math.max(0.3, w.hw - 0.3);
    for (let i = 0; i < w.n - 1; i++) {
      const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2], bx = P[i * 3 + 3], by = P[i * 3 + 4], bz = P[i * 3 + 5];
      const L = Math.hypot(bx - ax, by - ay); if (L < 0.01) continue;
      const nx = -(by - ay) / L, ny = (bx - ax) / L, steps = Math.max(1, Math.ceil(L / 5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t;
        for (const o of [-e, 0, e]) { const d = meshZ(x + nx * o, y + ny * o) - z; if (d > 0.1) B.push({ x: x + nx * o, y: y + ny * o, d, a: nm(w), br: w.bridge }); }
      }
    }
  }
  out.terrainOverRoad = B;
  const segNear = (x, y, fn) => { const a = GRID.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))); if (!a) return; for (let q = 0; q < a.length; q += 2) fn(WAYS[a[q]], a[q + 1]); };
  const onSeg = (w, i, x, y) => {
    const P = w.P, ax = P[i * 3], ay = P[i * 3 + 1], dx = P[i * 3 + 3] - ax, dy = P[i * 3 + 4] - ay, L2 = dx * dx + dy * dy; if (L2 < 1e-4) return null;
    const t = ((x - ax) * dx + (y - ay) * dy) / L2; if (t < 0 || t > 1) return null;
    const lat = ((x - ax) * -dy + (y - ay) * dx) / Math.sqrt(L2);
    return { z: P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t, lat };
  };
  // C. 建築壓在路上
  const BG = new Map(), C = [];
  for (const rec of TILES.values()) {
    const b = rec.bld; if (!b) continue;
    for (let k = 0, v = 0; k < b.nb; k++) {
      const n = b.bcnt[k]; let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let q = 0; q < n; q++) { const x = b.bxy[(v + q) * 2], y = b.bxy[(v + q) * 2 + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const ent = { b, v, n, base: b.bbase[k], h: b.bh[k] };
      for (let cx = Math.floor(x0 / 50); cx <= Math.floor(x1 / 50); cx++) for (let cy = Math.floor(y0 / 50); cy <= Math.floor(y1 / 50); cy++) { const kk = cx + ',' + cy; let a = BG.get(kk); if (!a) BG.set(kk, a = []); a.push(ent); }
      v += n;
    }
  }
  const inPoly = (e, x, y) => { let c = false; const A2 = e.b.bxy; for (let i = 0, j = e.n - 1; i < e.n; j = i++) { const xi = A2[(e.v + i) * 2], yi = A2[(e.v + i) * 2 + 1], xj = A2[(e.v + j) * 2], yj = A2[(e.v + j) * 2 + 1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  for (const w of WAYS) {
    if (w.tunnel) continue;
    const P = w.P, e = Math.max(0.3, w.hw - 0.5);
    for (let i = 0; i < w.n - 1; i++) {
      const ax = P[i * 3], ay = P[i * 3 + 1], az = P[i * 3 + 2], bx = P[i * 3 + 3], by = P[i * 3 + 4], bz = P[i * 3 + 5];
      const L = Math.hypot(bx - ax, by - ay); if (L < 0.01) continue;
      const nx = -(by - ay) / L, ny = (bx - ax) / L, steps = Math.max(1, Math.ceil(L / 4));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps, z = az + (bz - az) * t;
        for (const o of [-e, 0, e]) {
          const x = ax + (bx - ax) * t + nx * o, y = ay + (by - ay) * t + ny * o;
          for (const en of BG.get(Math.floor(x / 50) + ',' + Math.floor(y / 50)) || []) if (z > en.base - 1 && z < en.base + en.h - 0.5 && inPoly(en, x, y)) { C.push({ x, y, d: 1, a: nm(w), c: o === 0 }); break; }
        }
      }
    }
  }
  out.buildingOnRoad = C;
  // D. 橋墩插在路上
  const D = [];
  for (const rec of TILES.values()) {
    const A3 = rec.piers;
    for (let k = 0; k < A3.length / 9; k++) {
      const [x, y, tx, ty, offL, zg, top] = A3.subarray(k * 9, k * 9 + 7);
      const px = x - ty * offL, py = y + tx * offL;
      segNear(px, py, (w, i) => { const r = onSeg(w, i, px, py); if (r && Math.abs(r.lat) < w.hw + 0.6 && r.z > zg + 0.3 && r.z < top - 1.6) D.push({ x: px, y: py, d: w.hw + 0.6 - Math.abs(r.lat), a: nm(w) }); });
    }
  }
  out.pierOnRoad = D;
  // E. 立體交叉淨空 (下層路面到上層路面 0.6 ~ 4.6 m)
  const E = [];
  for (const w of WAYS) {
    const P = w.P;
    for (let i = 0; i < w.n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      segNear(x, y, (o, j) => { if (o === w) return; const r = onSeg(o, j, x, y); if (!r || Math.abs(r.lat) > o.hw) return; const dz = r.z - z; if (dz > 0.6 && dz < 4.6 && !(o.city && w.city && dz < 1.2)) E.push({ x, y, d: 4.6 - dz, a: nm(w), b: nm(o) }); });
    }
  }
  out.clearance = E;
  const ms = performance.now() - t0;
  console.log('[clipscan] ways', WAYS.length, 'tiles', TILES.size, 'ms', ms.toFixed(0));
  for (const [k, list] of Object.entries(out)) {
    const sp = spots(list);
    console.log('[clipscan] ' + k + ' ' + JSON.stringify({ samples: list.length, spots: sp.length, top: sp.slice(0, 12).map((s) => [Math.round(s.x), Math.round(s.y), +s.d.toFixed(2), s.a, s.b || (s.br ? 'bridge' : '')]) }));
  }
  const hist = (list, edges, f = (q) => q.d) => edges.map((e, k) => list.filter((q) => f(q) >= e && (k === edges.length - 1 || f(q) < edges[k + 1])).length);
  console.log('[clipscan] hist junction 0.4/1/3/6/20', JSON.stringify(hist(A, [0.4, 1, 3, 6])));
  const Bf = B.filter((q) => !q.a.startsWith('[')), Bw = B.filter((q) => q.a.startsWith('['));
  console.log('[clipscan] hist terrain city 0.1/0.3/1/3', JSON.stringify(hist(Bf, [0.1, 0.3, 1, 3])), 'spots', spots(Bf.filter((q) => q.d > 0.3)).length, 'fwy', JSON.stringify(hist(Bw, [0.1, 0.3, 1, 3])), 'spots', spots(Bw.filter((q) => q.d > 0.3)).length, 'bridge', B.filter((q) => q.br).length);
  console.log('[clipscan] terrain fwy top ' + JSON.stringify(spots(Bw.filter((q) => q.d > 0.3)).slice(0, 10).map((s) => [Math.round(s.x), Math.round(s.y), +s.d.toFixed(2), s.a, s.br ? 'br' : ''])));
  console.log('[clipscan] terrain city top ' + JSON.stringify(spots(Bf.filter((q) => q.d > 0.3)).slice(0, 10).map((s) => [Math.round(s.x), Math.round(s.y), +s.d.toFixed(2), s.a, s.br ? 'br' : ''])));
  console.log('[clipscan] building center hits', C.filter((q) => q.c).length, 'spots', spots(C.filter((q) => q.c)).length);
  window.CLIP = out;
}
async function ensureArea(x, y, msg) {
  for (let guard = 0; guard < 10; guard++) {
    const proms = streamTick({ x, y, all: true, build: false });
    if (!proms.length) break;
    if (msg) setStatus(msg);
    await Promise.all(proms);
  }
  streamTick({ x, y, build: 'all' });
}
let streamClock = 0;
function streamFrame(dt) { streamClock -= dt; if (streamClock > 0) return; streamClock = 0.25; streamTick(); }

// ---- 3D 建築: 依 OSM 高度 / 樓層擠出；牆面 UV (沿周長 m, 高度 m, 總高) 給窗戶材質用
const FACADE = [[0.45, 0.40, 0.32], [0.42, 0.42, 0.40], [0.55, 0.54, 0.50], [0.28, 0.19, 0.13], [0.30, 0.30, 0.29], [0.48, 0.37, 0.33], [0.25, 0.29, 0.33]];
// 建築依距離顯示 (手機 1.6 km、電腦 4.5 km)；遠處被霧氣蓋住，不畫可以省很多效能
let bldClock = 0;
function cullBuildings(dt) {
  bldClock -= dt;
  if (bldClock > 0) return;
  bldClock = 0.5;
  const R = (MOBILE ? 1600 : 4500) + 700;
  for (const rec of TILES.values()) for (const ch of rec.bldChunks) { const vis = Math.hypot(ch.x - S.x, ch.y - S.y) < R; for (const m of ch.meshes) m.visible = vis; }
}
function buildBuildings(bld, world) {
  const { bxy, bbase, bh, bcnt, bcol, nb } = bld;
  const out = [];
  const chunks = new Map(), CHB = 1000;
  let o = 0;
  for (let b = 0; b < nb; b++) {
    const n = bcnt[b], base = bbase[b], top = base + bh[b], col = FACADE[bcol[b]];
    let cx = 0, cy = 0;
    for (let i = 0; i < n; i++) { cx += bxy[(o + i) * 2]; cy += bxy[(o + i) * 2 + 1]; }
    cx /= n; cy /= n;
    const key = Math.floor(cx / CHB) + ',' + Math.floor(cy / CHB);
    let c = chunks.get(key);
    if (!c) chunks.set(key, c = { wp: [], wuv: [], wcol: [], wi: [], rp: [], rcol: [], ri: [] });
    let per = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = bxy[(o + i) * 2], ay = bxy[(o + i) * 2 + 1], bx = bxy[(o + j) * 2], by = bxy[(o + j) * 2 + 1];
      const L = Math.hypot(bx - ax, by - ay);
      const v0 = c.wp.length / 3;
      c.wp.push(ax, base, -ay, bx, base, -by, bx, top, -by, ax, top, -ay);
      c.wuv.push(per, 0, bh[b], per + L, 0, bh[b], per + L, bh[b], bh[b], per, bh[b], bh[b]);
      for (let q = 0; q < 4; q++) c.wcol.push(col[0], col[1], col[2]);
      c.wi.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
      per += L;
    }
    const contour = [];
    for (let i = 0; i < n; i++) contour.push(new T.Vector2(bxy[(o + i) * 2], bxy[(o + i) * 2 + 1]));
    const tris = T.ShapeUtils.triangulateShape(contour.slice(), []);   // 會就地刪除重複端點，傳複本
    const r0 = c.rp.length / 3;
    for (let i = 0; i < n; i++) { c.rp.push(contour[i].x, top, -contour[i].y); c.rcol.push(col[0] * 0.6, col[1] * 0.6, col[2] * 0.6); }
    for (const t of tris) c.ri.push(r0 + t[0], r0 + t[2], r0 + t[1]);
    o += n;
  }
  for (const c of chunks.values()) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(c.wp, 3));
    g.setAttribute('aUv3', new T.Float32BufferAttribute(c.wuv, 3));
    g.setAttribute('aCol', new T.Float32BufferAttribute(c.wcol, 3));
    g.setIndex(c.wp.length / 3 > 65535 ? new T.Uint32BufferAttribute(c.wi, 1) : new T.Uint16BufferAttribute(c.wi, 1));
    g.computeVertexNormals(); g.computeBoundingSphere();
    const m = new T.Mesh(g, matWall); m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false; world.add(m);
    const r = new T.BufferGeometry();
    r.setAttribute('position', new T.Float32BufferAttribute(c.rp, 3));
    r.setAttribute('aCol', new T.Float32BufferAttribute(c.rcol, 3));
    r.setIndex(c.rp.length / 3 > 65535 ? new T.Uint32BufferAttribute(c.ri, 1) : new T.Uint16BufferAttribute(c.ri, 1));
    r.computeVertexNormals(); r.computeBoundingSphere();
    const rm = new T.Mesh(r, matRoof); rm.castShadow = true; rm.receiveShadow = true; rm.matrixAutoUpdate = false; world.add(rm);
    out.push({ x: c.wp[0], y: -c.wp[2], meshes: [m, rm] });
  }
  return out;
}

// ======================================================================= 精細車輛
function plateTexture(text) {
  const cv = document.createElement('canvas'); cv.width = 380; cv.height = 160;
  const x = cv.getContext('2d');
  x.fillStyle = '#f4f4f0'; x.fillRect(0, 0, 380, 160);
  x.strokeStyle = '#111'; x.lineWidth = 8; x.strokeRect(6, 6, 368, 148);
  x.fillStyle = '#111'; x.font = 'bold 104px "Arial Narrow", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 190, 88);
  x.font = 'bold 20px sans-serif'; x.fillText('臺灣省', 190, 24);
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

// 方向燈: 琥珀色，每秒閃 1.5 次
const SIG_ON = new T.Color(1.0, 0.42, 0.0), SIG_OFF = new T.Color(0.18, 0.07, 0.0);
const blinkPhase = () => (performance.now() % 666) < 333;

function cosInterp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i], [x1, y1] = table[i + 1];
    if (x <= x1) { const t = (x - x0) / (x1 - x0), u = (1 - Math.cos(Math.PI * t)) / 2; return y0 + (y1 - y0) * u; }
  }
  return table[table.length - 1][1];
}

/** 沿 x 放樣：ring(x) 回傳 [[z(側), y(上)], ...] (閉合)；faceGroup(i,j) 回傳材質群組 */
function loft(xs, ring, faceGroup, caps = true) {
  const pos = [], groups = {};
  const N = ring(xs[0]).length;
  for (const x of xs) for (const [z, y] of ring(x)) pos.push(x, y, z);
  const add = (gid, a, b, c) => (groups[gid] = groups[gid] || []).push(a, b, c);
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < N; j++) {
    const a = i * N + j, b = i * N + (j + 1) % N, c = (i + 1) * N + (j + 1) % N, d = (i + 1) * N + j;
    const gid = faceGroup ? faceGroup(i, j) : 0;
    add(gid, a, d, c); add(gid, a, c, b);
  }
  if (caps) for (const [i, flip] of [[0, true], [xs.length - 1, false]]) {
    const ci = pos.length / 3; let cy = 0, cz = 0;
    for (let j = 0; j < N; j++) { cz += pos[(i * N + j) * 3 + 2]; cy += pos[(i * N + j) * 3 + 1]; }
    pos.push(xs[i], cy / N, cz / N);
    for (let j = 0; j < N; j++) { const a = i * N + j, b = i * N + (j + 1) % N; flip ? add(0, ci, b, a) : add(0, ci, a, b); }
  }
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  const idx = []; let start = 0;
  for (const gid of Object.keys(groups).sort()) { const arr = groups[gid]; idx.push(...arr); g.addGroup(start, arr.length, +gid); start += arr.length; }
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function superRing(hw, yb, yt, nexp, N, taperTop = 1) {
  const pts = [], yc = (yb + yt) / 2, hy = (yt - yb) / 2;
  for (let j = 0; j < N; j++) {
    const th = 2 * Math.PI * j / N, c = Math.cos(th), s = Math.sin(th);
    const zz = Math.sign(c) * Math.pow(Math.abs(c), 2 / nexp), yy = Math.sign(s) * Math.pow(Math.abs(s), 2 / nexp);
    const h = (yy + 1) / 2;
    pts.push([zz * hw * (1 + (taperTop - 1) * h), yc + yy * hy]);
  }
  return pts;
}

function buildCar() {
  const car = new T.Group();
  const paint = new T.MeshPhysicalMaterial({ color: new T.Color(0.55, 0.012, 0.018), metalness: 0.55, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.04 });
  const glass = new T.MeshPhysicalMaterial({ color: new T.Color(0.01, 0.012, 0.015), metalness: 0.1, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.0, envMapIntensity: 1.6 });
  const black = new T.MeshStandardMaterial({ color: new T.Color(0.012, 0.012, 0.013), roughness: 0.55 });
  const gloss = new T.MeshPhysicalMaterial({ color: new T.Color(0.01, 0.01, 0.01), roughness: 0.15, clearcoat: 1 });
  const chrome = new T.MeshStandardMaterial({ color: new T.Color(0.9, 0.9, 0.92), metalness: 1, roughness: 0.12 });
  const rimMat = new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.56, 0.58), metalness: 1, roughness: 0.25 });
  const tireMat = new T.MeshStandardMaterial({ color: new T.Color(0.02, 0.02, 0.02), roughness: 0.92 });
  const discMat = new T.MeshStandardMaterial({ color: new T.Color(0.3, 0.3, 0.3), metalness: 0.9, roughness: 0.45 });
  const caliper = new T.MeshStandardMaterial({ color: new T.Color(0.7, 0.04, 0.02), roughness: 0.4 });
  const headMat = new T.MeshStandardMaterial({ color: 0xffffff, emissive: new T.Color(1, 0.97, 0.9), emissiveIntensity: 1.6, roughness: 0.1 });
  const tailMat = new T.MeshBasicMaterial({ color: new T.Color(0.5, 0.005, 0.005), toneMapped: false }); // 不經色調映射，保持純紅
  const sigLMat = new T.MeshBasicMaterial({ color: SIG_OFF.clone(), toneMapped: false });   // 左方向燈
  const sigRMat = new T.MeshBasicMaterial({ color: SIG_OFF.clone(), toneMapped: false });   // 右方向燈
  const add = (geo, mat, x = 0, y = 0, z = 0, cast = true) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true; car.add(m); return m; };

  const L2 = 2.35, AX = 1.4, WR = 0.33;
  // ---- 車身下半部 (含輪拱)
  const top = [[-L2, 0.60], [-2.30, 0.78], [-2.18, 0.93], [-1.9, 0.965], [-1.3, 0.975], [0.9, 0.955], [1.25, 0.93], [1.7, 0.86], [2.15, 0.76], [2.3, 0.66], [L2, 0.52]];
  const bot = [[-L2, 0.30], [-2.2, 0.22], [-1.9, 0.20], [1.9, 0.20], [2.25, 0.24], [L2, 0.30]];
  const half = [[-L2, 0.74], [-2.25, 0.86], [-2.0, 0.905], [-1.4, 0.915], [1.5, 0.915], [2.05, 0.885], [2.28, 0.80], [L2, 0.70]];
  const xs = []; for (let i = 0; i <= 90; i++) { const t = i / 90; xs.push(-L2 + 2 * L2 * (0.5 - 0.5 * Math.cos(Math.PI * t))); }
  const arch = (x) => { let yb = cosInterp(bot, x); for (const ax of [AX, -AX]) { const d = x - ax, r = 0.43; if (Math.abs(d) < r) yb = Math.max(yb, WR + Math.sqrt(r * r - d * d)); } return yb; };
  const bodyGeo = loft(xs, (x) => superRing(cosInterp(half, x), arch(x), cosInterp(top, x), 5.5, 40), null);
  add(bodyGeo, paint);
  // 輪拱內襯 (避免看穿車身)
  for (const ax of [AX, -AX]) add(new T.BoxGeometry(0.95, 0.62, 1.2), black, ax, 0.5, 0);
  // ---- 車艙 (玻璃 + 車頂)
  const roof = [[-1.36, 0.95], [-1.05, 1.27], [-0.65, 1.42], [0.15, 1.45], [0.55, 1.37], [1.06, 0.95]];
  const gHalf = [[-1.36, 0.70], [-1.0, 0.75], [0.6, 0.76], [1.06, 0.72]];
  const gx = []; for (let i = 0; i <= 50; i++) gx.push(-1.36 + 2.42 * i / 50);
  const NR = 32;
  const cabinGeo = loft(gx, (x) => superRing(cosInterp(gHalf, x), 0.9, cosInterp(roof, x), 4, NR, 0.8), (i, j) => {
    const x = gx[i], th = 2 * Math.PI * (j + 0.5) / NR;
    const roofF = x > -0.98 && x < 0.52 && Math.abs(th - Math.PI / 2) < 0.95;
    const side = Math.abs(Math.cos(th)) > 0.5;
    const pillar = side && (x < -0.98 || Math.abs(x + 0.18) < 0.06 || x > 0.66); // C / B / A 柱與車身同色
    return (roofF || pillar) ? 0 : 1;
  });
  const cabin = new T.Mesh(cabinGeo, [paint, glass]); cabin.castShadow = true; car.add(cabin);
  // 柱子
  const tube = (a, b, r, mat) => {
    const va = new T.Vector3(...a), vb = new T.Vector3(...b), len = va.distanceTo(vb);
    const m = add(new T.CylinderGeometry(r, r, len, 10), mat);
    m.position.copy(va).add(vb).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
    return m;
  };
  for (const s of [1, -1]) {
    tube([-1.3, 0.958, s * 0.735], [1.0, 0.958, s * 0.74], 0.012, chrome); // 窗框飾條
    for (const dx of [0.98, -0.18, -1.28]) tube([dx, 0.3, s * 0.912], [dx, 0.93, s * 0.905], 0.005, black); // 車門縫
    for (const dx of [0.2, -0.82]) add(new T.BoxGeometry(0.14, 0.025, 0.03), chrome, dx, 0.86, s * 0.925);  // 門把
    // 後照鏡
    const mir = add(new T.BoxGeometry(0.16, 0.11, 0.2), paint, 0.92, 1.0, s * 0.97);
    add(new T.BoxGeometry(0.01, 0.085, 0.16), chrome, 0.835, 1.0, s * 0.975);
    tube([0.96, 0.96, s * 0.80], [0.94, 0.98, s * 0.88], 0.02, black);
    // 側裙
    add(new T.BoxGeometry(2.0, 0.07, 0.05), black, 0, 0.25, s * 0.9);
  }
  // ---- 車頭
  for (const s of [1, -1]) {
    const hl = add(new T.BoxGeometry(0.34, 0.085, 0.3), headMat, 2.13, 0.775, s * 0.6, false);
    hl.rotation.y = s * 0.28; hl.rotation.z = -0.25;
    add(new T.BoxGeometry(0.3, 0.02, 0.26), chrome, 2.12, 0.735, s * 0.6).rotation.set(0, s * 0.28, -0.25);
    add(new T.BoxGeometry(0.03, 0.03, 0.22), headMat, 2.31, 0.47, s * 0.55, false); // 日行燈
  }
  add(new T.BoxGeometry(0.06, 0.15, 0.78), gloss, 2.29, 0.6, 0);            // 水箱罩
  for (let k = 0; k < 4; k++) add(new T.BoxGeometry(0.065, 0.008, 0.76), chrome, 2.295, 0.54 + k * 0.04, 0);
  add(new T.BoxGeometry(0.08, 0.13, 1.15), black, 2.31, 0.33, 0);           // 下進氣口
  const pf = add(new T.PlaneGeometry(0.38, 0.16), new T.MeshStandardMaterial({ map: plateTexture('ABC-1234'), roughness: 0.4 }), 2.358, 0.44, 0);
  pf.rotation.y = Math.PI / 2;
  // ---- 車尾 (紅色尾燈組 + 白色倒車燈 + 後擋風玻璃上方第三煞車燈)
  add(new T.BoxGeometry(0.05, 0.06, 1.2), tailMat, -2.31, 0.86, 0, false);
  for (const s of [1, -1]) {
    add(new T.BoxGeometry(0.14, 0.17, 0.34), tailMat, -2.25, 0.84, s * 0.64, false).rotation.y = -s * 0.25;
    add(new T.BoxGeometry(0.03, 0.05, 0.12), headMat, -2.335, 0.74, s * 0.5, false);
  }
  add(new T.BoxGeometry(0.04, 0.03, 0.4), tailMat, -1.2, 1.25, 0, false);
  add(new T.BoxGeometry(0.12, 0.03, 1.3), paint, -2.2, 0.975, 0).rotation.z = 0.12;   // 尾翼唇
  add(new T.BoxGeometry(0.06, 0.12, 1.3), black, -2.32, 0.32, 0);           // 後下擾流
  const pr = add(new T.PlaneGeometry(0.38, 0.16), new T.MeshStandardMaterial({ map: plateTexture('ABC-1234'), roughness: 0.4 }), -2.335, 0.6, 0);
  pr.rotation.y = -Math.PI / 2;
  for (const s of [1, -1]) {
    const ex = add(new T.CylinderGeometry(0.045, 0.045, 0.16, 16), chrome, -2.3, 0.25, s * 0.45);
    ex.rotation.z = Math.PI / 2;
  }
  add(new T.BoxGeometry(0.22, 0.06, 0.07), paint, -0.85, 1.43, 0).rotation.z = 0.25; // 鯊魚鰭天線
  add(new T.BoxGeometry(4.0, 0.05, 1.5), black, 0, 0.2, 0, false);          // 底盤
  // ---- 方向燈 (+z 為右側): 前角、後角、後照鏡側燈
  for (const [s, mat] of [[-1, sigLMat], [1, sigRMat]]) {
    add(new T.BoxGeometry(0.1, 0.05, 0.16), mat, 2.2, 0.69, s * 0.74, false).rotation.y = -s * 0.5;
    add(new T.BoxGeometry(0.06, 0.07, 0.15), mat, -2.29, 0.7, s * 0.7, false);
    add(new T.BoxGeometry(0.1, 0.022, 0.05), mat, 0.9, 0.955, s * 1.07, false);
  }

  // ---- 輪胎 / 輪框 / 卡鉗
  const tireProfile = [[0.215, -0.112], [0.30, -0.112], [0.322, -0.098], [0.33, -0.065], [0.33, 0.065], [0.322, 0.098], [0.30, 0.112], [0.215, 0.112]]
    .map(([r, y]) => new T.Vector2(r, y));
  const tireGeo = new T.LatheGeometry(tireProfile, 56); tireGeo.rotateX(Math.PI / 2);
  const rimGeo = new T.CylinderGeometry(0.218, 0.218, 0.19, 48); rimGeo.rotateX(Math.PI / 2);
  const barrelGeo = new T.CylinderGeometry(0.2, 0.2, 0.2, 32, 1, true); barrelGeo.rotateX(Math.PI / 2);
  const discGeo = new T.CylinderGeometry(0.17, 0.17, 0.025, 40); discGeo.rotateX(Math.PI / 2);
  const hubGeo = new T.CylinderGeometry(0.045, 0.05, 0.04, 20); hubGeo.rotateX(Math.PI / 2);
  const wheels = [];
  for (const ax of [AX, -AX]) for (const s of [1, -1]) {
    const pivot = new T.Group(); pivot.position.set(ax, WR, s * 0.79); car.add(pivot);
    const spin = new T.Group(); pivot.add(spin);
    const out = s; // 外側方向 (+z 右側)
    const tire = new T.Mesh(tireGeo, tireMat); tire.castShadow = true; spin.add(tire);
    const barrel = new T.Mesh(barrelGeo, black); spin.add(barrel);
    const face = new T.Mesh(new T.CylinderGeometry(0.205, 0.205, 0.012, 48).rotateX(Math.PI / 2), rimMat);
    face.position.z = out * 0.075; spin.add(face);
    for (let k = 0; k < 5; k++) {
      const sp = new T.Mesh(new T.BoxGeometry(0.17, 0.045, 0.03), rimMat);
      const a = k * 2 * Math.PI / 5;
      sp.position.set(Math.cos(a) * 0.105, Math.sin(a) * 0.105, out * 0.09); sp.rotation.z = a; spin.add(sp);
      const hole = new T.Mesh(new T.BoxGeometry(0.06, 0.05, 0.02), black);
      hole.position.set(Math.cos(a + Math.PI / 5) * 0.15, Math.sin(a + Math.PI / 5) * 0.15, out * 0.083); hole.rotation.z = a + Math.PI / 5; spin.add(hole);
    }
    const hub = new T.Mesh(hubGeo, chrome); hub.position.z = out * 0.1; spin.add(hub);
    const disc = new T.Mesh(discGeo, discMat); disc.position.z = -out * 0.01; pivot.add(disc);
    const cal = new T.Mesh(new T.BoxGeometry(0.12, 0.08, 0.06), caliper); cal.position.set(-0.05, 0.13, out * 0.02); pivot.add(cal);
    wheels.push({ pivot, spin, front: ax > 0 });
  }
  car.userData = { wheels, tailMat, headMat, paint, sigLMat, sigRMat };
  return car;
}

// ======================================================================= 車輛狀態與物理
const PLAYER_TYPES = ['sedan', 'taxi', 'police', 'scooter', 'minibus', 'citybus', 'coach', 'boxtruck', 'bigtruck', 'semi'];
const PLAYER_PAINT = { taxi: [0.8, 0.52, 0.02], police: [0.85, 0.85, 0.83], citybus: [0.8, 0.8, 0.78], coach: [0.8, 0.8, 0.78], minibus: [0.8, 0.8, 0.78] };
let car = buildCar();
let trailer = null;
scene.add(car);
const S = { x: 0, y: 0, z: 0, vz: 0, h: 0, v: 0, steer: 0, road: null, pitch: 0, roll: 0, braking: false, vtype: 'sedan', vt: null };
let WB = 2.8, MARGIN = 1.25;

/** 換車: 依車種重建玩家車模型與物理參數 (聯結車另建拖車) */
function setVehicle(type) {
  const TV = window.TWV && window.TWV.TYPES;
  if (!TV || !TV[type]) return;
  // 舊車的幾何每次建車都是新的 (材質有些是共用的，不動)：移除時釋放，不然每換一次車就漏一份 GPU 記憶體
  const dropGeo = (g) => { scene.remove(g); g.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); };
  if (car) dropGeo(car);
  if (trailer) { dropGeo(trailer.group); trailer = null; }
  const r = window.TWV.build(type);
  car = r.group;
  car.userData = Object.assign({}, car.userData, r.ud);
  const ud = car.userData;
  ud.paint.color.setRGB(...(PLAYER_PAINT[type] || [0.55, 0.012, 0.018]));
  if (ud.accent) ud.accent.color.setRGB(...(type === 'scooter' ? [0.05, 0.06, 0.15] : [0.6, 0.02, 0.02]));
  scene.add(car);
  const t = TV[type];
  if (t.trailer) {
    const tr = window.TWV.build(t.trailer.type);
    tr.ud.accent.color.setRGB(0.05, 0.2, 0.45);
    trailer = { group: tr.group, ud: tr.ud, h: S.h, cfg: t.trailer };
    scene.add(tr.group);
  }
  S.vtype = type; S.vt = t; WB = t.wb; MARGIN = t.wid / 2 + 0.35;
  camInit = false;
}

// ---- 車道 / 路網 (國道、快速道路、一般道路共用)
/** 行進方向的車道數 (雙向一般道路只算一半) */
const laneCount = (w) => (w.city && !w.oneway) ? Math.max(1, Math.floor(w.lanes / 2)) : w.lanes;
/** 車道中心相對路線左法向的偏移。lane 0 = 最內側；雙向一般道路靠行進方向右側 */
function laneOffDir(w, lane, dir = 1) {
  const lc = laneCount(w);
  lane = Math.min(Math.max(lane, 0), lc - 1);
  if (w.city) {
    if (!w.oneway) { const off = (lane + 0.5) * (w.width / 2 - 0.3) / lc; return dir > 0 ? -off : off; }
    return (w.width / 2 - 0.3) - (lane + 0.5) * (w.width - 0.6) / w.lanes;
  }
  if (w.link && w.lanes === 1) return 0;
  return w.hw - w.ls - LANE_W * (lane + 0.5);
}
/** 速限: OSM maxspeed，沒有就依道路等級 */
const speedLimit = (w) => w.maxspeed || (w.city ? (w.cls === 5 ? 30 : 50) : w.trunk ? (w.link ? 50 : 80) : (w.link ? 60 : 100));
/** 路口 (路段端點 node) 可以接續的路段與方向；雙向一般道路兩個方向都能走 */
function nodeLinks(w, node) {
  const x = w.P[node * 3], y = w.P[node * 3 + 1];
  const own = PT_INDEX.get(ptKey(x, y)) || [];
  // 一般道路的點是「各路段自己的起點 + 0.1 m 整數位移」存的，同一個路口在不同路段上會差幾公分，四捨五入常落到隔壁格子:
  // 載入範圍內約 29% 的端點因此接不到任何路、另外 20% 少接幾條。隔壁格子 20 公分內的點也算進來 (兩邊至少一條是一般道路；國道之間的點完全一致)
  const gx = Math.round(x * 10), gy = Math.round(y * 10);
  let res = own;
  for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
    if (!ox && !oy) continue;
    for (const e of PT_INDEX.get((gx + ox) + ',' + (gy + oy)) || []) {
      const o = WAYS[e[0]];
      if (e[0] !== w.k && (o.city || w.city) && Math.hypot(o.P[e[1] * 3] - x, o.P[e[1] * 3 + 1] - y) < 0.2 && !res.some(([k, i]) => k === e[0] && i === e[1])) {
        if (res === own) res = own.slice();
        res.push(e);
      }
    }
  }
  return res;
}
function nextOptions(w, node) {
  const res = [];
  for (const [k, i] of nodeLinks(w, node)) {
    if (k === w.k) continue;
    const o = WAYS[k];
    if (Math.abs(o.P[i * 3 + 2] - w.P[node * 3 + 2]) > 2.5) continue;   // 不同樓層剛好重疊，不相連
    if (i < o.n - 1) res.push({ o, i, dir: 1, hx: o.ny[i], hy: -o.nx[i] });
    if (o.city && !o.oneway && i > 0) res.push({ o, i, dir: -1, hx: -o.ny[i], hy: o.nx[i] });
  }
  return res.sort((a, b) => a.o.gid - b.o.gid);   // 依全域編號排序: 選路結果不受分區載入順序影響
}
/** 接續選項 o (nextOptions 的一項) 走到底以後還有沒有路: 一般道路才看 (林口文化一路、羅東巷子裡只有 2 個點的死路，
 *  以前自動駕駛和 AI 都會直接開進去卡住)。只往前看一層，走不出去就算死路 */
function deadEndAhead(o) {
  if (!o.o.city) return false;
  return nextOptions(o.o, o.dir > 0 ? o.o.n - 1 : 0).length === 0;
}
/** 玩家自動駕駛選路: 國道優先同一條主線；一般道路直行，打方向燈就在路口轉彎 */
function chooseNext(w, node, dir, signal) {
  const hx = dir > 0 ? w.ny[node] : -w.ny[node], hy = dir > 0 ? -w.nx[node] : w.nx[node];
  let best = null, bs = -1e9;
  for (const o of nextOptions(w, node)) {
    const dot = hx * o.hx + hy * o.hy, cross = hx * o.hy - hy * o.hx;
    if (dot < (w.city || o.o.city ? -0.2 : 0.3)) continue;
    let sc = dot * 2 + (o.o.ref && o.o.ref === w.ref ? 3 : 0) + (o.o.link && !w.link ? -2 : 0) + (w.link && !o.o.link ? 2 : 0)
      + (!!o.o.city !== !!w.city ? -1 : 0) + (o.o.city && o.o.cls === 5 ? -1 : 0);
    if (deadEndAhead(o)) sc -= 6;   // 下一段的盡頭沒有路接 (死巷、資料斷掉): 除非沒別條，不要鑽進去
    if (HOOKS.navBias) sc += HOOKS.navBias(w, o);   // 導航路線上的下一段
    if (signal < 0 && cross > 0.3) sc += 6;
    if (signal > 0 && cross < -0.3) sc += 6;
    if (sc > bs) { bs = sc; best = o; }
  }
  if (!best && w.city) {   // 市區只剩急轉出得去 (單行道尾端接 V 字路口): 挑最順的那條，不要停在路尾
    let bd = -1e9;
    for (const o of nextOptions(w, node)) if (o.o.city) { const dot = hx * o.hx + hy * o.hy; if (dot > bd) { bd = dot; best = o; } }
  }
  return best;
}
const nextWay = (w) => { const o = chooseNext(w, w.n - 1, 1, 0); return o ? [o.o, o.i] : null; };

function spawn(wayIdx, idx, dir = 1, lane = null) {
  const w = WAYS[wayIdx];
  if (!w) return;
  if (!w.city || w.oneway) dir = 1;
  idx = Math.min(Math.max(idx, 0), w.n - 2);
  const ax = w.P[idx * 3], ay = w.P[idx * 3 + 1], bx = w.P[idx * 3 + 3], by = w.P[idx * 3 + 4];
  const lc = laneCount(w);
  const off = laneOffDir(w, lane != null ? lane : (w.city ? lc - 1 : Math.floor(lc / 2)), dir);
  S.x = ax + w.nx[idx] * off; S.y = ay + w.ny[idx] * off; S.z = w.P[idx * 3 + 2] + 0.5;
  S.h = Math.atan2(by - ay, bx - ax) + (dir < 0 ? Math.PI : 0); S.v = 0; S.vz = 0; S.steer = 0;
  S.road = roadAt(S.x, S.y, S.z, 0, 2); S.zVis = null;
  S.rt = null; S.apLane = null; S.apPending = null;
  // 傳送 / 回到路上: 停在原地重新出發 — 定速巡航取消 (不然會自己從 0 衝到設定速度)、手排回 1 檔、方向燈與脫困狀態清掉
  S.cruise = null; S.gear = 1; S.signal = 0; S.signalAuto = false; S.sigArmed = false; S.apStuck = 0; S.apUnstickAt = null;
  if (trailer) trailer.h = S.h;
  if (typeof camInit !== 'undefined') camInit = false;
}
function defaultSpawn() {
  let best = null;
  for (const w of WAYS) if (w.ref === '1' && !w.link && !w.bridge && !w.tunnel && !w.city && (!best || w.s[w.n - 1] > best.s[best.n - 1])) best = w;
  spawn(best.k, Math.floor(best.n * 0.2));
}
function respawnNearest() {
  let best = null, bd = 1e18;
  for (const w of WAYS) {
    if (w.link) continue;
    for (let i = 0; i < w.n - 1; i++) {
      const d = (w.P[i * 3] - S.x) ** 2 + (w.P[i * 3 + 1] - S.y) ** 2 + ((w.P[i * 3 + 2] - S.z) * 3) ** 2;
      if (d < bd) { bd = d; best = [w.k, i]; }
    }
  }
  const w = WAYS[best[0]], i = best[1];
  const dir = (w.city && !w.oneway && Math.cos(S.h) * w.ny[i] + Math.sin(S.h) * -w.nx[i] < 0) ? -1 : 1;
  spawn(best[0], best[1], dir);
}

// ---- 變速箱: 自排 (自動換檔) / 手排 (U 升檔、J 降檔)；定速巡航 (I)
// 六速齒比；終傳比依車種極速算 (6 檔 6000 rpm = 極速)，所以每種車的檔位速度範圍合理
const GEAR_R = [3.6, 2.2, 1.5, 1.15, 0.92, 0.75], RPM_IDLE = 800, RPM_MAX = 6500;
S.manual = false; S.gear = 1; S.rpm = RPM_IDLE; S.cruise = null;
try { S.manual = localStorage.getItem('tw_manual') === '1'; } catch (_) {}
if (params.get('manual') === '1') S.manual = true;
const wheelR = () => (S.vt && S.vt.len > 6.5 ? 0.5 : S.vtype === 'scooter' ? 0.28 : 0.33);
const finalDrive = () => { const vt = S.vt || { vmax: 45 }; return RPM_MAX * 0.92 / 60 * 2 * Math.PI * wheelR() / (GEAR_R[5] * vt.vmax * 1.2); };
const rpmAt = (g, v) => Math.abs(v) / (2 * Math.PI * wheelR()) * 60 * GEAR_R[g - 1] * finalDrive();
/** 扭力曲線 (0..1): 1000 rpm 六成、3500~4500 最大、6000 以後掉、6500 斷油 */
const torqueAt = (rpm) => rpm >= RPM_MAX ? 0 : rpm < 3500 ? 0.55 + 0.45 * smooth01(900, 3500, rpm) : rpm < 4500 ? 1 : 1 - 0.45 * smooth01(4500, RPM_MAX, rpm);
const toastEl = (() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;top:150px;left:50%;transform:translateX(-50%);background:rgba(10,14,12,.82);color:#fff;padding:8px 16px;border-radius:10px;font-size:15px;z-index:20;pointer-events:none;opacity:0;transition:opacity .35s;white-space:nowrap'; document.body.appendChild(d); return d; })();
function toast(msg, ms = 1800) { toastEl.textContent = msg; toastEl.style.opacity = 1; clearTimeout(toast.t); toast.t = setTimeout(() => { toastEl.style.opacity = 0; }, ms); }
function toggleManual() {
  if (S.vtype === 'scooter') { toast('🛵 機車是無段變速，沒有手排'); return; }
  S.manual = !S.manual;
  try { localStorage.setItem('tw_manual', S.manual ? '1' : '0'); } catch (_) {}
  toast(S.manual ? '⚙️ 手排：U 升檔、J 降檔 (搖桿 RB / LB)' : '⚙️ 自排');
}
function shift(d) {
  if (!S.manual || S.vtype === 'scooter') { if (d) toast('目前是自排，按 B 切換手排'); return; }
  const g = Math.min(6, Math.max(1, S.gear + d));
  if (g === S.gear) return;
  if (d < 0 && rpmAt(g, S.v) > RPM_MAX + 300) { toast('⚠ 轉速太高，不能降到 ' + g + ' 檔'); return; }
  S.gear = g; S.shiftT = 0.18;   // 換檔瞬間離合器分離
}
function toggleCruise() {
  if (S.cruise) { S.cruise = null; toast('定速巡航 關'); return; }
  if (S.v < 20 / 3.6) { toast('定速巡航：時速 20 以上才能設定'); return; }
  S.cruise = Math.round(S.v * 3.6) / 3.6;
  toast('🚗 定速巡航 ' + Math.round(S.cruise * 3.6) + ' km/h (+ / - 調整，踩煞車取消)');
}

const keys = {};
let camMode = params.get('cam') === '1' ? 1 : params.get('cam') === '2' ? 2 : 3, autopilot = params.has('demo'), mapScaleIdx = 0;
const MAP_SCALES = [0.11, 0.055, 0.025];
let laneCenter = true;   // 車道置中輔助 (K 切換)
try { if (localStorage.getItem('tw_lc') === '0') laneCenter = false; } catch (_) {}
if (params.get('lc') === '0') laneCenter = false; else if (params.get('lc') === '1') laneCenter = true;
window.addEventListener('keydown', (e) => {
  if (e.target && e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  if (e.code === 'KeyV') camMode = camMode === 3 ? 1 : 3;
  if (e.code === 'KeyC') camMode = camMode === 2 ? 3 : 2;   // 空拍視角
  if (e.code === 'Digit1') camMode = 1;
  if (e.code === 'Digit3') camMode = 3;
  if (e.code === 'KeyP') autopilot = !autopilot;
  if (e.code === 'KeyO') cycleTime();
  if (e.code === 'KeyK') { laneCenter = !laneCenter; S.lcLane = null; try { localStorage.setItem('tw_lc', laneCenter ? '1' : '0'); } catch (_) {} }
  if (e.code === 'KeyM') mapScaleIdx = (mapScaleIdx + 1) % MAP_SCALES.length;
  if (e.code === 'KeyR') respawnNearest();
  if (e.code === 'KeyH') $('help').classList.toggle('hidden');
  if (e.code === 'KeyG') setVehicle(PLAYER_TYPES[(PLAYER_TYPES.indexOf(S.vtype) + 1) % PLAYER_TYPES.length]);   // 換車
  if (e.code === 'KeyT') toggleMenu();
  if (e.code === 'KeyB') toggleManual();
  if (e.code === 'KeyU') shift(1);
  if (e.code === 'KeyJ') shift(-1);
  if (e.code === 'KeyI') toggleCruise();
  if ((e.code === 'Equal' || e.code === 'NumpadAdd') && S.cruise) S.cruise = Math.min(S.cruise + 5 / 3.6, 160 / 3.6);
  if ((e.code === 'Minus' || e.code === 'NumpadSubtract') && S.cruise) S.cruise = Math.max(S.cruise - 5 / 3.6, 20 / 3.6);
  for (const f of HOOKS.key) f(e);
  if (e.code === 'KeyQ' || e.code === 'KeyE') {   // 手動方向燈 Q 左、E 右 (再按一次關)；自動駕駛時路口依方向燈轉彎
    const d = e.code === 'KeyQ' ? -1 : 1;
    S.signal = S.signal === d ? 0 : d; S.signalAuto = false; S.sigArmed = false;
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
// 按著油門切到別的視窗 (Alt+Tab、點到別的程式) 時收不到 keyup: 失去焦點就全部放開，回來車子才不會自己一直衝
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

// ---- 自動駕駛路線: { w 路段, i 線段, dir 行進方向 }，沿路網推進，雙向道路可反向行駛
function updateRoute() {
  if (!S.rt) {
    if (!S.road) return null;
    const w = S.road.w;
    const dir = (w.city && !w.oneway && Math.cos(S.h) * S.road.tx + Math.sin(S.h) * S.road.ty < 0) ? -1 : 1;
    S.rt = { w, i: S.road.i, dir };
  }
  let { w, i, dir } = S.rt, guard = 0;
  while (guard++ < 60) {
    if (i < 0 || i > w.n - 2) {
      const node = dir > 0 ? w.n - 1 : 0;
      const nx = chooseNext(w, node, dir, S.signal || 0);
      if (!nx) {
        // 路線走到死路，但車子其實已經開上別的路段 (路網沒接好的地方): 從目前所在路段重新接路線
        const r = S.road;
        if (r && r.w !== w && guard < 40) {
          w = r.w; i = r.i;
          dir = (w.city && !w.oneway && Math.cos(S.h) * r.tx + Math.sin(S.h) * r.ty < 0) ? -1 : 1;
          continue;
        }
        i = Math.min(Math.max(i, 0), w.n - 2); break;
      }
      w = nx.o; dir = nx.dir; i = dir > 0 ? nx.i : nx.i - 1;
      if (S.signal && !S.signalAuto) { S.signal = 0; S.sigArmed = false; }   // 轉完彎熄燈
      continue;
    }
    const ax = w.P[i * 3], ay = w.P[i * 3 + 1], dx = w.P[i * 3 + 3] - ax, dy = w.P[i * 3 + 4] - ay;
    const t = ((S.x - ax) * dx + (S.y - ay) * dy) / (dx * dx + dy * dy || 1);
    if (dir > 0 && t > 1) { i++; continue; }
    if (dir < 0 && t < 0) { i--; continue; }
    const L = Math.hypot(dx, dy) || 1;
    const lat = ((S.x - ax) * -dy + (S.y - ay) * dx) / L;
    if (Math.abs(lat) > w.hw + 6) { S.rt = null; return null; }
    // 車子沒照路線走 (轉彎轉不過去開進旁邊的路): 從車子所在的路段重接路線
    const rr = S.road;
    if (Math.abs(lat) > w.hw + 1.5 && rr && rr.w !== w && guard < 40 && Math.abs(Math.cos(S.h) * rr.tx + Math.sin(S.h) * rr.ty) > 0.9) {
      w = rr.w; i = rr.i;
      dir = (w.city && !w.oneway && Math.cos(S.h) * rr.tx + Math.sin(S.h) * rr.ty < 0) ? -1 : 1;
      continue;
    }
    S.rt = { w, i, dir, t: Math.min(Math.max(t, 0), 1), lat };
    return S.rt;
  }
  S.rt = { w, i, dir, t: dir > 0 ? 1 : 0, lat: 0 };
  return S.rt;
}
/** 自動駕駛路線上的下一段路: 距離路段終點 dist 以內才回傳 { w, dir, d } */
function routeNext(dist) {
  const rt = S.rt;
  if (!rt) return null;
  const w = rt.w, dir = rt.dir, i = rt.i;
  const sNow = w.s[i] + (w.s[i + 1] - w.s[i]) * (rt.t || 0);
  const d = dir > 0 ? w.s[w.n - 1] - sNow : sNow;
  if (d > dist) return null;
  const nx = chooseNext(w, dir > 0 ? w.n - 1 : 0, dir, S.signal || 0);
  return nx ? { w: nx.o, dir: nx.dir, d } : null;
}
/** 自動駕駛走到死路時找前方可以接著開的路: 60 m 內、在車頭前方、高度差 3 m 內、可以順著車頭方向行駛的點 (取最近) */
function gapJump(x, y, z, h) {
  const fx = Math.cos(h), fy = Math.sin(h), cur = S.road && S.road.w;
  let best = null, bd = 1e9;
  for (const o of WAYS) {
    if (!o || o === cur || o.n < 2) continue;
    if (Math.abs(o.P[0] - x) > 400 && Math.abs(o.P[(o.n - 1) * 3] - x) > 400) continue;   // 粗篩
    for (let i = 0; i < o.n - 1; i++) {
      const px = o.P[i * 3], py = o.P[i * 3 + 1], dx = px - x, dy = py - y, d = Math.hypot(dx, dy);
      if (d < 4 || d > 60 || d >= bd || dx * fx + dy * fy < d * 0.7 || Math.abs(o.P[i * 3 + 2] - z) > 3) continue;
      const tx = o.P[i * 3 + 3] - px, ty = o.P[i * 3 + 4] - py, L = Math.hypot(tx, ty) || 1, c = (tx * fx + ty * fy) / L;
      const dir = c > 0.3 ? 1 : (c < -0.3 && o.city && !o.oneway) ? -1 : 0;
      if (!dir) continue;
      const lc = laneCount(o), off = laneOffDir(o, o.city ? lc - 1 : Math.floor(lc / 2), dir);
      bd = d; best = { x: px + o.nx[i] * off, y: py + o.ny[i] * off, h: Math.atan2(ty * dir, tx * dir) };
    }
  }
  return best;
}
function lookAhead(dist) {
  const rt = S.rt;
  if (!rt) return null;
  let w = rt.w, dir = rt.dir, guard = 0;
  const i0 = rt.i, t = rt.t || 0;
  let px = w.P[i0 * 3] + (w.P[i0 * 3 + 3] - w.P[i0 * 3]) * t, py = w.P[i0 * 3 + 1] + (w.P[i0 * 3 + 4] - w.P[i0 * 3 + 1]) * t;
  let v = dir > 0 ? i0 + 1 : i0, k = v;
  while (dist > 0 && guard++ < 800) {
    if (v < 0 || v > w.n - 1) {
      const node = dir > 0 ? w.n - 1 : 0;
      const nx = chooseNext(w, node, dir, S.signal || 0);
      if (!nx) break;
      w = nx.o; dir = nx.dir; v = nx.i + dir; continue;
    }
    const bx = w.P[v * 3], by = w.P[v * 3 + 1], d = Math.hypot(bx - px, by - py);
    k = v;
    if (d >= dist) { px += (bx - px) / d * dist; py += (by - py) / d * dist; dist = 0; break; }
    dist -= d; px = bx; py = by; v += dir;
  }
  k = Math.min(Math.max(k, 0), w.n - 1);
  const lc = laneCount(w);
  const lane = S.apLane == null ? (w.city ? lc - 1 : Math.floor(lc / 2)) : Math.min(S.apLane, lc - 1);
  const off = laneOffDir(w, lane, dir);
  return { x: px + w.nx[k] * off, y: py + w.ny[k] * off, w, dir };
}

/** 車道置中: 手動駕駛沒打方向盤時，把車子帶回最近的車道中心 (純追蹤法，只沿目前路段往前看)。
 *  回傳 -1..1 的轉向量，沒作用時回傳 null。打方向燈、車速太低、偏離太多或角度太大都會暫停。 */
function laneCenterSteer(maxSteer) {
  const r = S.road;
  S.lcOn = false;
  if (!r || S.v < 6 || (S.signal && !S.signalAuto)) { S.lcLane = null; return null; }
  const w = r.w, cd = Math.cos(S.h) * r.tx + Math.sin(S.h) * r.ty;
  if (Math.abs(cd) < 0.82) { S.lcLane = null; return null; }      // 夾角 > 35°: 路口轉彎中
  const dir = cd > 0 ? 1 : -1;
  if (!w.city && dir < 0) return null;                            // 逆向不輔助
  const lc = laneCount(w);
  if (S.lcLane == null || S.lcWay !== w.k || S.lcDir !== dir) {
    let b = 0, bd = 1e9;
    for (let ln = 0; ln < lc; ln++) { const d = Math.abs(laneOffDir(w, ln, dir) - r.lat); if (d < bd) { bd = d; b = ln; } }
    S.lcLane = b; S.lcWay = w.k; S.lcDir = dir;
  }
  const off = laneOffDir(w, Math.min(S.lcLane, lc - 1), dir);
  if (Math.abs(off - r.lat) > LANE_W * 0.9) { S.lcLane = null; return null; }   // 方向盤放開後還在滑: 下一格重選最近車道
  // 從投影點沿車道往前 L 公尺；到路段端點就接到「車道對得上」的下一段 (車道縮減就併到相鄰車道、在出口車道就跟著匝道)，接不上才沿切線延伸
  let P = w.P, cw = w, cdir = dir, coff = off, hops = 0;
  const i = r.i;
  let px = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * r.t, py = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * r.t;
  let dist = 7 + S.v * 0.9, v = dir > 0 ? i + 1 : i, k = v, tx = r.tx * dir, ty = r.ty * dir, guard = 0;
  while (dist > 0 && guard++ < 400) {
    if (v < 0 || v > cw.n - 1) {
      if (hops++ >= 3) break;
      const node = cdir > 0 ? cw.n - 1 : 0;
      const ex = P[node * 3] + cw.nx[node] * coff, ey = P[node * 3 + 1] + cw.ny[node] * coff;
      let best = null, bq = 0, bd = 2.5;
      for (const o of nextOptions(cw, node)) {
        if (tx * o.hx + ty * o.hy < 0.7) continue;                 // 只跟直行方向，轉彎交給駕駛
        const lcO = laneCount(o.o);
        for (let q = 0; q < lcO; q++) {
          const lo = laneOffDir(o.o, q, o.dir);
          const d = Math.hypot(o.o.P[o.i * 3] + o.o.nx[o.i] * lo - ex, o.o.P[o.i * 3 + 1] + o.o.ny[o.i] * lo - ey);
          if (d < bd) { bd = d; best = o; bq = q; }
        }
      }
      if (!best) break;
      cw = best.o; cdir = best.dir; P = cw.P; coff = laneOffDir(cw, bq, cdir); v = best.i + cdir;
      continue;
    }
    const bx = P[v * 3], by = P[v * 3 + 1], d = Math.hypot(bx - px, by - py);
    k = v;
    if (d > 1e-3) { tx = (bx - px) / d; ty = (by - py) / d; }
    if (d >= dist) { px += tx * dist; py += ty * dist; dist = 0; break; }
    dist -= d; px = bx; py = by; v += cdir;
  }
  if (dist > 0) { px += tx * dist; py += ty * dist; }
  k = Math.min(Math.max(k, 0), cw.n - 1);
  const gx = px + cw.nx[k] * coff, gy = py + cw.ny[k] * coff;
  const dx = gx - S.x, dy = gy - S.y, Ld = Math.hypot(dx, dy) || 1;
  const al = Math.atan2(Math.sin(Math.atan2(dy, dx) - S.h), Math.cos(Math.atan2(dy, dx) - S.h));
  S.lcOn = true;
  return Math.max(-0.8, Math.min(0.8, Math.atan2(2 * WB * Math.sin(al), Ld) / maxSteer));
}

function update(dt) {
  const vt = S.vt || (window.TWV && window.TWV.TYPES.sedan) || { acc: 1.5, vmax: 45, wb: 2.8, wid: 1.85 };
  const big = vt.len > 6.5;
  let thr = 0, brk = 0, str = 0;
  if (keys.KeyW || keys.ArrowUp) thr = 1;
  if (keys.KeyS || keys.ArrowDown) brk = 1;
  if (keys.KeyA || keys.ArrowLeft) str += 1;
  if (keys.KeyD || keys.ArrowRight) str -= 1;
  // 類比輸入 (螢幕方向盤、重力感應、實體方向盤 / 搖桿): 有在轉就取代鍵盤左右
  const analog = S.steerAxis != null && Math.abs(S.steerAxis) > 0.025;
  if (analog) str = S.steerAxis;
  if (S.padThr > 0.03) thr = Math.max(thr, S.padThr);
  if (S.padBrk > 0.03) brk = Math.max(brk, S.padBrk);
  const boost = keys.ShiftLeft || keys.ShiftRight;
  if (thr || brk || str) autopilot = autopilot && !(thr || brk || str) ? false : autopilot;
  const maxSteer = (big ? 0.6 : 0.55) / (1 + Math.abs(S.v) / 14);
  if (autopilot) {
    S.lcOn = false;
    const rt = updateRoute();
    const w0 = rt ? rt.w : (S.road && S.road.w);
    const dir = rt ? rt.dir : 1;
    const curLat = rt ? rt.lat : (S.road ? S.road.lat : 0);
    if (w0 && (S.apLane == null || S.apWay !== w0.k)) {
      const lc = laneCount(w0);
      if (S.apLane == null) S.apLane = w0.city ? lc - 1 : Math.round((w0.hw - w0.ls - curLat) / LANE_W - 0.5);
      else if (!w0.city) {
        let b = 0, bd = 1e9;
        for (let ln = 0; ln < lc; ln++) { const d = Math.abs(laneOffDir(w0, ln, dir) - curLat); if (d < bd) { bd = d; b = ln; } }
        S.apLane = b;
        if (S.apPending != null) { S.apPending = null; if (S.signalAuto) { S.signal = 0; S.signalAuto = false; } }
      }
      S.apLane = Math.min(Math.max(S.apLane, 0), lc - 1);
      if ((vt.len > 9) && !w0.city) S.apLane = Math.max(S.apLane, lc - 2, 0);   // 大型車走外側
      S.apWay = w0.k;
    }
    const la = lookAhead(10 + Math.abs(S.v) * 1.1 + (big ? 4 : 0));
    if (la && w0) {
      const dx = la.x - S.x, dy = la.y - S.y, Ld = Math.hypot(dx, dy) || 1;
      const alpha = Math.atan2(dy, dx) - S.h;
      const sa = Math.atan2(Math.sin(alpha), Math.cos(alpha));
      str = Math.max(-1, Math.min(1, Math.atan2(2 * WB * Math.sin(sa), Ld) / maxSteer));
      const lim = (speedLimit(la.w) / 3.6) * (la.w.link ? 0.9 : 1);
      const curv = Math.abs(sa) / Ld; const vc = Math.sqrt(3.5 / Math.max(curv * 2, 1e-4));
      const vtg = Math.max(3, Math.min(lim, vc, vt.vmax));
      // IDM 跟車 (含路口讓車)
      const lc = laneCount(w0);
      const shift = dir * (laneOffDir(w0, S.apLane, dir) - curLat);
      const ld = HOOKS.leader ? HOOKS.leader(shift) : { gap: 1e9, v: vtg };
      const v = Math.max(S.v, 0), A = Math.min(1.6, vt.acc * 1.1);
      let acc = A * (1 - Math.pow(v / vtg, 4));
      if (ld.gap < 1e8) {
        const ss = 3 + Math.max(0, v * 1.4 + v * (v - ld.v) / (2 * Math.sqrt(A * 2.5)));
        acc -= A * (ss / Math.max(ld.gap, 0.1)) ** 2;
      }
      if (ld.gap < 2.5) acc = -10;
      if (acc >= 0) thr = Math.min(1, acc / 2.2); else brk = Math.min(1, -acc / 8);
      // 卡在路緣 (油門踩著、前面沒車、車子不動) 3 秒: 把車擺回目前車道中央、車頭對齊路
      S.apStuck = (Math.abs(S.v) < 0.5 && thr > 0.2 && ld.gap > 6) ? (S.apStuck || 0) + dt : 0;
      if (S.apStuck > 3 && rt) {
        const P = w0.P, i = rt.i, t = rt.t || 0;
        const off = laneOffDir(w0, S.apLane, dir);
        const tx = P[i * 3 + 3] - P[i * 3], ty = P[i * 3 + 4] - P[i * 3 + 1], L = Math.hypot(tx, ty) || 1;
        S.x = P[i * 3] + tx * t + w0.nx[i] * off; S.y = P[i * 3 + 1] + ty * t + w0.ny[i] * off;
        S.h = Math.atan2(ty, tx) + (dir < 0 ? Math.PI : 0); S.steer = 0;
        // 同一個地方又卡住 (窄巷急轉彎轉不過去): 直接擺到路線前方 6 公尺、已經轉過去的位置
        const again = S.apUnstickAt && Math.hypot(S.apUnstickAt[0] - S.x, S.apUnstickAt[1] - S.y) < 6;
        S.apUnstickAt = [S.x, S.y];
        const a1 = again && lookAhead(6), a2 = a1 && lookAhead(9);
        if (a1 && a2 && Math.hypot(a2.x - a1.x, a2.y - a1.y) > 0.5) {
          const r3 = roadAt(a1.x, a1.y, S.z, 0, 2);
          if (r3) { S.x = a1.x; S.y = a1.y; S.h = Math.atan2(a2.y - a1.y, a2.x - a1.x); S.v = 0; S.apUnstickAt = null; }
        }
        else if (again) {   // 前面沒路 (原始資料斷掉的死路，例如地下道後半段缺資料): 跳到前方 60 m 內方向順的路
          const j = gapJump(S.x, S.y, S.z, S.h);
          if (j) { S.x = j.x; S.y = j.y; S.h = j.h; S.v = 0; S.apUnstickAt = null; S.apGapJumps = (S.apGapJumps || 0) + 1; }
        }
        const r2 = roadAt(S.x, S.y, S.z, 0, 2); if (r2) S.road = r2;
        if (S.apUnstickAt === null) S.rt = null;
        S.apStuck = 0; S.apUnstick = (S.apUnstick || 0) + 1;
      }
      // 換車道
      S.apCool = (S.apCool || 0) - dt;
      const laneOkP = (ln) => ln >= 0 && ln < lc && !(vt.len > 9 && !w0.city && ln < lc - 2);
      // 前方路段的車道對不上 (車道縮減、主線分岔): 提早往接得上的車道併，等不到空檔就減速
      const nxt = (!w0.city && !w0.link) ? routeNext(Math.max(150, v * 8)) : null;
      let fitsNext = () => true, must = null;
      if (nxt && !nxt.w.city) {
        const lcN = laneCount(nxt.w);
        fitsNext = (ln) => {
          const off = laneOffDir(w0, ln, dir);
          for (let q = 0; q < lcN; q++) if (Math.abs(laneOffDir(nxt.w, q, nxt.dir) - off) < 1.2) return true;
          return false;
        };
        if (!fitsNext(S.apLane)) {
          let best = null;
          for (let ln = 0; ln < lc; ln++) if (fitsNext(ln) && laneOkP(ln) && (best == null || Math.abs(ln - S.apLane) < Math.abs(best - S.apLane))) best = ln;
          if (best != null) must = S.apLane + Math.sign(best - S.apLane);
        }
      }
      if (must != null && S.apPending == null && Math.abs(shift) < 0.4) {
        if (!HOOKS.laneFree || HOOKS.laneFree(dir * (laneOffDir(w0, must, dir) - curLat))) {
          S.apPending = must; S.apSigT = 0.8; S.signal = must < S.apLane ? -1 : 1; S.signalAuto = true; S.apCool = 3;
        } else if (nxt.d < 90) { thr = 0; brk = Math.max(brk, 0.35); }
      }
      S.apShift = shift;   // 測試追蹤用
      if (S.apPending != null) {
        S.apSigT -= dt;
        if (S.apSigT <= 0) {
          const ok = laneOkP(S.apPending) && (!HOOKS.laneFree || HOOKS.laneFree(dir * (laneOffDir(w0, S.apPending, dir) - curLat)));
          if (ok) { S.apLane = S.apPending; S.apChanges = (S.apChanges || 0) + 1; } else S.signal = 0;
          S.apPending = null;
        }
      } else if (S.apCool <= 0 && lc > 1 && Math.abs(shift) < 0.4 && !w0.link && S.vtype !== 'scooter') {
        const blocked = ld.gap < 70 && ld.v < vtg - 2;
        const tries = blocked ? [S.apLane - 1, S.apLane + 1] : (ld.gap > 100 && Math.random() < dt * 0.1 ? [S.apLane + 1] : []);
        if (params.has('trace')) S.apDbg = 'blk ' + blocked + ' gap ' + ld.gap.toFixed(0) + ' lv ' + (ld.v * 3.6).toFixed(0) + ' vtg ' + (vtg * 3.6).toFixed(0) + ' lc ' + lc + ' ln ' + S.apLane + ' ' + tries.map((ln) => ln + ':' + (laneOkP(ln) ? 'ok' : 'X') + (fitsNext(ln) ? 'f' : 'nf') + (HOOKS.laneFree && laneOkP(ln) ? (HOOKS.laneFree(dir * (laneOffDir(w0, ln, dir) - curLat)) ? 'free' : 'busy') : '')).join(',');
        for (const ln of tries) {
          if (!laneOkP(ln) || !fitsNext(ln)) continue;
          if (!HOOKS.laneFree || HOOKS.laneFree(dir * (laneOffDir(w0, ln, dir) - curLat))) {
            S.apPending = ln; S.apSigT = 1.3; S.signal = ln < S.apLane ? -1 : 1; S.signalAuto = true; S.apCool = 5;
            break;
          }
        }
        if (tries.length && S.apCool <= 0) S.apCool = 1.5;
      }
      const shiftNow = laneOffDir(w0, S.apLane, dir) - curLat;
      if (S.signalAuto && S.apPending == null) {
        if (Math.abs(shiftNow) < 0.3) { S.sigHold = (S.sigHold || 0) + dt; if (S.sigHold > 0.4) { S.signal = 0; S.signalAuto = false; S.sigHold = 0; } }
        else S.sigHold = 0;
      }
    }
  } else {
    S.apLane = null; S.apPending = null; S.rt = null;
    if (S.signalAuto) { S.signal = 0; S.signalAuto = false; }
    if (str) { S.lcLane = null; S.lcOn = false; }
    else if (laneCenter) { const c = laneCenterSteer(maxSteer); if (c != null) str = c; }
    else S.lcOn = false;
  }
  // 手動方向燈: 方向盤轉過再回正後自動熄燈 (自動駕駛時保留到路口轉彎)
  if (S.signal && !S.signalAuto && !autopilot) {
    if (Math.abs(S.steer) > 0.1) S.sigArmed = true;
    else if (S.sigArmed && Math.abs(S.steer) < 0.02) { S.signal = 0; S.sigArmed = false; }
  }
  // 定速巡航: 煞車 / 手煞車取消；踩油門可以暫時加速，放開回到設定速度
  if (S.cruise && (brk > 0.05 || keys.Space || autopilot)) { S.cruise = null; toast('定速巡航 取消'); }
  if (S.cruise && !autopilot) {
    const e = S.cruise - S.v;
    const ct = Math.max(0, Math.min(1, e * 0.35 + 0.12 + Math.max(0, Math.sin(S.pitch)) * 1.5));
    thr = Math.max(thr, ct);
    if (e < -1.2 && thr === ct) { thr = 0; brk = Math.min(0.25, (-e - 1.2) * 0.06); }
  }
  S.thr = thr; S.brk = brk;
  // 縱向 (依車種: 加速度、極速、煞車)
  let a = 0;
  const vmax = vt.vmax * 1.2 * (boost ? 1.3 : 1);
  const A0 = 5.5 * (vt.acc / 1.5);
  const cvt = S.vtype === 'scooter';
  S.shiftT = Math.max(0, (S.shiftT || 0) - dt);
  if (S.manual && !cvt && !autopilot && S.v >= -0.3) {
    // 手排: 推力 = 扭力曲線 × 齒比；低速半離合 (不會熄火)；放油門有引擎煞車；6500 rpm 斷油
    const wr = rpmAt(S.gear, S.v), slip = wr < 1100;
    S.rpm = slip ? Math.max(wr, RPM_IDLE + thr * 1700) : Math.max(wr, RPM_IDLE);
    const gk = GEAR_R[S.gear - 1] / GEAR_R[0];
    if (thr && S.shiftT <= 0) a += A0 * 1.15 * thr * torqueAt(S.rpm) * Math.pow(gk, 0.85) * (slip ? Math.min(1, 0.45 + wr / 2000) : 1) * (boost ? 1.25 : 1);
    if (!thr && !slip && S.v > 1) a -= 0.25 + 0.9 * (S.rpm / RPM_MAX) * Math.sqrt(gk);
    if (wr > RPM_MAX + 200 && S.v > 0) a -= (wr - RPM_MAX) / 400;   // 超轉: 引擎拖住
  } else {
    if (thr) a += A0 * thr * (1 - Math.max(S.v, 0) / vmax);
    // 自排換檔點: 油門越深越晚換 (引擎聲、轉速表用)
    if (!cvt) {
      const up = 2600 + thr * 2400;
      if (rpmAt(S.gear, S.v) > up && S.gear < 6) { S.gear++; S.shiftT = 0.12; }
      else if (S.gear > 1 && rpmAt(S.gear - 1, S.v) < up * 0.62) S.gear--;
      S.rpm = Math.max(RPM_IDLE + thr * 400, rpmAt(S.gear, S.v));
    } else { S.gear = 1; S.rpm = Math.max(RPM_IDLE + thr * 2500, Math.min(7500, 3000 + Math.abs(S.v) * 120)); }
  }
  const wet = 1 - 0.22 * WEATHER.wet.value;   // 濕地煞車距離變長
  if (brk) a += S.v > 0.5 ? -(big ? 7 : 10) * brk * wet : -3.5 * brk;
  if (keys.Space) a += S.v > 0 ? -8 * wet : (S.v < 0 ? 8 : 0);
  a -= 0.00042 * S.v * Math.abs(S.v) + 0.12 * Math.sign(S.v);
  a -= 9.81 * Math.sin(S.pitch) * 0.9;
  S.v += a * dt;
  if (autopilot && S.v < 0) S.v = 0;   // 自動駕駛在車陣裡停住時踩煞車，不能變成倒車
  if (!thr && !brk && Math.abs(S.v) < 0.15) S.v = 0;
  S.braking = !!(brk && S.v > 0.5) || !!keys.Space;
  // 轉向
  const tgt = str * maxSteer;
  const sRate = analog && !autopilot ? 7 : 2.5;   // 類比方向盤反應快，鍵盤維持平滑
  S.steer += Math.max(-sRate * dt, Math.min(sRate * dt, tgt - S.steer));
  const yawRate = S.v * Math.tan(S.steer) / WB;
  S.h += yawRate * dt;
  // 平面移動 + 路緣碰撞
  let nx = S.x + Math.cos(S.h) * S.v * dt, ny = S.y + Math.sin(S.h) * S.v * dt;
  let r = roadAt(nx, ny, S.z, MARGIN);
  if (!r && S.road && S.road.w.city) r = roadAt(nx, ny, S.z, 0.3);   // 一般道路沒有護欄: 大車可以壓到路緣
  // 國道中央護欄: 不能開到對向路面，車身也不能壓進護欄 (資料裡兩條路面重疊的地方特別要擋)
  if (r && S.road && !r.w.city && !S.road.w.city) {
    const cw = S.road.w;
    if (r.w !== cw && r.w.oneway && cw.oneway && !r.w.link && !cw.link && r.tx * S.road.tx + r.ty * S.road.ty < -0.5) r = null;
    else if (r.w.pair && r.w.pair[r.i] && r.lat + (MARGIN - 0.35) > r.w.bc[r.i] - BAR_HALF) r = null;
  }
  if (!r && S.road) {
    const tx = S.road.tx, ty = S.road.ty;
    const sgn = Math.cos(S.h) * tx + Math.sin(S.h) * ty >= 0 ? 1 : -1;
    const vtan = S.v * (Math.cos(S.h) * tx * sgn + Math.sin(S.h) * ty * sgn);
    S.v = vtan * 0.92;
    const th = Math.atan2(ty * sgn, tx * sgn);
    S.h += Math.atan2(Math.sin(th - S.h), Math.cos(th - S.h)) * 0.25;
    const lat = S.road.lat, push = -Math.sign(lat) * 0.05;
    nx = S.x + tx * sgn * S.v * dt + (-ty) * push; ny = S.y + ty * sgn * S.v * dt + tx * push;
    r = roadAt(nx, ny, S.z, MARGIN);
    if (!r) { nx = S.x; ny = S.y; r = S.road; S.v *= 0.5; }
  }
  if (r) { S.x = nx; S.y = ny; S.road = r; }
  // 伸縮縫: 前輪、後輪各自壓過時「叩」一聲，車身輕彈
  {
    const hb = WB / 2, cx = Math.cos(S.h), cy = Math.sin(S.h);
    const fx1 = S.x + cx * hb, fy1 = S.y + cy * hb, rx1 = S.x - cx * hb, ry1 = S.y - cy * hb;
    if (S.axF && Math.abs(S.v) > 1) {
      if (crossedJoint(S.axF[0], S.axF[1], fx1, fy1, S.z)) { if (HOOKS.joint) HOOKS.joint(Math.abs(S.v), 0); S.jolt = 0.025; }
      if (crossedJoint(S.axR[0], S.axR[1], rx1, ry1, S.z)) { if (HOOKS.joint) HOOKS.joint(Math.abs(S.v), 1); S.jolt = 0.02; }
    }
    S.axF = [fx1, fy1]; S.axR = [rx1, ry1];
  }
  // 垂直
  const g = S.road ? S.road.z : terrainAt(S.x, S.y);
  if (S.z > g + 0.4) { S.vz -= 9.81 * dt; S.z += S.vz * dt; if (S.z < g) { S.z = g; S.vz = 0; } }
  else { S.z = g; S.vz = 0; }
  if (S.zVis == null || Math.abs(S.zVis - S.z) > 3) S.zVis = S.z;
  S.zVis += (S.z - S.zVis) * (1 - Math.exp(-dt * 14));
  if (S.jolt) { S.zVis += S.jolt; S.jolt = 0; }   // 壓過伸縮縫的小彈跳 (會被平滑濾掉)
  // 車身姿態 (機車轉彎壓車)
  const fx = Math.cos(S.h), fy = Math.sin(S.h);
  const zs = (dx, dy) => { const q = roadAt(S.x + dx, S.y + dy, S.z + 0.5, 0, 1.0); return q ? q.z : S.z; };
  const hl = Math.min(WB / 2, 3);
  const pitchT = Math.atan2(zs(fx * hl, fy * hl) - zs(-fx * hl, -fy * hl), 2 * hl);
  const rollT = vt.lean ? Math.max(-0.5, Math.min(0.5, Math.atan(S.v * yawRate / 9.81)))
    : Math.atan2(zs(-fy * 0.8, fx * 0.8) - zs(fy * 0.8, -fx * 0.8), 1.6);
  const k = 1 - Math.exp(-dt * 5);
  const clampA = (v) => Math.max(-0.2, Math.min(0.2, v));
  S.pitch += (clampA(pitchT) - S.pitch) * k;
  S.roll += ((vt.lean ? rollT : clampA(rollT)) - S.roll) * k;
  // 聯結車拖車 (拖車方向往牽引點收斂)
  if (trailer) {
    const c = trailer.cfg;
    trailer.h += S.v * Math.sin(S.h - trailer.h) / c.kingpin * dt;
  }
}

function syncCar(dt) {
  car.position.set(S.x, S.zVis != null ? S.zVis : S.z, -S.y);
  car.rotation.set(S.roll, S.h, S.pitch, 'YZX');
  for (const wh of car.userData.wheels || []) {
    wh.spin.rotation.z -= S.v * dt / (wh.r || 0.33);
    if (wh.front) wh.pivot.rotation.y = S.steer;
  }
  car.userData.tailMat.color.setRGB(S.braking ? 1 : 0.5, S.braking ? 0.02 : 0.005, S.braking ? 0.01 : 0.005);
  const on = blinkPhase();
  car.userData.sigLMat.color.copy(S.signal === -1 && on ? SIG_ON : SIG_OFF);
  car.userData.sigRMat.color.copy(S.signal === 1 && on ? SIG_ON : SIG_OFF);
  if (car.userData.flashA && S.vtype === 'police') {
    const f = (performance.now() % 500) < 250;
    car.userData.flashA.color.setRGB(f ? 1 : 0.05, f ? 0.02 : 0.02, f ? 0.02 : 0.02);
    car.userData.flashB.color.setRGB(f ? 0.05 : 0.05, f ? 0.02 : 0.15, f ? 0.02 : 1);
  }
  if (trailer) {
    const c = trailer.cfg;
    const hx = S.x - Math.cos(S.h) * c.hitch, hy = S.y - Math.sin(S.h) * c.hitch;
    const tx = hx - Math.cos(trailer.h) * c.kingpin, ty = hy - Math.sin(trailer.h) * c.kingpin;
    const q = roadAt(tx, ty, S.z + 1, 0, 2);
    trailer.group.position.set(tx, q ? q.z : (S.zVis != null ? S.zVis : S.z), -ty);
    trailer.group.rotation.set(0, trailer.h, S.pitch, 'YZX');
    trailer.ud.tailMat.color.copy(car.userData.tailMat.color);
    trailer.ud.sigLMat.color.copy(car.userData.sigLMat.color);
    trailer.ud.sigRMat.color.copy(car.userData.sigRMat.color);
  }
}

// ======================================================================= 攝影機
const camPos = new T.Vector3(), camLook = new T.Vector3();
let camInit = false, orbitYaw = (+params.get('yaw') || 0) * Math.PI / 180, dragging = false, lastX = 0;   // yaw: 測試用，空拍朝向 (度)
renderer.domElement.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; });
window.addEventListener('pointerup', () => { dragging = false; });
window.addEventListener('pointermove', (e) => { if (dragging) { orbitYaw -= (e.clientX - lastX) * 0.006; lastX = e.clientX; } });

const AER = (params.get('aer') || '150,140').split(',').map(Number);   // 空拍: 後退距離, 高度 (測試可用 ?aer=30,40 近拍)
const CAMAT = params.get('camat') ? params.get('camat').split(',').map(Number) : null;   // 測試: ?camat=x,y,z&look=x,y,z 固定攝影機 (資料座標)
const LOOKAT = params.get('look') ? params.get('look').split(',').map(Number) : null;
function updateCamera(dt) {
  if (CAMAT && LOOKAT) {
    camera.position.set(CAMAT[0], CAMAT[2], -CAMAT[1]); camera.lookAt(LOOKAT[0], LOOKAT[2], -LOOKAT[1]); camera.updateProjectionMatrix();
    const c = new T.Vector3(LOOKAT[0], LOOKAT[2], -LOOKAT[1]);
    sun.target.position.copy(c); sun.position.copy(c).addScaledVector(SUN_DIR, 600);
    return;
  }
  const vt = S.vt || { cam: 1, eye: [0.1, 1.2, -0.37] };
  const fwd = new T.Vector3(Math.cos(S.h), 0, -Math.sin(S.h));
  const carP = new T.Vector3(S.x, S.zVis != null ? S.zVis : S.z, -S.y);
  if (trailer) trailer.group.visible = camMode !== 1;
  if (camMode === 2) {   // 空拍
    car.visible = true;
    const back = fwd.clone().applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    const want = carP.clone().addScaledVector(back, -AER[0]).add(new T.Vector3(0, AER[1], 0));
    if (!camInit) { camPos.copy(want); camInit = true; }
    camPos.lerp(want, 1 - Math.exp(-dt * 3));
    camera.position.copy(camPos); camera.lookAt(carP.clone().addScaledVector(fwd, Math.min(60, AER[0] * 0.4)));
  } else if (camMode === 1) {   // 第一人稱: 只看到前方的路
    car.visible = false;
    camera.near = 0.1;
    const eye = new T.Vector3(...vt.eye).applyEuler(car.rotation).add(carP);
    const dir = new T.Vector3(1, -0.03, 0).applyEuler(new T.Euler(0, S.h, S.pitch, 'YZX'));
    camera.position.copy(eye);
    camera.lookAt(eye.clone().add(dir));
    camInit = false;
  } else {
    car.visible = true;
    if (!dragging) orbitYaw *= Math.exp(-dt * 1.5);
    const cm = vt.cam || 1;
    const back = fwd.clone().applyAxisAngle(new T.Vector3(0, 1, 0), orbitYaw);
    const want = carP.clone().addScaledVector(back, -8.5 * cm - (trailer ? 8 : 0)).add(new T.Vector3(0, 3.0 * Math.pow(cm, 0.8), 0));
    const look = carP.clone().addScaledVector(fwd, 2.5 * cm).add(new T.Vector3(0, 1.0 * Math.pow(cm, 0.8), 0));
    if (!camInit) { camPos.copy(want); camLook.copy(look); camInit = true; }
    camPos.lerp(want, 1 - Math.exp(-dt * 7)); camLook.lerp(look, 1 - Math.exp(-dt * 12));
    camera.position.copy(camPos); camera.lookAt(camLook);
  }
  camera.updateProjectionMatrix();
  sun.target.position.copy(carP);
  sun.position.copy(carP).addScaledVector(SUN_DIR, 600);
}

// ======================================================================= 選單: 傳送 / 換車 (T)
let SPAWNS = [];
function toggleMenu(force) {
  const el = $('menu');
  if (!el) return;
  const show = force != null ? force : el.classList.contains('hidden');
  el.classList.toggle('hidden', !show);
  if (show) {
    const list = $('menu-places'), cars = $('menu-cars');
    list.innerHTML = ''; cars.innerHTML = '';
    for (const sp of SPAWNS) {
      const b = document.createElement('button'); b.textContent = sp.name;
      b.onclick = () => { toggleMenu(false); goTo(sp); };
      list.appendChild(b);
    }
    for (const t of PLAYER_TYPES) {
      const b = document.createElement('button'); b.textContent = window.TWV ? window.TWV.TYPES[t].name : t;
      if (t === S.vtype) b.classList.add('on');
      b.onclick = () => { setVehicle(t); toggleMenu(false); };
      cars.appendChild(b);
    }
  }
}

async function goTo(sp) {
  $('loading').classList.remove('hidden');
  await ensureArea(sp.x, sp.y, '傳送中…');
  const w = wayByGid(sp.gid);
  if (w) spawn(w.k, sp.idx, sp.dir || 1);
  $('loading').classList.add('hidden');
}

// ======================================================================= 小地圖 (左上圓形)
const mcv = $('minimap'), mctx = mcv.getContext('2d');
const MAP_PX = 200, DPR = Math.min(window.devicePixelRatio || 1, 2);
mcv.width = MAP_PX * DPR; mcv.height = MAP_PX * DPR;
const REF_COLOR = { '1': '#3fbf5f', '3': '#f2b632', '3甲': '#4fc3f7', '5': '#b48cff' };
function drawMinimap() {
  const s = MAP_SCALES[mapScaleIdx], R = MAP_PX / 2, rad = R / s;
  const c = mctx;
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.clearRect(0, 0, MAP_PX, MAP_PX);
  c.save();
  c.beginPath(); c.arc(R, R, R - 2, 0, Math.PI * 2); c.clip();
  c.fillStyle = 'rgba(14,22,18,0.88)'; c.fillRect(0, 0, MAP_PX, MAP_PX);
  const sh = Math.sin(S.h), ch = Math.cos(S.h);
  // 世界座標 -> 螢幕 (車頭朝上)
  c.setTransform(DPR * sh * s, DPR * -ch * s, DPR * -ch * s, DPR * -sh * s, DPR * R, DPR * R);
  c.lineCap = 'round'; c.lineJoin = 'round';
  const order = [];
  for (const [key] of tilesNear(S.x, S.y, rad + 2600)) {
    const rec = TILES.get(key);
    if (rec) for (const k of rec.ways) { const w = WAYS[k]; if (w.bb[2] > S.x - rad && w.bb[0] < S.x + rad && w.bb[3] > S.y - rad && w.bb[1] < S.y + rad) order.push(w); }
  }
  order.sort((a, b) => (!!b.city - !!a.city) || (a.link - b.link) || (a.bridge - b.bridge));
  for (const pass of [0, 1]) for (const w of order) {
    c.beginPath();
    for (let i = 0; i < w.n; i++) { const x = w.P[i * 3] - S.x, y = w.P[i * 3 + 1] - S.y; i ? c.lineTo(x, y) : c.moveTo(x, y); }
    if (pass === 0) { c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = Math.max(w.width, 3.2 / s) + 2 / s; }
    else { c.strokeStyle = (HOOKS.wayColor && HOOKS.wayColor(w)) || (w.city ? (w.cls === 5 ? '#454e55' : '#66717a') : w.trunk ? (w.link ? '#7d8a96' : '#aebccb') : w.link ? '#a7b0b8' : '#d9dee3'); const tc = HOOKS.wayColor && HOOKS.wayColor(w); c.lineWidth = tc ? Math.max(w.width, 5 / s) : Math.max(w.width, (w.city ? (w.cls === 5 ? 1 : 1.6) : w.link ? 2 : 3.2) / s); if (w.tunnel) c.setLineDash([6 / s, 4 / s]); }
    c.stroke(); c.setLineDash([]);
  }
  for (const f of HOOKS.minimap) f(c, s, rad);
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  // 車
  c.fillStyle = '#fff'; c.strokeStyle = '#e0302a'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(R, R - 9); c.lineTo(R + 6.5, R + 7); c.lineTo(R, R + 3.5); c.lineTo(R - 6.5, R + 7); c.closePath(); c.fill(); c.stroke();
  c.restore();
  // 外框與北方
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.beginPath(); c.arc(R, R, R - 2, 0, Math.PI * 2); c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = 3; c.stroke();
  const nxs = -ch, nys = -sh; // 北方在螢幕上的方向
  const px = R + nxs * (R - 13), py = R + nys * (R - 13);
  c.fillStyle = '#e0302a'; c.beginPath(); c.arc(px, py, 9, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff'; c.font = 'bold 12px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('N', px, py + 0.5);
  c.fillStyle = 'rgba(255,255,255,0.8)'; c.font = '11px sans-serif';
  c.fillText(rad >= 1000 ? (rad / 1000).toFixed(1) + ' km' : Math.round(rad) + ' m', R, MAP_PX - 14);
}

// ======================================================================= HUD
const hudSpeed = $('speed'), hudLimit = $('limit'), hudRoad = $('road'), hudMode = $('mode');
function roadLabel(w) {
  if (!w) return '';
  if (w.city) return w.name || ['', '', '主要道路', '次要道路', '一般道路', '巷道', '匝道'][w.cls] + (w.bridge ? '（橋）' : '');
  if (w.trunk) return (w.ref ? `台${w.ref.replace(/^台|線$/g, '')}線` : '快速道路') + (w.name ? ' · ' + w.name : '') + (w.link ? ' 匝道' : '') + (w.bridge ? '（高架）' : '');
  const ref = w.ref ? `國道${w.ref}${/甲$/.test(w.ref) ? '' : '號'}` : '';
  if (w.link) return `${w.name || '交流道'}${w.name && !/匝道|交流道/.test(w.name) ? ' 匝道' : ''}`;
  return [ref, w.name].filter(Boolean).join(' · ') + (w.bridge ? '（高架）' : '') + (w.tunnel ? '（隧道）' : '');
}
function updateHud() {
  hudSpeed.textContent = Math.round(Math.abs(S.v) * 3.6);
  const w = S.road && S.road.w;
  const lim = w ? speedLimit(w) : 100;
  hudLimit.textContent = lim;
  hudRoad.textContent = roadLabel(w);
  hudMode.textContent = (S.vt ? S.vt.name + ' · ' : '') + (camMode === 1 ? '第一人稱' : camMode === 2 ? '空拍' : '第三人稱') + (autopilot ? ' · 自動駕駛' : laneCenter ? (S.lcOn ? ' · 車道置中' : ' · 車道置中 (待命)') : '');
  if (S.vtype === 'scooter' && w && !w.city) hudRoad.textContent = '⚠ 機車禁止行駛國道 / 快速道路';
}

// ======================================================================= 主迴圈
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---- 給擴充模組 (features.js: 車流、電台、看板) 用的介面
const HOOKS = { init: [], update: [], frame: [], minimap: [], tile: [], key: [], wayColor: null, navBias: null };
window.TW = { T, scene, camera, renderer, NIGHT, GLOW_TEX, landcoverAt, WAYS, wayByGid, TILES, TS, tilesNear, PT_INDEX, ptKey, S, LANE_W, roadAt, terrainAt, nextWay, buildCar, HOOKS, params,
  laneCount, laneOffDir, leftPost, rightEdge, nextOptions, deadEndAhead, speedLimit, setVehicle, spawn, ORIGIN: INDEX.origin_twd97, MOBILE, WEATHER, keys, tileBuf, roadLabel, toast, toggleMenu,
  toggleManual, shift, toggleCruise, ensureArea, respawnNearest, SPAWNS: () => SPAWNS, sun,
  get camMode() { return camMode; }, get autopilot() { return autopilot; }, set autopilot(v) { autopilot = !!v; },
  get mapScale() { return MAP_SCALES[mapScaleIdx]; }, MAP_PX: 200 };

setStatus('載入地圖分區…');
setTimeout(async () => {
  HOOKS.frame.push(streamFrame, cullBuildings, orthoFrame);
  // 傳送地點 (tile_web.py 依 live.json 起點與 city_web.py SPOTS 產生，附座標)
  for (const [name, gid, idx, dir, x, y] of INDEX.spawns || []) SPAWNS.push({ name, gid, idx, dir, x, y });
  // 起點: 國1 南下 0K (基隆端)；網址 ?spawn=路段gid,點 或 ?at=x,y 可覆寫
  let sp0 = SPAWNS[0] || { x: 0, y: 0 };
  if (params.has('at')) { const [x, y] = params.get('at').split(',').map(Number); sp0 = { x, y }; }
  else if (params.has('spawn')) {   // ?spawn= 指定的路段可能離預設起點很遠 (沒載入就找不到): 是傳送地點的話先載入那裡
    const g = +params.get('spawn').split(',')[0], hit = SPAWNS.find((p) => p.gid === g);
    if (hit) sp0 = { x: hit.x, y: hit.y };
  }
  // 上次的位置 (關掉前存的)；網址有指定地點或在測試時不用
  let resume = null;
  if (!params.has('at') && !params.has('spawn') && !params.has('t') && !params.has('fresh')) {
    try { resume = JSON.parse(localStorage.getItem('tw_pos') || 'null'); } catch (_) { resume = null; }
    if (resume && !(Number.isFinite(resume.x) && Number.isFinite(resume.y) && Number.isFinite(resume.h))) resume = null;
    if (resume) sp0 = { x: resume.x, y: resume.y };
  }
  await ensureArea(sp0.x, sp0.y, resume ? '回到上次的位置…' : '載入地圖分區…');
  const want = params.has('spawn') ? params.get('spawn').split(',').map(Number) : (!resume && sp0.gid != null) ? [sp0.gid, sp0.idx, sp0.dir] : null;
  const w0 = want && wayByGid(want[0]);
  if (resume) {
    const r = roadAt(resume.x, resume.y, (resume.z || terrainAt(resume.x, resume.y)) + 2, 0, 4);
    if (r) {   // 接回上次那條路，方向照上次的車頭
      const tx = r.tx, ty = r.ty, dir = Math.cos(resume.h) * tx + Math.sin(resume.h) * ty >= 0 ? 1 : -1;
      spawn(r.w.k, r.i, dir);
      S.x = resume.x; S.y = resume.y; S.h = resume.h; S.road = roadAt(S.x, S.y, r.z + 1, 0, 2) || S.road; if (S.road) S.z = S.road.z;
    } else { S.x = resume.x; S.y = resume.y; S.z = terrainAt(resume.x, resume.y); respawnNearest(); }
    if (resume.vtype) try { setVehicle(resume.vtype); } catch (_) {}
  } else if (w0) spawn(w0.k, want[1], want[2] || 1, params.has('lane') ? +params.get('lane') : null);   // ?lane=: 測試用
  else if (params.has('at')) { S.x = sp0.x; S.y = sp0.y; S.z = terrainAt(sp0.x, sp0.y); respawnNearest(); }
  else defaultSpawn();
  if (params.has('vehicle')) setVehicle(params.get('vehicle'));
  // 每 3 秒、切走或關掉頁面時記住目前位置 (下次打開從這裡繼續；?fresh 從預設起點開始)
  const savePos = () => {
    if (!S.road || !Number.isFinite(S.x + S.y + S.h) || params.has('t')) return;
    try { localStorage.setItem('tw_pos', JSON.stringify({ x: +S.x.toFixed(2), y: +S.y.toFixed(2), z: +S.z.toFixed(2), h: +S.h.toFixed(4), vtype: S.vtype, ts: Date.now() })); } catch (_) {}
  };
  setInterval(savePos, 3000);
  window.addEventListener('pagehide', savePos);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePos(); });
  for (const f of HOOKS.init) f();
  if (params.has('clipscan')) await clipScan();
  if (params.has('t')) { // 測試用: 先跑幾秒
    const LCT = params.has('lctest');   // 車道置中測試: 手動只踩油門，每 20 秒打一下方向盤
    autopilot = !LCT; S.v = 25;
    let lcMax = 0, lcSum = 0, lcN = 0, lcOff = 0;
    const n = +params.get('t') * 30;
    for (let i = 0; i < n; i++) {
      if (i % 15 === 0) streamTick({ build: false });   // 內嵌分區: 同步載入資料 (不建模型)
      if (LCT) {
        const vT = S.road && S.road.w.city ? 11 : 24; if (i === 0) S.v = vT; keys.KeyW = S.v < vT; keys.KeyS = S.v > vT + 3; const pl = (i % 600) >= 300 && (i % 600) < 306; keys.KeyA = pl && (i % 1200) < 600; keys.KeyD = pl && (i % 1200) >= 600;
        const r = S.road;
        if (r && S.lcOn && S.lcLane != null && (i % 600) > 420) {
          const e = Math.abs(laneOffDir(r.w, S.lcLane, S.lcDir) - r.lat); lcMax = Math.max(lcMax, e); lcSum += e; lcN++;
        }
        if (!S.lcOn) lcOff++;
        if (params.has('lcdbg') && i % 30 === 0 && r) console.log('[lcd]', (i / 30).toFixed(0), 'k', r.w.k, r.w.link ? 'link' : '', 'lanes', laneCount(r.w), 'hw', r.w.hw.toFixed(1), 'lat', r.lat.toFixed(2), 'cd', (Math.cos(S.h) * r.tx + Math.sin(S.h) * r.ty).toFixed(3), 'sig', S.signal, 'v', S.v.toFixed(1), 'on', S.lcOn, 'ln', S.lcLane, 'str', S.steer.toFixed(3));
        if (i % 300 === 0) console.log('[lc]', (i / 30).toFixed(0) + 's', r ? (r.w.name || r.w.k) : '-', 'v', (S.v * 3.6).toFixed(0), 'on', S.lcOn, 'lane', S.lcLane, 'err', r && S.lcLane != null ? (laneOffDir(r.w, S.lcLane, S.lcDir || 1) - r.lat).toFixed(2) : '-');
      }
      update(1 / 30); for (const f of HOOKS.update) f(1 / 30);
      if (params.has('jamdbg') && i % 60 === 0 && window.TWX) {   // 測試用: 前方 300 m 同方向車的車速 (看塞車有沒有走走停停)
        const hx = Math.cos(S.h), hy = Math.sin(S.h), ahead = [];
        for (const c of TWX.cars) if (c.alive && c.pool === 'fwy' && Math.cos(c.h - S.h) > 0.8) { const f = (c.x - S.x) * hx + (c.y - S.y) * hy; if (f > 0 && f < 300) ahead.push([f, c.v * 3.6, c.brake]); }
        ahead.sort((a, b) => a[0] - b[0]);
        console.log('[jam]', (i / 30).toFixed(0) + 's', 'me', (S.v * 3.6).toFixed(0), 'n', ahead.length, 'brake', ahead.filter((a) => a[2]).length, ahead.slice(0, 14).map((a) => a[0].toFixed(0) + ':' + a[1].toFixed(0)).join(' '));
      }
      if (params.has('trace') && i % 150 === 0 && S.rt) console.log('[trace]', (i / 30).toFixed(0) + 's', S.rt.w.k, S.rt.w.ref, S.rt.w.name, S.rt.w.link ? 'link' : '', 'dir', S.rt.dir, 'i', S.rt.i, '/', S.rt.w.n, 'v', (S.v * 3.6).toFixed(0), 'pos', S.x.toFixed(0) + ',' + S.y.toFixed(0), 'road', S.road ? S.road.w.k : '-', 'unst', S.apUnstick || 0, 'thr', (S.thr || 0).toFixed(2), 'brk', (S.brk || 0).toFixed(2), 'apSt', (S.apStuck || 0).toFixed(1), 'lat', S.rt.lat != null ? S.rt.lat.toFixed(1) : '-', 'lc[', S.apDbg || '', ']', 'shift', S.apShift != null ? S.apShift.toFixed(2) : '-', 'pend', S.apPending, 'cool', (S.apCool || 0).toFixed(1),
        HOOKS.leader ? (() => { const l = HOOKS.leader(0); return l.gap < 1e8 ? `lead gap=${l.gap.toFixed(1)} ${l.why === 2 ? 'YIELD' : 'follow'} ${l.who ? l.who.type + '#' + l.who.id + ' v=' + (l.who.v * 3.6).toFixed(0) + ' stuck=' + (l.who.stuck || 0).toFixed(0) + ' dh=' + Math.round(((l.who.h - S.h) * 180 / Math.PI) % 360) : ''}` : 'lead -'; })() : '',
        window.TWX ? (() => { let b = null, bd = 1e9; for (const c of TWX.cars) if (c.alive) { const d = Math.hypot(c.x - S.x, c.y - S.y); if (d < bd) { bd = d; b = c; } }
          return b ? `| nearest AI ${b.type} d=${bd.toFixed(1)} v=${(b.v * 3.6).toFixed(0)} w=${b.w.k} s=${b.s.toFixed(0)}/${b.w.s[b.w.n - 1].toFixed(0)} dir=${b.dir} dead=${b.deadEnd} plan=${b.plan ? (b.plan.none ? 'none' : b.plan.o.k) : '-'} dh=${(((b.h - S.h) * 180 / Math.PI) % 360).toFixed(0)}` : ''; })() : '');
    }
    autopilot = params.has('demo') || params.has('keep');
    if (params.has('trace') && S.road) { const w = S.road.w; const ends = [0, w.n - 1].map(n => nextOptions(w, n).map(o => o.o.gid + '/' + o.dir + (o.o.city ? 'c' : '') + (o.o.oneway ? 'o' : ''))); console.log('[end]', 'unstick', S.apUnstick || 0, 'gapjump', S.apGapJumps || 0, 'apStuck', (S.apStuck || 0).toFixed(1), 'v', S.v.toFixed(2), 'gid', w.gid, 'n', w.n, 'city', !!w.city, 'oneway', !!w.oneway, 'i', S.road.i, 't', S.road.t.toFixed(2), 'lat', S.road.lat.toFixed(2), 'hw', w.hw, 'rt', S.rt ? S.rt.dir + ' ' + S.rt.i : '-', 'ends', JSON.stringify(ends), 'thr', S.thr, 'brk', S.brk, 'h', S.h.toFixed(2), 'tan', Math.atan2(S.road.ty, S.road.tx).toFixed(2)); }
    if (params.has('trace') && S.rt) { const o = S.rt.w, P = o.P; console.log('[end2] rt gid', o.gid, 'n', o.n, 'hw', o.hw, 'lanes', o.lanes, 'width', o.width, 'pts', JSON.stringify(Array.from(P).map(v => +v.toFixed(1))), 'car', S.x.toFixed(1), S.y.toFixed(1), S.z.toFixed(1), 'cur end', JSON.stringify(Array.from(S.road.w.P.slice(-6)).map(v => +v.toFixed(1))), 'cur width', S.road.w.width, 'lanes', S.road.w.lanes, 'la', JSON.stringify(lookAhead(10))); }
    if (LCT) { keys.KeyW = keys.KeyA = keys.KeyD = keys.KeyS = false; console.log('[lc] settled err max', lcMax.toFixed(2), 'mean', (lcSum / Math.max(lcN, 1)).toFixed(2), 'off frames', lcOff, '/', n); }
    console.log('[test] simulated', params.get('t'), 's; speed', (S.v * 3.6).toFixed(0), 'km/h; lane', S.apLane,
      '; player bumps', window.TWX ? TWX.stats.bumps : '-', '; AI overlaps', window.TWX ? TWX.overlaps() : '-',
      '; AI lane changes', window.TWX ? TWX.stats.laneChanges : '-', '; player lane changes', S.apChanges || 0,
      '; pos', S.x.toFixed(1), S.y.toFixed(1), S.z.toFixed(1), 'zVis', S.zVis, '; road', S.road ? (S.road.w.name || S.road.w.k) : null,
      '; lead', HOOKS.leader ? (() => { const l = HOOKS.leader(0); return l ? JSON.stringify({ gap: l.gap, v: l.v }) : '-'; })() : '-', '; city turns', window.TWX ? TWX.stats.turns : '-', '; nan', window.TWX ? TWX.stats.nan : '-', '; joints', window.TWX ? (TWX.stats.joints || 0) : '-');
  }
  if (params.has('t')) await ensureArea(S.x, S.y);
  syncCar(0); updateCamera(1); updateDayNight(0);
  $('loading').classList.add('hidden');
  let last = performance.now(), frame = 0;
  function loop(now) {
    const dt = Math.min((now - last) / 1000, params.has("realtime") ? 1.0 : 0.05); last = now;   // realtime: 背景展示用，依真實時間推進
    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < sub; i++) update(dt / sub);
    for (const f of HOOKS.update) f(dt);
    syncCar(dt); updateCamera(dt); updateDayNight(dt); WATER_T.value = now / 1000;
    for (const f of HOOKS.frame) f(dt);
    renderer.render(scene, camera);
    if ((frame++ & 1) === 0) drawMinimap();
    updateHud();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}, 30);
})();

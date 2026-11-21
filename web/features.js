/* 台灣 1:1 — 擴充: 即時路況、AI 車流、CMS 電子看板、ETC 門架、警廣電台、引擎音效
 * 資料來自 Smart-Nav-Map (api/freeway-speed.js、api/cms.js、etc_gantry_data.js、智行地圖.html 電台)
 */
(function () {
'use strict';
const TW = window.TW;
if (!TW) return;
const T = TW.T, WAYS = TW.WAYS, S = TW.S, LANE_W = TW.LANE_W;
const $ = (id) => document.getElementById(id);
const LIVE = JSON.parse($('extra-live').textContent);
const API = TW.params.get('api') || LIVE.apiBase;
// 即時資料來源 (依序嘗試): 本機伺服器 scripts/phone_location.py -> Smart-Nav-Map 後端 -> 打包時的快照
const LOCAL = (TW.params.get('gps') || 'http://127.0.0.1:8765').replace(/\/$/, '');
// 本機伺服器只在「遊戲本身就開在這台電腦」(localhost / 檔案) 或網址指定 ?gps= 時才連：
// GitHub 版在別人的手機、電腦上去連 127.0.0.1，瀏覽器會一直跳「網站想存取區域網路」的警告
const LOCAL_OK = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === 'file:' || TW.params.has('gps');
const SOURCES = LOCAL_OK ? [[LOCAL, '本機'], [API, '後端']] : [[API, '後端']];
async function fetchLive(path) {
  for (const [base, label] of SOURCES) {
    try {
      const j = await fetchJson(base + path, 6000);
      if (j && j.ok && j.data && Array.isArray(j.data.items)) return [j, label];
    } catch (e) { /* 換下一個來源 */ }
  }
  return [null, ''];
}
const rand = (a, b) => a + Math.random() * (b - a);

// ======================================================================= 即時路況
const ROADS = new Set(LIVE.sections.map((x) => x.road));
const WAYMAP = LIVE.wayMap;
let SECTIONS = LIVE.sections;
const fmtTime = (s) => { const m = /T(\d\d:\d\d)/.exec(s || ''); return m ? m[1] : ''; };
// 路況來源標示: 連上即時伺服器時顯示「即時 · N 秒前」(上游資料多舊)，連不上才顯示打包時的離線快照
let liveSrc = '', liveAt = 0, liveOkAt = 0;
function srcLabel() {
  const now = Date.now();
  if (liveSrc && now - liveOkAt < 5 * 60 * 1000) {
    const sec = Math.max(0, Math.round((now - liveAt) / 1000));
    return '即時 · ' + (sec < 90 ? sec + ' 秒前' : Math.round(sec / 60) + ' 分鐘前') + '（' + liveSrc + '）';
  }
  return '離線快照 ' + fmtTime(LIVE.updateTime);
}
const wayTraffic = [];   // 依 w.k；分區載入時補上
const LV_COLOR = ['#8a939b', '#2fbf5b', '#b9d63a', '#f2b632', '#f07c2a', '#e0302a'];
const LV_NAME = ['無資料', '順暢', '車多', '車多', '壅塞', '嚴重壅塞'];
const levelOf = (t) => {
  if (!t || t.speed < 0) return 0;
  if (t.level) return Math.min(5, Math.max(1, t.level));
  return t.speed >= 80 ? 1 : t.speed >= 60 ? 2 : t.speed >= 40 ? 3 : t.speed >= 20 ? 4 : 5;
};
let SEC_IDX = {};
function indexSections() {
  SEC_IDX = {};
  for (const x of SECTIONS) (SEC_IDX[x.road + '|' + x.dir] = SEC_IDX[x.road + '|' + x.dir] || []).push(x);
}
/** ks: 要重算的路段 (預設全部已載入的路段)。wayMap 以全域編號 gid 對應 */
function recomputeTraffic(ks) {
  for (const k of ks || WAYS.keys()) {
    wayTraffic[k] = null;
    const mp = WAYMAP[WAYS[k].gid];
    if (!mp) continue;
    const arr = SEC_IDX[mp[0] + '|' + mp[1]] || (mp[0].indexOf('汐止五股') >= 0 ? SEC_IDX['國道1號|' + mp[1]] : null);
    if (!arr) continue;
    let best = null, bd = 1e18;
    for (const x of arr) {
      const lo = Math.min(x.s, x.e), hi = Math.max(x.s, x.e);
      const d = mp[2] < lo ? lo - mp[2] : mp[2] > hi ? mp[2] - hi : 0;
      if (d < bd) { bd = d; best = x; }
    }
    if (best && bd < 1500) wayTraffic[k] = best;
    if (FAKE_LV && wayTraffic[k]) wayTraffic[k] = Object.assign({}, wayTraffic[k], { level: FAKE_LV, speed: [90, 90, 70, 50, 30, 12][FAKE_LV] });
  }
}
const FAKE_LV = +TW.params.get('fakelv') || 0;   // 測試: ?fakelv=5 把國道路況全部當成嚴重壅塞
indexSections();
TW.HOOKS.wayColor = (w) => {
  if (w.link) return null;
  const lv = levelOf(wayTraffic[w.k]);
  return lv ? LV_COLOR[lv] : null;
};
async function fetchJson(url, ms) {
  const c = new AbortController();
  const tm = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(tm); }
}
async function pollSpeed() {
  let wait = 30000;
  try {
    const [j, src] = await fetchLive('/freeway-speed');
    if (j && j.ok && j.data && Array.isArray(j.data.items)) {
      SECTIONS = j.data.items.filter((x) => ROADS.has(x.road));
      const age = Number.isFinite(j.data.ageMs) ? j.data.ageMs : Math.max(0, Date.now() - Date.parse(j.data.updateTime || ''));
      liveSrc = src; liveOkAt = Date.now(); liveAt = Date.now() - (Number.isFinite(age) ? age : 0);
      indexSections(); recomputeTraffic();
      for (const c of cars) if (c.alive) c.v0 = desiredSpeed(c);
      wait = Math.max(5000, Math.min(30000, (j.data.nextUpdateIn || 30000) + Math.random() * 1500));   // 國道路況時時更新: 最多 30 秒、至少 5 秒抓一次 (後端回 0 或負數時不要每秒狂抓)
    }
  } catch (e) { /* 連不到後端: 沿用快照 */ }
  setTimeout(pollSpeed, wait);
}

// ======================================================================= 共用: 合併幾何
function sliceGeo(g, start, count) {
  const out = new T.BufferGeometry();
  for (const [name, n] of [['position', 3], ['normal', 3], ['uv', 2]]) {
    const a = g.getAttribute(name);
    if (a) out.setAttribute(name, new T.Float32BufferAttribute(a.array.slice(start * n, (start + count) * n), n));
  }
  return out;
}
function mergeGeos(list) {
  let n = 0;
  for (const g of list) n += g.getAttribute('position').count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of list) {
    pos.set(g.getAttribute('position').array, o * 3);
    const na = g.getAttribute('normal'), ua = g.getAttribute('uv');
    if (na) nor.set(na.array, o * 3);
    if (ua) uv.set(ua.array, o * 2);
    o += g.getAttribute('position').count;
  }
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.BufferAttribute(pos, 3));
  out.setAttribute('normal', new T.BufferAttribute(nor, 3));
  out.setAttribute('uv', new T.BufferAttribute(uv, 2));   // LED 看板等貼圖需要
  out.computeBoundingSphere();
  return out;
}
/** 把 root 底下的 mesh 依材質合併 (座標相對 frame)。filter(o) 決定要不要收。 */
function bakeByMaterial(root, frame, filter) {
  root.updateMatrixWorld(true);
  const inv = new T.Matrix4().copy(frame.matrixWorld).invert();
  const byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh || (filter && !filter(o))) return;
    let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.applyMatrix4(new T.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const parts = (Array.isArray(o.material) && g.groups.length) ? g.groups.map((gr) => [mats[gr.materialIndex], sliceGeo(g, gr.start, gr.count)]) : [[mats[0], g]];
    for (const [m, pg] of parts) { if (!byMat.has(m)) byMat.set(m, []); byMat.get(m).push(pg); }
  });
  return [...byMat].map(([m, list]) => [m, mergeGeos(list)]);
}

// ======================================================================= AI 車流 (多車種、國道 + 一般道路)
const TV = window.TWV.TYPES;
const MAX_FWY = Math.max(0, Math.min(220, +(TW.params.get('cars') || (TW.MOBILE ? 50 : 140))));   // 塞車時要排得出一整排車
const MAX_CITY = Math.max(0, Math.min(200, +(TW.params.get('citycars') || (TW.MOBILE ? 28 : 75))));
const COLORS = [ // 線性色彩；權重
  [[0.80, 0.80, 0.78], 24], [[0.45, 0.46, 0.48], 18], [[0.012, 0.012, 0.014], 14], [[0.09, 0.095, 0.10], 10],
  [[0.50, 0.02, 0.02], 7], [[0.03, 0.08, 0.36], 7], [[0.04, 0.17, 0.07], 4], [[0.48, 0.40, 0.28], 5], [[0.65, 0.66, 0.70], 3],
];
const pickW = (list) => { let s = 0; for (const it of list) s += it[1]; let r = Math.random() * s; for (const it of list) if ((r -= it[1]) <= 0) return it[0]; return list[0][0]; };
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const BODY_TYPES = [[[1, 1, 1], 50], [[1.0, 1.16, 1.04], 30], [[0.88, 1.03, 0.99], 20]]; // 轎車 / 休旅 / 掀背
// 每種車可同時存在的數量 (InstancedMesh 容量)
const CAP = { sedan: 150, taxi: 30, police: 4, citybus: 12, coach: 14, minibus: 8, boxtruck: 22, bigtruck: 16, semi: 12, semiTrailer: 12, scooter: 45 };
// 出現比例
const MIX_FWY = [['sedan', 60], ['taxi', 4], ['police', 1], ['coach', 7], ['boxtruck', 10], ['bigtruck', 9], ['semi', 9]];
const MIX_CITY = [['sedan', 40], ['taxi', 12], ['scooter', 28], ['citybus', 6], ['minibus', 4], ['boxtruck', 6], ['police', 0.5]];
const PAINTS = { citybus: [[0.8, 0.8, 0.78]], coach: [[0.8, 0.8, 0.78], [0.04, 0.05, 0.09], [0.8, 0.8, 0.78]], minibus: [[0.8, 0.8, 0.78]],
  police: [[0.85, 0.85, 0.83]], taxi: [[0.8, 0.52, 0.02]] };
const ACCENTS = {
  citybus: [[0.6, 0.02, 0.02], [0.03, 0.25, 0.08], [0.02, 0.12, 0.45], [0.8, 0.45, 0.02]],
  coach: [[0.02, 0.12, 0.45], [0.6, 0.02, 0.02], [0.8, 0.35, 0.02], [0.03, 0.25, 0.08], [0.45, 0.02, 0.3]],
  minibus: [[0.03, 0.25, 0.08], [0.6, 0.05, 0.02]],
  boxtruck: [[0.75, 0.75, 0.73], [0.55, 0.56, 0.58], [0.8, 0.8, 0.78], [0.6, 0.45, 0.05]],
  bigtruck: [[0.03, 0.12, 0.35], [0.25, 0.28, 0.2], [0.6, 0.55, 0.4], [0.5, 0.05, 0.03]],
  semi: [[0.55, 0.1, 0.05], [0.05, 0.2, 0.45], [0.15, 0.35, 0.15], [0.7, 0.5, 0.1], [0.6, 0.6, 0.62], [0.05, 0.4, 0.45]],
  scooter: [[0.05, 0.06, 0.15], [0.4, 0.02, 0.02], [0.1, 0.1, 0.1], [0.45, 0.45, 0.42], [0.03, 0.2, 0.1], [0.5, 0.3, 0.02]],
};
const BIG = new Set(['citybus', 'coach', 'minibus', 'boxtruck', 'bigtruck', 'semi']);
const HEAVY = new Set(['bigtruck', 'semi']);   // 國道限行外側兩車道

const cars = [];
let INST = null;
function buildInstances() {
  INST = {};
  for (const [name, cap] of Object.entries(CAP)) {
    const r = window.TWV.build(name), ud = r.ud;
    const kindOf = new Map([[ud.paint, 'paint'], [ud.accent, 'accent'], [ud.tailMat, 'tail'], [ud.sigLMat, 'sigL'], [ud.sigRMat, 'sigR'], [ud.flashA, 'flashA'], [ud.flashB, 'flashB']]);
    const conv = (m) => {
      const k = kindOf.get(m);
      if (k === 'paint' || k === 'accent') { const c = m.clone(); c.color.setRGB(1, 1, 1); c.userData.kind = k; return c; }
      if (k) { const c = new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }); c.userData.kind = k; return c; }
      if (m === ud.headMat) return new T.MeshBasicMaterial({ color: new T.Color(1.6, 1.55, 1.4) });
      return m.clone();
    };
    // 輪子: 依形狀 (外框大小) 分組，每組烘一個輪子 (輪軸在原點)，車上每個同形狀的輪子共用
    const inWheel = new Set(), groups = new Map();
    r.group.updateMatrixWorld(true);
    for (const wh of ud.wheels || []) {
      wh.pivot.traverse((o) => { if (o.isMesh) inWheel.add(o); });
      const sz = new T.Box3().setFromObject(wh.spin).getSize(new T.Vector3());
      const key = [sz.x, sz.y, sz.z].map((v) => v.toFixed(2)).join(',');
      if (!groups.has(key)) groups.set(key, { spin: wh.spin, list: [] });
      groups.get(key).list.push({ pos: wh.pivot.position.clone(), r: wh.r || 0.35 });
    }
    const meshes = bakeByMaterial(r.group, r.group, (o) => !inWheel.has(o)).map(([m, g]) => {
      const im = new T.InstancedMesh(g, conv(m), cap);
      im.instanceMatrix.setUsage(T.DynamicDrawUsage);
      im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true; im.count = 0;
      if (im.material.userData.kind) for (let i = 0; i < cap; i++) im.setColorAt(i, new T.Color(1, 1, 1));
      TW.scene.add(im);
      return im;
    });
    const wheels = [];
    for (const gr of groups.values()) {
      const wcap = cap * gr.list.length;
      const wm = bakeByMaterial(gr.spin, gr.spin).map(([m, g]) => {
        const im = new T.InstancedMesh(g, m.clone(), wcap);
        im.instanceMatrix.setUsage(T.DynamicDrawUsage);
        im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true; im.count = 0;
        TW.scene.add(im);
        return im;
      });
      wheels.push({ meshes: wm, list: gr.list, n: 0, cap: wcap });
    }
    INST[name] = { meshes, n: 0, cap, wheels };
  }
}

function seek(w, s) {
  let lo = 0, hi = w.n - 1;
  if (s <= 0) return 0;
  if (s >= w.s[hi]) return hi - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (w.s[m] <= s) lo = m; else hi = m; }
  return lo;
}
const POSE = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
function poseAt(w, s, lat, out = POSE) {
  const i = seek(w, s), P = w.P;
  const L = (w.s[i + 1] - w.s[i]) || 1, t = Math.min(Math.max((s - w.s[i]) / L, 0), 1);
  const nx = w.nx[i] + (w.nx[i + 1] - w.nx[i]) * t, ny = w.ny[i] + (w.ny[i + 1] - w.ny[i]) * t, nl = Math.hypot(nx, ny) || 1;
  out.x = P[i * 3] + (P[i * 3 + 3] - P[i * 3]) * t + nx / nl * lat;
  out.y = P[i * 3 + 1] + (P[i * 3 + 4] - P[i * 3 + 1]) * t + ny / nl * lat;
  out.z = P[i * 3 + 2] + (P[i * 3 + 5] - P[i * 3 + 2]) * t;
  out.tx = ny / nl; out.ty = -nx / nl;
  return out;
}
const wayLen = (w) => w.s[w.n - 1];
/** 車道中心 (相對路線左法向)；機車靠行進方向右側路邊 */
function laneLatC(c, lane) {
  if (c.type === 'scooter' && c.w.city) {
    const e = c.w.oneway ? c.w.width / 2 - 1.0 : c.w.width / 2 - 1.05;
    return c.w.oneway ? -e : (c.dir > 0 ? -e : e);
  }
  return TW.laneOffDir(c.w, lane, c.dir);
}
const laneOK = (c, lane) => lane >= 0 && lane < TW.laneCount(c.w) && !(HEAVY.has(c.type) && !c.w.city && lane < TW.laneCount(c.w) - 2);
const distToEnd = (c) => c.dir > 0 ? wayLen(c.w) - c.s : c.s;

let simT = 0;   // 車流時間 (走走停停波用)
function desiredSpeed(c) {
  const w = c.w;
  let lim = TW.speedLimit(w) / 3.6, wave = 1, floor = 2;
  if (!w.city) {
    const t = wayTraffic[w.k], lv = levelOf(t);
    if (t && t.speed > 0) lim = lv <= 1 ? Math.max(t.speed, TW.speedLimit(w)) / 3.6 : t.speed / 3.6;   // 順暢路段照限速開 (旅行速度是平均值，偏低)
    if (lv >= 3) {
      // 塞車不是整排等速前進，是一波一波走走停停: 波長約 350 m、以約 15 km/h 往後 (上游) 傳。
      // 前面的車先慢下來、煞車燈一路往後亮；起伏的平均值大約還是即時旅行速度
      const amp = lv >= 5 ? 0.95 : lv === 4 ? 0.8 : 0.5;
      const ph = (c.s * c.dir + (w.gid % 97) * 37) / 350 + simT * 4.2 / 350;
      wave = Math.max(0.05, 1 + amp * Math.sin(ph * 2 * Math.PI));
      if (lv >= 4) floor = 1;   // 嚴重壅塞可以慢到快停 (卡死偵測是 0.3 m/s 以下，不會被當成卡住回收)
    }
  }
  let v = Math.min(lim * c.pers * c.mood * wave, c.T.vmax * (HEAVY.has(c.type) ? 0.92 : 1));
  if (c.plan && c.plan.vturn < 50) {   // 路口轉彎前減速
    const d = Math.max(0, distToEnd(c) - 4);
    v = Math.min(v, Math.sqrt(c.plan.vturn * c.plan.vturn + 2 * 1.6 * d));
  }
  return Math.max(floor, v);
}
function densityWeight(w) {
  if (w.city) return w.cls === 5 ? 0.5 : (w.cls === 2 ? 3 : w.cls === 3 ? 2.4 : 1.6);
  return FWY_DENS[levelOf(wayTraffic[w.k])];
}
// 國道車流密度跟著即時路況: 順暢 1、車多 3~5、壅塞 7~9 倍 (大約是真實每車道每公里車數的比例)
const FWY_DENS = [1, 1, 4, 6, 8, 10];
// 車子總數固定，所以玩家所在路段越塞，就把國道車集中在越小的範圍 (車距變短)，塞車時眼前真的是一排車
const FWY_R = [[750, 1500, 1800], [750, 1500, 1800], [330, 780, 930], [210, 520, 640], [140, 360, 450], [110, 280, 360]];
// 車多 / 壅塞時，大部分的車直接生在玩家這條路的同方向 (前後都有)，眼前才會是一整排車
const FOCUS = [0, 0, 0.45, 0.65, 0.8, 0.88];
let fwyLv = 1, seedLv = 0, lvCand = 1, lvCandT = 0, lowT = 0, lowWas = 1e9;
const seedPos = [0, 0];
function playerFwyLevel() {
  const r = S.road;
  if (!r || r.w.city) return 1;
  return Math.max(1, levelOf(wayTraffic[r.w.k]));
}

/** 下一段路: 國道走主線；一般道路在路口隨機轉彎 (直行機率較高)，不會迴轉 */
function choosePlan(c) {
  const w = c.w, node = c.dir > 0 ? w.n - 1 : 0;
  const hx = c.dir > 0 ? w.ny[node] : -w.ny[node], hy = c.dir > 0 ? -w.nx[node] : w.nx[node];
  const opts = TW.nextOptions(w, node).filter((o) => (c.pool === 'city') === !!o.o.city && !(c.pool === 'city' && BIG.has(c.type) && o.o.cls === 5));
  let best = null;
  if (c.pool === 'fwy') {
    let bs = -1e9;
    for (const o of opts) {
      const dot = hx * o.hx + hy * o.hy;
      if (dot < 0.5) continue;
      const sc = dot + (o.o.ref === w.ref && o.o.ref ? 2 : 0) + (o.o.link ? -3 : 0) + (w.link && !o.o.link ? 3 : 0);
      if (sc > bs) { bs = sc; best = o; }
    }
  } else {
    const cand = [];
    for (const o of opts) {
      const dot = hx * o.hx + hy * o.hy;
      if (dot < -0.2) continue;
      cand.push([o, (dot > 0.9 ? 3 : 1) * (o.o.cls === 5 ? 0.35 : o.o.cls <= 3 ? 1.6 : 1) * (TW.deadEndAhead(o) ? 0.03 : 1)]);   // 盡頭沒路接的少走
    }
    if (cand.length) best = pickW(cand);
    else {   // 只剩急轉 (單行道尾端接 V 字路口): 挑最順的那條，總比停在路尾擋路好
      let bd = -1e9;
      for (const o of opts) { const dot = hx * o.hx + hy * o.hy; if (dot > bd) { bd = dot; best = o; } }
    }
  }
  if (!best) return null;
  const dot = hx * best.hx + hy * best.hy, cross = hx * best.hy - hy * best.hx;
  return { ...best, vturn: dot > 0.94 ? 99 : dot > 0.5 ? 9 : 6, turn: dot > 0.94 ? 0 : (cross > 0 ? -1 : 1) };
}

// 生成點 (每個分區一組，分區載入時建立)
const SAMPLES = new Map();   // 分區 key -> { fwy: [[k, s, x, y]], city: [...] }
function addSamples(rec) {
  const e = { fwy: [], city: [] };
  for (const k of rec.ways) {
    const w = WAYS[k];
    if (w.n < 2 || wayLen(w) < 20) continue;
    if (w.city) { if (w.cls <= 5) for (let s = 8; s < wayLen(w) - 5; s += w.cls === 5 ? 60 : 30) { poseAt(w, s, 0); e.city.push([w.k, s, POSE.x, POSE.y]); } }
    else if (!w.link) for (let s = 10; s < wayLen(w) - 5; s += 40) { poseAt(w, s, 0); e.fwy.push([w.k, s, POSE.x, POSE.y]); }
  }
  SAMPLES.set(rec.key, e);
}
const typeCount = {};
let nextId = 1;

function trySpawn(c, pool, minR, maxR) {
  const cand = [];
  for (const [key] of TW.tilesNear(S.x, S.y, maxR + 2600)) {   // 路段依中點歸屬分區，最長約 5 km
    const e = SAMPLES.get(key);
    if (!e) continue;
    for (const sm of (pool === 'city' ? e.city : e.fwy)) {
      const d2 = (sm[2] - S.x) ** 2 + (sm[3] - S.y) ** 2;
      if (d2 > minR * minR && d2 < maxR * maxR) cand.push(sm);
    }
  }
  if (!cand.length) return false;
  let pickFrom = cand, focused = false;
  if (pool === 'fwy' && S.road && !S.road.w.city && Math.random() < FOCUS[fwyLv]) {
    // 玩家這條路、同方向 (同一條國道、行進方向一致、高度接近)
    const pw = S.road.w, hx = Math.cos(S.h), hy = Math.sin(S.h);
    const mine = cand.filter((sm) => {
      const w = WAYS[sm[0]];
      if (w.link || (w !== pw && (w.ref || '') !== (pw.ref || ''))) return false;
      const i = Math.min(seek(w, sm[1]), w.n - 2);
      return w.ny[i] * hx - w.nx[i] * hy > 0.8 && Math.abs(w.P[i * 3 + 2] - S.z) < 8;
    });
    if (mine.length) { pickFrom = mine; focused = true; }
  }
  if (pool === 'fwy' && fwyLv >= 3) {
    const hx = Math.cos(S.h), hy = Math.sin(S.h), far = Math.max(150, maxR * 0.55);
    const hidden = pickFrom.filter((sm) => { const f = (sm[2] - S.x) * hx + (sm[3] - S.y) * hy; return f < -30 || f > far; });
    if (hidden.length >= 12) pickFrom = hidden;   // 候選太少就不限制 (車數補滿優先，不然塞車反而車變少)
  }
  for (let attempt = 0; attempt < 16; attempt++) {
    const sm = pickFrom[(Math.random() * pickFrom.length) | 0];
    const w = WAYS[sm[0]];
    if (!focused && Math.random() > densityWeight(w) / (w.city ? 4.5 : 10)) continue;
    let type = pickW(pool === 'city' ? MIX_CITY : MIX_FWY);
    if ((typeCount[type] || 0) >= CAP[type] || (type === 'semi' && (typeCount.semiTrailer || 0) >= CAP.semiTrailer)) type = 'sedan';
    if ((typeCount[type] || 0) >= CAP[type]) return false;
    if (BIG.has(type) && w.city && w.cls === 5) type = 'sedan';
    const dir = (w.city && !w.oneway && Math.random() < 0.5) ? -1 : 1;
    const tc = { w, dir, type };
    const lc = TW.laneCount(w);
    let lane = (Math.random() * lc) | 0;
    if (HEAVY.has(type) && !w.city) lane = Math.max(lane, lc - 2, 0);
    const lat = laneLatC(tc, lane);
    const s0 = pool === 'fwy' ? Math.min(wayLen(w) - 3, Math.max(3, sm[1] + (Math.random() - 0.5) * 40)) : sm[1];   // 取樣點 40 m 一個，前後錯開才排得密
    poseAt(w, s0, lat);
    let ok = Math.hypot(POSE.x - S.x, POSE.y - S.y) > Math.min(minR, 40);
    const gapNeed = pool === 'city' ? 14 : [28, 28, 24, 18, 13, 8][levelOf(wayTraffic[w.k])];   // 塞車時車距短 (含車長)；約等於該車速下的跟車距離，生出來才不會全部急煞
    for (const o of cars) if (ok && o.alive && o !== c && (o.x - POSE.x) ** 2 + (o.y - POSE.y) ** 2 < gapNeed * gapNeed && Math.abs(o.z - POSE.z) < 3) ok = false;
    if (!ok) continue;
    const TT = TV[type];
    const scale = type === 'sedan' ? pickW(BODY_TYPES) : [1, 1, 1];
    Object.assign(c, {
      id: nextId++, alive: true, pool, type, T: TT, w, s: s0, dir, lane, lat, prevLat: lat, pers: pool === 'fwy' ? rand(0.95, 1.15) : rand(0.88, 1.1), mood: 1, moodT: 1, moodTimer: rand(10, 40),
      color: pick(PAINTS[type] || COLORS.map((x) => x[0])), accent: pick(ACCENTS[type] || [[0.6, 0.6, 0.6]]),
      sx: scale[0], sy: scale[1], sz: scale[2], front: TT.front * scale[0], rear: TT.rear * scale[0], wid: TT.wid * scale[2],
      th: rand(0.8, 1.35), gapMin: rand(0.75, 1.4),   // 個人跟車習慣: 時間車距、停車間距倍數 (塞車時車距才不會整齊劃一)
      lcCool: rand(2, 8), vlat: 0, brake: false, deadEnd: false, pending: null, signal: 0, sigT: 0, plan: null, roll: 0, trail: [],
      x: POSE.x, y: POSE.y, z: POSE.z, h: Math.atan2(POSE.ty, POSE.tx) + (dir < 0 ? Math.PI : 0), pitch: 0,
    });
    if (TT.trailer) for (let k = 0; k <= 30; k++) c.trail.push([POSE.x - Math.cos(c.h) * k * 0.5, POSE.y - Math.sin(c.h) * k * 0.5, POSE.z]);
    typeCount[type] = (typeCount[type] || 0) + 1;
    if (TT.trailer) typeCount.semiTrailer = (typeCount.semiTrailer || 0) + 1;
    c.v0 = desiredSpeed(c); c.v = c.v0 * rand(0.7, 1);
    return true;
  }
  return false;
}
function kill(c) {
  if (!c.alive) return;
  c.alive = false;
  typeCount[c.type]--;
  if (c.T.trailer) typeCount.semiTrailer--;
}

function initTraffic() {
  buildInstances();
  fwyLv = playerFwyLevel();
  for (let i = 0; i < MAX_FWY; i++) { const c = { alive: false, pool: 'fwy' }; cars.push(c); trySpawn(c, 'fwy', 60, FWY_R[fwyLv][1]); }
  for (let i = 0; i < MAX_CITY; i++) { const c = { alive: false, pool: 'city' }; cars.push(c); trySpawn(c, 'city', 40, 550); }
}

// 玩家也算一台車 (給 AI 跟車、換道、路口讓車判斷用)
const PLAYER = { isPlayer: true, id: 0 };
function syncPlayer() {
  const vt = S.vt || TV.sedan;
  PLAYER.x = S.x; PLAYER.y = S.y; PLAYER.z = S.z; PLAYER.h = S.h; PLAYER.v = S.v;
  PLAYER.front = vt.front; PLAYER.rear = vt.rear; PLAYER.wid = vt.wid;
  PLAYER.changing = !!S.signal; PLAYER.w = S.road && S.road.w;
  return PLAYER;
}
const isChanging = (o) => o.isPlayer ? o.changing : (o.pending != null || Math.abs(o.lat - laneLatC(o, o.lane)) > 0.3);
// 空間格子 (80 m 一格): 找前車、換道檢查只看附近 5×5 格 (半徑 ≥160 m，比 leaderFor 看的範圍大)。
// 以前每台車都要把全部 ~215 台掃一遍 (O(n²))，國道塞車時一次更新 5 ms 以上，畫面一慢又變成每幀兩次 → 越來越卡
const GRID_C = 80, GRID = new Map();
const gkey = (x, y) => (Math.floor(x / GRID_C) + 4096) * 8192 + (Math.floor(y / GRID_C) + 4096);
function buildGrid() {
  for (const a of GRID.values()) a.length = 0;
  for (const c of cars) if (c.alive) { const k = gkey(c.x, c.y); let a = GRID.get(k); if (!a) GRID.set(k, a = []); a.push(c); }
}
function eachOther(me, fn) {
  const cx = Math.floor(me.x / GRID_C) + 4096, cy = Math.floor(me.y / GRID_C) + 4096;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const a = GRID.get((cx + i) * 8192 + cy + j);
    if (a) for (let n = 0; n < a.length; n++) { const o = a[n]; if (o !== me && o.alive) fn(o); }
  }
  if (me !== PLAYER) fn(syncPlayer());
}
/** 前車: shift = 目標車道相對目前位置的橫向位移 (行進方向左正)；一般道路另外檢查路口橫向來車 */
const onRing = (w) => !!(w && w.city && w.name && w.name.includes('圓環'));   // 圓環 (路名有「圓環」的一般道路)
function leaderFor(me, shift) {
  const fx = Math.cos(me.h), fy = Math.sin(me.h);
  const lo = Math.min(0, shift), hi = Math.max(0, shift);
  const inCity = me.w && me.w.city;
  let gap = 1e9, vl = 40, who = null, why = 0;   // who / why: 測試追蹤用 (誰擋住、1 跟車 2 路口讓車)
  eachOther(me, (o) => {
    if (Math.abs(o.z - me.z) > 3) return;
    const dx = o.x - me.x, dy = o.y - me.y;
    if (dx * dx + dy * dy > 40000) return;
    // 提早排除 (兩個分支都只看前方 0~160 m、橫向 12 m 內): 後面的車、太遠、隔好幾個車道的不用再算角度
    const d = dx * fx + dy * fy; if (d <= 0 || d > 160) return;
    const lat = -dx * fy + dy * fx; if (lat < lo - 12 || lat > hi + 12) return;
    const cs = Math.cos(o.h - me.h);
    const oCity = o.isPlayer ? !!(o.w && o.w.city) : o.pool === 'city', meCity = me.isPlayer ? !!(me.w && me.w.city) : me.pool === 'city';
    if (oCity !== meCity && Math.abs(cs) < 0.7) return;   // 不同路網的交叉 (上下穿越) 互不影響
    // 卡住太久 (互相禮讓的死結): 不再讓斜向/橫向也卡住的車，平行同車道的前車照樣跟
    const meStuck = (me.stuck || 0) > 6, oStuck = !o.isPlayer && ((o.stuck || 0) > 6 || o.v < 0.3);   // AI 永遠讓玩家
    if (cs >= 0.3) {
      if (d <= 0 || d > 160) return;
      if (meStuck && oStuck && cs < 0.9 && (o.id < me.id || (me.stuck || 0) > 12)) return;
      // 前車斜著 (正在轉彎、換路段) 時車身橫向佔得比較寬: 用轉過的車身寬度算，不然後車看不到、直接追撞 (基隆義一路→中正路)
      const sn = Math.sqrt(Math.max(0, 1 - cs * cs));
      const hw = (me.wid + o.wid * cs + (o.front + o.rear) * sn) / 2 + 0.05;
      if (lat < lo - hw || lat > hi + hw) return;
      const g = d - me.front - o.rear;
      if (g < gap) { gap = g; vl = Math.max(0, o.v * cs); who = o; why = 1; }
    } else if (inCity && Math.abs(cs) < 0.75 && d > 1 && d < 22 && Math.abs(lat) < 7) {
      // 路口: 橫向來車在前方，對方在動 (或編號較小) 就讓
      if (meStuck && oStuck) return;
      // 圓環: 環道內的車先行，不讓還沒進圓環的車 (以前環道裡的車一直讓路口進來的車，整個圓環塞死，例如台北東門圓環)
      if (onRing(me.w) && !onRing(o.w)) return;
      // 玩家沒有編號 (o.id undefined 比大小永遠 false): 以前玩家停在路口時 AI 不讓、直接撞上來。AI 一律讓玩家
      if (o.isPlayer || o.v > 1.5 || o.id < me.id) { const g = d - me.front - 2; if (g < gap) { gap = g; vl = 0; who = o; why = 2; } }
    }
  });
  return { gap, v: vl, who, why };
}
/** 目標車道安全嗎: 前後留距離；附近有車要切進同一車道也先不切 */
function laneSafeFor(me, shift) {
  const fx = Math.cos(me.h), fy = Math.sin(me.h);
  let safe = true;
  eachOther(me, (o) => {
    if (!safe || Math.abs(o.z - me.z) > 3) return;
    const dx = o.x - me.x, dy = o.y - me.y, d = dx * fx + dy * fy; if (d > 90 || d < -110) return;   // 前後太遠的不影響換道
    if (Math.cos(o.h - me.h) < 0.3) return;
    const lat = -dx * fy + dy * fx;
    const hw = (me.wid + o.wid) / 2 + 0.25;
    if (Math.abs(lat - shift) < hw && d > -(o.front + me.rear + 8 + Math.max(0, o.v - me.v) * 2.8) && d < me.front + o.rear + 10 + Math.max(0, me.v - o.v) * 2.2) { safe = false; return; }
    if (Math.abs(d) >= 34 || !isChanging(o)) return;
    if (o.isPlayer) { if (Math.abs(lat - shift) < 5.8) safe = false; return; }
    const tl = o.dir * (laneLatC(o, o.pending != null ? o.pending : o.lane) - o.lat);
    if (Math.abs(lat + tl - shift) < hw + 0.2) safe = false;
  });
  return safe;
}
TW.HOOKS.leader = (shift) => leaderFor(syncPlayer(), shift);
TW.HOOKS.laneFree = (shift) => laneSafeFor(syncPlayer(), shift);

const stats = { bumps: 0, laneChanges: 0, turns: 0, nan: 0 };
function stepCar(c, dt) {
  const w = c.w, lc = TW.laneCount(w);
  if (c.lane >= lc) c.lane = lc - 1;
  const shift = c.dir * (laneLatC(c, c.lane) - c.lat);
  const ld = leaderFor(c, c.pending != null ? c.dir * (laneLatC(c, c.pending) - c.lat) : shift);
  const gap = ld.gap, vl = ld.gap < 1e8 ? ld.v : c.v0;
  // 個性: 偶爾想快一點或慢一點
  c.moodTimer -= dt;
  if (c.moodTimer <= 0) { c.moodT = rand(0.88, 1.12); c.moodTimer = rand(15, 50); }
  c.mood += (c.moodT - c.mood) * Math.min(1, dt * 0.3);
  if (!c.plan && distToEnd(c) < 55) c.plan = choosePlan(c) || { none: true, vturn: 3 };
  c.v0 = desiredSpeed(c);
  // IDM 跟車
  const A = c.T.acc, Bd = BIG.has(c.type) ? 1.8 : 2.3, S0 = (c.type === 'scooter' ? 1.2 : 2.5) * (c.gapMin || 1), TH = (BIG.has(c.type) ? 1.6 : 1.3) * (c.th || 1);
  let a = A * (1 - Math.pow(c.v / c.v0, 4));
  if (gap < 1e8) {
    const ss = S0 + Math.max(0, c.v * TH + c.v * (c.v - vl) / (2 * Math.sqrt(A * Bd)));
    a -= A * (ss / Math.max(gap, 0.1)) ** 2;
  }
  a = Math.max(-9, Math.min(A, a));
  c.v = Math.max(0, c.v + a * dt);
  c.odo = (c.odo || 0) + c.v * dt;   // 里程 (輪子轉動用)
  if (gap < 0.6) c.v = Math.min(c.v, vl * 0.9);
  c.stuck = c.v < 0.3 ? (c.stuck || 0) + dt : 0;
  let ds = c.v * dt;
  if (gap < 1e8) ds = Math.min(ds, Math.max(0, gap - 0.4));
  c.brake = a < -0.9 || (c.v < 0.8 && gap < 25);
  // 換車道: 先打方向燈 1.2 秒，再確認一次安全才切
  c.lcCool -= dt;
  if (c.pending != null) {
    c.sigT -= dt;
    if (c.sigT <= 0) {
      if (laneOK(c, c.pending) && laneSafeFor(c, c.dir * (laneLatC(c, c.pending) - c.lat))) { c.lane = c.pending; stats.laneChanges++; }
      else c.signal = 0;
      c.pending = null;
    }
  } else if (c.lcCool <= 0 && Math.abs(shift) < 0.3 && lc > 1 && !w.link && !w.tunnel && c.type !== 'scooter' && distToEnd(c) > 40) {   // 隧道內雙白實線: 不換車道
    const blocked = gap < 50 && vl < c.v0 - 2.5;
    const keepRight = BIG.has(c.type) ? 0.25 : 0.08;
    const tries = blocked ? [c.lane - 1, c.lane + 1] : (gap > 90 && Math.random() < dt * keepRight ? [c.lane + 1] : []);
    for (const ln of tries) {
      if (!laneOK(c, ln)) continue;
      if (laneSafeFor(c, c.dir * (laneLatC(c, ln) - c.lat))) { c.pending = ln; c.sigT = 1.2; c.signal = ln < c.lane ? -1 : 1; c.lcCool = rand(6, 14); break; }
    }
    if (tries.length && c.lcCool <= 0) c.lcCool = 1.5;
  }
  // 路口轉彎打方向燈
  if (c.pending == null && c.plan && c.plan.turn && distToEnd(c) < 35) c.signal = c.plan.turn;
  else if (c.pending == null && c.signal && Math.abs(laneLatC(c, c.lane) - c.lat) < 0.3 && !(c.plan && c.plan.turn)) c.signal = 0;
  // 前進 (跨路段 / 路口)
  c.s += c.dir * ds;
  let guard = 0;
  while ((c.dir > 0 ? c.s > wayLen(c.w) : c.s < 0) && guard++ < 8) {
    const over = c.dir > 0 ? c.s - wayLen(c.w) : -c.s;
    const plan = c.plan && !c.plan.none ? c.plan : choosePlan(c);
    if (!plan) {
      if (c.w.city && !c.w.oneway) { c.dir = -c.dir; c.s = c.dir > 0 ? over : wayLen(c.w) - over; c.plan = null; c.signal = 0; break; }   // 死巷迴轉
      c.s = c.dir > 0 ? wayLen(c.w) : 0; c.v = 0; c.deadEnd = true; break;
    }
    const wasLink = c.w.link;
    // 匝道端點和主線不在同一點 (匝道車道貼在主線外側): 換路段時保留車子實際位置，再平滑移進新路段的車道，像真的切車道
    const ow = c.w, oi = c.dir > 0 ? ow.n - 1 : 0, ni = plan.i;
    const jump = !ow.city && !plan.o.city && Math.hypot(ow.P[oi * 3] - plan.o.P[ni * 3], ow.P[oi * 3 + 1] - plan.o.P[ni * 3 + 1]) > 0.5;
    if (jump) poseAt(ow, c.dir > 0 ? wayLen(ow) : 0, c.lat);
    c.w = plan.o; c.dir = plan.dir;
    c.s = plan.o.s[plan.i] + c.dir * over;
    if (jump) {
      const nl2 = (POSE.x - plan.o.P[ni * 3]) * plan.o.nx[ni] + (POSE.y - plan.o.P[ni * 3 + 1]) * plan.o.ny[ni];
      if (Math.abs(nl2) < 20) { c.lat = nl2; c.prevLat = c.lat; }   // poseAt 的橫向是路段點序的左法向，和行進方向無關
    }
    const nl = TW.laneCount(c.w);
    if (c.lane >= nl) c.lane = nl - 1;
    if (wasLink && !c.w.link) c.lane = nl - 1;
    if (plan.turn) { stats.turns++; c.lane = plan.turn > 0 ? nl - 1 : 0; }
    if (HEAVY.has(c.type) && !c.w.city) c.lane = Math.max(c.lane, nl - 2, 0);
    c.plan = null; c.signal = 0; c.pending = null;
  }
  // 橫向 (平滑換道 / 轉彎後回到車道)
  // 二階阻尼彈簧 + 橫向加速度上限: 換車道是平順的 S 形 (慢慢切出去、慢慢擺正)，車頭角度跟著橫向速度連續變化，不會甩一下
  const tgt = laneLatC(c, c.lane);
  c.prevLat = c.lat;
  const vmax = c.type === 'scooter' ? 1.0 : 1.2;
  const om = c.pool === 'city' ? 1.45 : 1.1, aMax = c.pool === 'city' ? 1.3 : 0.8;
  const err = tgt - c.lat;
  let acc = om * om * err - 2 * om * (c.vlat || 0);
  acc = Math.max(-aMax, Math.min(aMax, acc));
  c.vlat = Math.max(-vmax, Math.min(vmax, (c.vlat || 0) + acc * dt));
  c.lat += c.vlat * dt;
  if (Math.abs(err) < 0.01 && Math.abs(c.vlat) < 0.03) { c.lat = tgt; c.vlat = 0; }
  poseAt(c.w, c.s, c.lat);
  c.x = POSE.x; c.y = POSE.y; c.z = POSE.z;
  const latVel = c.vlat;
  const h0 = c.h;
  c.h = Math.atan2(POSE.ty, POSE.tx) + (c.dir < 0 ? Math.PI : 0) + Math.atan2(c.dir * latVel, Math.max(c.v, 4));
  const z1 = poseAt(c.w, c.s + c.dir * 1.4, c.lat, {}).z, z0 = poseAt(c.w, c.s - c.dir * 1.4, c.lat, {}).z;
  c.pitch = Math.atan2(z1 - z0, 2.8);
  if (c.T.lean) {   // 機車轉彎壓車
    const yr = Math.atan2(Math.sin(c.h - h0), Math.cos(c.h - h0)) / Math.max(dt, 1e-3);
    const tgtRoll = Math.max(-0.5, Math.min(0.5, Math.atan(c.v * yr / 9.81)));
    c.roll += (tgtRoll - c.roll) * Math.min(1, dt * 4);
  }
  if (c.T.trailer) {   // 聯結車拖車沿著曳引車走過的軌跡
    const tr = c.trail, last = tr[0];
    if (!last || (last[0] - c.x) ** 2 + (last[1] - c.y) ** 2 > 0.25) { tr.unshift([c.x, c.y, c.z]); if (tr.length > 60) tr.pop(); }
  }
}
/** 沿軌跡往回 dist 公尺的點 */
function trailPoint(tr, x, y, dist) {
  let px = x, py = y, pz = tr.length ? tr[0][2] : 0;
  for (const p of tr) {
    const d = Math.hypot(p[0] - px, p[1] - py);
    if (d >= dist) { const t = dist / (d || 1); return [px + (p[0] - px) * t, py + (p[1] - py) * t, pz + (p[2] - pz) * t]; }
    dist -= d; px = p[0]; py = p[1]; pz = p[2];
  }
  return [px, py, pz];
}

let bumpCooldown = 0;
let touchClock = 0;
function collidePlayer(dt) {
  bumpCooldown -= dt; touchClock += dt;
  const pl = syncPlayer();
  const fx = Math.cos(S.h), fy = Math.sin(S.h);
  const pOff = (pl.front - pl.rear) / 2, pHalf = (pl.front + pl.rear) / 2;
  const pcx = S.x + fx * pOff, pcy = S.y + fy * pOff;
  for (const c of cars) {
    if (!c.alive || Math.abs(c.z - S.z) > 2) continue;
    // 國道車與市區車垂直交會 (不同路網的立體交叉) 不算碰撞
    if (S.road && (c.pool === 'city') !== !!S.road.w.city && Math.abs(Math.cos(c.h - S.h)) < 0.7) continue;
    const cOff = (c.front - c.rear) / 2, cHalf = (c.front + c.rear) / 2;
    const ccx = c.x + Math.cos(c.h) * cOff, ccy = c.y + Math.sin(c.h) * cOff;
    const dx = ccx - pcx, dy = ccy - pcy;
    const lim = pHalf + cHalf + 2;
    if (dx * dx + dy * dy > lim * lim) continue;
    const ax = dx * fx + dy * fy, ay = -dx * fy + dy * fx;
    const hl = pHalf + cHalf * Math.abs(Math.cos(c.h - S.h)) + c.wid / 2 * Math.abs(Math.sin(c.h - S.h)) - 0.15;
    const hw = pl.wid / 2 + c.wid / 2 * Math.abs(Math.cos(c.h - S.h)) + cHalf * Math.abs(Math.sin(c.h - S.h)) - 0.05;
    if (Math.abs(ax) >= hl || Math.abs(ay) >= hw) continue;
    const px = hl - Math.abs(ax), py = hw - Math.abs(ay);
    let nx = S.x, ny = S.y;
    // 對向會車只擦到一點邊 (窄的雙向道、大車): 當側面擦撞往旁邊推開；不然第一幀縱向重疊比較小，會被當成正面撞、被對向車推著倒退
    const passing = Math.cos(c.h - S.h) < -0.5 && py < 0.9;
    if (px < py && !passing) {
      const sg = Math.sign(ax) || 1;
      nx -= fx * sg * px; ny -= fy * sg * px;
      // 正面撞上: 最多被往後推一點 (以前直接變成對向車速的反方向，對撞公車會被推著倒退 45 km/h)
      if (ax > 0) S.v = Math.min(S.v, Math.max(-1, c.v * Math.cos(c.h - S.h) * 0.9)); else S.v = Math.max(S.v, c.v * 0.9);
    } else {
      const sg = Math.sign(ay) || 1;
      nx += fy * sg * py; ny -= fx * sg * py;
      S.v *= 0.97;
    }
    if (TW.roadAt(nx, ny, S.z, 0.5)) { S.x = nx; S.y = ny; }
    // 同一台車一直貼著 (路口互卡、排隊) 只算一次碰撞、響一次；離開 0.5 秒以上再碰到才算新的一次
    const fresh = touchClock - (c.touchAt ?? -9) > 0.5;
    c.touchAt = touchClock;
    if (fresh && bumpCooldown <= 0) {
      bumpCooldown = 0.6; stats.bumps++; sound.bump();
      if (TW.params.has('bumpdbg')) console.log('[bump]', c.type, 'front/side', px < py ? (ax > 0 ? 'front' : 'rear') : 'side', 'dh', Math.round(((c.h - S.h) * 180 / Math.PI) % 360), 'v', (S.v * 3.6).toFixed(0), 'ai v', (c.v * 3.6).toFixed(0), 'ai w', c.w.k, c.w.name || '', 'me', S.road ? S.road.w.k + ' ' + (S.road.w.name || '') : '-', 'ai plan', c.plan ? (c.plan.none ? 'none' : c.plan.o.k) : '-', 'pos', S.x.toFixed(0), S.y.toFixed(0));
    }
  }
}

const _m = new T.Matrix4(), _q = new T.Quaternion(), _e = new T.Euler(), _p = new T.Vector3(), _s = new T.Vector3(), _col = new T.Color();
const TAIL_ON = new T.Color(1, 0.02, 0.01), TAIL_OFF = new T.Color(0.45, 0.004, 0.004);
const SIG_ON = new T.Color(1.0, 0.42, 0.0), SIG_OFF = new T.Color(0.18, 0.07, 0.0);
const FL_R = new T.Color(1, 0.02, 0.02), FL_B = new T.Color(0.05, 0.15, 1), FL_OFF = new T.Color(0.05, 0.02, 0.02);
let respawnClock = 0;
const _wm = new T.Matrix4();
function drawInstance(name, c, x, y, z, h, pitch, roll, sx, sy, sz, blink, flash) {
  const ins = INST[name];
  if (!ins || ins.n >= ins.cap || !Number.isFinite(x + y + z + h + pitch + roll)) return;
  const i = ins.n++;
  _e.set(roll, h, pitch, 'YZX');
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, z, -y), _q, _s.set(sx, sy, sz));
  for (const wg of ins.wheels) for (const wl of wg.list) {   // 輪子轉動
    if (wg.n >= wg.cap) break;
    _wm.makeRotationZ(-(c.odo || 0) / wl.r).setPosition(wl.pos);
    _wm.premultiply(_m);
    for (const im of wg.meshes) im.setMatrixAt(wg.n, _wm);
    wg.n++;
  }
  for (const im of ins.meshes) {
    im.setMatrixAt(i, _m);
    const kind = im.material.userData.kind;
    if (!kind) continue;
    if (kind === 'paint') im.setColorAt(i, _col.setRGB(c.color[0], c.color[1], c.color[2]));
    else if (kind === 'accent') im.setColorAt(i, _col.setRGB(c.accent[0], c.accent[1], c.accent[2]));
    else if (kind === 'tail') im.setColorAt(i, c.brake ? TAIL_ON : TAIL_OFF);
    else if (kind === 'sigL') im.setColorAt(i, c.signal === -1 && blink ? SIG_ON : SIG_OFF);
    else if (kind === 'sigR') im.setColorAt(i, c.signal === 1 && blink ? SIG_ON : SIG_OFF);
    else if (kind === 'flashA') im.setColorAt(i, flash ? FL_R : FL_OFF);
    else if (kind === 'flashB') im.setColorAt(i, flash ? FL_OFF : FL_B);
  }
}
const PROF = TW.params.has('prof') ? { step: 0, coll: 0, resp: 0, draw: 0, n: 0 } : null;   // ?prof: 測試用計時
function updateTraffic(dt) {
  if (!INST) return;
  simT += dt;
  let pt = PROF ? performance.now() : 0;
  const sub = dt > 1 / 25 ? 2 : 1;   // 30 fps 以上一步就夠 (以前 45 fps 以下就算兩次，畫面一慢負擔加倍、越來越卡)
  for (let k = 0; k < sub; k++) for (const c of (buildGrid(), cars)) if (c.alive) {
    stepCar(c, dt / sub);
    if (!Number.isFinite(c.x + c.y + c.z + c.h + c.s + c.v)) { stats.nan++; kill(c); }   // 防護: 座標算壞就回收
  }
  if (PROF) { const t = performance.now(); PROF.step += t - pt; pt = t; PROF.n++; }
  collidePlayer(dt);
  if (PROF) { const t = performance.now(); PROF.coll += t - pt; pt = t; }
  // 回收: 國道 1.8 km、一般道路 650 m 外才回收並在遠處重新生成 (不會在眼前消失)
  respawnClock -= dt;
  if (respawnClock <= 0) {
    respawnClock = 0.25;
    // 路況等級加遲滯: 新等級要維持 3 秒才採用 (玩家所在路段偶爾會瞬間判到旁邊的匝道、平面道路，不能跟著跳)
    const rawLv = playerFwyLevel();
    if (rawLv !== lvCand) { lvCand = rawLv; lvCandT = 0; } else lvCandT += 0.25;
    if (lvCandT >= 3 || seedLv === 0) fwyLv = lvCand;
    lowT = fwyLv >= 3 ? 0 : lowT + 0.25;
    // 傳送、或離開壅塞 15 秒以上後再開進車多/壅塞路段: 國道車直接重排到玩家周圍 (不然生車最小距離會在眼前留一段空的)
    const jumped = Math.hypot(S.x - seedPos[0], S.y - seedPos[1]) > 600;
    seedPos[0] = S.x; seedPos[1] = S.y;
    if (fwyLv >= 3 && (jumped || (seedLv < 3 && lowWas >= 15) || seedLv === 0)) {
      for (const c of cars) if (c.pool === 'fwy') { kill(c); trySpawn(c, 'fwy', 12, FWY_R[fwyLv][1]); }
      stats.reseed = (stats.reseed || 0) + 1;
    }
    lowWas = lowT > 0 ? lowT : lowWas;
    if (fwyLv >= 3) lowWas = 0;
    seedLv = fwyLv;
    // 空車位 (之前生不出來) 跟要回收的活車分開算額度: 不然生車點少的地方 (基隆市區) 空車位每輪都先用光 4 個額度，卡死的車永遠收不掉
    let n = 0, nDead = 0;
    for (const c of cars) {
      if (!c.alive) {
        if (nDead++ < 4) { if (c.pool === 'city') trySpawn(c, 'city', 280, 550); else trySpawn(c, 'fwy', FWY_R[fwyLv][0], FWY_R[fwyLv][1]); }
        continue;
      }
      const d = Math.hypot(c.x - S.x, c.y - S.y);
      const behind = c.alive && (c.x - S.x) * Math.cos(S.h) + (c.y - S.y) * Math.sin(S.h) < -25;
      const FR = FWY_R[fwyLv];
      const far = c.pool === 'city' ? (d > 650 || (c.deadEnd && (d > 80 || behind))) : (d > FR[2] || (c.deadEnd && d > Math.min(700, FR[1])));
      // 開到死路 (單行道尾端沒路接) 的車停 5 秒就回收，不然後面的車 (包括玩家) 會一直排在它後面
      const jam = ((c.stuck || 0) > 8 && (d > 120 || behind)) || (c.stuck || 0) > 25 || (c.deadEnd && (c.stuck || 0) > 5);   // 卡死的車: 停 8 秒就在看不到的地方回收，卡太久直接回收
      if (jam && !far) stats.unjam = (stats.unjam || 0) + 1;
      if ((far || jam) && n++ < 4) {
        kill(c);
        if (c.pool === 'city') trySpawn(c, 'city', 280, 550); else trySpawn(c, 'fwy', FWY_R[fwyLv][0], FWY_R[fwyLv][1]);
      }
    }
  }
  if (PROF) { const t = performance.now(); PROF.resp += t - pt; pt = t; }
  // 繪製
  const now = performance.now(), blink = (now % 666) < 333, flash = (now % 500) < 250;
  for (const k in INST) { INST[k].n = 0; for (const wg of INST[k].wheels) wg.n = 0; }
  for (const c of cars) {
    if (!c.alive) continue;
    drawInstance(c.type, c, c.x, c.y, c.z, c.h, c.pitch, c.roll, c.sx, c.sy, c.sz, blink, flash);
    if (c.T.trailer) {
      const tr = c.T.trailer;
      const hx = c.x - Math.cos(c.h) * tr.hitch, hy = c.y - Math.sin(c.h) * tr.hitch;
      const tp = trailPoint(c.trail, hx, hy, tr.kingpin);
      const th = Math.atan2(hy - tp[1], hx - tp[0]);
      drawInstance('semiTrailer', c, tp[0], tp[1], tp[2], th, c.pitch, 0, 1, 1, 1, blink, flash);
    }
  }
  for (const k in INST) {
    for (const im of INST[k].meshes) { im.count = INST[k].n; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
    for (const wg of INST[k].wheels) for (const im of wg.meshes) { im.count = wg.n; im.instanceMatrix.needsUpdate = true; }
  }
  if (PROF) PROF.draw += performance.now() - pt;
}
// 智行地圖路況圖層 (Smart-Nav-Map /api/traffic/segments): 國道 + 臺北、桃園市區官方路況 + 手機回報，順暢的不送
// 連得上智行地圖伺服器時，小地圖照它的顏色畫出車多、壅塞的路段 (市區道路也有)
const snmTraffic = { lines: [], at: 0, box: null, busy: false, failAt: -1e9 };
async function pollSnmTraffic() {
  if (snmTraffic.busy || !API || Date.now() - snmTraffic.failAt < 60000) return;   // 伺服器沒開: 一分鐘後再試
  const b = snmTraffic.box;
  if (b && Date.now() - snmTraffic.at < 30000 && Math.abs(S.x - b[0]) < 1500 && Math.abs(S.y - b[1]) < 1500) return;
  snmTraffic.busy = true;
  try {
    const [la0, lo0] = toLatLon(S.x - 4000, S.y - 4000), [la1, lo1] = toLatLon(S.x + 4000, S.y + 4000);
    const j = await fetchJson(`${API}/traffic/segments?n=${la1.toFixed(5)}&s=${la0.toFixed(5)}&e=${lo1.toFixed(5)}&w=${lo0.toFixed(5)}`, 8000);
    const fc = j && (j.data || j);
    if (fc && Array.isArray(fc.features)) {
      snmTraffic.lines = [];
      for (const f of fc.features) {
        const g = f.geometry, pr = f.properties || {};
        if (!g || g.type !== 'LineString' || !pr.color || pr.trafficLevel === 'free') continue;
        const pts = new Float32Array(g.coordinates.length * 2);
        g.coordinates.forEach((q, i) => { const [x, y] = tm2(q[1], q[0]); pts[i * 2] = x - TW.ORIGIN[0]; pts[i * 2 + 1] = y - TW.ORIGIN[1]; });
        snmTraffic.lines.push({ pts, color: pr.color });
      }
      snmTraffic.at = Date.now(); snmTraffic.box = [S.x, S.y];
    }
  } catch (e) { snmTraffic.failAt = Date.now(); /* 智行地圖伺服器沒開: 只用國道路況 */ }
  snmTraffic.busy = false;
}
TW.HOOKS.minimap.push((ctx, s) => {
  ctx.lineCap = 'round';
  for (const L of snmTraffic.lines) {
    ctx.beginPath();
    for (let i = 0; i < L.pts.length; i += 2) { const x = L.pts[i] - S.x, y = L.pts[i + 1] - S.y; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.strokeStyle = L.color; ctx.lineWidth = 4 / s; ctx.stroke();
  }
});
TW.HOOKS.minimap.push((ctx, s) => {
  for (const c of cars) {
    if (!c.alive) continue;
    ctx.beginPath(); ctx.arc(c.x - S.x, c.y - S.y, (c.type === 'scooter' ? 1.4 : BIG.has(c.type) ? 3.2 : 2.4) / s, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${c.color.map((v) => Math.round(Math.pow(v, 1 / 2.2) * 255)).join(',')})`;
    ctx.fill(); ctx.lineWidth = 0.8 / s; ctx.strokeStyle = '#000'; ctx.stroke();
  }
});

// ======================================================================= CMS 電子看板 / ETC 門架 (造型參考 Smart-Nav-Map cms_3d.js)
const RED_WORDS = /事故|封閉|施工|壅塞|車禍|管制|散落|故障|危險|注意|慢行|追撞|落石|火警/;
const cleanText = (t) => String(t || '').replace(/\(圖\)/g, '').replace(/\(至\)/g, '至').replace(/[\s　]+/g, ' ').trim();
function pageColor(p) {
  if (p.type === '7' || RED_WORDS.test(p.text)) return '#FF3B2F';
  if (p.type === '6' || /雨|霧|風|減速|限速/.test(p.text)) return '#FFB31A';
  return '#3CFF52';
}
function splitLines(t) {
  const a = Array.from(t);
  if (a.length <= 10) return [t];
  const n = Math.ceil(a.length / 2);
  return [a.slice(0, n).join(''), a.slice(n, Math.min(a.length, n * 2)).join('')];
}
const COLS = 192, ROWS = 60, PITCH = 4;
function boardCanvas(p) {
  const lo = document.createElement('canvas'); lo.width = COLS; lo.height = ROWS;
  const lx = lo.getContext('2d', { willReadFrequently: true }), lines = splitLines(p.text), col = pageColor(p);   // 只拿來讀像素: CPU 畫布，不用每次從 GPU 讀回
  let fs = lines.length > 1 ? 26 : 34;
  const font = (n) => '700 ' + n + 'px "PingFang TC","Microsoft JhengHei","Noto Sans TC",sans-serif';
  lx.font = font(fs);
  const widest = Math.max(...lines.map((l) => lx.measureText(l).width));
  if (widest > COLS - 4) { fs = Math.max(12, Math.floor(fs * (COLS - 4) / widest)); lx.font = font(fs); }
  lx.fillStyle = '#fff'; lx.textAlign = 'center'; lx.textBaseline = 'middle';
  lines.forEach((l, i) => lx.fillText(l, COLS / 2, lines.length > 1 ? ROWS * (0.27 + i * 0.47) : ROWS / 2));
  const px = lx.getImageData(0, 0, COLS, ROWS).data;
  const cv = document.createElement('canvas'); cv.width = COLS * PITCH; cv.height = ROWS * PITCH;
  const x = cv.getContext('2d');
  x.fillStyle = '#08080A'; x.fillRect(0, 0, cv.width, cv.height);
  const lit = [], dim = [];
  for (let gy = 0; gy < ROWS; gy++) for (let gx = 0; gx < COLS; gx++) (px[(gy * COLS + gx) * 4 + 3] > 110 ? lit : dim).push(gx, gy);
  const dots = (arr, color, r) => { x.fillStyle = color; x.beginPath(); for (let i = 0; i < arr.length; i += 2) { const cx = arr[i] * PITCH + PITCH / 2, cy = arr[i + 1] * PITCH + PITCH / 2; x.moveTo(cx + r, cy); x.arc(cx, cy, r, 0, Math.PI * 2); } x.fill(); };
  dots(dim, '#1E1F22', 1.35);
  x.globalAlpha = 0.35; dots(lit, col, 2.4);
  x.globalAlpha = 1; dots(lit, col, 1.6);
  return cv;
}
const lampTex = {};
function lampTexture(kind) {
  if (lampTex[kind]) return lampTex[kind];
  const Sz = 128, cv = document.createElement('canvas'); cv.width = Sz; cv.height = Sz;
  const x = cv.getContext('2d');
  let g;
  if (kind === 'halo') {
    g = x.createRadialGradient(Sz / 2, Sz / 2, Sz * 0.12, Sz / 2, Sz / 2, Sz / 2);
    g.addColorStop(0, 'rgba(206,245,90,0.75)'); g.addColorStop(0.45, 'rgba(196,242,58,0.25)'); g.addColorStop(1, 'rgba(196,242,58,0)');
    x.fillStyle = g; x.fillRect(0, 0, Sz, Sz);
  } else {
    x.fillStyle = '#0B0B0D'; x.fillRect(0, 0, Sz, Sz);
    g = x.createRadialGradient(Sz * 0.45, Sz * 0.42, 2, Sz / 2, Sz / 2, Sz * 0.42);
    if (kind === 'on') { g.addColorStop(0, '#FBFFE0'); g.addColorStop(0.35, '#DDF86A'); g.addColorStop(0.8, '#A9D82C'); g.addColorStop(1, '#5E7A14'); }
    else { g.addColorStop(0, '#4A5040'); g.addColorStop(0.6, '#2E3328'); g.addColorStop(1, '#1C1F18'); }
    x.fillStyle = g; x.beginPath(); x.arc(Sz / 2, Sz / 2, Sz * 0.42, 0, Math.PI * 2); x.fill();
    x.strokeStyle = '#2A2C30'; x.lineWidth = 4; x.stroke();
  }
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace;
  return (lampTex[kind] = t);
}
function plateCanvas(text, bg = '#0A7A3E', w = 192, h = 64, size = 38) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, w, h);
  x.strokeStyle = '#FFFFFF'; x.lineWidth = 4; x.strokeRect(4, 4, w - 8, h - 8);
  x.fillStyle = '#FFFFFF'; x.font = '700 ' + size + 'px Arial,"Microsoft JhengHei",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, w / 2, h / 2 + 2);
  return c;
}
const steelMat = new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.58, 0.61), metalness: 0.75, roughness: 0.38 });
const darkMat = new T.MeshStandardMaterial({ color: new T.Color(0.018, 0.02, 0.024), metalness: 0.3, roughness: 0.55 });
const texMat = (cv) => { const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; return new T.MeshBasicMaterial({ map: t, toneMapped: false }); };

/** 門架本體 (照國道街景): 暫存群組，之後依材質合併
 *  - 立柱: 每邊兩根粗圓管，沿路方向前後相距 2*cz (實景很寬，約 2.4 m)，中間之字形斜撐
 *    中央那根立在中央護欄上 (護欄在那一段降低，baseL)；外側那根不在護欄上，立在護欄外的地上 (baseR、混凝土基礎)
 *  - 橫梁: 四根主管的立體桁架 (前後 2*tz、上下 TH)，前後面 V 形斜撐 + 直桿，上下面斜撐 (柱頂不加內側斜撐)
 *  - 區域座標: x = 橫向 (左負右正)、y = 高、z = 沿路 (+z 面向來車)
 */
const galvMat = new T.MeshStandardMaterial({ color: new T.Color(0.62, 0.65, 0.68), metalness: 0.55, roughness: 0.42 });
const footMat = new T.MeshStandardMaterial({ color: new T.Color(0.55, 0.55, 0.52), roughness: 0.9, metalness: 0 });
function trussGroup(XL, XR, H, TH, o = {}) {
  const baseL = o.baseL ?? TW.BAR_LOW, baseR = o.baseR ?? 0, tz = o.tz ?? 0.5, cz = o.cz ?? 1.2;
  const g = new T.Group(), UP = new T.Vector3(0, 1, 0);
  const rod = (a, b, r, mat = galvMat) => {
    const A = new T.Vector3(...a), B = new T.Vector3(...b), d = B.clone().sub(A), len = d.length();
    if (len < 0.01) return;
    const m = new T.Mesh(new T.CylinderGeometry(r, r, len, r > 0.1 ? 12 : 6, 1, r < 0.1), mat);
    m.position.copy(A).add(B).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(UP, d.normalize()); g.add(m);
  };
  const blk = (x, y, z, w, h, d, mat = galvMat) => { const m = new T.Mesh(new T.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); g.add(m); };
  const top = H + TH;
  // ---- 立柱
  for (const [px, base] of [[XL, baseL], [XR, baseR]]) {
    for (const z of [-cz, cz]) {
      rod([px, base, z], [px, top + 0.12, z], 0.16);
      blk(px, base + 0.025, z, 0.6, 0.05, 0.6);                   // 底板
      blk(px, top + 0.14, z, 0.4, 0.04, 0.4);                     // 柱頂蓋板
    }
    if (base < 0.3) blk(px, base - 0.6, 0, 1.0, 1.3, 2 * cz + 1.0, footMat);   // 護欄外: 混凝土基礎
    const n = Math.max(3, Math.round((H - base) / 1.15)), st = (H - base) / n;
    rod([px, base + 0.3, -cz], [px, base + 0.3, cz], 0.05);
    for (let k = 0; k < n; k++) { const y = base + k * st, a = k % 2 ? cz : -cz; rod([px, y + (k ? 0 : 0.3), a], [px, y + st, -a], 0.05); }
    // 柱頂: 橫梁穿過的框 (兩根立柱之間的橫桿 + 斜撐)
    for (const y of [H, top]) rod([px, y, -cz], [px, y, cz], 0.07);
    rod([px, H, -cz], [px, top, cz], 0.05); rod([px, H, cz], [px, top, -cz], 0.05);
  }
  // ---- 橫梁 (立體桁架)
  const x0 = XL - 0.25, x1 = XR + 0.25, nSeg = Math.max(4, Math.round((x1 - x0) / Math.max(1.5, TH * 0.75))), step = (x1 - x0) / nSeg;
  for (const z of [-tz, tz]) for (const y of [H, top]) rod([x0, y, z], [x1, y, z], 0.09);   // 四根主管
  for (let k = 0; k <= nSeg; k++) {
    const x = x0 + k * step;
    for (const z of [-tz, tz]) rod([x, H, z], [x, top, z], 0.04);   // 前後面直桿
    rod([x, H, -tz], [x, H, tz], 0.04); rod([x, top, -tz], [x, top, tz], 0.04);   // 上下面橫桿
    if (k < nSeg) {
      const xa = x, xb = x + step, xm = x + step / 2;
      for (const z of [-tz, tz]) { rod([xa, top, z], [xm, H, z], 0.035); rod([xm, H, z], [xb, top, z], 0.035); }   // 前後面 V 形
      rod([xa, top, -tz], [xb, top, tz], 0.032); rod([xa, H, tz], [xb, H, -tz], 0.032);                              // 上下面斜撐
    }
  }
  return g;
}
/** 門架兩根立柱的橫向位置: 中央 = 中央護欄中心；外側 = 外側護欄外 (不跨在護欄上) */
const gantryX = (w, i) => [-TW.leftPost(w, i), TW.rightEdge(w, i) + 0.5];
// ---- 維修走道 (牌面下緣前方)：格柵地板、每 1.5 m 一支托架吊在下弦、前緣踢腳板；欄杆只在沒有牌面擋住的地方 (照實景)
const gridTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  x.clearRect(0, 0, 64, 64); x.fillStyle = '#fff';
  for (let i = 0; i < 64; i += 8) { x.fillRect(i, 0, 2, 64); } for (let j = 0; j < 64; j += 21) x.fillRect(0, j, 64, 3);
  const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; return t;
})();
const barTex = (() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64; const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 5); x.fillRect(0, 30, 64, 4); x.fillRect(0, 59, 64, 5);
  for (let i = 0; i < 64; i += 8) x.fillRect(i, 0, 2, 64);
  const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; return t;
})();
const gratingMat = new T.MeshStandardMaterial({ color: new T.Color(0.6, 0.63, 0.66), metalness: 0.5, roughness: 0.5, alphaMap: gridTex, alphaTest: 0.5, side: T.DoubleSide });
const railMat = new T.MeshStandardMaterial({ color: new T.Color(0.6, 0.63, 0.66), metalness: 0.5, roughness: 0.5, alphaMap: barTex, alphaTest: 0.5, side: T.DoubleSide });
/** 貼圖重複寫進 UV (同一個材質就能合併成一個繪製呼叫) */
function tiledPlane(w, h, ru, rv) { const geo = new T.PlaneGeometry(w, h), uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ru, uv.getY(i) * rv); return geo; }
function catwalk(g, xa, xb, y, zB, zF, hangY, covered = []) {
  const L = xb - xa, D = zF - zB, box = (w, h, d, x, yy, z) => { const m = new T.Mesh(new T.BoxGeometry(w, h, d), galvMat); m.position.set(x, yy, z); g.add(m); };
  const floor = new T.Mesh(tiledPlane(L, D, L / 0.6, D / 0.6).rotateX(-Math.PI / 2), gratingMat); floor.position.set((xa + xb) / 2, y, (zB + zF) / 2); g.add(floor);
  const n = Math.max(2, Math.round(L / 1.5));
  for (let k = 0; k <= n; k++) {
    const x = xa + L * k / n;
    box(0.07, 0.12, D + 0.12, x, y - 0.07, (zB + zF) / 2);            // 托架
    if (hangY > y) box(0.07, hangY - y + 0.07, 0.07, x, (hangY + y) / 2 - 0.03, zB);   // 吊到桁架下弦
  }
  box(L, 0.12, 0.05, (xa + xb) / 2, y - 0.06, zF);                     // 前緣槽鋼
  box(L, 0.1, 0.03, (xa + xb) / 2, y + 0.05, zF);                      // 踢腳板
  // 欄杆: 只在牌面之間的空隙與兩端
  const free = []; let cur = xa;
  for (const [a, b] of covered.slice().sort((p, q) => p[0] - q[0])) { if (a > cur) free.push([cur, Math.min(a, xb)]); cur = Math.max(cur, b); }
  if (cur < xb) free.push([cur, xb]);
  for (const [a, b] of free) {
    const l = b - a; if (l < 0.35) continue;
    const r = new T.Mesh(tiledPlane(l, 1.0, l / 0.6, 1), railMat); r.position.set((a + b) / 2, y + 0.5, zF); g.add(r);
    box(l, 0.05, 0.05, (a + b) / 2, y + 1.0, zF);
    const m = Math.max(1, Math.round(l / 1.5));
    for (let k = 0; k <= m; k++) box(0.05, 1.0, 0.05, a + l * k / m, y + 0.5, zF);
  }
}
/** 牌面背後: 灰色背板 + 橫向加強肋 (每 0.3 m) + 垂直吊桿 (每 1.4 m 一支) 從走道接到桁架上弦 */
const ribMat = new T.MeshStandardMaterial({ color: new T.Color(0.5, 0.52, 0.55), metalness: 0.6, roughness: 0.45 });
function signBack(g, cx, cy, w, h, z, yLo, yHi) {
  const b = new T.Mesh(new T.BoxGeometry(w, h, 0.04), ribMat); b.position.set(cx, cy, z - 0.03); g.add(b);
  for (let y = -h / 2 + 0.15; y < h / 2 - 0.05; y += 0.3) { const r = new T.Mesh(new T.BoxGeometry(w - 0.06, 0.06, 0.05), ribMat); r.position.set(cx, cy + y, z - 0.075); g.add(r); }
  const lo = Math.min(yLo, cy - h / 2) - 0.05, hi = Math.max(yHi, cy + h / 2) + 0.1, nh = Math.max(2, Math.round(w / 1.4));
  for (let j = 0; j < nh; j++) { const v = new T.Mesh(new T.BoxGeometry(0.1, hi - lo, 0.1), galvMat); v.position.set(cx - w / 2 + w * (j + 0.5) / nh, (lo + hi) / 2, z - 0.16); g.add(v); }
}
function placeOnWay(obj, w, i) {
  const x = w.P[i * 3], y = w.P[i * 3 + 1], z = w.P[i * 3 + 2];
  const n3 = new T.Vector3(w.nx[i], 0, -w.ny[i]), t3 = new T.Vector3(w.ny[i], 0, w.nx[i]);
  const m = new T.Matrix4().makeBasis(n3.clone().negate(), new T.Vector3(0, 1, 0), t3.clone().negate()); // +x 右、+z 面向來車
  m.setPosition(x, z, -y);
  obj.matrixAutoUpdate = false; obj.matrix.copy(m); obj.updateMatrixWorld(true);
}
function mergedGroup(tmp) {
  const out = new T.Group();
  for (const [mat, geo] of bakeByMaterial(tmp, tmp)) { const m = new T.Mesh(geo, mat); m.castShadow = true; m.receiveShadow = true; out.add(m); }
  return out;
}

// ---- CMS: 接近才建模型 (LED 貼圖較大)
const signs = LIVE.cms.map((c) => ({ ...c, pages: (c.pages || []).map((p) => ({ text: cleanText(p.text), type: String(p.type || '') })).filter((p) => p.text), model: null, page: 0 }));
function buildSign(sg) {
  const w = TW.wayByGid(sg.way), hw = w.hw;
  const [XL, XR] = gantryX(w, sg.idx), H = 7, TH = 1.1;
  const root = new T.Group();
  const truss = trussGroup(XL, XR, H, TH);
  const BW = Math.min(8, XR - XL - 6), BH = 2.3, BY = H + TH + BH / 2 + 0.15, BX = (XL + XR) / 2;
  const box = (wd, ht, dp, mat, x, y, z) => { const m = new T.Mesh(new T.BoxGeometry(wd, ht, dp), mat); m.position.set(x, y, z); truss.add(m); };
  box(BW + 0.3, BH + 0.3, 0.6, darkMat, BX, BY, 0);
  const lampsY = BY + BH / 2 + 0.45, lampXs = [-BW / 2 + 1.2, BW / 2 - 1.2];
  for (const lx of lampXs) box(0.5, 0.45, 0.4, darkMat, BX + lx, lampsY, 0.05);
  box(2.5, 0.9, 0.08, darkMat, XL + 1.7, H + TH / 2, 0.49);
  root.add(mergedGroup(truss));
  const page = sg.pages[0] || { text: '', type: '1' };
  const faceMat = texMat(boardCanvas(page));
  const face = new T.Mesh(new T.PlaneGeometry(BW, BH), faceMat); face.position.set(BX, BY, 0.31); root.add(face);
  const lamps = lampXs.map((lx) => {
    const mat = new T.MeshBasicMaterial({ map: lampTexture('on'), toneMapped: false });
    const led = new T.Mesh(new T.PlaneGeometry(0.42, 0.42), mat); led.position.set(BX + lx, lampsY, 0.255); root.add(led);
    const halo = new T.Mesh(new T.PlaneGeometry(1.1, 1.1), new T.MeshBasicMaterial({ map: lampTexture('halo'), transparent: true, depthWrite: false, toneMapped: false }));
    halo.position.set(BX + lx, lampsY, 0.27); root.add(halo);
    return { mat, halo };
  });
  const mile = new T.Mesh(new T.PlaneGeometry(2.4, 0.8), texMat(plateCanvas((sg.m / 1000).toFixed(1).replace(/\.0$/, '') + 'K')));
  mile.position.set(XL + 1.7, H + TH / 2, 0.54); root.add(mile);
  placeOnWay(root, w, sg.idx);
  TW.scene.add(root);
  return { root, faceMat, lamps };
}
function disposeSign(sg) {
  const md = sg.model; if (!md) return;
  TW.scene.remove(md.root);
  md.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map && !Object.values(lampTex).includes(o.material.map)) o.material.map.dispose(); });
  sg.model = null;
}
let signClock = 0, pageClock = 0, blinkClock = 0, blinkOn = true;
function updateSigns(dt) {
  signClock -= dt; pageClock -= dt; blinkClock -= dt;
  if (signClock <= 0) {
    signClock = 0.5;
    let built = 0;
    for (const sg of signs) {
      const w = TW.wayByGid(sg.way);
      if (!w) { if (sg.model) disposeSign(sg); continue; }   // 那一區還沒載入
      const x = w.P[sg.idx * 3], y = w.P[sg.idx * 3 + 1];
      const d = Math.hypot(x - S.x, y - S.y);
      if (!sg.model && d < 1600 && sg.pages.length && built < 3) { sg.model = buildSign(sg); built++; }
      else if (sg.model && d > 2600) disposeSign(sg);
    }
  }
  if (pageClock <= 0) {
    pageClock = 5;
    for (const sg of signs) if (sg.model && sg.pages.length > 1) {
      sg.page = (sg.page + 1) % sg.pages.length;
      const t = sg.model.faceMat.map; t.image = boardCanvas(sg.pages[sg.page]); t.needsUpdate = true;
    }
  }
  if (blinkClock <= 0) {
    blinkClock = 0.6; blinkOn = !blinkOn;
    for (const sg of signs) if (sg.model) for (const lm of sg.model.lamps) { lm.mat.map = lampTexture(blinkOn ? 'on' : 'off'); lm.halo.visible = blinkOn; }
  }
}
async function pollCms() {
  let wait = 30000;
  try {
    const [j] = await fetchLive('/cms');
    if (j && j.ok && j.data && Array.isArray(j.data.items)) {
      const byId = new Map(j.data.items.map((x) => [x.id, x]));
      for (const sg of signs) {
        const it = byId.get(sg.id); if (!it) continue;
        const pages = (it.messages || []).map((g) => ({ text: cleanText(g.text), type: String(g.type || '') })).filter((p) => p.text);
        if (pages.map((p) => p.text).join('|') !== sg.pages.map((p) => p.text).join('|')) {
          sg.pages = pages; sg.page = 0;
          if (sg.model && pages.length) { const t = sg.model.faceMat.map; t.image = boardCanvas(pages[0]); t.needsUpdate = true; }
        }
      }
      wait = Math.max(5000, Math.min(30000, (j.data.nextUpdateIn || 30000) + Math.random() * 1500));   // 至少隔 5 秒 (後端回 0 或負數時不要每秒狂抓)
    }
  } catch (e) { /* 沿用快照 */ }
  setTimeout(pollCms, wait);
}

// ---- ETC 門架: 全部建 (合併後每座 2~3 個繪製呼叫)
function buildEtc(g) {
  const w = TW.wayByGid(g.way), hw = w.hw;
  const [XL, XR] = gantryX(w, g.idx), H = 6.4, TH = 1.0;
  const truss = trussGroup(XL, XR, H, TH);
  // 每車道一組偵測器 (天線箱 + 攝影機)
  for (let ln = 0; ln < w.lanes; ln++) {
    const xc = -(TW.laneOffDir(w, ln, 1));  // 本地 +x 為右 = -左
    const ant = new T.Mesh(new T.BoxGeometry(0.9, 0.55, 0.35), darkMat); ant.position.set(xc, H - 0.35, 0.25); truss.add(ant);
    const cam = new T.Mesh(new T.BoxGeometry(0.28, 0.24, 0.5), steelMat); cam.position.set(xc + 0.7, H - 0.25, 0.35); truss.add(cam);
    const lens = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, 0.05, 12).rotateX(Math.PI / 2), darkMat); lens.position.set(xc + 0.7, H - 0.25, 0.62); truss.add(lens);
  }
  const cab = new T.Mesh(new T.BoxGeometry(0.8, 1.6, 0.6), steelMat); cab.position.set(XR, 0.8, 2.3); truss.add(cab);   // 機櫃在外側立柱旁
  const root = new T.Group();
  root.add(mergedGroup(truss));
  const id = new T.Mesh(new T.PlaneGeometry(1.8, 0.45), texMat(plateCanvas(g.id, '#0A7A3E', 256, 64, 34)));
  id.position.set(XL + 1.4, H + TH / 2, 0.5); root.add(id);
  placeOnWay(root, w, g.idx);
  TW.scene.add(root);
}

// ======================================================================= 交流道出口指示牌 (照實景: 綠底白字門架)
// 資料: scripts/build_signs.py -> extra-signs。左邊直行 (下兩個交流道 + ↑)，右邊出口 (路線盾牌、地名、英文 + ↗)，出口牌上方黃底出口編號
const GUIDES = (() => { const el = $('extra-signs'); try { return el ? JSON.parse(el.textContent) : []; } catch (e) { return []; } })().map((g) => ({ ...g, model: null }));
// 實景量測: 單一地名牌約 3.5 m 寬 × 2.6 m 高 (橫長方形)，中文字高約 0.7 m
const SGN = { green: '#0a6b3b', px: 96, zh: 0.72, en: 0.28, sh: 0.7, arrow: 0.62, pad: 0.34, gap: 0.6, minW: 3.5, minH: 2.6 };
const ZH_FONT = '"Microsoft JhengHei","PingFang TC","Noto Sans TC","Noto Sans CJK TC","Heiti TC",sans-serif';
const EN_FONT = 'Arial,"Helvetica Neue",sans-serif';
const zhFont = (m) => '700 ' + Math.round(m * SGN.px) + 'px ' + ZH_FONT;
const enFont = (m) => '700 ' + Math.round(m * SGN.px) + 'px ' + EN_FONT;
const mctx = document.createElement('canvas').getContext('2d');
/** 文字寬度 (公尺)；中文字距拉開一點 (標誌字距寬) */
function textW(text, font, spacing = 0) { mctx.font = font; return mctx.measureText(text).width / SGN.px + spacing * Math.max(0, [...text].length - 1); }
function drawSpaced(x, text, cx, y, spacing) {
  const chars = [...text];
  if (!spacing || chars.length < 2) { x.fillText(text, cx, y); return; }
  const ws = chars.map((c) => x.measureText(c).width), sp = spacing * SGN.px;
  let px = cx - (ws.reduce((a, b) => a + b, 0) + sp * (chars.length - 1)) / 2;
  const al = x.textAlign; x.textAlign = 'left';
  chars.forEach((c, i) => { x.fillText(c, px, y); px += ws[i] + sp; });
  x.textAlign = al;
}
const shieldKind = (ref) => {
  const n = parseInt(ref, 10);
  if (/^(1|2|3|3甲|4|5|6|8|10)$/.test(ref)) return 'nat';          // 國道
  if (/^台/.test(ref) || (n >= 61 && n <= 88)) return 'prov';        // 東西向快速公路 / 省道
  return 'county';
};
const shieldW = (ref) => (ref.replace(/^台/, '').length > 2 ? 0.95 : 0.7);
function drawShield(x, ref, cx, top) {
  const P = SGN.px, h = SGN.sh * P, w = shieldW(ref) * P, num = ref.replace(/^台/, ''), kind = shieldKind(ref);
  x.save();
  x.beginPath();
  if (kind === 'nat') {          // 梅花形
    const r = h * 0.26, cy = top + h * 0.53;
    for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * Math.PI * 2 / 5; x.moveTo(cx + Math.cos(a) * h * 0.24 + r, cy + Math.sin(a) * h * 0.24); x.arc(cx + Math.cos(a) * h * 0.24, cy + Math.sin(a) * h * 0.24, r, 0, Math.PI * 2); }
    x.moveTo(cx + h * 0.3, cy); x.arc(cx, cy, h * 0.3, 0, Math.PI * 2);
    x.fillStyle = '#ffffff'; x.fill();
    x.beginPath();
    for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + k * Math.PI * 2 / 5; x.moveTo(cx + Math.cos(a) * h * 0.24 + r * 0.8, cy + Math.sin(a) * h * 0.24); x.arc(cx + Math.cos(a) * h * 0.24, cy + Math.sin(a) * h * 0.24, r * 0.8, 0, Math.PI * 2); }
    x.moveTo(cx + h * 0.27, cy); x.arc(cx, cy, h * 0.27, 0, Math.PI * 2);
    x.fillStyle = '#1d4f9c'; x.fill();
    x.fillStyle = '#ffffff';
  } else if (kind === 'prov') {  // 盾形 (照片的 64、65)
    const l = cx - w / 2, r = cx + w / 2, b = top + h;
    x.moveTo(l, top + h * 0.12); x.quadraticCurveTo(cx - w * 0.25, top - h * 0.02, cx, top + h * 0.1); x.quadraticCurveTo(cx + w * 0.25, top - h * 0.02, r, top + h * 0.12);
    x.lineTo(r, top + h * 0.55); x.quadraticCurveTo(r, b - h * 0.12, cx, b); x.quadraticCurveTo(l, b - h * 0.12, l, top + h * 0.55); x.closePath();
    x.fillStyle = '#ffffff'; x.fill();
    x.lineWidth = h * 0.09; x.strokeStyle = '#c8202a'; x.save(); x.clip(); x.stroke(); x.restore();
    x.fillStyle = '#c8202a';
    x.fillRect(l, top + h * 0.2, w, h * 0.6); x.fill();
    x.fillStyle = '#ffffff';
  } else {                       // 縣道: 白底黑字
    x.rect(cx - w / 2, top + h * 0.1, w, h * 0.8); x.fillStyle = '#ffffff'; x.fill(); x.fillStyle = '#111111';
  }
  x.font = '700 ' + Math.round(h * (num.length > 2 ? 0.36 : 0.44)) + 'px ' + EN_FONT;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(num, cx, top + h * 0.53);
  x.restore();
}
/** 箭頭: ang 0 = ↑，正 = 往右斜 */
function drawArrow(x, cx, cy, size, ang) {
  const P = size * SGN.px;
  x.save(); x.translate(cx, cy); x.rotate(ang);
  x.fillStyle = '#ffffff'; x.beginPath();
  x.moveTo(0, -P * 0.5); x.lineTo(P * 0.32, -P * 0.12); x.lineTo(P * 0.1, -P * 0.12); x.lineTo(P * 0.1, P * 0.5);
  x.lineTo(-P * 0.1, P * 0.5); x.lineTo(-P * 0.1, -P * 0.12); x.lineTo(-P * 0.32, -P * 0.12); x.closePath(); x.fill();
  x.restore();
}
function panelBase(wM, hM, bg = SGN.green, border = '#ffffff') {
  const P = SGN.px, cv = document.createElement('canvas');
  cv.width = Math.ceil(wM * P); cv.height = Math.ceil(hM * P);
  const x = cv.getContext('2d');
  const rr = (i, r) => { x.beginPath(); x.roundRect(i, i, cv.width - 2 * i, cv.height - 2 * i, r); };
  x.fillStyle = bg; rr(0, 0.12 * P); x.fill();
  x.lineWidth = 0.05 * P; x.strokeStyle = border; rr(0.08 * P, 0.07 * P); x.stroke();
  x.textAlign = 'center'; x.textBaseline = 'alphabetic';
  return { cv, x, w: wM, h: hM };
}
const ZH_SP = 0.2;   // 中文字距 (m)
/** 出口牌: 每個目的地一欄 (盾牌 / 中文 / 英文)，欄間白色分隔線，箭頭在出口那一側的下方 */
/** 中文字距: 照實景，兩個字的地名字距很寬 (約一個字)，字越多越緊 */
const zsp = (t, multi) => { const n = [...t].length, v = n <= 2 ? 0.7 : n === 3 ? 0.4 : 0.2; return multi ? Math.min(v, 0.35) : v; };
function exitPanel(gd) {
  const S = SGN, n = gd.dz.length, perCol = gd.shields.length === n, multi = n > 1;
  const cols = gd.dz.map((zh, i) => {
    const zw = textW(zh, zhFont(S.zh), zsp(zh, multi)), ew = gd.den[i] ? textW(gd.den[i], enFont(S.en)) : 0;
    const sw = perCol ? shieldW(gd.shields[i]) : 0;
    return { zh, en: gd.den[i] || '', sh: perCol ? gd.shields[i] : null, w: Math.max(zw, ew, sw, 1.4) };
  });
  const groupSh = !perCol && gd.shields.length ? gd.shields : null;
  const hasSh = perCol || !!groupSh;
  const W = Math.max(S.minW + 0.2, S.pad * 2 + cols.reduce((a, c) => a + c.w, 0) + S.gap * (n - 1) + (n === 1 ? 0.6 : 0));
  const Hc = S.pad + (hasSh ? S.sh + 0.12 : 0) + S.zh + 0.12 + S.en + 0.2 + S.arrow + S.pad * 0.7, H = Math.max(S.minH, Hc), oy = (H - Hc) * 0.45;
  const p = panelBase(W, H), x = p.x, P = S.px;
  const used = cols.reduce((a, c) => a + c.w, 0) + S.gap * (n - 1);
  let cx = (W - used) / 2;
  const yZh = (oy + S.pad + (hasSh ? S.sh + 0.12 : 0) + S.zh * 0.9) * P, yEn = yZh + (0.12 + S.en) * P;
  cols.forEach((c, i) => {
    const mid = (cx + c.w / 2) * P;
    if (c.sh) drawShield(x, c.sh, mid, (oy + S.pad) * P);
    x.fillStyle = '#ffffff';
    x.font = zhFont(S.zh); drawSpaced(x, c.zh, mid, yZh, zsp(c.zh, multi));
    if (c.en) { x.font = enFont(S.en); x.fillText(c.en, mid, yEn); }
    if (i < n - 1) { x.fillStyle = '#ffffff'; x.fillRect((cx + c.w + S.gap / 2) * P - 0.025 * P, (oy + S.pad + (hasSh ? S.sh * 0.5 : 0)) * P, 0.05 * P, (S.zh + S.en + 0.3) * P); }
    cx += c.w + S.gap;
  });
  if (groupSh) {
    let tw = groupSh.reduce((a, r) => a + shieldW(r) + 0.15, -0.15), sx = (W - tw) / 2;
    for (const r of groupSh) { drawShield(x, r, (sx + shieldW(r) / 2) * P, (oy + S.pad) * P); sx += shieldW(r) + 0.15; }
  }
  const ay = H - S.pad * 0.7 - S.arrow / 2, R = gd.side !== 'L';
  drawArrow(x, (n === 1 ? W / 2 + (R ? 1 : -1) * 0.9 : (R ? W - S.pad - 0.5 : S.pad + 0.5)) * P, ay * P, S.arrow, R ? Math.PI / 4 : -Math.PI / 4);
  return p;
}
function thruPanel([zh, en]) {
  const S = SGN;
  const W = Math.max(S.minW, S.pad * 2 + Math.max(textW(zh, zhFont(S.zh), zsp(zh)), en ? textW(en, enFont(S.en)) : 0));
  const Hc = S.pad + S.zh + 0.12 + S.en + 0.2 + S.arrow + S.pad * 0.7, H = Math.max(S.minH, Hc), oy = (H - Hc) * 0.45;
  const p = panelBase(W, H), x = p.x, P = S.px;
  const yZh = (oy + S.pad + S.zh * 0.9) * P;
  x.fillStyle = '#ffffff'; x.font = zhFont(S.zh); drawSpaced(x, zh, W / 2 * P, yZh, zsp(zh));
  if (en) { x.font = enFont(S.en); x.fillText(en, W / 2 * P, yZh + (0.12 + S.en) * P); }
  drawArrow(x, W / 2 * P, (H - S.pad * 0.7 - S.arrow / 2) * P, S.arrow, 0);
  return p;
}
function exitTab(gd) {
  const text = gd.ref + ' ' + gd.name, S = SGN, h = 0.55;
  mctx.font = '700 ' + Math.round(0.4 * S.px) + 'px ' + ZH_FONT;
  const W = mctx.measureText(text).width / S.px + 0.36;
  const p = panelBase(W, h, '#f2b705', '#f2b705'), x = p.x;
  x.fillStyle = '#111111'; x.font = mctx.font; x.textBaseline = 'middle'; x.fillText(text, W / 2 * S.px, h / 2 * S.px + 1);
  return p;
}
function signMat(cv) {
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 8;
  // 反光標誌: 有日照明暗，再加一點自發光讓背光面也讀得到
  return new T.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: new T.Color(0.32, 0.32, 0.32), roughness: 0.55, metalness: 0 });
}
const backMat = new T.MeshStandardMaterial({ color: new T.Color(0.42, 0.44, 0.46), metalness: 0.6, roughness: 0.5 });
function buildGuide(gd) {
  const w = TW.wayByGid(gd.gid);
  // 照實景: 中央立柱在中央護欄上、外側立柱在護欄外；: 牌面下緣約 5.8 m、桁架高 2.3 m 藏在牌面後面、柱距 (沿路) 1.4 m
  const [XL, XR] = gantryX(w, gd.idx), H = 5.95, TH = 2.3, TZ = 0.75;
  const root = new T.Group(), steel = trussGroup(XL, XR, H, TH, { tz: TZ, cz: 1.2 });
  const ex = exitPanel(gd), th = gd.thru.map(thruPanel), tab = gd.ref ? exitTab(gd) : null, R = gd.side !== 'L';
  // ---- 牌面對準車道: 出口牌在出口那一側最外車道正上方，直行牌平均排在其餘車道上方
  const nL = Math.max(1, w.lanes), ls = w.ls || 0, laneX = (f) => LANE_W * (f + 0.5) - w.hw + ls;   // 車道 f (0 = 最左) 中心的本地 x
  const m = th.length, rest = Math.max(1, nL - 1);
  const thruX = (j) => { const f = (j + 0.5) * rest / Math.max(1, m) - 0.5; return laneX(R ? f : f + 1); };
  const list = th.map((p, j) => ({ p, c: thruX(j) }));
  const exItem = { p: ex, c: laneX(R ? nL - 1 : 0) };
  const items = R ? [...list, exItem] : [exItem, ...list];   // 左到右
  const lo = XL + 0.55, hi = TW.rightEdge(w, gd.idx) - 0.2, gap = 0.35;   // 牌面最多到路緣
  const s = Math.min(1, (hi - lo - gap * (items.length - 1)) / items.reduce((a, it) => a + it.p.w, 0));
  for (const it of items) { it.w = it.p.w * s; it.h = it.p.h * s; it.l = it.c - it.w / 2; }
  for (let i = 0; i < items.length; i++) items[i].l = Math.max(items[i].l, i ? items[i - 1].l + items[i - 1].w + gap : lo);
  for (let i = items.length - 1; i >= 0; i--) items[i].l = Math.min(items[i].l, (i < items.length - 1 ? items[i + 1].l - gap : hi) - items[i].w);
  for (let i = 0; i < items.length; i++) items[i].l = Math.max(items[i].l, i ? items[i - 1].l + items[i - 1].w + gap : lo);
  const yB = H - 0.15, Z = TZ + 0.26;   // 牌面下緣、牌面位置 (掛在桁架前面)
  const put = (p, cx, y0, pw, ph) => {
    const mesh = new T.Mesh(new T.PlaneGeometry(pw, ph), signMat(p.cv));
    mesh.position.set(cx, y0 + ph / 2, Z); root.add(mesh);
    signBack(steel, cx, y0 + ph / 2, pw, ph, Z, yB - 0.1, H + TH);
  };
  for (const it of items) put(it.p, it.l + it.w / 2, yB, it.w, it.h);   // 下緣對齊 (照實景)
  if (tab) {
    const tw = tab.w * s, thh = tab.h * s, e = exItem;
    put(tab, R ? e.l + e.w - tw / 2 : e.l + tw / 2, yB + e.h + 0.06, tw, thh);
  }
  catwalk(steel, XL + 0.35, XR - 0.3, yB - 0.1, TZ, Z + 0.85, H, items.map((it) => [it.l - 0.05, it.l + it.w + 0.05]));
  root.add(mergedGroup(steel));
  placeOnWay(root, w, gd.idx);
  TW.scene.add(root);
  // 測試: ?gview=x,y,z,lx,ly,lz (門架區域座標) -> 印出對應的 camat / look (資料座標)
  if (TW.params.has('gview')) {
    const v = TW.params.get('gview').split(',').map(Number), f = (a, b, c) => { const p = new T.Vector3(a, b, c).applyMatrix4(root.matrix); return [p.x, -p.z, p.y].map((u) => u.toFixed(1)).join(','); };
    console.log('[test] gview gid ' + gd.gid + ' camat=' + f(v[0], v[1], v[2]) + '&look=' + f(v[3], v[4], v[5]));
  }
  return root;
}
function disposeGuide(gd) {
  if (!gd.model) return;
  TW.scene.remove(gd.model);
  gd.model.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.map) { o.material.map.dispose(); o.material.dispose(); } });
  gd.model = null;
}
let guideClock = 0;
function updateGuides(dt) {
  guideClock -= dt;
  if (guideClock > 0) return;
  guideClock = 0.5;
  let built = 0;
  for (const gd of GUIDES) {
    const w = TW.wayByGid(gd.gid);
    if (!w) { disposeGuide(gd); continue; }
    const d = Math.hypot(w.P[gd.idx * 3] - S.x, w.P[gd.idx * 3 + 1] - S.y);
    if (!gd.model && d < 1500 && built < 2) { gd.model = buildGuide(gd); built++; }
    else if (gd.model && d > 2300) disposeGuide(gd);
  }
}

// ======================================================================= 警廣電台 (hls.js)
const radio = (() => {
  const R = LIVE.radio, st = R.stations;
  let idx = 0, hls = null, playing = false, retry = null;
  const audio = new Audio(); audio.crossOrigin = 'anonymous'; audio.preload = 'none';
  const nameEl = $('radio-name'), freqEl = $('radio-freq'), statEl = $('radio-status'), btn = $('radio-play');
  const vol = $('radio-vol');
  audio.volume = +(vol ? vol.value : 0.8);
  const label = () => { nameEl.textContent = st[idx].name; freqEl.textContent = st[idx].freq + ' MHz'; };
  const status = (t) => { statEl.textContent = t; };
  const setPlaying = (v) => { playing = v; btn.textContent = v ? '❚❚' : '▶'; $('radio').classList.toggle('on', v); };
  function stop() { clearTimeout(retry); if (hls) { hls.destroy(); hls = null; } audio.pause(); audio.removeAttribute('src'); audio.load(); setPlaying(false); status('已暫停'); }
  function play() {
    clearTimeout(retry);
    const url = R.base + st[idx].code + '/playlist.m3u8';
    status('連線中…'); setPlaying(true);
    if (hls) { hls.destroy(); hls = null; }
    const start = () => audio.play().then(() => status('播放中')).catch(() => { status('點擊收聽'); setPlaying(false); });
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ liveDurationInfinity: true, lowLatencyMode: false });
      hls.on(window.Hls.Events.MANIFEST_PARSED, start);
      hls.on(window.Hls.Events.ERROR, (e, d) => {
        if (!d.fatal) return;
        status('連線失敗，3 秒後重試');
        retry = setTimeout(() => { if (playing) play(); }, 3000);
      });
      hls.loadSource(url); hls.attachMedia(audio);
    } else if (audio.canPlayType('application/vnd.apple.mpegurl')) { audio.src = url; start(); }
    else status('瀏覽器不支援 HLS');
  }
  function toggle() { playing ? stop() : play(); }
  function sw(d) { idx = (idx + d + st.length) % st.length; label(); if (playing) play(); else status('按 F 或 ▶ 收聽'); }
  label(); status('按 F 或 ▶ 收聽');
  btn.addEventListener('click', toggle);
  $('radio-prev').addEventListener('click', () => sw(-1));
  $('radio-next').addEventListener('click', () => sw(1));
  if (vol) vol.addEventListener('input', () => { audio.volume = +vol.value; });
  return { toggle, sw };
})();

// ======================================================================= 引擎音效 (Web Audio 即時合成)
const sound = (() => {
  let ac = null, nodes = null, enabled = true, gear = 1, lastV = 0, shiftDip = 0;
  function noiseBuffer() {
    const b = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5 + w * 0.15; }
    return b;
  }
  function init() {
    if (ac) return;
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const master = ac.createGain(); master.gain.value = 0.45; master.connect(ac.destination);
    const comp = ac.createDynamicsCompressor(); comp.connect(master);
    // 引擎: 點火頻率正弦 + 半頻三角波 (低沉) + 少量二倍頻，輕微飽和後經柔和低通
    const o1 = ac.createOscillator(); o1.type = 'sine';
    const o2 = ac.createOscillator(); o2.type = 'triangle';
    const o3 = ac.createOscillator(); o3.type = 'sine';
    const g1 = ac.createGain(); g1.gain.value = 0.55; const g2 = ac.createGain(); g2.gain.value = 0.45; const g3 = ac.createGain(); g3.gain.value = 0.08;
    const shaper = ac.createWaveShaper();
    const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 1.2); }
    shaper.curve = curve;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
    const eng = ac.createGain(); eng.gain.value = 0;
    o1.connect(g1); o2.connect(g2); o3.connect(g3); g1.connect(shaper); g2.connect(shaper); g3.connect(shaper); shaper.connect(lp); lp.connect(eng); eng.connect(comp);
    // 進氣 / 排氣嘶聲
    const nb = noiseBuffer();
    const mkNoise = () => { const s = ac.createBufferSource(); s.buffer = nb; s.loop = true; s.start(); return s; };
    const intake = ac.createBiquadFilter(); intake.type = 'bandpass'; intake.Q.value = 0.8;
    const intakeG = ac.createGain(); intakeG.gain.value = 0;
    mkNoise().connect(intake); intake.connect(intakeG); intakeG.connect(comp);
    // 風切 + 胎噪
    const wind = ac.createBiquadFilter(); wind.type = 'lowpass'; wind.frequency.value = 650;
    const windG = ac.createGain(); windG.gain.value = 0;
    mkNoise().connect(wind); wind.connect(windG); windG.connect(comp);
    // 輪胎尖叫
    const sq = ac.createBiquadFilter(); sq.type = 'bandpass'; sq.frequency.value = 1900; sq.Q.value = 9;
    const sqG = ac.createGain(); sqG.gain.value = 0;
    mkNoise().connect(sq); sq.connect(sqG); sqG.connect(comp);
    [o1, o2, o3].forEach((o) => o.start());
    nodes = { o1, o2, o3, lp, eng, intake, intakeG, windG, sqG, master, nb, comp };
  }
  function update(dt) {
    if (!ac || !nodes) return;
    const v = Math.abs(S.v), t = ac.currentTime;
    const acc = (S.v - lastV) / Math.max(dt, 1e-3); lastV = S.v;
    const thr = Math.max(S.thr || 0, Math.min(1, Math.max(0, acc / 3.5)));
    // 檔位、轉速由主程式的變速箱算 (自排 / 手排)
    if (S.gear !== gear) { shiftDip = S.gear > gear ? 0.12 : 0.08; gear = S.gear; }
    const rpm = S.rpm || 800;
    shiftDip = Math.max(0, shiftDip - dt);
    const fire = rpm / 60 * 2; // 四缸四行程
    nodes.o1.frequency.setTargetAtTime(fire, t, 0.03);
    nodes.o2.frequency.setTargetAtTime(fire / 2, t, 0.03);
    nodes.o3.frequency.setTargetAtTime(fire * 2, t, 0.03);
    nodes.lp.frequency.setTargetAtTime(180 + thr * 700 + rpm * 0.08, t, 0.08);
    const eg = enabled ? (0.07 + thr * 0.13) * (shiftDip > 0 ? 0.55 : 1) : 0;
    nodes.eng.gain.setTargetAtTime(eg, t, shiftDip > 0 ? 0.03 : 0.12);
    nodes.intake.frequency.setTargetAtTime(300 + rpm * 0.12, t, 0.08);
    nodes.intakeG.gain.setTargetAtTime(enabled ? thr * 0.015 * (rpm / 6000) : 0, t, 0.08);
    nodes.windG.gain.setTargetAtTime(enabled ? Math.min(0.5, (v / 40) ** 2 * 0.22) : 0, t, 0.2);
    const latAcc = Math.abs(S.v * S.v * Math.tan(S.steer || 0) / 2.8);
    nodes.sqG.gain.setTargetAtTime(enabled && latAcc > 6.5 ? Math.min(0.12, (latAcc - 6.5) * 0.03) : 0, t, 0.05);
    if (gearEl) {
      const red = rpm > 6000 ? ' style="color:#ff5a4a"' : '';
      gearEl.innerHTML = (S.vtype === 'scooter' ? 'CVT' : (S.manual ? '手排 ' : '自排 ') + (S.v < -0.3 ? 'R' : gear) + ' 檔') + ' · <span' + red + '>' + Math.round(rpm) + ' rpm</span>'
        + (S.cruise ? ' · <b style="color:#5fd0ff">定速 ' + Math.round(S.cruise * 3.6) + '</b>' : '');
    }
  }
  // 伸縮縫「喀噔」: 模態合成 — 輪胎撞擊激發車身共振 (40~600 Hz 多個衰減模態) + 輪胎拍擊 + 內裝細碎震動 + 懸吊回彈的第二下悶響。
  // 每個輪軸壓過縫的前、後兩個邊緣各撞一次 (間隔 = 縫寬 / 車速)，左右輪差幾毫秒，每次音高、力道隨機微調，不會像機關槍。
  let jointBufs = null;
  function makeJointBufs() {
    const sr = ac.sampleRate, out = [];
    for (let variant = 0; variant < 4; variant++) {
      const len = Math.floor(sr * 0.42), b = ac.createBuffer(1, len, sr), d = b.getChannelData(0);
      const rnd = (a, z) => a + Math.random() * (z - a);
      // 車身 / 底盤模態: 頻率, 衰減時間, 振幅
      const modes = [[rnd(36, 44), 0.11, 1.0], [rnd(55, 64), 0.08, 0.75], [rnd(82, 94), 0.055, 0.55], [rnd(120, 140), 0.04, 0.4],
        [rnd(190, 230), 0.026, 0.28], [rnd(320, 380), 0.016, 0.2], [rnd(560, 680), 0.009, 0.13], [rnd(900, 1100), 0.005, 0.07]];
      const ph = modes.map(() => Math.random() * Math.PI * 2);
      let lp = 0, lp2 = 0, prev = 0;
      const rb = rnd(0.062, 0.074);   // 回彈時間
      for (let i = 0; i < len; i++) {
        const t = i / sr, att = Math.min(1, t / 0.0015);
        let v = 0;
        for (let m = 0; m < modes.length; m++) { const [f, tau, a] = modes[m]; v += a * Math.exp(-t / tau) * Math.sin(2 * Math.PI * f * t + ph[m]); }
        // 懸吊回彈: 約 70 ms 後再一下較小的低頻悶響
        const t2 = t - rb;
        if (t2 > 0) v += 0.32 * Math.min(1, t2 / 0.004) * (Math.exp(-t2 / 0.09) * Math.sin(2 * Math.PI * modes[0][0] * 1.05 * t2) + 0.6 * Math.exp(-t2 / 0.05) * Math.sin(2 * Math.PI * modes[1][0] * t2));
        // 輪胎拍擊: 低通雜訊，很短
        const n = Math.random() * 2 - 1;
        lp += (n - lp) * 0.16; lp2 += (lp - lp2) * 0.3;
        v += 1.6 * lp2 * Math.exp(-t / 0.011);
        // 內裝塑膠細碎震動: 高通雜訊，延遲一點點出現
        const hp = n - prev; prev = n;
        if (t > 0.004) v += 0.05 * hp * Math.exp(-(t - 0.004) / 0.025) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 23 * t));
        d[i] = v * att;
      }
      let pk = 0; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(d[i]));
      for (let i = 0; i < len; i++) d[i] /= pk || 1;
      out.push(b);
    }
    return out;
  }
  function knock(v, axle) {
    if (!ac || !enabled) return;
    if (!jointBufs) jointBufs = makeJointBufs();
    const t0 = ac.currentTime + 0.002;
    const sp = Math.max(1, v);
    const k = Math.min(1.1, Math.pow(sp / 25, 0.8)) * (axle ? 0.78 : 1) * (0.9 + Math.random() * 0.2);
    const out = ac.createBiquadFilter();   // 車內聽到的: 高頻被車身擋掉，車速快一點比較亮
    out.type = 'lowpass'; out.frequency.value = Math.min(4200, 1100 + sp * 70) * (axle ? 0.8 : 1); out.Q.value = 0.5;
    const og = ac.createGain(); og.gain.value = 0.85;
    out.connect(og); og.connect(nodes.comp);
    const gapT = Math.min(0.045, Math.max(0.006, 0.38 / sp));   // 縫的前後兩個邊緣
    const lr = Math.random() * 0.004;                             // 左右輪時間差
    const hits = [[0, 1], [lr, 0.55], [gapT, 0.7], [gapT + lr, 0.4]];
    for (const [dt, a] of hits) {
      const s = ac.createBufferSource();
      s.buffer = jointBufs[(Math.random() * jointBufs.length) | 0];
      s.playbackRate.value = (axle ? 0.92 : 1) * (0.94 + Math.random() * 0.12) * (0.9 + Math.min(0.25, sp / 140));
      const g = ac.createGain(); g.gain.value = k * a * 0.75;
      s.connect(g); g.connect(out); s.start(t0 + dt); s.stop(t0 + dt + 0.45);
    }
    // 疊加撞車的悶響 (較輕、隨車速變大)，前後兩個邊緣各一下
    bump(0.42 * k, 0);
    bump(0.26 * k, gapT);
  }
  /** 撞擊悶響; amp = 音量倍率 (撞車 1), delay = 延遲秒數 */
  function bump(amp = 1, delay = 0) {
    if (!ac || !enabled) return;
    const s = ac.createBufferSource(); s.buffer = nodes.nb;
    const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400;
    const g = ac.createGain(); const t = ac.currentTime + delay;
    g.gain.setValueAtTime(0.9 * amp, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    s.connect(f); f.connect(g); g.connect(nodes.comp); s.start(t); s.stop(t + 0.4);
  }
  let lastBlink = false;
  function blinker() {   // 方向燈滴答聲
    const on = S.signal ? (performance.now() % 666) < 333 : false;
    if (!ac || !enabled || on === lastBlink) { lastBlink = on; return; }
    lastBlink = on;
    if (!S.signal && !on) return;
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
    o.type = 'square'; o.frequency.value = on ? 1700 : 1150;
    g.gain.setValueAtTime(0.06, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.035);
    o.connect(g); g.connect(nodes.comp); o.start(t); o.stop(t + 0.04);
  }
  function toggle() { enabled = !enabled; init(); }
  const gearEl = $('gear');
  const unlock = () => { init(); if (ac.state === 'suspended') ac.resume(); if (!jointBufs) jointBufs = makeJointBufs(); };
  window.addEventListener('keydown', unlock, { once: false });
  window.addEventListener('pointerdown', unlock, { once: false });
  // 切到別的分頁: 畫面停了但 AudioContext 會照最後的參數一直響 (引擎聲嗡嗡叫)，跟著暫停 / 回來再繼續
  document.addEventListener('visibilitychange', () => {
    if (!ac) return;
    if (document.visibilityState === 'hidden') { if (ac.state === 'running') ac.suspend(); }
    else if (ac.state === 'suspended' && enabled) ac.resume();
  });
  if (TW.params.has('audiotest')) { unlock(); setTimeout(() => { let err = null; try { for (let i = 0; i < 6; i++) knock(10 + i * 5, i & 1); } catch (e) { err = String(e); } console.log('[audiotest] knock ok', !err, err || '', 'bufs', jointBufs ? jointBufs.length : 0, 'state', ac.state); }, 500); }
  return { update, bump, knock, blinker, toggle, get on() { return enabled; } };
})();

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyF') radio.toggle();
  if (e.code === 'KeyZ') radio.sw(-1);
  if (e.code === 'KeyX') radio.sw(1);
  if (e.code === 'KeyN') sound.toggle();
});

// ======================================================================= HUD: 目前路段路況
const trafficEl = $('traffic');
const DIR_NAME = { N: '北上', S: '南下', E: '東向', W: '西向' };
let hudClock = 0;
function updateTrafficHud(dt) {
  hudClock -= dt;
  if (hudClock > 0) return;
  hudClock = 0.3;
  const w = S.road && S.road.w;
  const t = w ? wayTraffic[w.k] : null, mp = w ? WAYMAP[w.gid] : null;
  if (!t) { trafficEl.textContent = w && w.link ? '匝道 · 路況 ' + srcLabel() : '路況 ' + srcLabel(); trafficEl.style.borderColor = LV_COLOR[0]; return; }
  const lv = levelOf(t);
  trafficEl.innerHTML = `<b style="color:${LV_COLOR[lv]}">${t.speed > 0 ? t.speed + ' km/h · ' : ''}${LV_NAME[lv]}</b>　${DIR_NAME[mp[1]] || ''} ${t.from} → ${t.to}　<small>${srcLabel()}</small>`;
  trafficEl.style.borderColor = LV_COLOR[lv];
}

// ======================================================================= 手機定位同步 (透過電腦上的 scripts/phone_location.py)
// TWD97 TM2 (EPSG:3826) 正算，與 prep_freeway.py 相同公式
const A = 6378137, F = 1 / 298.257222101, E2 = F * (2 - F), EP2 = E2 / (1 - E2), K0 = 0.9999, LON0 = 121, FE = 250000;
function tm2(lat, lon) {
  const phi = lat * Math.PI / 180, lam = (lon - LON0) * Math.PI / 180;
  const s = Math.sin(phi), c = Math.cos(phi), N = A / Math.sqrt(1 - E2 * s * s), Tn = Math.tan(phi) ** 2, C = EP2 * c * c, Aa = c * lam;
  const e4 = E2 * E2, e6 = e4 * E2;
  const M = A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
  const x = FE + K0 * N * (Aa + (1 - Tn + C) * Aa ** 3 / 6 + (5 - 18 * Tn + Tn * Tn + 72 * C - 58 * EP2) * Aa ** 5 / 120);
  const y = K0 * (M + N * Math.tan(phi) * (Aa * Aa / 2 + (5 - Tn + 9 * C + 4 * C * C) * Aa ** 4 / 24 + (61 - 58 * Tn + Tn * Tn + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  return [x, y];
}
/** 遊戲座標 (公尺) -> 經緯度 (牛頓法反算) */
function toLatLon(x, y) {
  const X = x + TW.ORIGIN[0], Y = y + TW.ORIGIN[1];
  let lat = 25.03, lon = 121.55;
  for (let k = 0; k < 6; k++) {
    const [fx, fy] = tm2(lat, lon), h = 1e-6;
    const [ax, ay] = tm2(lat + h, lon), [bx, by] = tm2(lat, lon + h);
    const j11 = (ax - fx) / h, j21 = (ay - fy) / h, j12 = (bx - fx) / h, j22 = (by - fy) / h;
    const rx = X - fx, ry = Y - fy, det = j11 * j22 - j12 * j21;
    lat += (j22 * rx - j12 * ry) / det; lon += (-j21 * rx + j11 * ry) / det;
  }
  return [lat, lon];
}

// 遊戲每秒把車子的經緯度送到橋接程式，橋接程式再透過 Wi-Fi 設成手機的「模擬定位」(Android adb / iPhone)。
const gpsSync = (() => {
  const url = (TW.params.get('gps') || 'http://127.0.0.1:8765').replace(/\/$/, '');
  const el = $('gps');
  let on = false, clock = 0, busy = false, status = '';
  const show = () => { el.textContent = on ? '📱 ' + status : ''; };
  async function post(path, body) {
    const r = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return r.json();
  }
  async function send() {
    if (busy) return;
    busy = true;
    const [lat, lon] = toLatLon(S.x, S.y);
    const course = ((90 - S.h * 180 / Math.PI) % 360 + 360) % 360;   // 正北 0°、順時針
    try {
      const j = await post('/loc', { lat, lon, speed: Math.max(0, S.v), course });
      status = j.ok ? `同步中 ${lat.toFixed(5)}, ${lon.toFixed(5)}${j.device ? '' : '（找不到手機）'}` : ('橋接程式錯誤: ' + (j.error || ''));
    } catch (e) {
      status = '連不到電腦上的橋接程式';
    }
    busy = false; show();
  }
  function toggle() {
    on = !on; clock = 0; status = on ? '連線中…' : '';
    if (!on) post('/clear').catch(() => {});
    show();
  }
  function frame(dt) { if (!on) return; clock -= dt; if (clock <= 0) { clock = 0.5; send(); } }   // 每秒 2 次，手機 App 才會判定「正在移動」並用行進方向
  const btn = $('menu-gps');
  if (btn) btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (e) => { if (e.code === 'KeyL') toggle(); });
  return { toggle, frame, toLatLon, get on() { return on; } };
})();

// ======================================================================= 手機觸控按鍵 (模擬鍵盤)
(() => {
  if (!TW.MOBILE) return;
  document.body.classList.add('touch');
  const pad = $('touch');
  if (!pad) return;
  pad.classList.remove('hidden');
  const send = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
  // 按住型: 方向、油門、煞車 (可多指同時按)
  for (const el of pad.querySelectorAll('[data-key]')) {
    const code = el.dataset.key;
    let held = false;
    const down = (e) => { e.preventDefault(); if (el.setPointerCapture) el.setPointerCapture(e.pointerId); held = true; el.classList.add('on'); send('keydown', code); };
    const up = (e) => { e.preventDefault(); if (!held) return; held = false; el.classList.remove('on'); send('keyup', code); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
  }
  // 點一下型: 方向燈、視角、自動駕駛、換車、選單
  for (const el of pad.querySelectorAll('[data-tap]')) {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); send('keydown', el.dataset.tap); setTimeout(() => send('keyup', el.dataset.tap), 80); });
  }
  // 切到背景時放開所有按鍵 (避免車子自己一直開)
  document.addEventListener('visibilitychange', () => { for (const el of pad.querySelectorAll('[data-key]')) { el.classList.remove('on'); send('keyup', el.dataset.key); } });
})();

// ======================================================================= 操控設定: 按鈕 / 螢幕方向盤 / 重力感應 / 實體方向盤・搖桿
const controls = (() => {
  const DEF = { mode: TW.MOBILE ? 'buttons' : 'keys', sens: 1, lock: 180, size: 1, side: 'left', center: true, tiltMax: 35, pad: true, padInv: false, dead: 0.06, padMap: null };
  let C = { ...DEF };
  try { Object.assign(C, JSON.parse(localStorage.getItem('tw_ctrl') || '{}')); } catch (_) {}
  const testMode = TW.params.get('steer');   // 測試用: ?steer=wheel (不存檔)
  if (testMode) C.mode = testMode;
  const save = () => { if (testMode) return; try { localStorage.setItem('tw_ctrl', JSON.stringify(C)); } catch (_) {} };
  let rot = 0, dragging = false, lastAng = 0, tiltZero = 0, tiltVal = null, padAxis = 0, padThr = 0, padBrk = 0, padSeen = false, padPrev = [], wiz = null;

  // ---- 螢幕方向盤
  const css = document.createElement('style');
  css.textContent = `
  #wheel { position: fixed; bottom: calc(18px + env(safe-area-inset-bottom)); z-index: 4; touch-action: none; user-select: none; -webkit-user-select: none; cursor: grab; }
  #wheel svg { width: 100%; height: 100%; display: block; filter: drop-shadow(0 4px 10px rgba(0,0,0,.45)); }
  #wheel.hidden { display: none; }
  #ctrl-panel .row2 { display: flex; align-items: center; gap: 10px; margin: 6px 0; font-size: 14px; }
  #ctrl-panel .row2 label { width: 120px; flex: none; opacity: .85; }
  #ctrl-panel .row2 input[type=range] { flex: 1; }
  #ctrl-panel .row2 output { width: 56px; text-align: right; font-variant-numeric: tabular-nums; }
  #ctrl-panel .seg { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  #ctrl-panel .seg button { flex: 1 1 110px; text-align: center; }
  body.wheel-right #t-gas { right: auto; left: calc(22px + env(safe-area-inset-left)); }
  body.wheel-right #t-brake { right: auto; left: calc(140px + env(safe-area-inset-left)); }
  #ctrl-panel .hint { font-size: 12px; opacity: .65; margin: 2px 0 10px; }`;
  document.head.appendChild(css);
  const wheel = document.createElement('div');
  wheel.id = 'wheel'; wheel.className = 'hidden';
  wheel.innerHTML = `<svg viewBox="-100 -100 200 200">
    <circle r="88" fill="none" stroke="rgba(20,22,26,.85)" stroke-width="20"/>
    <circle r="88" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="2"/>
    <circle r="98" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1.5"/>
    <g fill="rgba(26,28,33,.9)" stroke="rgba(255,255,255,.3)" stroke-width="1.5">
      <path d="M-80 8 L-26 14 L-22 30 L-70 44 Z"/><path d="M80 8 L26 14 L22 30 L70 44 Z"/><path d="M-14 26 L14 26 L10 80 L-10 80 Z"/>
    </g>
    <circle r="30" fill="rgba(30,33,40,.95)" stroke="rgba(255,255,255,.4)" stroke-width="2"/>
    <rect x="-5" y="-98" width="10" height="20" rx="3" fill="#e63b2e"/>
    <text y="7" text-anchor="middle" font-size="16" fill="rgba(255,255,255,.75)" font-family="sans-serif">TW</text>
  </svg>`;
  document.body.appendChild(wheel);
  const angAt = (e) => { const r = wheel.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
  wheel.addEventListener('pointerdown', (e) => { e.preventDefault(); try { wheel.setPointerCapture(e.pointerId); } catch (_) {} dragging = true; lastAng = angAt(e); wheel.style.cursor = 'grabbing'; });
  wheel.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const a = angAt(e); let d = a - lastAng; if (d > 180) d -= 360; if (d < -180) d += 360;
    lastAng = a; rot = Math.max(-C.lock, Math.min(C.lock, rot + d));
  });
  const release = () => { dragging = false; wheel.style.cursor = 'grab'; };
  wheel.addEventListener('pointerup', release); wheel.addEventListener('pointercancel', release); wheel.addEventListener('lostpointercapture', release);

  // ---- 重力感應 (橫拿手機: 左右傾斜)
  function onTilt(e) {
    const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    let t = ang === 90 ? e.beta : ang === -90 || ang === 270 ? -e.beta : e.gamma;
    if (t == null) return;
    tiltVal = t;
  }
  async function enableTilt() {
    try { if (window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) { const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') return false; } } catch (_) { return false; }
    window.addEventListener('deviceorientation', onTilt);
    return true;
  }

  // ---- 套用設定: 顯示 / 隱藏方向盤與按鈕
  function apply() {
    const sz = Math.round((TW.MOBILE ? 150 : 190) * C.size);
    wheel.style.width = wheel.style.height = sz + 'px';
    wheel.style.left = C.side === 'left' ? 'calc(18px + env(safe-area-inset-left))' : '';
    wheel.style.right = C.side === 'right' ? 'calc(18px + env(safe-area-inset-right))' : '';
    wheel.classList.toggle('hidden', C.mode !== 'wheel');
    for (const id of ['t-left', 't-right']) { const el = $(id); if (el) el.style.display = C.mode === 'buttons' || C.mode === 'keys' ? '' : 'none'; }
    document.body.classList.toggle('wheel-right', C.mode === 'wheel' && C.side === 'right');   // 方向盤在右邊時，油門煞車移到左邊
    if (C.mode === 'tilt') enableTilt();
    if (!TW.MOBILE && C.mode === 'wheel' && $('help')) $('help').classList.add('hidden');   // 電腦版方向盤在左下，說明先收起 (H 可再打開)
    save();
  }

  // ---- 每格: 算出類比轉向 (-1 右 .. 1 左)，交給主程式
  function frame(dt) {
    let axis = null;
    if (C.mode === 'wheel') {
      if (!dragging && C.center) rot *= Math.exp(-dt * 7);
      if (Math.abs(rot) < 0.3 && !dragging) rot = 0;
      wheel.firstElementChild.style.transform = `rotate(${rot}deg)`;
      axis = -rot / C.lock * C.sens;
    } else if (C.mode === 'tilt' && tiltVal != null) {
      const t = tiltVal - tiltZero, td = Math.abs(t) < 3 ? 0 : t - Math.sign(t) * 3;   // 3° 死區，拿手機的小晃動不算
      axis = -td / Math.max(5, C.tiltMax - 3) * C.sens;
    }
    // 實體方向盤 / 搖桿 (Gamepad API)
    padThr = padBrk = 0;
    if (C.pad && navigator.getGamepads) {
      for (const gp of navigator.getGamepads()) {
        if (!gp || !gp.connected) continue;
        if (wiz) { wizFrame(gp); break; }
        const M = C.padMap && C.padMap.id === gp.id ? C.padMap : null;
        const pedal = (m) => {
          if (!m) return 0;
          if (m.button != null) return gp.buttons[m.button] ? gp.buttons[m.button].value : 0;
          const v = gp.axes[m.axis]; if (v == null) return 0;
          return Math.max(0, Math.min(1, (v - m.rest) / ((m.full - m.rest) || 1)));
        };
        let x = gp.axes[0] || 0;
        if (M && M.steer) x = -Math.max(-1, Math.min(1, ((gp.axes[M.steer.axis] || 0) - M.steer.rest) / M.steer.span));   // 校正後: 左 = -1 (跟標準搖桿一樣)
        const ax = Math.abs(x) < C.dead ? 0 : (x - Math.sign(x) * C.dead) / (1 - C.dead);
        if (M) { padThr = pedal(M.thr); padBrk = pedal(M.brk); }
        else { padThr = gp.buttons[7] ? gp.buttons[7].value : 0; padBrk = gp.buttons[6] ? gp.buttons[6].value : 0; }
        const btn = (i) => !!(gp.buttons[i] && gp.buttons[i].pressed);
        const edge = (i) => btn(i) && !padPrev[i];
        if (edge(5)) TW.shift(1);
        if (edge(4)) TW.shift(-1);
        if (edge(3)) TW.toggleCruise();
        padPrev = gp.buttons.map((b) => b.pressed);
        if (ax || padThr > 0.02 || padBrk > 0.02) padSeen = true;
        if (padSeen) { padAxis = (C.padInv ? ax : -ax) * C.sens; if (axis == null || Math.abs(padAxis) > Math.abs(axis)) axis = padAxis; }
        break;
      }
    }
    S.steerAxis = axis == null ? null : Math.max(-1, Math.min(1, axis));
    S.padThr = padThr; S.padBrk = padBrk;
  }

  // ---- 實體方向盤校正精靈: 左打到底 -> 放開踩油門 -> 踩煞車 (每個步驟自動偵測變化最大的軸 / 按鍵)
  const wizEl = document.createElement('div');
  wizEl.id = 'pad-wiz'; wizEl.className = 'hidden';
  document.body.appendChild(wizEl);
  const STEPS = [
    ['🛞 把方向盤 (或搖桿) <b>往左打到底</b>，維持住', 'steer'],
    ['🦶 放開方向盤，<b>把油門踩到底</b>，維持住', 'thr'],
    ['🦶 放開油門，<b>把煞車踩到底</b>，維持住', 'brk'],
  ];
  function startWizard() {
    const gps = navigator.getGamepads ? [...navigator.getGamepads()].filter((g) => g && g.connected) : [];
    wizEl.classList.remove('hidden');
    if (!gps.length) {
      wizEl.innerHTML = '<h3>實體方向盤 / 搖桿設定</h3><p>還沒偵測到裝置。請插上 USB 或藍牙連線後，<b>轉一下方向盤或按任意鍵</b>（瀏覽器要先看到動作才會出現）。</p><div class="seg"><button id="wiz-retry">再試一次</button><button id="wiz-x">關閉</button></div>';
      $('wiz-retry').onclick = startWizard; $('wiz-x').onclick = () => wizEl.classList.add('hidden');
      return;
    }
    wiz = { step: 0, rest: null, hold: 0, map: { id: gps[0].id }, name: gps[0].id };
    showStep();
  }
  function showStep() {
    const [txt] = STEPS[wiz.step];
    wizEl.innerHTML = `<h3>設定：${wiz.name.replace(/</g, '')}</h3><p class="step">步驟 ${wiz.step + 1} / 3</p><p class="big">${txt}</p>
      <div class="bar"><i id="wiz-bar"></i></div><p class="hint">偵測到就會自動進入下一步。${wiz.step ? '沒有踏板 (用搖桿板機) 可以按「跳過」用預設的 RT / LT。' : ''}</p>
      <div class="seg">${wiz.step ? '<button id="wiz-skip">跳過</button>' : ''}<button id="wiz-x">取消</button></div>`;
    $('wiz-x').onclick = () => { wiz = null; wizEl.classList.add('hidden'); };
    if ($('wiz-skip')) $('wiz-skip').onclick = () => nextStep(null);
    wiz.rest = null; wiz.hold = 0;
  }
  const desc = (m) => !m ? '預設' : m.button != null ? '按鍵 ' + m.button : '第 ' + m.axis + ' 軸';
  function nextStep(m) {
    const key = STEPS[wiz.step][1];
    if (m) wiz.map[key] = m;
    wiz.step++;
    if (wiz.step >= STEPS.length) {
      if (!wiz.map.thr && !wiz.map.brk) { wiz.map.thr = { button: 7 }; wiz.map.brk = { button: 6 }; }
      C.padMap = wiz.map; C.pad = true; save();
      wizEl.innerHTML = `<h3>✅ 設定完成</h3><p>方向盤：第 ${wiz.map.steer ? wiz.map.steer.axis : '-'} 軸　油門：${desc(wiz.map.thr)}　煞車：${desc(wiz.map.brk)}</p><p class="hint">換檔撥片 / RB、LB：升降檔 (手排，按 B 切換)　Y：定速巡航。設定記在這台裝置，選單 (T) → 操控設定可以重新設定。</p><div class="seg"><button id="wiz-x">開始開車</button></div>`;
      $('wiz-x').onclick = () => wizEl.classList.add('hidden');
      wiz = null; padSeen = true;
      return;
    }
    showStep();
  }
  function wizFrame(gp) {
    const axes = [...gp.axes], btns = gp.buttons.map((b) => b.value);
    if (!wiz.rest) { wiz.rest = { axes, btns }; return; }
    const key = STEPS[wiz.step][1], used = new Set(['steer', 'thr', 'brk'].map((k) => wiz.map[k] && wiz.map[k].axis).filter((v) => v != null));
    let best = null, bd = 0;
    axes.forEach((v, i) => { if (used.has(i)) return; const d = Math.abs(v - wiz.rest.axes[i]); if (d > bd) { bd = d; best = { axis: i, v }; } });
    let bb = null;
    if (key !== 'steer') btns.forEach((v, i) => { if (v - wiz.rest.btns[i] > 0.5 && bb == null) bb = i; });
    const need = key === 'steer' ? 0.45 : 0.35;
    const bar = $('wiz-bar'); if (bar) bar.style.width = Math.min(100, (bb != null ? 1 : bd / need) * 100) + '%';
    if (bb != null || bd > need) {
      wiz.hold += 1 / 60;
      if (wiz.hold > 0.6) {
        if (bb != null) nextStep({ button: bb });
        else if (key === 'steer') nextStep({ axis: best.axis, rest: wiz.rest.axes[best.axis], span: (best.v - wiz.rest.axes[best.axis]) || -1 });
        else nextStep({ axis: best.axis, rest: wiz.rest.axes[best.axis], full: best.v });
      }
    } else wiz.hold = 0;
  }
  window.addEventListener('gamepadconnected', (e) => {
    const id = e.gamepad.id || '搖桿';
    const isWheel = /wheel|g29|g920|g923|t300|t150|tmx|thrustmaster|fanatec|moza|logitech.*racing|driving force/i.test(id);
    if (isWheel && !(C.padMap && C.padMap.id === id)) {
      TW.toast('🛞 偵測到方向盤：' + id.slice(0, 40) + '，開始踏板設定…', 2600);
      setTimeout(startWizard, 900);
    } else TW.toast('🎮 已連接：' + id.slice(0, 40) + '（轉動即可使用）', 2600);
  });

  // ---- 新手引導: 第一次開啟時選操控方式 (之後選單或「🛞 操控」按鈕可再打開)
  const guide = document.createElement('div');
  guide.id = 'ctrl-guide'; guide.className = 'hidden';
  document.body.appendChild(guide);
  function openGuide() {
    const cards = TW.MOBILE ? [
      ['buttons', '◀ ▶', '按鈕', '左下角 ◀ ▶ 轉向，右下角油門、煞車。最簡單。'],
      ['wheel', '🛞', '螢幕方向盤', '用手指轉左下角的方向盤，放開會自動回正。'],
      ['tilt', '📱', '重力感應', '橫拿手機左右傾斜轉向 (iPhone 會詢問權限)。'],
      ['pad', '🎮', '藍牙搖桿', '連上藍牙搖桿：左搖桿轉向、RT 油門、LT 煞車。'],
    ] : [
      ['keys', '⌨️', '鍵盤', 'W / ↑ 油門、S / ↓ 煞車、A D / ← → 轉向。K 車道置中輔助。'],
      ['wheel', '🛞', '螢幕方向盤', '用滑鼠拖左下角的方向盤轉向，放開會自動回正。'],
      ['pad', '🎮', '實體方向盤 / 搖桿', '插上 USB 方向盤 (羅技、圖馬思特…) 或搖桿，跟著步驟校正方向盤與踏板。'],
    ];
    guide.innerHTML = `<div class="box"><h2>選擇操控方式</h2><p class="hint">之後可以在 選單 (T) → 操控設定 隨時更改，設定會記在這台裝置。</p>
      <div class="cards">${cards.map(([k, ic, n, d]) => `<button data-k="${k}" class="${(k === C.mode || (k === 'pad' && padSeen)) ? 'on' : ''}"><span class="ic">${ic}</span><b>${n}</b><small>${d}</small></button>`).join('')}</div>
      <p class="keys">${TW.MOBILE ? '右上角：方向燈、視角、自動駕駛、選單、全螢幕。橫拿手機比較好玩。' : 'P 自動駕駛　V 視角　B 自排/手排　U J 升降檔　I 定速巡航　Y 天氣　T 選單 (導航、任務、傳送)　H 說明'}</p>
      <div class="seg"><button id="guide-ok">開始開車</button></div></div>`;
    guide.classList.remove('hidden');
    for (const b of guide.querySelectorAll('.cards button')) b.onclick = () => {
      const k = b.dataset.k;
      if (k === 'pad') { C.pad = true; save(); guide.classList.add('hidden'); startWizard(); return; }
      C.mode = k; rot = 0; apply(); if (window._ctrlSync) window._ctrlSync();
      for (const o of guide.querySelectorAll('.cards button')) o.classList.toggle('on', o === b);
    };
    $('guide-ok').onclick = () => guide.classList.add('hidden');
    try { localStorage.setItem('tw_onboard', '1'); } catch (_) {}
  }
  css.textContent += `
  #pad-wiz, #ctrl-guide { position: fixed; z-index: 30; color: #fff; }
  #pad-wiz { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(480px, 92vw); padding: 18px 22px; border-radius: 16px; background: rgba(12,16,22,.95); box-shadow: 0 10px 40px rgba(0,0,0,.6); }
  #pad-wiz h3 { margin: 0 0 8px; font-size: 17px; } #pad-wiz .big { font-size: 20px; margin: 14px 0; } #pad-wiz .step { opacity: .6; margin: 0; font-size: 13px; }
  #pad-wiz .bar { height: 10px; border-radius: 5px; background: rgba(255,255,255,.12); overflow: hidden; } #pad-wiz .bar i { display: block; height: 100%; width: 0; background: #2f80ff; transition: width .1s; }
  #pad-wiz .seg, #ctrl-guide .seg { display: flex; gap: 8px; margin-top: 12px; }
  #pad-wiz button, #ctrl-guide button { padding: 9px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.1); color: #fff; font-size: 14px; cursor: pointer; flex: 1; }
  #pad-wiz .hint, #ctrl-guide .hint { font-size: 12px; opacity: .65; }
  #ctrl-guide { inset: 0; background: rgba(0,0,0,.55); display: flex; align-items: center; justify-content: center; }
  #ctrl-guide.hidden { display: none; }
  #ctrl-guide .box { width: min(760px, 94vw); max-height: 92vh; overflow: auto; padding: 18px 22px; border-radius: 18px; background: rgba(12,16,22,.96); box-shadow: 0 10px 40px rgba(0,0,0,.6); }
  #ctrl-guide h2 { margin: 0 0 4px; font-size: 20px; }
  #ctrl-guide .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 12px 0; }
  #ctrl-guide .cards button { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 10px; text-align: center; }
  #ctrl-guide .cards button.on { background: #2f80ff; border-color: #2f80ff; }
  #ctrl-guide .ic { font-size: 34px; } #ctrl-guide small { opacity: .8; font-size: 12px; line-height: 1.45; }
  #ctrl-guide .keys { font-size: 13px; opacity: .85; line-height: 1.7; }
  #ctrl-guide #guide-ok { background: #2f80ff; border-color: #2f80ff; font-size: 16px; }`;

  // ---- 選單: 操控設定
  function buildPanel() {
    const menu = $('menu'); if (!menu || $('ctrl-panel')) return;
    const p = document.createElement('div'); p.id = 'ctrl-panel';
    const modes = TW.MOBILE ? [['buttons', '◀ ▶ 按鈕'], ['wheel', '🛞 方向盤'], ['tilt', '📱 重力感應']] : [['keys', '⌨️ 鍵盤'], ['wheel', '🛞 螢幕方向盤']];
    p.innerHTML = `<h2>操控設定</h2><div class="seg" id="ctrl-mode">${modes.map(([k, n]) => `<button data-m="${k}">${n}</button>`).join('')}</div>
      <div class="row2"><label>轉向靈敏度</label><input type="range" id="ctrl-sens" min="0.4" max="2.5" step="0.05"><output id="ctrl-sens-o"></output></div>
      <div class="row2" data-for="wheel"><label>方向盤打到底</label><input type="range" id="ctrl-lock" min="60" max="540" step="10"><output id="ctrl-lock-o"></output></div>
      <div class="row2" data-for="wheel"><label>方向盤大小</label><input type="range" id="ctrl-size" min="0.6" max="1.6" step="0.05"><output id="ctrl-size-o"></output></div>
      <div class="seg" data-for="wheel"><button id="ctrl-side">方向盤位置</button><button id="ctrl-center">放開自動回正</button></div>
      <div class="row2" data-for="tilt"><label>傾斜打到底</label><input type="range" id="ctrl-tilt" min="15" max="70" step="1"><output id="ctrl-tilt-o"></output></div>
      <div class="seg" data-for="tilt"><button id="ctrl-zero">以目前角度為正中 (校正)</button></div>
      <div class="seg"><button id="ctrl-pad">實體方向盤 / 搖桿</button><button id="ctrl-padinv">搖桿方向反轉</button><button id="ctrl-wiz">🛞 校正方向盤 / 踏板</button><button id="ctrl-guide-btn">❓ 操控引導</button></div>
      <div class="hint">實體方向盤或搖桿：插上後轉一下就會偵測到；X 軸轉向、RT 油門、LT 煞車。設定會記在這台裝置。</div>`;
    menu.appendChild(p);
    const sync = () => {
      for (const b of p.querySelectorAll('#ctrl-mode button')) b.classList.toggle('on', b.dataset.m === C.mode);
      for (const el of p.querySelectorAll('[data-for]')) el.style.display = el.dataset.for === C.mode ? '' : 'none';
      $('ctrl-sens').value = C.sens; $('ctrl-sens-o').textContent = '×' + (+C.sens).toFixed(2);
      $('ctrl-lock').value = C.lock; $('ctrl-lock-o').textContent = '±' + C.lock + '°';
      $('ctrl-size').value = C.size; $('ctrl-size-o').textContent = Math.round(C.size * 100) + '%';
      $('ctrl-tilt').value = C.tiltMax; $('ctrl-tilt-o').textContent = C.tiltMax + '°';
      $('ctrl-side').textContent = '方向盤位置：' + (C.side === 'left' ? '左邊' : '右邊');
      $('ctrl-center').textContent = '放開自動回正：' + (C.center ? '開' : '關'); $('ctrl-center').classList.toggle('on', C.center);
      $('ctrl-pad').textContent = '實體方向盤 / 搖桿：' + (C.pad ? '開' : '關'); $('ctrl-pad').classList.toggle('on', C.pad);
      $('ctrl-padinv').classList.toggle('on', C.padInv);
      apply();
    };
    for (const b of p.querySelectorAll('#ctrl-mode button')) b.onclick = () => { C.mode = b.dataset.m; rot = 0; sync(); };
    const slider = (id, key) => { $(id).oninput = (e) => { C[key] = +e.target.value; sync(); }; };
    slider('ctrl-sens', 'sens'); slider('ctrl-lock', 'lock'); slider('ctrl-size', 'size'); slider('ctrl-tilt', 'tiltMax');
    $('ctrl-side').onclick = () => { C.side = C.side === 'left' ? 'right' : 'left'; sync(); };
    $('ctrl-center').onclick = () => { C.center = !C.center; sync(); };
    $('ctrl-zero').onclick = () => { if (tiltVal != null) tiltZero = tiltVal; };
    $('ctrl-pad').onclick = () => { C.pad = !C.pad; sync(); };
    $('ctrl-padinv').onclick = () => { C.padInv = !C.padInv; sync(); };
    $('ctrl-wiz').onclick = () => { TW.toggleMenu(false); startWizard(); };
    $('ctrl-guide-btn').onclick = () => { TW.toggleMenu(false); openGuide(); };
    window._ctrlSync = sync;
    sync();
  }
  buildPanel(); apply();
  // 第一次開: 顯示操控引導 (測試時不顯示)
  let onboarded = false; try { onboarded = localStorage.getItem('tw_onboard') === '1'; } catch (_) {}
  if (!onboarded && !TW.params.has('t') && !TW.params.has('camat') && !TW.params.has('noguide')) setTimeout(openGuide, 1500);
  if (TW.params.has('wheeltest')) setTimeout(() => {   // 測試: 模擬手指把方向盤順時針轉 90°
    const r = wheel.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width * 0.42;
    const ev = (type, a) => wheel.dispatchEvent(new PointerEvent(type, { pointerId: 7, bubbles: true, clientX: cx + Math.cos(a) * R, clientY: cy + Math.sin(a) * R }));
    ev('pointerdown', -Math.PI / 2);
    for (let k = 1; k <= 9; k++) ev('pointermove', -Math.PI / 2 + k * Math.PI / 18);
    setTimeout(() => { for (let k = 0; k < 30; k++) frame(1 / 60); console.log('[wheeltest] held rot', rot.toFixed(1), 'axis', S.steerAxis && S.steerAxis.toFixed(3), 'steer', S.steer.toFixed(3), 'h', S.h.toFixed(3));
      ev('pointerup', 0); setTimeout(() => { for (let k = 0; k < 60; k++) frame(1 / 60); console.log('[wheeltest] released rot', rot.toFixed(1), 'axis', S.steerAxis, 'steer', S.steer.toFixed(3)); }, 1500); }, 1000);
  }, 1500);
  return { frame, openGuide, startWizard, get settings() { return C; } };
})();

// ======================================================================= 掛上主程式
TW.HOOKS.init.push(() => {
  initTraffic();
  pollSpeed(); pollCms(); setInterval(pollSnmTraffic, 5000); pollSnmTraffic();
  if (TW.params.get('radio') === 'auto') radio.toggle(); // 測試用
  if (TW.params.has('gpsauto')) gpsSync.toggle();      // 測試用
});
// ======================================================================= 樹木 (玩家附近的山坡、山區)
// 18 m 一格，依格子雜湊決定有沒有樹 (同一個地方每次都一樣)。只長在坡度 6° 以上或海拔 150 m 以上 (山區少建築)，
// 道路兩側 8 m 內、高架下方都不種。玩家移動 150 m 以上才重新排一次。
const trees = (() => {
  if (TW.params.has('notrees')) return { update() {}, dirty() {} };
  const CAP = TW.MOBILE ? 700 : 7000, R = TW.MOBILE ? 320 : 900, STEP = 18;
  const crownGeo = new T.IcosahedronGeometry(1, 1);
  { // 樹冠稍微壓扁、表面不規則
    const p = crownGeo.getAttribute('position');
    for (let i = 0; i < p.count; i++) { const k = 0.85 + 0.3 * Math.abs(Math.sin(p.getX(i) * 7.1 + p.getZ(i) * 5.3)); p.setXYZ(i, p.getX(i) * k, p.getY(i) * 0.8 * k, p.getZ(i) * k); }
    crownGeo.computeVertexNormals();
  }
  const trunkGeo = new T.CylinderGeometry(0.12, 0.2, 1, 6);
  // 近 (220 m 內，投射陰影) / 遠 (不投射、樹冠面數少) 兩組: 陰影那一輪只畫近的 (以前 7000 棵全畫，約 60 萬三角形)
  const NEAR_R = 220, crownFar = new T.IcosahedronGeometry(1, 0);
  { const p = crownFar.getAttribute('position'); for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * 0.8); crownFar.computeVertexNormals(); }
  const crownMat = new T.MeshStandardMaterial({ roughness: 0.9, metalness: 0, flatShading: true }), trunkMat = new T.MeshStandardMaterial({ color: 0x3b2a1c, roughness: 0.95 });
  const crown = new T.InstancedMesh(crownGeo, crownMat, CAP), trunk = new T.InstancedMesh(trunkGeo, trunkMat, CAP);
  const crownF = new T.InstancedMesh(crownFar, crownMat, CAP), trunkF = new T.InstancedMesh(trunkGeo, trunkMat, CAP);
  for (const m of [crown, trunk, crownF, trunkF]) { m.castShadow = m === crown || m === trunk; m.receiveShadow = true; m.count = 0; m.frustumCulled = false; TW.scene.add(m); }
  const M4 = new T.Matrix4(), Q = new T.Quaternion(), V = new T.Vector3(), SC = new T.Vector3(), COL = new T.Color(), UP = new T.Vector3(0, 1, 0);
  const hash = (i, j, k) => { let h = (i * 374761393 + j * 668265263 + k * 2147483647) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  let cx = 1e9, cy = 1e9;
  function rebuild() {
    cx = S.x; cy = S.y;
    let n = 0, nn = 0, nf = 0;
    const i0 = Math.floor((cx - R) / STEP), i1 = Math.floor((cx + R) / STEP), j0 = Math.floor((cy - R) / STEP), j1 = Math.floor((cy + R) / STEP);
    for (let i = i0; i <= i1 && n < CAP; i++) for (let j = j0; j <= j1 && n < CAP; j++) {
      const x = (i + hash(i, j, 1)) * STEP, y = (j + hash(i, j, 2)) * STEP;
      if ((x - cx) ** 2 + (y - cy) ** 2 > R * R) continue;
      const z = TW.terrainAt(x, y);
      if (!z && z !== 0) continue;
      const sl = Math.hypot(TW.terrainAt(x + 6, y) - z, TW.terrainAt(x, y + 6) - z) / 6;   // 坡度 (tan)
      const lcK = TW.landcoverAt ? TW.landcoverAt(x, y) : 0;
      if (lcK && lcK !== 7 && lcK !== 4) continue;          // 水、沙灘、砂石、都市、農田、草地不種
      let dens = lcK === 7 ? 0.8 : lcK === 4 ? 0.25 : sl > 0.1 ? 0.75 : z > 150 ? 0.55 : 0;
      if (z > 3000) dens *= 0.3;                       // 高山: 草原、樹少
      if (sl > 1.2) dens *= 0.4;                       // 懸崖
      if (hash(i, j, 3) > dens) continue;
      if (TW.roadAt(x, y, z + 30, -8, 0)) continue;     // 道路附近、高架下方不種
      const h = 6 + hash(i, j, 4) * 9, w = h * (0.32 + hash(i, j, 5) * 0.14);
      Q.setFromAxisAngle(UP, hash(i, j, 6) * 6.28);
      const near = (x - cx) ** 2 + (y - cy) ** 2 < NEAR_R * NEAR_R, C = near ? crown : crownF, Tr = near ? trunk : trunkF, q = near ? nn++ : nf++;
      M4.compose(V.set(x, z + h * 0.62, -y), Q, SC.set(w, h * 0.42, w)); C.setMatrixAt(q, M4);
      M4.compose(V.set(x, z + h * 0.2 - 0.3, -y), Q, SC.set(1, h * 0.45, 1)); Tr.setMatrixAt(q, M4);
      const g = hash(i, j, 7);
      C.setColorAt(q, COL.setRGB(0.03 + g * 0.04, 0.07 + g * 0.06, 0.025 + g * 0.02));
      n++;
    }
    crown.count = trunk.count = nn; crownF.count = trunkF.count = nf;
    for (const m of [crown, trunk, crownF, trunkF]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
  }
  let clock = 0, since = 0, early = 0, dirtyT = 0;
  return {
    update(dt) {
      if ((clock -= dt) > 0) return; clock = 0.5;
      since += 0.5;
      if (dirtyT > 0 && (dirtyT -= 0.5) <= 0) { rebuild(); return; }   // 分區陸續載入: 停 1 秒沒有新分區再重排
      // 移動 150 m 重排；剛開始或傳送後地形分區陸續載入，前幾次每 3 秒補排
      if (Math.hypot(S.x - cx, S.y - cy) > 150) { early = 0; since = 0; rebuild(); }
      else if (early < 6 && since > 3) { early++; since = 0; rebuild(); }
    },
    get count() { return crown.count + crownF.count; },
    dirty() { dirtyT = 1.0; },
  };
})();
TW.HOOKS.update.push((dt) => trees.update(dt));
TW.HOOKS.tile.push(() => trees.dirty());   // 道路分區載入後重排 (避開剛載入的道路)

// ======================================================================= 夜晚車燈: 頭燈白色光暈、尾燈紅色 (煞車更亮)，玩家車頭燈照亮前方路面
const carGlow = (() => {
  const N = MAX_FWY + MAX_CITY + 1;   // 車子在 init 才生成，這裡用上限
  const mk = (size, cap) => {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(cap * 3), 3));
    const m = new T.PointsMaterial({ map: TW.GLOW_TEX, size, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, blending: T.AdditiveBlending, toneMapped: false, fog: false });
    const pts = new T.Points(g, m); pts.frustumCulled = false; pts.visible = false; TW.scene.add(pts);
    return pts;
  };
  const heads = mk(1.7, N * 2), tails = mk(0.9, N * 2);
  const beam = new T.SpotLight(0xfff1dc, 0, 110, 0.42, 0.55, 1.0);
  beam.castShadow = false; TW.scene.add(beam, beam.target);
  let hn = 0, tn = 0;
  const put = (pts, i, x, y, z, r, gg, b) => {
    const P = pts.geometry.attributes.position.array, C = pts.geometry.attributes.color.array;
    P[i * 3] = x; P[i * 3 + 1] = z; P[i * 3 + 2] = -y; C[i * 3] = r; C[i * 3 + 1] = gg; C[i * 3 + 2] = b;
  };
  function lamps(x, y, z, h, front, rear, wid, brake, isHeavy) {
    const fx = Math.cos(h), fy = Math.sin(h), lx = -fy, ly = fx, hw = wid * 0.38, hz = isHeavy ? 1.0 : 0.68;
    for (const sd of [-1, 1]) {
      put(heads, hn++, x + fx * front + lx * hw * sd, y + fy * front + ly * hw * sd, z + hz, 1, 0.95, 0.82);
      const k = brake ? 1 : 0.45;
      put(tails, tn++, x - fx * rear + lx * hw * sd, y - fy * rear + ly * hw * sd, z + hz + 0.1, k, 0.02 * k, 0.01 * k);
    }
  }
  return {
    update() {
      const night = TW.NIGHT.value;
      heads.visible = tails.visible = night > 0.02;
      beam.intensity = night * 28;
      if (!heads.visible) return;
      heads.material.opacity = tails.material.opacity = night;
      hn = tn = 0;
      for (const c of cars) if (c.alive) lamps(c.x, c.y, c.z, c.h, c.front, c.rear, c.wid, c.brake, HEAVY.has(c.type));
      const vt = TW.S.vt || { wid: 1.85 };
      const firstPerson = Math.hypot(TW.camera.position.x - S.x, TW.camera.position.z + S.y) < 3;   // 第一人稱: 不畫自己的車燈光暈 (會擋住畫面)
      if (!firstPerson) lamps(S.x, S.y, S.zVis != null ? S.zVis : S.z, S.h, 2.25, 2.25, vt.wid || 1.85, S.brk > 0.1, false);
      for (const p of [heads, tails]) {
        p.geometry.setDrawRange(0, p === heads ? hn : tn);
        p.geometry.attributes.position.needsUpdate = p.geometry.attributes.color.needsUpdate = true;
      }
      const fx = Math.cos(S.h), fy = Math.sin(S.h), z = (S.zVis != null ? S.zVis : S.z) + 0.75;
      beam.position.set(S.x + fx * 2.2, z, -(S.y + fy * 2.2));
      beam.target.position.set(S.x + fx * 30, z - 2.2, -(S.y + fy * 30));
    },
  };
})();
TW.HOOKS.update.push(() => carGlow.update());

let densClock = 0;
if (TW.params.has('densdbg')) TW.HOOKS.update.push((dt) => {   // 測試: 玩家附近國道車數
  if ((densClock += dt) < 5) return; densClock = 0;
  let n300 = 0, n650 = 0, same = 0, ahead = 0, alive = 0;
  for (const c of cars) if (c.alive && c.pool === 'fwy') {
    alive++;
    const d = Math.hypot(c.x - S.x, c.y - S.y);
    if (d < 300) n300++; if (d < 650) n650++;
    if (S.road && c.w === S.road.w) { same++; if ((c.x - S.x) * Math.cos(S.h) + (c.y - S.y) * Math.sin(S.h) > 0) ahead++; }
  }
  console.log('[dens] lv', fwyLv, 'alive', alive, '<300m', n300, '<650m', n650, 'sameWay', same, 'ahead', ahead, 'v', (S.v * 3.6).toFixed(0));
});
TW.HOOKS.update.push((dt) => { controls.frame(dt); }, (dt) => { PLAYER.stuck = Math.abs(S.v) < 0.3 ? (PLAYER.stuck || 0) + dt : 0; updateTraffic(dt); });
// 分區載入: 生成點、路況、ETC 門架 (門架所在路段載入時才建)
const ETC_BY_GID = new Map();
for (const g of LIVE.etc) { if (!ETC_BY_GID.has(g.way)) ETC_BY_GID.set(g.way, []); ETC_BY_GID.get(g.way).push(g); }
TW.HOOKS.tile.push((rec) => {
  addSamples(rec);
  recomputeTraffic(rec.ways);
  for (const k of rec.ways) for (const g of ETC_BY_GID.get(WAYS[k].gid) || []) buildEtc(g);
});
TW.HOOKS.joint = (v, axle) => { stats.joints = (stats.joints || 0) + 1; sound.knock(v, axle); };
TW.HOOKS.frame.push((dt) => { updateSigns(dt); updateGuides(dt); sound.update(dt); sound.blinker(); updateTrafficHud(dt); gpsSync.frame(dt); });
// 除錯/測試: AI 車之間互相重疊的對數
function overlaps() {
  let n = 0;
  for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) {
    const a = cars[i], b = cars[j];
    if (!a.alive || !b.alive || Math.abs(a.z - b.z) > 2) continue;
    const dx = b.x - a.x, dy = b.y - a.y, fx = Math.cos(a.h), fy = Math.sin(a.h);
    if (Math.cos(a.h - b.h) < 0.5) continue;   // 路口交會不算
    if (Math.abs(dx * fx + dy * fy) < (a.front + a.rear + b.front + b.rear) / 4 - 0.3 && Math.abs(-dx * fy + dy * fx) < (a.wid + b.wid) / 2 - 0.15) n++;
  }
  return n;
}
window.TWX = { PROF, cars, signs, GUIDES, wayTraffic, radio, sound, stats, overlaps, gpsSync, controls,
  sign: { panelBase, drawSpaced, zhFont, enFont, textW, signMat, backMat, placeOnWay, drawShield, mergedGroup, SGN, ZH_SP, ZH_FONT, EN_FONT } };
})();

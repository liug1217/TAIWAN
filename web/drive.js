/* 台灣 1:1 — 駕駛: 玩家車輛狀態與物理、自動駕駛、攝影機、儀表、小地圖、主迴圈 */
(function () {
'use strict';
const { T, $, params, setStatus, HOOKS, INDEX, TS, tileBuf, LANE_W, WAYS, wayByGid, ptKey, PT_INDEX, roadAt, terrainAt, landcoverAt,
  laneCount, laneOffDir, nextOptions, chooseNext, deadEndAhead, nextWay, speedLimit, leftPost, rightEdge, BAR_HALF,
  renderer, MOBILE, scene, camera, SUN_DIR, NIGHT, WEATHER, sun, smooth01, updateDayNight, cycleTime, GLOW_TEX, WATER_T,
  TILES, tilesNear, streamTick, streamFrame, ensureArea, orthoFrame, cullBuildings, crossedJoint, warmShaders,
  SIG_ON, SIG_OFF, blinkPhase, buildCar } = TW;
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
/** 玩家車極速 (m/s): 機車照車種，其他一律 200 km/h */
const vTop = () => (S.vtype === 'scooter' ? ((S.vt && S.vt.vmax) || 18) * 1.2 : 200 / 3.6);
const finalDrive = () => RPM_MAX * 0.92 / 60 * 2 * Math.PI * wheelR() / (GEAR_R[5] * vTop());
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
  if ((e.code === 'Equal' || e.code === 'NumpadAdd') && S.cruise) S.cruise = Math.min(S.cruise + 5 / 3.6, vTop());
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
  // 離最近車道中心超過 0.6 線寬 = 在路肩 / 分岔的槽化區上 (正要開進匝道): 不拉回主線
  if (Math.abs(off - r.lat) > LANE_W * 0.6) { S.lcLane = null; return null; }
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

/** 兩條相鄰路面可以直接開過去嗎 (分合流、同一條國道前後段、一般道路路口)。
 *  中間有護欄的不會相鄰 (fix_clip 只在路緣落在別條路面上時拿掉護欄)，所以只看方向和高度 */
function joinable(a, b) {
  if (Math.abs(a.z - b.z) > 1.0) return false;
  if (a.w.city && b.w.city) return true;
  const dot = a.tx * b.tx + a.ty * b.ty;
  if (a.w.city || b.w.city) return (a.w.link || b.w.link) && Math.abs(dot) > 0.3;   // 匝道接平面道路
  if (!a.w.oneway || !b.w.oneway) return Math.abs(dot) > 0.5;
  return dot > 0.5 && (a.w.link || b.w.link || (a.w.ref && a.w.ref === b.w.ref));
}
/** 分岔 / 合流節點附近，兩條相接路面中間的楔形縫 (OSM 路面沒蓋滿，畫面上 world.js 用混凝土補平了):
 *  (x, y) 左右 4.5 m 內各有一條路、兩條相接 (共用端點，或匝道接主線) 且接點在 80 m 內 → 算在路上，回傳較高的那條 */
function gapRoad(x, y, h, zRef) {
  const ax = -Math.sin(h), ay = Math.cos(h);
  let L = null, R = null;
  for (let d = 0.5; d <= 4.5 && !(L && R); d += 0.5) {
    if (!L) L = roadAt(x + ax * d, y + ay * d, zRef, 0);
    if (!R) R = roadAt(x - ax * d, y - ay * d, zRef, 0);
  }
  if (!L || !R || L.w === R.w || !joinable(L, R)) return null;
  const near = (px, py) => Math.hypot(px - x, py - y) < 80;
  const ends = (w) => [[w.P[0], w.P[1]], [w.P[(w.n - 1) * 3], w.P[(w.n - 1) * 3 + 1]]];
  let ok = false;
  for (const p of ends(L.w)) for (const q of ends(R.w)) if (Math.hypot(p[0] - q[0], p[1] - q[1]) < 1.5 && near(p[0], p[1])) ok = true;
  if (!ok) for (const [u, v] of [[L.w, R.w], [R.w, L.w]]) for (const rp of u.ramps || []) if (rp.mgid === v.gid && near(u.P[rp.e * 3], u.P[rp.e * 3 + 1])) ok = true;
  return ok ? (L.z >= R.z ? L : R) : null;
}
/** 車身四個角 (左右、前方左右) 都落在路面上 (可以是不同但相接的路面) → 回傳車子中心所在的路 */
function bodyOnRoads(x, y, h, pref) {
  const c = roadAt(x, y, S.z, 0, 1.3, pref, true) || gapRoad(x, y, h, S.z);
  if (!c) return null;
  const m = MARGIN - 0.1, sx = -Math.sin(h) * m, sy = Math.cos(h) * m, fx = Math.cos(h) * WB * 0.5, fy = Math.sin(h) * WB * 0.5;
  const pts = [x + sx, y + sy, x - sx, y - sy, x + sx + fx, y + sy + fy, x - sx + fx, y - sy + fy];
  for (let k = 0; k < 8; k += 2) {
    const q = roadAt(pts[k], pts[k + 1], S.z, 0, 1.3, c.w, true) || gapRoad(pts[k], pts[k + 1], h, S.z);
    if (!q || (q.w !== c.w && !joinable(c, q))) return null;
  }
  return c;
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
    // 剛放開方向鍵的 0.7 秒內不介入: 用點的方式切出口 / 換車道時不會一放手就被拉回原車道
    if (str) { S.lcLane = null; S.lcOn = false; S.lcHold = 0.7; }
    else if (laneCenter && (S.lcHold = (S.lcHold || 0) - dt) <= 0) { const c = laneCenterSteer(maxSteer); if (c != null) str = c; }
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
  // 馬力加大 (舊版 5.5)；Shift 加速只加推力，極速一樣封頂 200 km/h
  const vmax = vTop();
  const A0 = 8.0 * (vt.acc / 1.5) * (boost ? 1.35 : 1);
  const drag = (v) => 0.00042 * v * Math.abs(v) + 0.12 * Math.sign(v);
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
    // 推力在極速前抵掉風阻 + 滾動阻力，平路剛好跑到 vmax
    if (thr) { const u = Math.max(S.v, 0) / vmax; a += thr * Math.max(0, A0 * (1 - u * u) + (u < 1 ? drag(Math.max(S.v, 0)) : 0)); }
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
  a -= drag(S.v);
  a -= 9.81 * Math.sin(S.pitch) * 0.9;
  S.v += a * dt;
  if (S.v > vmax) S.v -= (S.v - vmax) * Math.min(1, dt * 2);   // 極速封頂 (下坡也不會一直加速)
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
  const pref = S.road && S.road.w;
  let r = roadAt(nx, ny, S.z, MARGIN, 1.3, pref, true);
  if (!r && S.road && S.road.w.city) r = roadAt(nx, ny, S.z, 0.3, 1.3, pref, true);   // 一般道路沒有護欄: 大車可以壓到路緣
  if (!r) r = bodyOnRoads(nx, ny, S.h, pref);   // 分合流: 車身跨在主線和匝道兩條路面上也算在路上
  // 國道中央護欄: 不能開到對向路面，車身也不能壓進護欄 (資料裡兩條路面重疊的地方特別要擋)
  if (r && S.road && !r.w.city && !S.road.w.city) {
    const cw = S.road.w;
    if (r.w !== cw && r.w.oneway && cw.oneway && !r.w.link && !cw.link && r.tx * S.road.tx + r.ty * S.road.ty < -0.5) r = null;
    else if (r.w.pair && r.w.pair[r.i] && r.lat + (MARGIN - 0.35) > r.w.bc[r.i] - BAR_HALF) r = null;
  }
  if (!r && S.road) {
    S.hits = (S.hits || 0) + 1;   // 測試統計: 撞路緣 / 護欄次數
    const tx = S.road.tx, ty = S.road.ty;
    const sgn = Math.cos(S.h) * tx + Math.sin(S.h) * ty >= 0 ? 1 : -1;
    const vtan = S.v * (Math.cos(S.h) * tx * sgn + Math.sin(S.h) * ty * sgn);
    // 擦護欄: 只留沿路方向的速度，再加一點摩擦 (依時間算；舊版每個物理步 ×0.92，120 Hz 下擦一下就停死)
    S.v = vtan * Math.exp(-dt * 0.8);
    const th = Math.atan2(ty * sgn, tx * sgn);
    S.h += Math.atan2(Math.sin(th - S.h), Math.cos(th - S.h)) * (1 - Math.exp(-dt * 10));
    const lat = S.road.lat, push = -Math.sign(lat) * 1.5 * dt;
    nx = S.x + tx * sgn * S.v * dt + (-ty) * push; ny = S.y + ty * sgn * S.v * dt + tx * push;
    // 橫向夾回可行駛範圍內 (舊版只推 5 cm，窄匝道上會卡在牆邊不動)
    {
      const w = S.road.w, i = S.road.i, ax = w.P[i * 3], ay = w.P[i * 3 + 1];
      const ln = (nx - ax) * -ty + (ny - ay) * tx;
      const lim = ln > 0 ? Math.max(0, w.hw + (w.eL ? w.eL[i] : 0) - MARGIN - 0.03) : -Math.max(0, w.hw + (w.eR ? w.eR[i] : 0) - MARGIN - 0.03);
      if (Math.abs(ln) > Math.abs(lim)) { const d = lim - ln; nx += -ty * d; ny += tx * d; }
    }
    r = roadAt(nx, ny, S.z, MARGIN, 1.3, pref, true) || bodyOnRoads(nx, ny, S.h, pref);
    if (!r) { nx = S.x; ny = S.y; r = S.road; S.v *= Math.exp(-dt * 6); }
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
Object.assign(TW, { S, setVehicle, spawn, ORIGIN: INDEX.origin_twd97, keys, roadLabel, toast, toggleMenu,
  toggleManual, shift, toggleCruise, respawnNearest, SPAWNS: () => SPAWNS, MAP_PX: 200, update });
Object.defineProperties(TW, {
  camMode: { get() { return camMode; }, configurable: true },
  autopilot: { get() { return autopilot; }, set(v) { autopilot = !!v; }, configurable: true },
  mapScale: { get() { return MAP_SCALES[mapScaleIdx]; }, configurable: true },
});

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
  if (!params.has('t')) { setStatus('準備畫面…'); await warmShaders(camera); }   // 著色器先編譯好，開車途中不會卡
  $('loading').classList.add('hidden');
  let last = performance.now(), frame = 0;
  // ?hitch: 每 10 秒印出每幀各部分的平均 / 最長時間 (找卡頓用)
  const HP = params.has('hitch') ? { acc: {}, t0: performance.now(), frames: 0, long: 0, worst: 0 } : null;
  const hp = (name, f) => { if (!HP) return f(); const t = performance.now(); f(); const d = performance.now() - t; const a = HP.acc[name] || (HP.acc[name] = { s: 0, m: 0 }); a.s += d; if (d > a.m) a.m = d; };
  function loop(now) {
    const fs = performance.now();
    const dt = Math.min((now - last) / 1000, params.has('realtime') ? 1.0 : 0.05); last = now;   // realtime: 背景展示用，依真實時間推進
    const sub = Math.max(1, Math.ceil(dt / (1 / 120)));
    hp('physics', () => { for (let i = 0; i < sub; i++) update(dt / sub); });
    HOOKS.update.forEach((f, i) => hp('upd' + i, () => f(dt)));
    hp('car+cam', () => { syncCar(dt); updateCamera(dt); updateDayNight(dt); WATER_T.value = now / 1000; });
    HOOKS.frame.forEach((f, i) => hp('frm' + i, () => f(dt)));
    hp('render', () => renderer.render(scene, camera));
    hp('minimap', () => { if ((frame++ & 1) === 0) drawMinimap(); });
    hp('hud', () => updateHud());
    if (HP) {
      const d = performance.now() - fs; HP.frames++; if (d > 50) HP.long++; if (d > HP.worst) HP.worst = d;
      if (performance.now() - HP.t0 > 10000) {
        const el = performance.now() - HP.t0;
        console.log('[hitch] fps', (HP.frames / el * 1000).toFixed(1), 'long>50ms', HP.long, 'worst', HP.worst.toFixed(0), 'calls', renderer.info.render.calls, 'tris', (renderer.info.render.triangles / 1e3).toFixed(0) + 'k',
          Object.entries(HP.acc).sort((a, b) => b[1].s - a[1].s).map(([k, v]) => k + ' ' + (v.s / HP.frames).toFixed(2) + '/' + v.m.toFixed(0)).join(' | '));
        HP.acc = {}; HP.t0 = performance.now(); HP.frames = 0; HP.long = 0; HP.worst = 0;
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}, 30);
})();

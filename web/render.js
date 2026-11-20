/* 台灣 1:1 — 渲染器、天空、日夜、材質 (移植自 Blender 版公式)
 * 材質與 Blender 版 (scripts/build_freeway_blender.py) 使用相同公式與顏色 (線性色彩空間)
 */
(function () {
'use strict';
const { T, $, params, LANE_W } = TW;
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

Object.assign(TW, { renderer, MOBILE, scene, camera, SUN_DIR, NIGHT, WEATHER, sun, smooth01, updateDayNight, cycleTime, GLOW_TEX, GLOW_LAMP, matLampPole, matSoundWall, matSoundGlass, matBillboard, matBillboardBack, matLampHead, patch, matAsphalt, matConcrete, matBarrier, matGore, matPost, matPostBand, matDrum, matDrumBand, matGlare, matCityRoad, matWall, matRoof, matJointSteel, matJointRubber, matReflR, matReflBlack, matRetro, matRetroGlow, matReflY, matTunnelWall, matCabinet, matRail, matPortal, matTunnelLight, WATER_T, matWater, TERRAIN_SPEC, matTerrain });
})();

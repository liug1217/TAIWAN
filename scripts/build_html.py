"""把引擎、資料、程式打包成網頁。

- 台灣.html : 單一檔案，分區資料全部內嵌 (離線、直接雙擊開都能玩)
- index.html: GitHub Pages / 本機伺服器版，分區資料放在 tiles/，開到哪載到哪 (要先跑 scripts/tile_web.py)
"""
import base64
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")


def three_classic():
    """three.module.min.js (ES module) -> 一般 <script>，掛在 window.THREE。"""
    src = open(os.path.join(WEB, "vendor", "three.module.min.js"), encoding="utf-8").read()
    i = src.rindex("export{")
    body, tail = src[:i], src[i + len("export{"):]
    items = tail[:tail.rindex("}")].split(",")
    pairs = []
    for it in items:
        it = it.strip()
        if not it:
            continue
        local, _, name = it.partition(" as ")
        pairs.append(f"{(name or local).strip()}:{local.strip()}")
    return 'window.THREE=(function(){"use strict";\n' + body + "\nreturn{" + ",".join(pairs) + "};})();"


def safe(js, label):
    if re.search(r"</script", js, re.I) or "<!--" in js:
        raise SystemExit(f"{label} contains an HTML-unsafe sequence")
    return js


def main():
    tpl = open(os.path.join(WEB, "template.html"), encoding="utf-8").read()
    tiles = os.path.join(ROOT, "tiles")
    index = open(os.path.join(tiles, "index.json"), encoding="utf-8").read().replace("</", "<\/")
    parts = {
        "THREE_JS": safe(three_classic(), "three.js"),
        # 主程式拆成幾個模組，依序載入 (每個都是獨立的 IIFE，透過 window.TW 互通)
        "APP_JS": chr(10).join(safe(open(os.path.join(WEB, f), encoding="utf-8").read(), f) for f in ("core.js", "render.js", "world.js", "car.js", "drive.js")),
        "TILE_INDEX": index,
        "VEHICLES_JS": safe(open(os.path.join(WEB, "vehicles.js"), encoding="utf-8").read(), "vehicles.js"),
        "HLS_JS": safe(open(os.path.join(WEB, "vendor", "hls.light.min.js"), encoding="utf-8").read(), "hls.js"),
        "FEATURES_JS": safe(open(os.path.join(WEB, "features.js"), encoding="utf-8").read(), "features.js"),
        "GAMEPLAY_JS": safe(open(os.path.join(WEB, "gameplay.js"), encoding="utf-8").read(), "gameplay.js"),
    }
    # 額外模組 (電台、車流…) 依序附加在 app.js 之前
    extra_dir = os.path.join(WEB, "extra")
    extra = ""
    if os.path.isdir(extra_dir):
        for f in sorted(os.listdir(extra_dir)):
            p = os.path.join(extra_dir, f)
            if f.endswith(".json"):
                key = os.path.splitext(f)[0]
                extra += f'<script id="extra-{key}" type="application/json">' + \
                    open(p, encoding="utf-8").read().replace("</", "<\\/") + "</script>\n"
    # 貼圖 (web/tex/*.jpg) 以 base64 內嵌: <script id="tex-檔名">
    tex_dir = os.path.join(WEB, "tex")
    if os.path.isdir(tex_dir):
        for f in sorted(os.listdir(tex_dir)):
            if f.endswith(".jpg"):
                b64 = base64.b64encode(open(os.path.join(tex_dir, f), "rb").read()).decode("ascii")
                extra += f'<script id="tex-{f[:-4]}" type="text/plain">{b64}</script>\n'
    base = tpl.replace("{{EXTRA}}", extra)
    for k, v in parts.items():
        base = base.replace("{{" + k + "}}", v)
    # 台灣.html 內嵌的分區: 地圖變大後全部內嵌會超過 GitHub 單檔 100 MB，
    # 所以從原點 (台北) 由近到遠內嵌到 INLINE_MB 為止，其他分區開啟時有網路就從 GitHub Pages 下載
    INLINE_MB = 80
    keys = set()
    for kind in ("t", "d"):
        keys |= {f[:-4] for f in os.listdir(os.path.join(tiles, kind)) if f.endswith(".bin")}
    def dist(k):
        tx, ty = (int(v) for v in k.split("_"))
        return (tx + 0.5) ** 2 + (ty + 0.5) ** 2
    inline, total, skipped = [], 0, 0
    for k in sorted(keys, key=lambda k: (dist(k), k)):   # 同距離用名稱排 (每次打包順序一樣，diff 乾淨)
        blobs = []
        for kind in ("t", "d"):
            p = os.path.join(tiles, kind, k + ".bin")
            if os.path.exists(p):
                blobs.append((kind, base64.b64encode(open(p, "rb").read()).decode("ascii")))
        size = sum(len(b) for _, b in blobs)
        if total + size > INLINE_MB * 1e6:
            skipped += 1
            continue
        total += size
        for kind, b64 in blobs:
            inline.append(f'<script id="tile-{kind}-{k}" type="application/octet-stream">{b64}</script>')
    # 導航路網 (scripts/build_nav.mjs)
    navp = os.path.join(tiles, "n", "nav.bin")
    if os.path.exists(navp):
        inline.append('<script id="tile-n-nav" type="application/octet-stream">' + base64.b64encode(open(navp, "rb").read()).decode("ascii") + '</script>')
    if skipped:
        print(f"台灣.html: {len(keys) - skipped} tiles inline, {skipped} tiles fetched online from GitHub Pages")
    for name, tl in (("台灣.html", "\n".join(inline)), ("index.html", "")):
        out = base.replace("{{TILES_INLINE}}", tl)
        path = os.path.join(ROOT, name)
        open(path, "w", encoding="utf-8").write(out)
        print(f"wrote {path} ({len(out.encode('utf-8')) / 1e6:.2f} MB)")


if __name__ == "__main__":
    main()

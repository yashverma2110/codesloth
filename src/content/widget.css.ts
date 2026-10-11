/** Styles live inside a closed shadow root, so GitHub's CSS can't leak in and ours can't leak out. */
export const WIDGET_CSS = `
:host { all: initial; }
.root { --fg:#1f2328; --muted:#59636e; --border:#d1d9e0; --bg:#ffffff; --bg2:#f6f8fa; --accent:#0969da; --add:#1a7f37; --del:#d1242f; --warn:#9a6700; --btn:#1f883d; --shadow:0 8px 24px rgba(140,149,159,.25);
  font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif; color:var(--fg); }
.root.dark { --fg:#f0f6fc; --muted:#9198a1; --border:#3d444d; --bg:#151b23; --bg2:#212830; --accent:#4493f8; --add:#3fb950; --del:#f85149; --warn:#d29922; --btn:#238636; --shadow:0 8px 24px rgba(1,4,9,.6); }
* { box-sizing: border-box; }
.bubble { position:fixed; width:48px; height:48px; border-radius:50%; border:none; background:var(--btn); color:#fff; box-shadow:var(--shadow);
  display:flex; align-items:center; justify-content:center; cursor:grab; touch-action:none; user-select:none; z-index:2147483000; padding:0; transition:left .18s ease, top .18s ease; }
.bubble:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.bubble.dragging, .panel.dragging { transition:none; cursor:grabbing; }
.bubble svg { width:22px; height:22px; pointer-events:none; }
.bubble .dot { position:absolute; top:2px; right:2px; width:12px; height:12px; border-radius:50%; background:var(--del); border:2px solid var(--bg); display:none; }
.bubble.needs-setup .dot { display:block; }
.panel { position:fixed; display:flex; flex-direction:column; background:var(--bg); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow);
  z-index:2147483000; overflow:hidden; min-height:200px; resize:vertical; }
.panel[hidden] { display:none; }
.hdr { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--border); background:var(--bg2); cursor:grab; touch-action:none; user-select:none; }
.hdr .ttl { font-weight:600; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hdr button, .btn { font:inherit; font-size:12px; padding:3px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg); color:var(--fg); cursor:pointer; }
.btn.primary { background:var(--btn); border-color:var(--btn); color:#fff; }
.hdr .x { border:none; background:transparent; font-size:16px; line-height:1; padding:2px 6px; color:var(--muted); }
.sub { padding:6px 12px; border-bottom:1px solid var(--border); color:var(--muted); font-size:12px; }
.body { overflow:auto; flex:1; overscroll-behavior:contain; }
.muted { color:var(--muted); font-size:12px; }
.warn { color:var(--warn); font-size:12px; margin:2px 0; }
.err { color:var(--del); }
.setup { padding:16px 12px; }
.setup p { margin:0 0 10px; }
details.layer { border-bottom:1px solid var(--border); }
details.layer > summary { list-style:none; cursor:pointer; padding:8px 12px; display:flex; gap:8px; align-items:baseline; }
details.layer > summary::-webkit-details-marker { display:none; }
.idx { font-weight:600; color:var(--muted); min-width:22px; }
.ltitle { font-weight:600; flex:1; }
details.layer.done .ltitle { text-decoration:line-through; color:var(--muted); }
.desc { padding:0 12px 6px 42px; color:var(--muted); font-size:12px; }
ul.files { list-style:none; margin:0; padding:0 0 8px; }
li.file { padding:4px 12px 4px 42px; cursor:pointer; }
li.file:hover, li.file:focus-visible { background:var(--bg2); outline:none; }
.path { font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace; font-size:12px; word-break:break-all; }
.dir { color:var(--muted); }
.reason { color:var(--muted); font-size:11.5px; }
.st { display:inline-block; width:14px; font-weight:700; }
.add { color:var(--add); } .del { color:var(--del); }
.stats { font-size:11.5px; white-space:nowrap; }
input[type=checkbox] { margin:0; accent-color:var(--btn); }
`;

export const WIDGET_CSS_V3 = `
.hdr .icon { width:24px; height:24px; padding:0; border-radius:50%; font-weight:700; }
.menu { position:absolute; top:44px; right:12px; z-index:3; display:flex; flex-direction:column; min-width:230px; background:var(--bg); border:1px solid var(--border); border-radius:8px; box-shadow:var(--shadow); padding:4px; }
.menu[hidden] { display:none; }
.menu button { text-align:left; font:inherit; font-size:12.5px; padding:6px 10px; border:none; background:transparent; color:var(--fg); border-radius:6px; cursor:pointer; }
.menu button:hover, .menu button:focus-visible { background:var(--bg2); outline:none; }
.tabs { display:flex; gap:4px; padding:0 8px; border-bottom:1px solid var(--border); background:var(--bg); }
.tab { font:inherit; font-size:13px; padding:8px 10px 7px; border:none; border-bottom:2px solid transparent; background:transparent; color:var(--muted); cursor:pointer; border-radius:6px 6px 0 0; }
.tab:hover { color:var(--fg); background:var(--bg2); }
.tab[aria-selected=true] { color:var(--fg); font-weight:600; border-bottom-color:#fd8c73; }
.tab:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.pane[hidden] { display:none !important; }
.pane.graph { flex:1; min-height:0; display:flex; flex-direction:column; }
.banner { display:flex; gap:8px; align-items:center; justify-content:space-between; padding:6px 12px; background:rgba(84,174,255,.12); border-bottom:1px solid var(--border); font-size:12px; }
.banner[hidden] { display:none; }
.flag { margin:0 12px 6px 42px; padding:6px 8px; border-radius:6px; background:rgba(212,167,44,.15); color:var(--fg); font-size:12px; border:1px solid rgba(212,167,44,.5); }
details.layer.changed .ltitle::after { content:" ⚠"; color:#d4a72c; }
li.file.chg { background:rgba(212,167,44,.08); }
.badge { margin-left:6px; font:600 10px -apple-system,sans-serif; padding:1px 6px; border-radius:999px; background:#d4a72c; color:#1f2328; }
.toast { font-size:12px; }
.toast a { color:var(--accent); }
.setup .row { display:flex; gap:8px; margin-bottom:10px; }
.overlay { position:fixed; inset:0; z-index:2147483001; background:rgba(1,4,9,.45); display:flex; align-items:center; justify-content:center; }
.ov-box { width:calc(100vw - 48px); height:calc(100vh - 48px); background:var(--bg); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow); display:flex; flex-direction:column; overflow:hidden; }
.ov-box .gv { flex:1; min-height:0; }
`;

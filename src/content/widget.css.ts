/** Styles live inside a closed shadow root, so GitHub's CSS can't leak in and ours can't leak out. */
export const WIDGET_CSS = `
:host { all: initial; }
.root { --fg:#1f2328; --muted:#59636e; --border:#d1d9e0; --bg:#ffffff; --bg2:#f6f8fa; --accent:#0969da; --sel-bg:#ddf4ff; --add:#1a7f37; --del:#d1242f; --warn:#9a6700; --btn:#1f883d; --shadow:0 8px 24px rgba(140,149,159,.25);
  font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif; color:var(--fg); }
.root.dark { --fg:#f0f6fc; --muted:#9198a1; --border:#3d444d; --bg:#151b23; --bg2:#212830; --accent:#4493f8; --sel-bg:rgba(56,139,253,.15); --add:#3fb950; --del:#f85149; --warn:#d29922; --btn:#238636; --shadow:0 8px 24px rgba(1,4,9,.6); }
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
.flag { margin:0 0 6px; padding:6px 8px; border-radius:6px; background:rgba(212,167,44,.15); color:var(--fg); font-size:12px; border:1px solid rgba(212,167,44,.5); }
.badge { margin-left:6px; font:600 10px -apple-system,sans-serif; padding:1px 6px; border-radius:999px; background:#d4a72c; color:#1f2328; }
.toast { font-size:12px; }
.toast a { color:var(--accent); }
.setup .row { display:flex; gap:8px; margin-bottom:10px; }
.overlay { position:fixed; inset:0; z-index:2147483001; background:rgba(1,4,9,.45); display:flex; align-items:center; justify-content:center; }
.ov-box { width:calc(100vw - 48px); height:calc(100vh - 48px); background:var(--bg); border:1px solid var(--border); border-radius:12px; box-shadow:var(--shadow); display:flex; flex-direction:column; overflow:hidden; }
.ov-box .gv { flex:1; min-height:0; }


/* ---- v0.4 checklist ---- */
.sub { padding:10px 12px; }
.plbl { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:var(--muted); margin-bottom:6px; }
.plbl b { color:var(--fg); font-weight:600; }
.pbar { height:6px; border-radius:3px; background:var(--bg2); border:1px solid var(--border); overflow:hidden; }
.pbar i { display:block; height:100%; background:var(--btn); border-radius:3px; transition:width .2s; }
.hdr .icon.has-warn::after { content:""; position:relative; top:-7px; left:1px; width:6px; height:6px; border-radius:50%; background:var(--warn); display:inline-block; }
.menu .sep { border-top:1px solid var(--border); margin:4px 0; }
.menu .meta { padding:3px 10px; font-size:11.5px; color:var(--muted); }
.menu .meta.warn { color:var(--warn); }
.sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
ol.steps { list-style:none; margin:0; padding:0; }
.step { border-bottom:1px solid var(--border); }
.srow { display:flex; align-items:center; gap:6px; padding-right:12px; }
.sh { flex:1; min-width:0; display:flex; align-items:center; gap:10px; padding:10px 6px 10px 12px; border:none; background:transparent; color:var(--fg); font:inherit; text-align:left; cursor:pointer; }
.sh:hover { background:var(--bg2); }
.sh:focus-visible, .tick:focus-visible, li.file:focus-visible, .next:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.num { flex:none; width:22px; height:22px; border-radius:50%; border:1.5px solid var(--muted); display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:600; color:var(--fg); }
.step.current .num { background:var(--fg); color:var(--bg); border-color:var(--fg); }
.step.done .num { background:var(--add); border-color:var(--add); color:#fff; }
.sh .h { flex:1; min-width:0; font-weight:600; overflow:hidden; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-height:1.3; overflow-wrap:anywhere; }
.step.done .sh .h { color:var(--muted); font-weight:500; }
.sh .cnt { font-size:12px; color:var(--muted); white-space:nowrap; }
.chev { color:var(--muted); transition:transform .15s; display:inline-block; }
.step.open .chev { transform:rotate(90deg); }
.chg-ico { color:#d4a72c; font-size:12px; }
.unsync { color:var(--muted); font-size:12px; cursor:help; }
.tick { flex:none; width:15px; height:15px; cursor:pointer; }
.sbody { padding:0 12px 10px 44px; }
.why { margin:0 0 8px; color:var(--muted); font-size:12.5px; }
.folder { font:11.5px ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace; color:var(--muted); padding:4px 0 2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
ul.files { list-style:none; margin:0 0 4px; padding:0; }
li.file { display:flex; align-items:flex-start; gap:6px; margin-left:-10px; border-radius:6px; border-left:3px solid transparent; }
li.file:hover { background:var(--bg2); }
li.file.chg { background:rgba(212,167,44,.10); }
li.file.sel { background:var(--sel-bg); border-left-color:var(--accent); }
.fbtn { flex:1; min-width:0; display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:4px 4px 4px 7px; border:none; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; border-radius:6px; }
.fbtn:focus-visible { outline:2px solid var(--accent); outline-offset:-2px; }
.ftick { flex:none; margin:7px 6px 0 0 !important; width:13px; height:13px; cursor:pointer; opacity:.55; }
li.file:hover .ftick, .ftick:focus-visible, .ftick:checked, li.file.sel .ftick { opacity:1; }
li.file.rev .fname, li.file.rev .nums { color:var(--muted); }
li.file.rev .nums .bar { opacity:.35; }
li.file.sel .fname { font-weight:600; color:var(--fg); }
.rev-ico { flex:none; width:12px; height:12px; border-radius:50%; background:var(--add); color:#fff; font-size:9px; line-height:12px; text-align:center; font-weight:700; }
.dot { flex:none; width:8px; height:8px; border-radius:50%; box-sizing:border-box; }
.dot.new { background:var(--add); }
.dot.mod { border:1.5px solid var(--warn); }
.dot.del { border:1.5px dashed var(--del); }
.dot.ren { width:10px; height:8px; border-radius:2px; border:1.5px solid var(--accent); }
.fname { flex:1; min-width:0; font:12.5px ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.nums { display:inline-flex; align-items:center; gap:5px; font-size:11px; white-space:nowrap; }
.nums .bar { display:inline-block; height:5px; border-radius:2px; background:var(--add); opacity:.7; }
.reason { display:none; flex-basis:100%; padding:2px 0 3px 16px; font-size:12px; color:var(--muted); }
.fbtn:hover .reason, .fbtn:focus .reason, li.file.sel .reason, li.file.peek .reason { display:block; }
.sfoot { padding-top:8px; }
.btn.next { width:100%; padding:7px 12px; font-size:13px; font-weight:600; }
.sfoot .hint { margin-top:5px; font-size:11px; color:var(--muted); text-align:center; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.step.partial .num { border-color:var(--add); box-shadow:0 0 0 2px rgba(46,160,67,.25); }
.step.partial.current .num { background:var(--fg); color:var(--bg); }
.alldone { display:flex; align-items:center; gap:8px; margin:10px 12px 4px; padding:8px 10px; border:1px solid var(--add); border-radius:6px; font-weight:600; outline:none; }
.alldone .ok { width:18px; height:18px; border-radius:50%; background:var(--add); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:11px; }

/* ---- v0.5 commit story ---- */
li.file { flex-wrap:wrap; }
.cm { flex:none; font-size:11px; color:var(--muted); border:1px solid var(--border); border-radius:999px; padding:0 6px; white-space:nowrap; }
.chip { flex:none; font-size:10.5px; line-height:15px; padding:0 6px; border-radius:999px; border:1px solid var(--warn); color:var(--warn); white-space:nowrap; }
.chip.dash { border-style:dashed; color:var(--accent); border-color:var(--accent); }
.chip.plain { border-color:var(--border); color:var(--muted); }
.reason .rtext, .reason .latest { display:block; }
.reason .latest { color:var(--fg); margin-top:2px; }
.reason .latest i { font-style:normal; color:var(--muted); }
.story { margin:-4px 0 8px; font-size:12px; color:var(--fg); display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.story .ico { color:var(--muted); }
.sdots { display:inline-flex; gap:3px; }
.sdots i { width:7px; height:7px; border-radius:50%; border:1.5px solid var(--muted); box-sizing:border-box; }
.sdots i.on { background:var(--muted); }
.tlwrap { flex-basis:100%; padding:2px 8px 8px 22px; }
ol.tl { list-style:none; margin:0; padding:0 0 0 12px; border-left:1.5px solid var(--border); }
.tc { position:relative; padding:0 0 8px 6px; }
.tc:last-child { padding-bottom:0; }
.tc::before { content:""; position:absolute; left:-18.5px; top:4px; width:9px; height:9px; border-radius:50%; background:var(--bg); border:1.5px solid var(--muted); box-sizing:border-box; }
.tc.newest::before { background:var(--accent); border-color:var(--accent); }
.tmsg { font-size:12px; color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tm { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:11px; color:var(--muted); margin-top:1px; }
.av { width:16px; height:16px; border-radius:50%; background:var(--bg2); border:1px solid var(--border); color:var(--fg); font:700 8px/14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; text-align:center; box-sizing:border-box; }
a.sha { font:10.5px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); text-decoration:none; }
a.sha:hover { text-decoration:underline; }
a.sha:focus-visible { outline:2px solid var(--accent); outline-offset:1px; border-radius:3px; }

/* ---- v0.5.1: everything respects the panel width (no horizontal overflow) ---- */
.panel, .panel * { box-sizing:border-box; }
.body { overflow-x:hidden; overflow-y:auto; }
li.file { min-width:0; }
ol.steps, .step, .sbody, ul.files, .fbtn, .reason, .tlwrap, ol.tl, .tc, .tm, .sfoot, .story, .flag, .why { min-width:0; max-width:100%; }
.fbtn { flex:1 1 0; }
.fname { flex:1 1 0; min-width:min(11ch, 100%); }
.cm, .chip, .nums, .chg-ico, .unsync, .sdot { flex:none; }
.reason { min-width:0; overflow-wrap:anywhere; }
.reason .latest { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.tlwrap { flex:1 1 100%; width:100%; padding:2px 8px 8px 22px; overflow:hidden; }
.tmsg { white-space:normal; overflow-wrap:anywhere; word-break:break-word; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; }
.tm { flex-wrap:wrap; row-gap:2px; }
.tm .chip { max-width:100%; overflow:hidden; text-overflow:ellipsis; }
.btn.next { max-width:100%; white-space:normal; overflow-wrap:anywhere; }
.sfoot .hint { max-width:100%; }
.story { overflow-wrap:anywhere; }
.sdots { flex-wrap:wrap; max-width:100%; }
`;

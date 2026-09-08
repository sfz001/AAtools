#!/usr/bin/env python3
"""从 issues.json 生成 index.html。

修完一条后，把该条目的 "fixed" 改为 true（可选填 "fixed_note" 记录实际改法），
然后重跑 `python3 audit/build.py`：已修复项会自动加删除线、置灰并移到报告最底部。
"""
import json, html, re, collections, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'issues.json')
OUT = os.path.join(HERE, 'index.html')

d = json.load(open(DATA))
meta, refuted = d['meta'], d['refuted']
issues = sorted(d['issues'], key=lambda x: x['rank'])
open_issues = [i for i in issues if not i.get('fixed')]
fixed_issues = [i for i in issues if i.get('fixed')]

SEV = {'high': ('严重', 'high'), 'medium': ('中等', 'med'), 'low': ('轻微', 'low')}


def e(s):
    return html.escape(str(s), quote=True)


def cs(text):
    """反引号片段渲染为 <code>，其余转义。"""
    parts = re.split(r'`([^`]+)`', text)
    return ''.join(f'<code>{e(p)}</code>' if n % 2 else e(p) for n, p in enumerate(parts))


counts = collections.Counter(i['severity'] for i in open_issues)
mods = []
for i in open_issues:
    if i['module'] not in mods:
        mods.append(i['module'])
mod_counts = collections.Counter(i['module'] for i in open_issues)


def render(i, fixed=False):
    label, cls = SEV[i['severity']]
    locs = ''.join(f'<code class="loc">{e(l)}</code>' for l in i['locations'])
    note = ''
    if fixed and i.get('fixed_note'):
        note = f'<div class="fixnote"><span class="fixnote-label">已改</span><p>{cs(i["fixed_note"])}</p></div>'
    body = '' if fixed else (
        f'<p class="desc">{cs(i["description"])}</p>'
        f'<div class="fix"><span class="fix-label">建议修复</span><p>{cs(i["fix"])}</p></div>'
    )
    return f'''<article class="issue sev-{cls}{' is-fixed' if fixed else ''}" data-sev="{cls}" data-mod="{e(i['module'])}" id="issue-{i['rank']}">
<header class="issue-head">
<span class="rank">#{i['rank']}</span>
<span class="pill pill-{'fixed' if fixed else cls}">{'已修复' if fixed else label}</span>
<span class="mod">{e(i['module'])}</span>
</header>
<h3 class="issue-title">{cs(i['title'])}</h3>
<div class="locs">{locs}</div>
{note}{body}
</article>'''


blocks, last = [], None
for i in open_issues:
    label, cls = SEV[i['severity']]
    if i['severity'] != last:
        last = i['severity']
        blocks.append(f'<h2 class="sev-head sev-{cls}" id="sev-{cls}">'
                      f'<span class="sev-head-dot"></span>{label}'
                      f'<span class="sev-head-n">{counts[i["severity"]]} 项</span></h2>')
    blocks.append(render(i))

fixed_html = ''
if fixed_issues:
    fixed_html = ('<section class="fixed-section" id="fixed">'
                  '<h2 class="sev-head sev-fixed"><span class="sev-head-dot"></span>已修复'
                  f'<span class="sev-head-n">{len(fixed_issues)} 项</span></h2>'
                  '<p class="fixed-note">以下问题已在代码中修复，保留条目以便回溯。</p>'
                  + ''.join(render(i, fixed=True) for i in fixed_issues) + '</section>')

ref_rows = ''.join(f'''<div class="ref-row">
<code class="loc">{e(x['file'])}:{e(x['line'])}</code>
<div class="ref-body"><p class="ref-title">{cs(x['title'])}</p>
<p class="ref-why"><span class="ref-why-label">驳回</span>{cs(x['reason'])}</p></div>
</div>''' for x in refuted)

nav = ''.join(
    f'<a class="nav-item" href="#issue-{i["rank"]}" data-nav="{i["rank"]}" data-sev="{SEV[i["severity"]][1]}" '
    f'data-mod="{e(i["module"])}"><span class="nav-dot sev-{SEV[i["severity"]][1]}"></span>'
    f'<span class="nav-n">{i["rank"]}</span><span class="nav-t">{e(i["title"][:46])}</span></a>'
    for i in open_issues)

mod_chips = ''.join(f'<button class="chip" data-filter-mod="{e(m)}" aria-pressed="false">{e(m)}'
                    f'<span class="chip-n">{mod_counts[m]}</span></button>' for m in mods)

fixed_stat = (f'<div class="stat"><div class="stat-n done">{len(fixed_issues)}</div>'
              f'<div class="stat-l">已修复</div></div>') if fixed_issues else ''
fixed_link = '<a class="rail-jump" href="#fixed">跳到已修复 &darr;</a>' if fixed_issues else ''

HTML = f'''<title>AAtools 代码审计</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
:root {{
  --ground:#faf9fc; --surface:#ffffff; --surface-2:#f3f1f8;
  --ink:#1d1a26; --ink-2:#4a4458; --muted:#6f6880; --line:#e3dfec; --line-2:#d3cde1;
  --accent:#7c3aed; --accent-ink:#5b21b6; --accent-soft:#f0ebfe;
  --high:#bf2f49; --high-bg:#fcedf0; --high-line:#f2ccd4;
  --med:#a4620b; --med-bg:#fdf4e7; --med-line:#f0dcbc;
  --low:#3f6f86; --low-bg:#edf3f7; --low-line:#cfdfe8;
  --done:#5b8c5a; --done-bg:#eef5ee; --done-line:#cfe2ce;
  --sans:"IBM Plex Sans","PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;
  --mono:"IBM Plex Mono","SF Mono",Menlo,Consolas,monospace;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --ground:#141221; --surface:#1c1930; --surface-2:#241f3a;
    --ink:#ece9f5; --ink-2:#c3bcd6; --muted:#918aa8; --line:#2f2947; --line-2:#3b3457;
    --accent:#a78bfa; --accent-ink:#c4b5fd; --accent-soft:#2a2145;
    --high:#f2879b; --high-bg:#331d25; --high-line:#4d2a34;
    --med:#e3ac5f; --med-bg:#302517; --med-line:#4a3922;
    --low:#8fbcd3; --low-bg:#1b2831; --low-line:#2b3d49;
    --done:#8fc08d; --done-bg:#1d2a1d; --done-line:#2e422d;
  }}
}}
:root[data-theme="dark"] {{
  --ground:#141221; --surface:#1c1930; --surface-2:#241f3a;
  --ink:#ece9f5; --ink-2:#c3bcd6; --muted:#918aa8; --line:#2f2947; --line-2:#3b3457;
  --accent:#a78bfa; --accent-ink:#c4b5fd; --accent-soft:#2a2145;
  --high:#f2879b; --high-bg:#331d25; --high-line:#4d2a34;
  --med:#e3ac5f; --med-bg:#302517; --med-line:#4a3922;
  --low:#8fbcd3; --low-bg:#1b2831; --low-line:#2b3d49;
  --done:#8fc08d; --done-bg:#1d2a1d; --done-line:#2e422d;
}}
*,*::before,*::after {{ box-sizing:border-box; }}
body {{ margin:0; background:var(--ground); color:var(--ink); font-family:var(--sans);
  font-size:15px; line-height:1.62; -webkit-font-smoothing:antialiased; }}
code {{ font-family:var(--mono); font-size:.86em; }}
a {{ color:inherit; }}
:focus-visible {{ outline:2px solid var(--accent); outline-offset:2px; border-radius:3px; }}
@media (prefers-reduced-motion:reduce) {{ * {{ transition:none!important; }} }}

.masthead {{ border-bottom:1px solid var(--line); background:var(--surface); }}
.masthead-in {{ max-width:1320px; margin:0 auto; padding:34px 32px 26px;
  display:flex; flex-wrap:wrap; gap:24px; align-items:flex-end; justify-content:space-between; }}
.brand-eyebrow {{ font-family:var(--mono); font-size:11px; font-weight:500; letter-spacing:.14em;
  text-transform:uppercase; color:var(--accent); margin:0 0 8px; }}
h1 {{ font-size:30px; font-weight:600; letter-spacing:-.018em; margin:0; text-wrap:balance; }}
.subtitle {{ margin:9px 0 0; color:var(--muted); font-size:14px; max-width:64ch; }}
.theme-btn {{ font:inherit; font-size:12px; color:var(--muted); background:var(--surface-2);
  border:1px solid var(--line); border-radius:999px; padding:6px 14px; cursor:pointer; }}
.theme-btn:hover {{ color:var(--ink); border-color:var(--line-2); }}

.stats {{ max-width:1320px; margin:0 auto; padding:0 32px; }}
.stats-in {{ display:flex; flex-wrap:wrap; border:1px solid var(--line);
  border-radius:10px; background:var(--surface); overflow:hidden; margin-top:-1px; }}
.stat {{ flex:1 1 120px; padding:16px 20px; border-right:1px solid var(--line); }}
.stat:last-child {{ border-right:0; }}
.stat-n {{ font-family:var(--mono); font-size:26px; font-weight:600; line-height:1.1;
  font-variant-numeric:tabular-nums; letter-spacing:-.02em; }}
.stat-l {{ font-size:12px; color:var(--muted); margin-top:4px; }}
.stat-n.high {{ color:var(--high); }} .stat-n.med {{ color:var(--med); }}
.stat-n.low {{ color:var(--low); }} .stat-n.ok {{ color:var(--accent); }}
.stat-n.done {{ color:var(--done); }}

.shell {{ max-width:1320px; margin:0 auto; padding:28px 32px 90px;
  display:grid; grid-template-columns:246px minmax(0,1fr); gap:38px; align-items:start; }}
.rail {{ position:sticky; top:20px; max-height:calc(100vh - 40px);
  display:flex; flex-direction:column; gap:16px; min-height:0; }}
.rail-label {{ font-family:var(--mono); font-size:10px; font-weight:500; letter-spacing:.13em;
  text-transform:uppercase; color:var(--muted); margin:0 0 9px; }}
.rail-jump {{ font-size:12px; color:var(--muted); text-decoration:none; }}
.rail-jump:hover {{ color:var(--accent); }}
.search {{ width:100%; font:inherit; font-size:13px; padding:9px 12px; color:var(--ink);
  background:var(--surface); border:1px solid var(--line); border-radius:8px; }}
.search::placeholder {{ color:var(--muted); }}
.chips {{ display:flex; flex-wrap:wrap; gap:6px; }}
.chip {{ font:inherit; font-size:12px; display:inline-flex; align-items:center; gap:6px;
  padding:5px 10px; border-radius:7px; cursor:pointer; color:var(--ink-2);
  background:var(--surface); border:1px solid var(--line); }}
.chip:hover {{ border-color:var(--line-2); }}
.chip[aria-pressed="true"] {{ background:var(--accent-soft); border-color:var(--accent);
  color:var(--accent-ink); font-weight:500; }}
.chip-n {{ font-family:var(--mono); font-size:10.5px; color:var(--muted);
  font-variant-numeric:tabular-nums; }}
.chip[aria-pressed="true"] .chip-n {{ color:var(--accent-ink); }}
.nav {{ overflow-y:auto; border-top:1px solid var(--line); padding-top:10px; min-height:0; }}
.nav-item {{ display:grid; grid-template-columns:7px 22px 1fr; align-items:baseline; gap:8px;
  padding:5px 4px; border-radius:6px; text-decoration:none; font-size:12.5px; color:var(--ink-2); }}
.nav-item:hover {{ background:var(--surface-2); color:var(--ink); }}
.nav-dot {{ width:7px; height:7px; border-radius:2px; align-self:center; }}
.nav-dot.sev-high {{ background:var(--high); }}
.nav-dot.sev-med {{ background:var(--med); }}
.nav-dot.sev-low {{ background:var(--low); }}
.nav-n {{ font-family:var(--mono); font-size:11px; color:var(--muted);
  font-variant-numeric:tabular-nums; }}
.nav-t {{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}

.sev-head {{ display:flex; align-items:center; gap:11px; margin:38px 0 16px;
  font-size:14px; font-weight:600; letter-spacing:.04em; scroll-margin-top:20px; }}
.sev-head:first-child {{ margin-top:0; }}
.sev-head-dot {{ width:9px; height:9px; border-radius:2px; }}
.sev-head.sev-high {{ color:var(--high); }}
.sev-head.sev-high .sev-head-dot {{ background:var(--high); }}
.sev-head.sev-med {{ color:var(--med); }}
.sev-head.sev-med .sev-head-dot {{ background:var(--med); }}
.sev-head.sev-low {{ color:var(--low); }}
.sev-head.sev-low .sev-head-dot {{ background:var(--low); }}
.sev-head.sev-fixed {{ color:var(--done); }}
.sev-head.sev-fixed .sev-head-dot {{ background:var(--done); }}
.sev-head-n {{ font-family:var(--mono); font-size:11px; font-weight:400; color:var(--muted);
  font-variant-numeric:tabular-nums; }}

.issue {{ background:var(--surface); border:1px solid var(--line); border-left-width:3px;
  border-radius:0 9px 9px 0; padding:17px 22px 19px; margin-bottom:11px; scroll-margin-top:20px; }}
.issue.sev-high {{ border-left-color:var(--high); }}
.issue.sev-med {{ border-left-color:var(--med); }}
.issue.sev-low {{ border-left-color:var(--low); }}
.issue-head {{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }}
.rank {{ font-family:var(--mono); font-size:12px; font-weight:600; color:var(--muted);
  font-variant-numeric:tabular-nums; }}
.pill {{ font-size:11px; font-weight:600; padding:2px 9px; border-radius:5px;
  border:1px solid transparent; }}
.pill-high {{ color:var(--high); background:var(--high-bg); border-color:var(--high-line); }}
.pill-med {{ color:var(--med); background:var(--med-bg); border-color:var(--med-line); }}
.pill-low {{ color:var(--low); background:var(--low-bg); border-color:var(--low-line); }}
.pill-fixed {{ color:var(--done); background:var(--done-bg); border-color:var(--done-line); }}
.mod {{ font-size:12px; color:var(--muted); }}
.issue-title {{ font-size:16.5px; font-weight:600; line-height:1.45; letter-spacing:-.008em;
  margin:11px 0 0; text-wrap:balance; }}
.issue-title code {{ background:var(--surface-2); padding:1px 5px; border-radius:4px; }}
.locs {{ display:flex; flex-wrap:wrap; gap:5px; margin:11px 0 0; }}
.loc {{ font-size:11.5px; color:var(--ink-2); background:var(--surface-2);
  border:1px solid var(--line); border-radius:5px; padding:2px 7px; white-space:nowrap; }}
.desc {{ margin:13px 0 0; color:var(--ink-2); font-size:14.2px; max-width:76ch; }}
.desc code {{ background:var(--surface-2); padding:1px 4px; border-radius:3px; color:var(--ink); }}
.fix {{ margin:14px 0 0; padding:12px 15px; background:var(--accent-soft); border-radius:7px; }}
.fix-label {{ display:block; font-family:var(--mono); font-size:10px; font-weight:600;
  letter-spacing:.12em; text-transform:uppercase; color:var(--accent-ink); margin-bottom:5px; }}
.fix p {{ margin:0; font-size:13.8px; color:var(--ink-2); max-width:76ch; }}
.fix code {{ background:var(--surface); padding:1px 5px; border-radius:3px;
  border:1px solid var(--line); color:var(--ink); }}

/* 已修复：删除线 + 置灰 + 置底 */
.fixed-section {{ margin-top:54px; padding-top:8px; }}
.fixed-note {{ margin:-6px 0 16px; font-size:13px; color:var(--muted); }}
.issue.is-fixed {{ border-left-color:var(--line-2); background:transparent;
  padding-top:13px; padding-bottom:14px; }}
.issue.is-fixed .issue-title {{ color:var(--muted); font-weight:500; font-size:15px;
  text-decoration:line-through; text-decoration-thickness:1px;
  text-decoration-color:var(--line-2); }}
.issue.is-fixed .rank, .issue.is-fixed .mod {{ color:var(--line-2); }}
.issue.is-fixed .loc {{ color:var(--muted); background:transparent; }}
.fixnote {{ margin:11px 0 0; padding:10px 14px; background:var(--done-bg);
  border:1px solid var(--done-line); border-radius:7px; }}
.fixnote-label {{ display:block; font-family:var(--mono); font-size:10px; font-weight:600;
  letter-spacing:.12em; text-transform:uppercase; color:var(--done); margin-bottom:4px; }}
.fixnote p {{ margin:0; font-size:13.5px; color:var(--ink-2); max-width:76ch; }}

.refuted {{ margin-top:54px; padding-top:26px; border-top:1px solid var(--line); }}
.refuted h2 {{ font-size:14px; font-weight:600; margin:0 0 6px; letter-spacing:.04em; }}
.refuted-note {{ margin:0 0 18px; font-size:13px; color:var(--muted); max-width:70ch; }}
.ref-row {{ display:grid; grid-template-columns:190px minmax(0,1fr); gap:16px;
  padding:13px 0; border-top:1px solid var(--line); align-items:start; }}
.ref-row .loc {{ justify-self:start; }}
.ref-title {{ margin:0; font-size:13.6px; font-weight:500; color:var(--ink-2); }}
.ref-why {{ margin:6px 0 0; font-size:13px; color:var(--muted); max-width:80ch; }}
.ref-why-label {{ font-family:var(--mono); font-size:9.5px; font-weight:600; letter-spacing:.12em;
  text-transform:uppercase; color:var(--muted); border:1px solid var(--line-2);
  border-radius:4px; padding:1px 5px; margin-right:8px; }}

.empty {{ padding:40px 0; color:var(--muted); font-size:14px; }}
.foot {{ max-width:1320px; margin:0 auto; padding:0 32px 40px; color:var(--muted); font-size:12px; }}
.foot code {{ color:var(--ink-2); }}

@media (max-width: 940px) {{
  .shell {{ grid-template-columns:1fr; gap:22px; padding:22px 20px 70px; }}
  .rail {{ position:static; max-height:none; }}
  .nav {{ display:none; }}
  .masthead-in, .stats, .foot {{ padding-left:20px; padding-right:20px; }}
  .ref-row {{ grid-template-columns:1fr; gap:7px; }}
}}
</style>

<header class="masthead">
  <div class="masthead-in">
    <div>
      <p class="brand-eyebrow">Chrome 扩展 · 静态审计</p>
      <h1>AAtools 代码审计</h1>
      <p class="subtitle">全量通读 {meta['loc']:,} 行源码，{meta['method']}。</p>
    </div>
    <button class="theme-btn" id="themeBtn" type="button">切换主题</button>
  </div>
</header>

<section class="stats">
  <div class="stats-in">
    <div class="stat"><div class="stat-n">{len(open_issues)}</div><div class="stat-l">待处理</div></div>
    <div class="stat"><div class="stat-n high">{counts['high']}</div><div class="stat-l">严重</div></div>
    <div class="stat"><div class="stat-n med">{counts['medium']}</div><div class="stat-l">中等</div></div>
    <div class="stat"><div class="stat-n low">{counts['low']}</div><div class="stat-l">轻微</div></div>
    {fixed_stat}
    <div class="stat"><div class="stat-n">{len(refuted)}</div><div class="stat-l">复核驳回</div></div>
    <div class="stat"><div class="stat-n ok">{meta['tests']}</div><div class="stat-l">现有测试通过</div></div>
  </div>
</section>

<div class="shell">
  <aside class="rail">
    <div>
      <p class="rail-label">检索</p>
      <input class="search" id="q" type="search" placeholder="搜索标题、文件、正文" autocomplete="off">
    </div>
    <div>
      <p class="rail-label">严重程度</p>
      <div class="chips" id="sevChips">
        <button class="chip" data-filter-sev="high" aria-pressed="false">严重<span class="chip-n">{counts['high']}</span></button>
        <button class="chip" data-filter-sev="med" aria-pressed="false">中等<span class="chip-n">{counts['medium']}</span></button>
        <button class="chip" data-filter-sev="low" aria-pressed="false">轻微<span class="chip-n">{counts['low']}</span></button>
      </div>
    </div>
    <div>
      <p class="rail-label">模块</p>
      <div class="chips" id="modChips">{mod_chips}</div>
    </div>
    {fixed_link}
    <nav class="nav" id="nav" aria-label="问题索引">{nav}</nav>
  </aside>

  <main id="list">
    {''.join(blocks)}
    <p class="empty" id="empty" hidden>没有匹配的问题。</p>
    {fixed_html}

    <section class="refuted">
      <h2>复核后驳回</h2>
      <p class="refuted-note">审查员提出但经独立复核不成立、或属于测试覆盖建议而非代码缺陷的条目，列此备查。</p>
      {ref_rows}
    </section>
  </main>
</div>

<p class="foot">生成于 {meta['date']} · 数据源 <code>audit/issues.json</code>，修复后把该条 <code>fixed</code> 改为 true 并重跑 <code>python3 audit/build.py</code>。</p>

<script>
(function () {{
  var root = document.documentElement;
  function get(k) {{ try {{ return localStorage.getItem(k); }} catch (e) {{ return null; }} }}
  function set(k, v) {{ try {{ localStorage.setItem(k, v); }} catch (e) {{}} }}

  var saved = get('aatools-audit-theme');
  if (saved === 'dark' || saved === 'light') root.setAttribute('data-theme', saved);
  document.getElementById('themeBtn').addEventListener('click', function () {{
    var dark = root.getAttribute('data-theme') === 'dark' ||
      (!root.hasAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    var next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    set('aatools-audit-theme', next);
  }});

  var issues = [].slice.call(document.querySelectorAll('#list > .issue'));
  var navItems = [].slice.call(document.querySelectorAll('.nav-item'));
  var heads = [].slice.call(document.querySelectorAll('#list > .sev-head'));
  var qEl = document.getElementById('q');
  var emptyEl = document.getElementById('empty');
  var sevOn = {{}}, modOn = {{}};

  function anyOn(o) {{ for (var k in o) {{ if (o[k]) return true; }} return false; }}

  function apply() {{
    var q = qEl.value.trim().toLowerCase();
    var shown = 0, byRank = {{}};
    issues.forEach(function (el) {{
      var ok = true;
      if (anyOn(sevOn) && !sevOn[el.dataset.sev]) ok = false;
      if (ok && anyOn(modOn) && !modOn[el.dataset.mod]) ok = false;
      if (ok && q && el.textContent.toLowerCase().indexOf(q) < 0) ok = false;
      el.hidden = !ok;
      byRank[el.id.slice(6)] = ok;
      if (ok) shown++;
    }});
    navItems.forEach(function (a) {{ a.hidden = !byRank[a.dataset.nav]; }});
    heads.forEach(function (h) {{
      var sib = h.nextElementSibling, live = false;
      while (sib && sib.classList.contains('issue')) {{
        if (!sib.hidden) {{ live = true; break; }}
        sib = sib.nextElementSibling;
      }}
      h.hidden = !live;
    }});
    emptyEl.hidden = shown > 0;
  }}

  function bindChips(id, state, key) {{
    var host = document.getElementById(id);
    if (!host) return;
    host.addEventListener('click', function (ev) {{
      var btn = ev.target.closest('.chip');
      if (!btn) return;
      var v = btn.getAttribute(key);
      state[v] = !state[v];
      btn.setAttribute('aria-pressed', state[v] ? 'true' : 'false');
      apply();
    }});
  }}
  bindChips('sevChips', sevOn, 'data-filter-sev');
  bindChips('modChips', modOn, 'data-filter-mod');
  qEl.addEventListener('input', apply);
}})();
</script>
'''

open(OUT, 'w').write(HTML)
print(f'index.html 已生成：待处理 {len(open_issues)} 条，已修复 {len(fixed_issues)} 条，驳回 {len(refuted)} 条')

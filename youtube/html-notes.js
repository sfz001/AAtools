// src/html-notes.js — HTML 笔记
// 新版架构：模型输出结构化 JSON（内容），扩展用内置模板渲染成精美网页（样式固定可控）
// 兼容：只有明确且通过结构上限的旧版 HTML（历史缓存/自定义 promptHtml）可渲染；
// 损坏 JSON、拒答与普通文字一律作为错误拒绝。

// ── 笔记模板渲染器 ──────────────────────────────────────────
YTX.HtmlNotes = {

  // 页面样式：纯 CSS、零外部资源、零脚本，兼容 sanitizeHtml 注入的严格 CSP
  CSS: [
    ':root{color-scheme:light dark;--bg:#f6f6fb;--card:#ffffff;--ink:#23223a;--ink-2:#5b5872;--ink-3:#8f8ca6;--line:#e9e8f2;--accent:#7c3aed;--accent-soft:rgba(124,58,237,.10);--grad:linear-gradient(135deg,#6d28d9 0%,#7c3aed 48%,#8b5cf6 100%);--shadow:0 1px 2px rgba(35,34,58,.05),0 10px 28px -14px rgba(109,40,217,.20)}',
    '@media (prefers-color-scheme:dark){:root{--bg:#12121a;--card:#1b1b26;--ink:#e9e8f4;--ink-2:#b5b3c9;--ink-3:#7d7a95;--line:#2a2a3a;--accent-soft:rgba(139,92,246,.16);--shadow:0 1px 2px rgba(0,0,0,.45),0 12px 32px -16px rgba(0,0,0,.6)}}',
    '*{margin:0;padding:0;box-sizing:border-box}',
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Source Han Sans SC",sans-serif;background:var(--bg);color:var(--ink);line-height:1.75;font-size:15px;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;padding:40px 18px 72px}',
    '::selection{background:rgba(124,58,237,.25)}',
    '.page{max-width:780px;margin:0 auto}',
    // ── 顶部横幅 ──
    '.hero{position:relative;overflow:hidden;border-radius:24px;background:var(--grad);color:#fff;padding:46px 42px 40px;box-shadow:0 24px 60px -22px rgba(109,40,217,.55)}',
    '.hero::before{content:"";position:absolute;width:340px;height:340px;right:-110px;top:-140px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.28),rgba(255,255,255,0) 68%)}',
    '.hero::after{content:"";position:absolute;width:240px;height:240px;left:-90px;bottom:-120px;border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.16),rgba(255,255,255,0) 66%)}',
    '.hero>*{position:relative}',
    '.eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:11.5px;font-weight:700;letter-spacing:.18em;color:rgba(255,255,255,.9);background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:5px 14px;margin-bottom:20px}',
    '.eyebrow::before{content:"";width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 0 4px rgba(255,255,255,.25)}',
    '.hero-title{font-size:26px;font-weight:800;letter-spacing:.01em;line-height:1.42;margin-bottom:14px}',
    '.hero-meta{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12.5px;color:rgba(255,255,255,.85)}',
    '.tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}',
    '.tag{font-size:12px;font-weight:600;color:#fff;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:4px 12px}',
    // ── 通用区块 ──
    '.section{margin-top:30px}',
    '.section-head{display:flex;align-items:center;gap:12px;margin-bottom:16px}',
    '.section-badge{width:30px;height:30px;flex:none;border-radius:10px;background:var(--grad);color:#fff;font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 14px -6px rgba(109,40,217,.5)}',
    '.section-title{font-size:17px;font-weight:800;letter-spacing:.02em}',
    '.section-sub{margin-left:auto;font-size:12px;color:var(--ink-3)}',
    '.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:24px 26px;box-shadow:var(--shadow)}',
    // ── 核心摘要 ──
    '.summary-card{position:relative;overflow:hidden}',
    '.summary-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--grad)}',
    '.summary-text{font-size:15.5px}',
    // ── 关键要点 ──
    '.kp{display:flex;gap:16px;padding:18px 20px;transition:transform .18s ease,box-shadow .18s ease}',
    '.kp+.kp{margin-top:12px}',
    '.kp:hover{transform:translateY(-1px);box-shadow:0 2px 4px rgba(35,34,58,.06),0 14px 32px -14px rgba(109,40,217,.3)}',
    '.kp-idx{flex:none;width:28px;height:28px;margin-top:2px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-size:13px;font-weight:800;display:flex;align-items:center;justify-content:center}',
    '.kp-body{flex:1;min-width:0}',
    '.ts{display:inline-block;font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;font-size:11.5px;font-weight:700;line-height:1;color:#fff;background:var(--grad);border-radius:7px;padding:5px 9px;margin-right:8px;vertical-align:1.5px;cursor:pointer;white-space:nowrap;text-decoration:none;transition:transform .15s ease}',
    '.ts:hover{transform:translateY(-1px)}',
    // ── 详细内容时间线 ──
    '.tl{position:relative;margin:6px 4px 0}',
    '.tl::before{content:"";position:absolute;left:78px;top:6px;bottom:6px;width:2px;border-radius:2px;background:linear-gradient(180deg,var(--accent) 0%,rgba(124,58,237,.35) 60%,rgba(124,58,237,.08) 100%)}',
    '.tl-item{position:relative;padding:0 0 26px 112px}',
    '.tl-item:last-child{padding-bottom:2px}',
    '.tl-dot{position:absolute;left:72.5px;top:9px;width:13px;height:13px;border-radius:50%;background:var(--card);border:3px solid var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}',
    '.tl-time{position:absolute;left:0;top:5px;width:58px;text-align:right;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px;font-weight:700;color:var(--accent);cursor:pointer;text-decoration:none}',
    '.tl-head{font-size:15.5px;font-weight:700}',
    '.tl-text{margin-top:5px;font-size:14px;color:var(--ink-2)}',
    // ── 页脚 ──
    '.foot{margin-top:46px;padding-top:18px;border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--ink-3)}',
    '.foot-brand{display:inline-flex;align-items:center;gap:7px;font-weight:700;color:var(--accent)}',
    '.foot-brand::before{content:"";width:8px;height:8px;border-radius:3px;background:var(--grad)}',
    // ── 响应式 / 打印 ──
    '@media (max-width:560px){body{padding:24px 14px 48px;font-size:14.5px}.hero{padding:34px 24px 30px;border-radius:20px}.hero-title{font-size:21px}.card{padding:20px 18px}.tl-item{padding-left:92px}.tl::before{left:62px}.tl-dot{left:56.5px}.tl-time{width:46px;font-size:11px}.foot{flex-direction:column;align-items:flex-start;gap:6px}}',
    '@media print{body{background:#fff;padding:0}.hero{box-shadow:none}.card,.hero{-webkit-print-color-adjust:exact;print-color-adjust:exact}.foot{display:none}}',
  ].join('\n'),

  esc: function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  // 解析模型输出：JSON → 规范化数据对象；失败返回 null。只有另行通过
  // isLegacyHtmlOutput 严格判定的明确旧版 HTML 才能进入兼容渲染路径。
  parseNote: function (text) {
    if (!text) return null;
    try {
      var raw = YTX.extractJSON(text, 'object');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      if (Object.prototype.hasOwnProperty.call(raw, 'summary') && typeof raw.summary !== 'string') return null;
      if (Object.prototype.hasOwnProperty.call(raw, 'keyPoints') && !Array.isArray(raw.keyPoints)) return null;
      if (Object.prototype.hasOwnProperty.call(raw, 'sections') && !Array.isArray(raw.sections)) return null;
      if (Object.prototype.hasOwnProperty.call(raw, 'tags') && !Array.isArray(raw.tags)) return null;
      if ((raw.keyPoints && raw.keyPoints.length > 100) ||
          (raw.sections && raw.sections.length > 100) ||
          (raw.tags && raw.tags.length > 100)) return null;
      var hasContent = typeof raw.summary === 'string' ||
                       Array.isArray(raw.keyPoints) || Array.isArray(raw.sections);
      if (!hasContent) return null;

      function normTime(t) {
        if (t == null) return '';
        if (typeof t !== 'string') return '';
        var s = t.trim()
          .replace(/^[\[(【]\s*/, '')
          .replace(/\s*[\])】]$/, '');
        s = YTX.safeTime(s);
        if (!s) return '';
        var secs = YTX.timeToSeconds(s);
        if (isFinite(secs) && secs >= 0) return YTX.fmtTime(secs);
        return s;
      }
      function normText(t, maxChars) {
        if (typeof t !== 'string') return '';
        var value = t
          .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return value.length > maxChars ? value.slice(0, maxChars) : value;
      }
      function optionalString(value) { return value == null || typeof value === 'string'; }

      var keyPoints = (Array.isArray(raw.keyPoints) ? raw.keyPoints : [])
        .filter(function (k) {
          return k && typeof k === 'object' && !Array.isArray(k) &&
            typeof k.text === 'string' && optionalString(k.time) && normText(k.text, 4000);
        })
        .slice(0, 10)
        .map(function (k) { return { time: normTime(k.time), text: normText(k.text, 4000) }; });

      var sections = (Array.isArray(raw.sections) ? raw.sections : [])
        .filter(function (s) {
          return s && typeof s === 'object' && !Array.isArray(s) && optionalString(s.time) &&
            optionalString(s.heading) && optionalString(s.text) &&
            (normText(s.heading, 300) || normText(s.text, 20000));
        })
        .slice(0, 12)
        .map(function (s) {
          return { time: normTime(s.time), heading: normText(s.heading, 300), text: normText(s.text, 20000) };
        });

      var tags = (Array.isArray(raw.tags) ? raw.tags : [])
        .filter(function (t) { return typeof t === 'string' && t.trim(); })
        .slice(0, 6)
        .map(function (t) {
          return t.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
            .replace(/\s+/g, ' ').trim().replace(/^#+/, '').slice(0, 100);
        })
        .filter(Boolean);

      var note = { summary: normText(raw.summary, 20000), keyPoints: keyPoints, sections: sections, tags: tags };
      if (!note.summary && !note.keyPoints.length && !note.sections.length) return null;
      return note;
    } catch (e) {
      return null;
    }
  },

  unwrapLegacyHtmlOutput: function (text) {
    var source = String(text || '').trim();
    var fenced = source.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : source;
  },

  // 仅作格式诊断；是否接受结果由 parseNote / isLegacyHtmlOutput 的白名单决定。
  isLikelyJsonOutput: function (text) {
    var source = String(text || '').trim();
    return /^```(?:json)?\s*/i.test(source) || /^[{[]/.test(source);
  },

  // 旧版兼容只接受明确的网页/结构化 HTML。普通拒答、解释文字或损坏 JSON
  // 不能再落入“旧 HTML”分支并被当成成功结果长期缓存。
  isLegacyHtmlOutput: function (text) {
    var source = this.unwrapLegacyHtmlOutput(text);
    if (!source || source.length > YTX.LEGACY_HTML_MAX_CHARS) return false;
    source = source.replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
    var isFullDocument = /^<!doctype\s+html\b/i.test(source) || /^<html\b/i.test(source);
    var hasFragmentStructure = /<(?:main|article|section)\b/i.test(source);
    if (!isFullDocument && !hasFragmentStructure) return false;

    // 在 DOMParser 前先用有界扫描拒绝明显的元素洪泛；实际浏览器中再以
    // 解析后的精确元素数复核（隐式 html/head/body 也计入）。
    var tags = 0;
    var tagPattern = /<\s*[a-z][^>]*>/gi;
    while (tagPattern.exec(source)) {
      if (++tags > YTX.HTML_MAX_ELEMENTS) return false;
    }
    function hasMeaningfulText(inner) {
      return inner
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/&(?:nbsp|#160|#x0*a0);/gi, ' ')
        .replace(/&(?:[a-z][a-z0-9]+|#[0-9]+|#x[0-9a-f]+);/gi, 'x')
        .trim().length > 0;
    }

    // 完整历史网页继续兼容；HTML 片段则必须有语义容器，并包含标题或
    // 至少两个非空内容元素，避免 <p>Sorry…</p>/<div>拒答</div> 被缓存。
    if (!isFullDocument) {
      var meaningfulCount = 0;
      var hasHeading = false;
      var meaningfulPattern = /<(h[1-6]|p|li|blockquote|pre|td|th|dt|dd|figcaption)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
      var match;
      while ((match = meaningfulPattern.exec(source))) {
        if (!hasMeaningfulText(match[2])) continue;
        meaningfulCount++;
        if (/^h[1-6]$/i.test(match[1])) hasHeading = true;
        if (hasHeading || meaningfulCount >= 2) break;
      }
      if (!hasHeading && meaningfulCount < 2) return false;
    }

    if (typeof DOMParser === 'function') {
      try {
        var doc = new DOMParser().parseFromString(source, 'text/html');
        if (!doc || doc.querySelectorAll('*').length > YTX.HTML_MAX_ELEMENTS) return false;
        if (!isFullDocument) {
          var roots = doc.querySelectorAll('main,article,section');
          var domMeaningfulCount = 0;
          var domHasHeading = false;
          for (var r = 0; r < roots.length; r++) {
            var nodes = roots[r].querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th,dt,dd,figcaption');
            for (var n = 0; n < nodes.length; n++) {
              if (!nodes[n].textContent || !nodes[n].textContent.trim()) continue;
              domMeaningfulCount++;
              if (/^H[1-6]$/.test(nodes[n].tagName)) domHasHeading = true;
              if (domHasHeading || domMeaningfulCount >= 2) break;
            }
            if (domHasHeading || domMeaningfulCount >= 2) break;
          }
          if (!domHasHeading && domMeaningfulCount < 2) return false;
        }
      } catch (_) {
        return false;
      }
    }
    return true;
  },

  // 结构化数据 → 完整网页 HTML
  buildNoteHtml: function (data) {
    var esc = this.esc;
    var title = YTX.Export.getVideoTitle();
    if (!title || title === 'YouTube Video') title = 'YouTube 视频笔记';

    var now = new Date();
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    var dateStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    var timeStr = pad(now.getHours()) + ':' + pad(now.getMinutes());
    var videoUrl = YTX.getVideoUrl();

    function timeAnchor(time, className) {
      var seconds = YTX.parseTime(time);
      if (seconds == null) return '';
      var href = videoUrl + '&t=' + seconds + 's';
      return '<a class="' + className + '" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(time) + '</a>';
    }

    var meta = ['<span>' + esc(dateStr) + ' 生成</span>'];
    if (data.sections.length) meta.push('<span>' + data.sections.length + ' 个章节</span>');
    if (data.keyPoints.length) meta.push('<span>' + data.keyPoints.length + ' 个要点</span>');

    var hero =
      '<header class="hero">' +
        '<span class="eyebrow">YOUTUBE · 视频笔记</span>' +
        '<h1 class="hero-title">' + esc(title) + '</h1>' +
        '<div class="hero-meta">' + meta.join('') + '</div>' +
        (data.tags.length
          ? '<div class="tags">' + data.tags.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>'
          : '') +
      '</header>';

    var html = [];
    var n = 0;

    if (data.summary) {
      n++;
      html.push(
        '<section class="section">' +
          '<div class="section-head"><span class="section-badge">' + n + '</span><h2 class="section-title">核心摘要</h2></div>' +
          '<div class="card summary-card"><p class="summary-text">' + esc(data.summary) + '</p></div>' +
        '</section>'
      );
    }

    if (data.keyPoints.length) {
      n++;
      html.push(
        '<section class="section">' +
          '<div class="section-head"><span class="section-badge">' + n + '</span><h2 class="section-title">关键要点</h2><span class="section-sub">共 ' + data.keyPoints.length + ' 条</span></div>' +
          data.keyPoints.map(function (k, i) {
            return '<div class="card kp">' +
              '<span class="kp-idx">' + (i + 1) + '</span>' +
              '<div class="kp-body"><p class="kp-text">' +
                (k.time ? timeAnchor(k.time, 'ts') : '') +
                esc(k.text) +
              '</p></div>' +
            '</div>';
          }).join('') +
        '</section>'
      );
    }

    if (data.sections.length) {
      n++;
      html.push(
        '<section class="section">' +
          '<div class="section-head"><span class="section-badge">' + n + '</span><h2 class="section-title">详细内容</h2><span class="section-sub">共 ' + data.sections.length + ' 段</span></div>' +
          '<div class="tl">' +
            data.sections.map(function (s) {
              return '<div class="tl-item">' +
                '<span class="tl-dot"></span>' +
                (s.time ? timeAnchor(s.time, 'tl-time') : '') +
                '<div class="tl-body">' +
                  (s.heading ? '<h3 class="tl-head">' + esc(s.heading) + '</h3>' : '') +
                  (s.text ? '<p class="tl-text">' + esc(s.text) + '</p>' : '') +
                '</div>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</section>'
      );
    }

    var foot =
      '<footer class="foot">' +
        '<span class="foot-brand">AAtools · AI 笔记</span>' +
        '<span>' + esc(dateStr + ' ' + timeStr) + ' · 时间戳可点击跳转视频</span>' +
      '</footer>';

    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + esc(title) + '</title>\n' +
      '<style>\n' + this.CSS + '\n</style>\n' +
      '</head>\n<body>\n<div class="page">\n' +
      hero + html.join('') + foot +
      '\n</div>\n</body>\n</html>';
  },

  // 结构化数据 → Obsidian Markdown
  noteToMarkdown: function (data) {
    var lines = [];
    if (data.summary) { lines.push('## 摘要', '', data.summary, ''); }
    if (data.keyPoints.length) {
      lines.push('## 关键要点', '');
      data.keyPoints.forEach(function (k) {
        lines.push('- ' + (k.time ? '[' + k.time + '] ' : '') + k.text);
      });
      lines.push('');
    }
    if (data.sections.length) {
      lines.push('## 详细内容', '');
      data.sections.forEach(function (s) {
        lines.push('### ' + (s.heading || '小节') + (s.time ? ' [' + s.time + ']' : ''));
        if (s.text) { lines.push('', s.text, ''); }
      });
    }
    if (data.tags.length) {
      var tags = data.tags.map(function (t) { return t.trim().replace(/\s+/g, '-'); }).filter(Boolean);
      if (tags.length) lines.push('## 标签', '', tags.map(function (t) { return '#' + t; }).join(' '), '');
    }
    return lines.join('\n').trim();
  },

  // 返回最终可进入 iframe/下载的 HTML；空串代表输出不应被接受或缓存。
  sanitizeOutput: function (text) {
    try {
      var data = this.parseNote(text);
      if (data) {
        return YTX.Export.sanitizeHtml(this.buildNoteHtml(data), {
          maxElements: YTX.HTML_MAX_ELEMENTS,
        });
      }
      if (!this.isLegacyHtmlOutput(text)) return '';
      return YTX.Export.sanitizeHtml(this.unwrapLegacyHtmlOutput(text), {
        maxChars: YTX.LEGACY_HTML_MAX_CHARS,
        maxElements: YTX.HTML_MAX_ELEMENTS,
      });
    } catch (_) {
      return '';
    }
  },
};

// ── 笔记 Feature ─────────────────────────────────────────────
YTX.features.html = {
  tab: { key: 'html', label: '笔记', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>' },
  prefix: 'HTML',
  contentId: 'ytx-content-html',
  actionsId: 'ytx-actions-html',
  displayMode: 'flex',

  // 状态
  text: '',
  isGenerating: false,

  reset: function () {
    this._activityVersion = (this._activityVersion || 0) + 1;
    this.text = '';
    this.isGenerating = false;
    if (this.requestId) YTX.cancelRequest(this.requestId);
    this.requestId = null;
    if (this._deferred) { this._deferred.reject(new Error('视频已切换')); this._deferred = null; }
  },

  actionsHtml: function () {
    return '<button id="ytx-generate-html" class="ytx-btn ytx-btn-icon ytx-btn-primary" title="生成笔记">' + YTX.icons.play + '</button>';
  },

  contentHtml: function () {
    return '<div class="ytx-empty">点击「生成笔记」将视频内容生成精美网页笔记</div>';
  },

  bindEvents: function (panel) {
    var self = this;
    panel.querySelector('#ytx-generate-html').addEventListener('click', function (e) {
      if (!YTX.isTrustedEvent(e)) return;
      self.start().catch(function () {});
    });
  },

  start: function () {
    var self = this;
    if (this.isGenerating) return Promise.resolve();
    this._activityVersion = (this._activityVersion || 0) + 1;
    this.isGenerating = true;
    this.text = '';

    if (this._deferred) this._deferred.reject(new Error('已被新请求覆盖'));
    this._deferred = YTX.createDeferred();
    var deferred = this._deferred;

    var startVideoId = YTX.currentVideoId;

    var btn = YTX.panel.querySelector('#ytx-generate-html');
    var contentEl = YTX.panel.querySelector('#ytx-content-html');
    btn.disabled = true;

    function bailSilently() {
      if (self._deferred === deferred) {
        self.isGenerating = false;
        deferred.resolve();
        self._deferred = null;
      }
    }

    var requestId = null;
    (async function () {
      try {
        btn.innerHTML = YTX.icons.spinner;
        contentEl.innerHTML = '<div class="ytx-loading" style="padding:14px 16px"><div class="ytx-spinner"></div><span>正在获取字幕...</span></div>';
        await YTX.ensureTranscript();
        if (YTX.currentVideoId !== startVideoId || self._deferred !== deferred) return bailSilently();

        btn.innerHTML = YTX.icons.spinner;
        contentEl.innerHTML = '<div class="ytx-loading" style="padding:14px 16px"><div class="ytx-spinner"></div><span>正在生成笔记...</span></div>';

        var settings = await YTX.getSettings();
        if (YTX.currentVideoId !== startVideoId || self._deferred !== deferred) return bailSilently();
        var payload = YTX.getContentPayload();

        if (self.requestId) YTX.cancelRequest(self.requestId);
        requestId = YTX.makeRequestId();
        self.requestId = requestId;
        await YTX.startStreamRequest(Object.assign({
          type: 'GENERATE_HTML',
          prompt: settings.promptHtml || YTX.prompts.HTML,
          provider: settings.provider,
          model: settings.model,
          requestId: requestId,
        }, payload));
      } catch (err) {
        if (self._deferred !== deferred) return;
        if (requestId && self.requestId !== requestId) return;
        if (requestId) {
          YTX.cancelRequest(requestId);
          self.requestId = null;
        }
        if (YTX.currentVideoId !== startVideoId) return bailSilently();
        YTX.renderError(contentEl, err.message);
        btn.disabled = false;
        YTX.btnPrimary(btn);
        self.isGenerating = false;
        if (self._deferred === deferred) { deferred.reject(err); self._deferred = null; }
      }
    })();

    return deferred.promise;
  },

  onChunk: function (text) {
    var nextText = YTX.appendCappedText(this.text, text);
    if (nextText === null) {
      if (this.requestId) YTX.cancelRequest(this.requestId);
      this.onError('AI 输出过长，已超过安全上限并取消生成');
      return;
    }
    this.text = nextText;
  },

  onDone: function (completion) {
    this.requestId = null;
    var parsedNote = YTX.HtmlNotes.parseNote(this.text);
    var validLegacyHtml = YTX.HtmlNotes.isLegacyHtmlOutput(this.text);
    var safeHtml = (parsedNote || validLegacyHtml) ? YTX.HtmlNotes.sanitizeOutput(this.text) : '';
    if (!safeHtml) {
      var error = new Error(this.text ? 'AI 返回的笔记格式无效，请重新生成' : 'AI 未返回笔记内容，请重新生成');
      YTX.parseError(YTX.panel.querySelector('#ytx-content-html'), '笔记', error);
      YTX.panel.querySelector('#ytx-generate-html').disabled = false;
      YTX.btnPrimary(YTX.panel.querySelector('#ytx-generate-html'));
      this.isGenerating = false;
      if (this._deferred) { this._deferred.reject(error); this._deferred = null; }
      return;
    }
    var incompleteWarning = YTX.streamCompletionWarning(completion);
    this.renderContent(safeHtml);
    if (incompleteWarning) {
      YTX.prependOutputWarning(YTX.panel.querySelector('#ytx-content-html'), incompleteWarning);
    }
    YTX.panel.querySelector('#ytx-generate-html').disabled = false;
    if (incompleteWarning) YTX.btnPrimary(YTX.panel.querySelector('#ytx-generate-html'));
    else YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-html'));
    this.isGenerating = false;
    if (!incompleteWarning) YTX.cache.save(YTX.currentVideoId, 'html', { text: this.text });
    if (this._deferred) {
      if (incompleteWarning) this._deferred.reject(new Error(incompleteWarning));
      else this._deferred.resolve();
      this._deferred = null;
    }
  },

  onError: function (error) {
    this.requestId = null;
    YTX.renderError(YTX.panel.querySelector('#ytx-content-html'), error);
    YTX.panel.querySelector('#ytx-generate-html').disabled = false;
    YTX.btnPrimary(YTX.panel.querySelector('#ytx-generate-html'));
    this.isGenerating = false;
    if (this._deferred) { this._deferred.reject(new Error(error)); this._deferred = null; }
  },

  renderContent: function (safeHtml) {
    if (!YTX.panel || !this.text) return;
    var self = this;
    var contentEl = YTX.panel.querySelector('#ytx-content-html');
    contentEl.innerHTML =
      '<div class="ytx-html-toolbar">' +
        '<span class="ytx-mm-toolbar-spacer"></span>' +
        '<button class="ytx-mm-tool-btn" data-action="open-tab">新标签打开</button>' +
        '<button class="ytx-mm-tool-btn" data-action="download">下载 HTML</button>' +
        '<button class="ytx-mm-tool-btn" data-action="export-obsidian">导出 Obsidian</button>' +
      '</div>';
    var iframe = document.createElement('iframe');
    // opaque origin：即使宿主页通过 window.frames 枚举到该 frame，也无法读取笔记。
    // 仅允许清洗后、target=_blank 的 YouTube 时间戳打开独立标签页。
    iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
    iframe.referrerPolicy = 'no-referrer';
    safeHtml = safeHtml || YTX.HtmlNotes.sanitizeOutput(this.text);
    if (!safeHtml) {
      YTX.parseError(contentEl, '笔记', new Error('笔记结构超过安全上限'));
      return;
    }
    iframe.srcdoc = safeHtml;
    contentEl.appendChild(iframe);

    contentEl.querySelectorAll('.ytx-mm-tool-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        if (!YTX.isTrustedEvent(e)) return;
        var action = btn.dataset.action;
        if (action === 'open-tab') self.openInNewTab();
        else if (action === 'download') self.downloadHtml();
        else if (action === 'export-obsidian') self.exportObsidian();
      });
    });
  },

  openInNewTab: function () {
    var safe = YTX.HtmlNotes.sanitizeOutput(this.text);
    if (!safe) return;
    var blob = new Blob([safe], { type: 'text/html' });
    var url = URL.createObjectURL(blob);
    var opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) {
      try { opened.opener = null; } catch (_) {}
    }
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  },

  downloadHtml: function () {
    var title = YTX.Export.getVideoTitle();
    var filename = YTX.Export.getSafeFilename(title) + '-笔记.html';
    var safe = YTX.HtmlNotes.sanitizeOutput(this.text);
    if (!safe) return;
    var blob = new Blob([safe], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    var btn = YTX.panel.querySelector('#ytx-content-html .ytx-mm-tool-btn[data-action="download"]');
    if (btn) YTX.Export.flashButton(btn, '已下载', 1500);
  },

  exportObsidian: function () {
    var title = YTX.Export.getVideoTitle() + ' - 笔记';
    var data = YTX.HtmlNotes.parseNote(this.text);
    var md = data
      ? YTX.HtmlNotes.noteToMarkdown(data)
      : YTX.Export.htmlToMarkdown(YTX.Export.sanitizeHtml(YTX.HtmlNotes.unwrapLegacyHtmlOutput(this.text)));
    YTX.Export.downloadObsidian(md, title);
    var btn = YTX.panel.querySelector('#ytx-content-html .ytx-mm-tool-btn[data-action="export-obsidian"]');
    if (btn) YTX.Export.flashButton(btn, '已导出', 1500);
  },
};

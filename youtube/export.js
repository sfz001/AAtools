// youtube/export.js — 导出模块：Markdown 下载 + Obsidian 导出

YTX.Export = {

  // ── 视频标题 ─────────────────────────────────────────
  getVideoTitle: function () {
    var el = document.querySelector('yt-formatted-string.ytd-watch-metadata') ||
             document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
             document.querySelector('#title h1 yt-formatted-string') ||
             document.querySelector('h1.title');
    return (el && el.textContent || '').trim() || 'YouTube Video';
  },

  getSafeFilename: function (title) {
    return title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 80) || 'export';
  },

  // ── Markdown 下载（纯本地）─────────────────────────────
  downloadMarkdown: function (md, filename) {
    var blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename + '.md';
    a.click();
    URL.revokeObjectURL(url);
  },

  // ── HTML → Markdown 转换 ──────────────────────────────
  htmlToMarkdown: function (html) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');
    var body = doc.body;
    if (!body) return html;

    function walk(node) {
      if (node.nodeType === 3) return node.textContent;
      if (node.nodeType !== 1) return '';

      var tag = node.tagName.toLowerCase();
      var children = Array.from(node.childNodes).map(walk).join('');

      switch (tag) {
        case 'h1': return '# ' + children.trim() + '\n\n';
        case 'h2': return '## ' + children.trim() + '\n\n';
        case 'h3': return '### ' + children.trim() + '\n\n';
        case 'h4': return '#### ' + children.trim() + '\n\n';
        case 'h5': return '##### ' + children.trim() + '\n\n';
        case 'h6': return '###### ' + children.trim() + '\n\n';
        case 'p': return children.trim() + '\n\n';
        case 'br': return '\n';
        case 'strong': case 'b': return '**' + children + '**';
        case 'em': case 'i': return '*' + children + '*';
        case 'code': return '`' + children + '`';
        case 'blockquote': return children.trim().split('\n').map(function (l) { return '> ' + l; }).join('\n') + '\n\n';
        case 'hr': return '---\n\n';
        case 'ul': return children + '\n';
        case 'ol': return children + '\n';
        case 'li':
          var prefix = node.parentElement && node.parentElement.tagName === 'OL' ? '1. ' : '- ';
          return prefix + children.trim() + '\n';
        case 'a':
          var href = node.getAttribute('href') || '';
          return '[' + children + '](' + href + ')';
        case 'img':
          var src = node.getAttribute('src') || '';
          var alt = node.getAttribute('alt') || '';
          return '![' + alt + '](' + src + ')';
        default:
          return children;
      }
    }

    var md = walk(body).replace(/\n{3,}/g, '\n\n').trim();
    return md;
  },

  // ── 导图 JSON → Markdown（缩进 bullet list）──────────
  mindmapToMarkdown: function (node, depth, opts) {
    depth = depth || 0;
    opts = opts || {};
    var indent = '';
    for (var i = 0; i < depth; i++) indent += '  ';
    var prefix = depth === 0 ? '# ' : indent + '- ';
    var timePart = (!opts.noTime && node.time) ? ' [' + node.time + ']' : '';
    var line = prefix + (node.label || '') + timePart + '\n';

    if (node.children && node.children.length > 0) {
      var childLines = node.children.map(function (child) {
        return YTX.Export.mindmapToMarkdown(child, depth + 1, opts);
      }).join('');
      return line + childLines;
    }
    return line;
  },

  // ── Obsidian 导出（带 YAML frontmatter 的 .md 下载）────
  downloadObsidian: function (md, title) {
    var url = YTX.getVideoUrl();
    var date = new Date().toISOString().slice(0, 10);
    var frontmatter = '---\n' +
      'title: "' + title.replace(/"/g, '\\"') + '"\n' +
      'source: ' + url + '\n' +
      'date: ' + date + '\n' +
      'tags:\n  - youtube\n  - aatools\n' +
      '---\n\n';
    var content = frontmatter + md;
    var filename = this.getSafeFilename(title) + '.md';
    var blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  // ── HTML 清洗：剥离脚本/外部资源加载/事件属性，并强 CSP ──
  sanitizeHtml: function (html) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');
    if (!doc || !doc.documentElement) return '';

    // 删除可执行/外部资源加载/自动跳转元素：脚本、内嵌框架、对象、外部样式表与字体、import、meta refresh 等
    doc.querySelectorAll(
      'script, base, object, embed, iframe, frame, frameset, applet, ' +
      'link[rel="import"], link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"], ' +
      'link[rel="dns-prefetch"], link[rel="preconnect"], link[as], ' +
      'meta[http-equiv]'
    ).forEach(function (el) {
      el.parentNode && el.parentNode.removeChild(el);
    });

    // 删除所有元素的 on* 事件属性 + javascript:/data:/vbscript: 链接
    doc.querySelectorAll('*').forEach(function (el) {
      var attrs = Array.from(el.attributes);
      attrs.forEach(function (attr) {
        var name = attr.name.toLowerCase();
        var val = (attr.value || '').trim();
        if (name.indexOf('on') === 0) {
          el.removeAttribute(attr.name);
          return;
        }
        if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action' || name === 'formaction' || name === 'srcset' || name === 'poster' || name === 'background') &&
            /^\s*(javascript|data|vbscript):/i.test(val) &&
            !/^\s*data:image\//i.test(val)) {
          el.removeAttribute(attr.name);
        }
      });
    });

    // 注入严格 CSP：默认拒绝所有外部加载，仅放开内联样式 + data: 图（笔记里嵌入截图）
    var head = doc.head || doc.createElement('head');
    if (!doc.head) doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
    var meta = doc.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content',
      "default-src 'none'; " +
      "img-src data:; " +
      "style-src 'unsafe-inline'; " +
      "font-src 'none'; " +
      "connect-src 'none'; " +
      "frame-src 'none'; " +
      "media-src 'none'; " +
      "object-src 'none'; " +
      "script-src 'none'; " +
      "base-uri 'none'; " +
      "form-action 'none'; " +
      "navigate-to 'none';"
    );
    head.insertBefore(meta, head.firstChild);

    return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
  },

  // ── 按钮状态闪烁 ─────────────────────────────────────
  flashButton: function (btn, text, ms) {
    var original = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(function () {
      btn.textContent = original;
      btn.disabled = false;
    }, ms || 1500);
  },
};

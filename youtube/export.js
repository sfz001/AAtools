// youtube/export.js — 导出模块：Markdown 下载 + Obsidian 导出

YTX.Export = {

  // ── 视频标题 ─────────────────────────────────────────
  getVideoTitle: function () {
    var el = document.querySelector('yt-formatted-string.ytd-watch-metadata') ||
             document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
             document.querySelector('#title h1 yt-formatted-string') ||
             document.querySelector('h1.title');
    var title = (el && el.textContent || '').trim();
    if (!title && /^\/shorts\//.test(location.pathname)) {
      title = (document.title || '').replace(/\s*-\s*YouTube\s*$/i, '').trim();
    }
    return title || 'YouTube Video';
  },

  getSafeFilename: function (title) {
    return title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 80) || 'export';
  },

  // ── Markdown 下载（纯本地）─────────────────────────────
  downloadMarkdown: function (md, filename) {
    var blob = new Blob([this.sanitizeMarkdownForExport(md)], { type: 'text/markdown;charset=utf-8' });
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
          return href ? '[' + children + '](' + href + ')' : children;
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
  yamlString: function (value) {
    // JSON 字符串也是合法的 YAML 双引号标量，并会正确处理反斜杠、引号和控制字符。
    return JSON.stringify(String(value == null ? '' : value))
      .replace(/\u0085/g, '\\u0085')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
  },

  localDate: function (date) {
    date = date || new Date();
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  },

  sanitizeMarkdownForExport: function (markdown) {
    var value = String(markdown == null ? '' : markdown);
    // Canonicalize compatibility characters before every security match. This
    // intentionally trades typographic fidelity in untrusted AI output for a
    // stable guarantee: a plugin that later performs NFKC cannot resurrect
    // full-width/mathematical scheme letters or compatibility dot separators.
    value = value.normalize('NFKC');
    // CommonMark removes a backslash before any ASCII punctuation during
    // parsing. Canonicalize those escapes before URI detection, otherwise
    // `\\/\\/host\\.tld` or `foo\\:\\/\\/host` can become active only after
    // this sanitizer has finished. Security-first: collapse the entire
    // backslash run before an escapable punctuation mark.
    var commonmarkEscapable = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    value = value.replace(/\\+./g, function (match) {
      var punctuation = match.charAt(match.length - 1);
      return commonmarkEscapable.indexOf(punctuation) >= 0 ? punctuation : match;
    });
    // Remove every Unicode format control before URI detection. A downstream
    // Vault plugin may strip soft hyphens, bidi marks or newer Cf characters;
    // doing it here first prevents that normalization from reconstructing a
    // hidden scheme. HTML entities are hard-broken instead of preserved: a
    // second Markdown/entity pass must not turn `java&#115;cript&#58;` active.
    value = value.replace(/\p{Cf}/gu, '');
    value = value.replace(/&(?:#[xX][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/g, '(entity)');
    value = value.replace(/&/g, '&amp;');
    // Obsidian embeds会自动读取本地/远程资源；一律降级为普通占位文本。
    value = value.replace(/!\[\[([^\]]*)\]\]/g, function (_match, label) {
      return label ? '[嵌入已移除: ' + label + ']' : '[嵌入已移除]';
    });
    // AI 正文属于不可信内容。CommonMark 会在实体解码前识别链接，因此把
    // 每个 `[` 实体化可同时去活 inline/reference/shortcut/wiki link 与图片，
    // 又保留其可读 label；这也不会被预先插入的反斜杠转义绕过。
    value = value.replace(/\[/g, '&#91;');
    // Markdown 允许直接嵌入 HTML；转义后只作为文本展示，不交给 Vault/插件解释。
    value = value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // 部分 Vault/插件会把裸 URI 自动链接化。对可执行、本地、外部导航协议
    // 使用显式 ASCII 文本分隔符去活化；不要使用全角同形符，因为某些插件
    // 会先做 NFKC，届时全角冒号/点/斜杠会被还原成可点击 URL。
    var dangerousSchemes = [
      'http', 'https', 'ftp', 'file', 'mailto', 'tel', 'obsidian',
      'javascript', 'data', 'vbscript', 'vscode', 'intent', 'shell', 'command',
      'sms', 'smsto', 'geo', 'chrome', 'chrome-extension', 'ms-settings',
      'x-apple.systempreferences', 'ssh', 'sftp', 'irc', 'ircs',
    ];
    // 上面的实体硬分隔已经覆盖编码字符；这里仍保留逐字母模式，兼容历史
    // 输入并把所有明文危险 scheme 统一改成不可归一化复原的文本。
    function schemeLetterPattern(letter) {
      var code = letter.charCodeAt(0);
      var literal = letter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return '(?:' + literal + '|&#0*' + code + ';|&#x0*' + code.toString(16) + ';)';
    }
    var encodedSchemePattern = dangerousSchemes.map(function (scheme) {
      return scheme.split('').map(schemeLetterPattern).join('');
    }).join('|');
    // 任意 RFC 风格 scheme 都可能被第三方插件注册，包括单字符 scheme
    // 与无需 `//` 的 handler。只要冒号后存在非空 URI payload 就硬分隔；
    // 这会有意把模型正文里的 `key:value` 也降级为普通可读文本。
    value = value.replace(
      /(^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9+.-]{0,31})[ \t]*(?:\\+)?:(?=\S)/gim,
      function (_match, prefix, scheme) { return prefix + scheme + ' (colon) '; }
    );
    var uriPattern = new RegExp(
      '(^|[^A-Za-z0-9_])(' + encodedSchemePattern + ')[ \\t]*(?::|[\\uFF1A\\uFE55]|\\\\+:|&(?:colon|#0*58|#x0*3a);)',
      'gim'
    );
    value = value.replace(uriPattern, function (_match, prefix, encodedScheme) {
      var decodedScheme = encodedScheme.replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, function (_entity, hex, decimal) {
        return String.fromCharCode(parseInt(hex || decimal, hex ? 16 : 10));
      });
      return prefix + decodedScheme + ' (colon) ';
    });
    // Obsidian/linkify-it also recognizes scheme-relative URLs, fuzzy domains,
    // IPv4 addresses and email addresses. Make their structural punctuation
    // explicit text while keeping it readable; do not depend on a user's
    // current plugin set or Unicode normalization policy.
    value = value.replace(/(^|[^:\uFF1A\uFE55])[\/\uFF0F]{2}(?=[^\s\/\uFF0F])/gm, function (_match, prefix) {
      return prefix + ' (slashes) ';
    });
    value = value.replace(/[@\uFF20]/g, ' (at) ');
    value = value.replace(
      /(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,62})[.\u3002\uFF0E\uFF61])+(?:[\p{L}](?:[\p{L}\p{M}-]{1,62})|xn--[A-Za-z0-9-]{1,59})/gu,
      function (domain) { return domain.replace(/[.\u3002\uFF0E\uFF61]/g, ' (dot) '); }
    );
    value = value.replace(/\b\d{1,3}(?:[.\u3002\uFF0E\uFF61]\d{1,3}){3}\b/g, function (address) {
      return address.replace(/[.\u3002\uFF0E\uFF61]/g, ' (dot) ');
    });
    value = value.replace(/\blocalhost[:\uFF1A\uFE55](?=\d{1,5}\b)/gi, function (hostAndColon) {
      return hostAndColon.slice(0, -1) + ' (colon) ';
    });

    // DataviewJS、Templater 及同类 Obsidian 插件常把 fence info string
    // 当作执行入口。模型正文中的所有 fenced block 一律降级为 text；普通
    // Markdown 代码仍可读，但不能通过 ```dataviewjs / ```javascript 等标签
    // 获得插件执行语义。fence 外的 Dataview inline-JS `$=` 同样硬分隔。
    var fence = null;
    value = value.split('\n').map(function (line) {
      if (fence) {
        var close = line.match(/^(\s*)([`\uFF40]{3,}|[~\uFF5E]{3,})\s*\r?$/);
        var closeMarker = close && close[2].replace(/\uFF40/g, '`').replace(/\uFF5E/g, '~');
        if (closeMarker && closeMarker[0] === fence.char && closeMarker.length >= fence.length) {
          fence = null;
          return close[1] + closeMarker;
        }
        return line;
      }
      var open = line.match(/^(\s*)([`\uFF40]{3,}|[~\uFF5E]{3,})([^\r\n]*)\r?$/);
      if (open) {
        var openMarker = open[2].replace(/\uFF40/g, '`').replace(/\uFF5E/g, '~');
        fence = { char: openMarker[0], length: openMarker.length };
        return open[1] + openMarker + 'text';
      }
      return line.replace(/[$\uFF04][ \t]*[=\uFF1D]/g, '$ =');
    }).join('\n');
    return value;
  },

  downloadObsidian: function (md, title) {
    var url = YTX.getVideoUrl();
    var date = this.localDate(new Date());
    var frontmatter = '---\n' +
      'title: ' + this.yamlString(title) + '\n' +
      'source: ' + url + '\n' +
      'date: ' + date + '\n' +
      'tags:\n  - youtube\n  - aatools\n' +
      '---\n\n';
    var content = frontmatter + this.sanitizeMarkdownForExport(md);
    var filename = this.getSafeFilename(title) + '.md';
    var blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  },

  // ── HTML 清洗：剥离脚本/外部资源加载/事件属性，并强 CSP ──
  sanitizeHtml: function (html, options) {
    options = options || {};
    html = typeof html === 'string' ? html : String(html == null ? '' : html);
    var maxChars = Number(options.maxChars);
    if (Number.isSafeInteger(maxChars) && maxChars >= 0 && html.length > maxChars) return '';
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');
    if (!doc || !doc.documentElement) return '';
    var maxElements = Number(options.maxElements == null ? YTX.HTML_MAX_ELEMENTS : options.maxElements);
    var initialElements = doc.querySelectorAll('*');
    if (!Number.isSafeInteger(maxElements) || maxElements < 1 || initialElements.length > maxElements) return '';

    // 删除可执行/外部资源加载/自动跳转元素：脚本、内嵌框架、对象、外部样式表与字体、import、meta refresh 等
    doc.querySelectorAll(
      'script, template, base, object, embed, iframe, frame, frameset, applet, svg, math, ' +
      'animate, set, animateMotion, animateTransform, discard, ' +
      'link[rel="import"], link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"], ' +
      'link[rel="dns-prefetch"], link[rel="preconnect"], link[as], ' +
      'meta[http-equiv]'
    ).forEach(function (el) {
      el.parentNode && el.parentNode.removeChild(el);
    });

    function canonicalYoutubeTimestampHref(value) {
      try {
        var parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.youtube.com' || parsed.pathname !== '/watch') return '';
        var videoId = parsed.searchParams.get('v') || '';
        var rawTime = parsed.searchParams.get('t') || '';
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !/^\d+s?$/.test(rawTime)) return '';
        var seconds = Number(rawTime.replace(/s$/, ''));
        if (!Number.isSafeInteger(seconds) || seconds < 0) return '';
        return 'https://www.youtube.com/watch?v=' + videoId + '&t=' + seconds + 's';
      } catch (_) {
        return '';
      }
    }

    function isSafeRasterDataUrl(value) {
      return /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(value);
    }

    // 删除所有元素的 on* 事件属性，并显式白名单化导航与 data:image。
    // Chrome 尚未可靠实现 CSP navigate-to，不能把链接安全只交给 CSP。
    doc.querySelectorAll('*').forEach(function (el) {
      var attrs = Array.from(el.attributes);
      attrs.forEach(function (attr) {
        var name = attr.name.toLowerCase();
        var val = (attr.value || '').trim();
        if (name.indexOf('on') === 0) {
          el.removeAttribute(attr.name);
          return;
        }
        if (name === 'href') {
          if (val.charAt(0) === '#') {
            el.removeAttribute('target');
            el.removeAttribute('rel');
            return;
          }
          var safeHref = canonicalYoutubeTimestampHref(val);
          if (safeHref) {
            el.setAttribute(attr.name, safeHref);
            el.setAttribute('target', '_blank');
            el.setAttribute('rel', 'noopener noreferrer');
          }
          else el.removeAttribute(attr.name);
          return;
        }
        if (name === 'xlink:href') {
          if (val.charAt(0) !== '#') el.removeAttribute(attr.name);
          return;
        }
        if (name === 'src') {
          if (el.tagName.toLowerCase() !== 'img' || !isSafeRasterDataUrl(val)) {
            el.removeAttribute(attr.name);
          }
          return;
        }
        if (name === 'action' || name === 'formaction' || name === 'srcset' ||
            name === 'poster' || name === 'background' || name === 'ping' ||
            name === 'manifest') {
          el.removeAttribute(attr.name);
          return;
        }
        // CSS url() 也可能绕过元素 src 白名单（含 data:image/svg+xml）。
        if (name === 'style' && /url\s*\(/i.test(val)) el.removeAttribute(attr.name);
      });
      // href 被移除的 legacy <a> 也不能借原 target="_top" 导航宿主页。
      if (el.tagName.toLowerCase() === 'a' && !el.hasAttribute('href')) {
        el.removeAttribute('target');
        el.removeAttribute('rel');
      }
    });

    doc.querySelectorAll('style').forEach(function (styleEl) {
      var css = styleEl.textContent || '';
      css = css.replace(/@import\s+[^;]+;?/gi, '');
      css = css.replace(/url\s*\([^)]*\)/gi, 'none');
      styleEl.textContent = css;
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
      "navigate-to https://www.youtube.com;"
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

// src/markdown.js — renderMarkdown、escapeHtml

YTX.escapeHtml = function (text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
};

YTX.renderMarkdown = function (text) {
  var lines = text.split('\n');
  var out = [];
  var i = 0;

  function inlineFormat(str) {
    var s = YTX.escapeHtml(str);
    // **粗体**
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // *斜体*
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // `行内代码`
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 时间戳 [MM:SS] 或 [H:MM:SS]
    s = s.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, function (match, time) {
      var secs = YTX.timeToSeconds(time);
      return '<span class="ytx-timestamp" data-time="' + secs + '">[' + time + ']</span>';
    });
    return s;
  }

  // 以时间戳开头的列表项（总结的「时间线」）：时间戳当作左侧标记、正文单独成列，
  // 配合 content.css 的 .ytx-ts-item 让长句换行后仍与正文左缘对齐，而不是缩在时间戳下面
  function listItem(html) {
    var m = html.match(/^(<span class="ytx-timestamp"[^>]*>[^<]*<\/span>)\s*([\s\S]*)$/);
    if (!m) return '<li>' + html + '</li>';
    return '<li class="ytx-ts-item">' + m[1] + '<span class="ytx-ts-body">' + m[2] + '</span></li>';
  }

  function collectList(startIndex, prefix) {
    var items = [];
    var idx = startIndex;
    while (idx < lines.length) {
      var line = lines[idx];
      var m = line.match(prefix);
      if (!m) break;
      items.push(inlineFormat(m[1]));
      idx++;
    }
    return { items: items, nextIndex: idx };
  }

  while (i < lines.length) {
    var line = lines[i];
    var trimmed = line.trim();

    // 空行
    if (!trimmed) { i++; continue; }

    // 标题
    var hMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      var level = hMatch[1].length;
      out.push('<h' + level + '>' + inlineFormat(hMatch[2]) + '</h' + level + '>');
      i++; continue;
    }

    // 分割线
    if (/^---+$/.test(trimmed)) {
      out.push('<hr>');
      i++; continue;
    }

    // 无序列表 - 或 *
    if (/^[-*]\s+/.test(trimmed)) {
      var result = collectList(i, /^\s*[-*]\s+(.+)/);
      out.push('<ul>' + result.items.map(listItem).join('') + '</ul>');
      i = result.nextIndex; continue;
    }

    // 有序列表
    if (/^\d+[.)]\s+/.test(trimmed)) {
      var result = collectList(i, /^\s*\d+[.)]\s+(.+)/);
      out.push('<ol>' + result.items.map(listItem).join('') + '</ol>');
      i = result.nextIndex; continue;
    }

    // 普通段落（合并连续非空行）
    var para = [];
    while (i < lines.length && lines[i].trim() && !/^#{1,3}\s/.test(lines[i].trim()) && !/^[-*]\s+/.test(lines[i].trim()) && !/^\d+[.)]\s+/.test(lines[i].trim()) && !/^---+$/.test(lines[i].trim())) {
      para.push(inlineFormat(lines[i].trim()));
      i++;
    }
    if (para.length) out.push('<p>' + para.join('<br>') + '</p>');
  }

  return out.join('');
};

// src/export.js — 导出模块：Markdown 下载 + Notion 导出

YTX.Export = {

  // ── 读取 Notion 设置 ─────────────────────────────────
  getNotionSettings: function () {
    return new Promise(function (resolve) {
      chrome.storage.sync.get(['notionKey', 'notionPage'], function (data) {
        resolve({ token: data.notionKey || '', pageId: data.notionPage || '' });
      });
    });
  },

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

  // ── HTML → Notion blocks ──────────────────────────────
  htmlToNotionBlocks: function (html) {
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');
    var body = doc.body;
    if (!body) return [];

    var blocks = [];

    function parseRichText(node) {
      var result = [];
      if (!node) return result;
      node.childNodes.forEach(function (child) {
        if (child.nodeType === 3) {
          var text = child.textContent;
          if (text) result.push({ type: 'text', text: { content: text } });
        } else if (child.nodeType === 1) {
          var tag = child.tagName.toLowerCase();
          var content = child.textContent || '';
          if (!content) return;
          var annotations = {};
          if (tag === 'strong' || tag === 'b') annotations.bold = true;
          if (tag === 'em' || tag === 'i') annotations.italic = true;
          if (tag === 'code') annotations.code = true;
          if (tag === 'a') {
            result.push({
              type: 'text',
              text: { content: content, link: { url: child.getAttribute('href') || '' } },
              annotations: annotations
            });
            return;
          }
          // For nested formatting, recurse
          if (tag === 'strong' || tag === 'b' || tag === 'em' || tag === 'i' || tag === 'code') {
            var inner = parseRichText(child);
            inner.forEach(function (rt) {
              rt.annotations = Object.assign({}, rt.annotations || {}, annotations);
            });
            result = result.concat(inner);
            return;
          }
          result.push({ type: 'text', text: { content: content } });
        }
      });
      return result;
    }

    function parseListItems(ul, type, depth) {
      depth = depth || 0;
      var items = [];
      Array.from(ul.children).forEach(function (li) {
        if (li.tagName !== 'LI') return;
        var richText = [];
        var nestedBlocks = [];
        li.childNodes.forEach(function (child) {
          if (child.nodeType === 3) {
            var t = child.textContent;
            if (t.trim()) richText.push({ type: 'text', text: { content: t } });
          } else if (child.nodeType === 1) {
            var ct = child.tagName.toLowerCase();
            if (ct === 'ul' || ct === 'ol') {
              var childType = ct === 'ol' ? 'numbered_list_item' : 'bulleted_list_item';
              if (depth < 1) {
                // Notion 最多 2 层嵌套，depth 0→1 可以嵌套
                nestedBlocks = nestedBlocks.concat(parseListItems(child, childType, depth + 1));
              } else {
                // 超过 2 层：展平，用缩进前缀 "└ " 表示层级
                var flat = parseListItems(child, childType, depth + 1);
                flat.forEach(function (fb) {
                  var prefix = '└ ';
                  var rt = fb[fb.type].rich_text;
                  if (rt.length > 0) rt[0].text.content = prefix + rt[0].text.content;
                  else rt.push({ type: 'text', text: { content: prefix } });
                  nestedBlocks.push(fb);
                });
              }
            } else {
              richText = richText.concat(parseRichText(child));
            }
          }
        });
        if (richText.length === 0) richText.push({ type: 'text', text: { content: ' ' } });
        var block = { type: type };
        block[type] = { rich_text: richText };
        if (nestedBlocks.length > 0 && depth < 1) {
          block[type].children = nestedBlocks;
        } else if (nestedBlocks.length > 0) {
          // depth >= 1: 不能再嵌套，追加为同级
          items.push(block);
          items = items.concat(nestedBlocks);
          return;
        }
        items.push(block);
      });
      return items;
    }

    function walkElements(parent) {
      Array.from(parent.children).forEach(function (el) {
        var tag = el.tagName.toLowerCase();

        if (/^h([1-6])$/.test(tag)) {
          var level = parseInt(RegExp.$1, 10);
          var hType = level <= 1 ? 'heading_1' : level <= 2 ? 'heading_2' : 'heading_3';
          var rt = parseRichText(el);
          if (rt.length === 0) rt.push({ type: 'text', text: { content: el.textContent || '' } });
          var block = { type: hType };
          block[hType] = { rich_text: rt };
          blocks.push(block);
          return;
        }

        if (tag === 'p') {
          var rt = parseRichText(el);
          if (rt.length === 0 && !el.textContent.trim()) return;
          if (rt.length === 0) rt.push({ type: 'text', text: { content: el.textContent || '' } });
          blocks.push({ type: 'paragraph', paragraph: { rich_text: rt } });
          return;
        }

        if (tag === 'ul' || tag === 'ol') {
          var type = tag === 'ol' ? 'numbered_list_item' : 'bulleted_list_item';
          blocks = blocks.concat(parseListItems(el, type));
          return;
        }

        if (tag === 'hr') {
          blocks.push({ type: 'divider', divider: {} });
          return;
        }

        if (tag === 'blockquote') {
          var rt = parseRichText(el);
          if (rt.length === 0) rt.push({ type: 'text', text: { content: el.textContent || '' } });
          blocks.push({ type: 'quote', quote: { rich_text: rt } });
          return;
        }

        // div/section/article → recurse
        if (tag === 'div' || tag === 'section' || tag === 'article' || tag === 'main' || tag === 'header' || tag === 'footer') {
          walkElements(el);
          return;
        }

        // fallback: treat as paragraph if has text
        if (el.textContent && el.textContent.trim()) {
          blocks.push({ type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: el.textContent } }] } });
        }
      });
    }

    walkElements(body);
    return blocks;
  },

  // ── 导图 JSON → Notion blocks ─────────────────────────
  mindmapToNotionBlocks: function (node) {
    var blocks = [];

    // 根节点 → heading_2
    blocks.push({
      type: 'heading_2',
      heading_2: {
        rich_text: [{ type: 'text', text: { content: node.label || '' } }]
      }
    });

    function buildChildren(children, depth) {
      depth = depth || 0;
      var items = [];
      if (!children) return items;
      children.forEach(function (child) {
        var label = child.label || '';
        if (child.time) label += ' [' + child.time + ']';
        var block = {
          type: 'bulleted_list_item',
          bulleted_list_item: {
            rich_text: [{ type: 'text', text: { content: label } }]
          }
        };
        if (child.children && child.children.length > 0) {
          if (depth < 1) {
            // Notion 最多 2 层嵌套
            block.bulleted_list_item.children = buildChildren(child.children, depth + 1);
          } else {
            // 超过 2 层：展平为同级，加前缀标识层级
            items.push(block);
            var flat = buildChildren(child.children, depth + 1);
            flat.forEach(function (fb) {
              fb.bulleted_list_item.rich_text[0].text.content = '└ ' + fb.bulleted_list_item.rich_text[0].text.content;
            });
            items = items.concat(flat);
            return;
          }
        }
        items.push(block);
      });
      return items;
    }

    if (node.children && node.children.length > 0) {
      blocks = blocks.concat(buildChildren(node.children));
    }

    return blocks;
  },

  // ── 文本 → Notion code block（自动分片，每片 ≤ 2000 字符）──
  makeCodeBlock: function (text, language) {
    var richText = [];
    for (var i = 0; i < text.length; i += 2000) {
      richText.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
    }
    return { type: 'code', code: { rich_text: richText, language: language || 'plain text' } };
  },

  // ── 发送到 Notion ─────────────────────────────────────
  sendToNotion: function (title, blocks, callback) {
    YTX.Export.getNotionSettings().then(function (settings) {
      if (!settings.token) {
        callback({ error: '请先在扩展设置中配置 Notion Integration Token' });
        return;
      }
      if (!settings.pageId) {
        callback({ error: '请先在扩展设置中配置 Notion 父级页面' });
        return;
      }
      // 在最前面插入视频链接
      var videoUrl = YTX.getVideoUrl();
      var linkBlock = {
        type: 'paragraph',
        paragraph: {
          rich_text: [
            { type: 'text', text: { content: '视频链接：' } },
            { type: 'text', text: { content: videoUrl, link: { url: videoUrl } } }
          ]
        }
      };
      YTX.sendToBg({
        type: 'EXPORT_NOTION',
        token: settings.token,
        pageId: settings.pageId,
        title: title,
        blocks: [linkBlock].concat(blocks)
      }).then(function (resp) {
        callback(resp);
      }).catch(function (err) {
        callback({ error: err.message });
      });
    });
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

  // ── GitHub Gist ────────────────────────────────────────

  getGithubToken: function () {
    return new Promise(function (resolve) {
      chrome.storage.sync.get(['githubKey'], function (data) {
        resolve(data.githubKey || '');
      });
    });
  },

  uploadGist: function (filename, content, description) {
    return YTX.Export.getGithubToken().then(function (token) {
      if (!token) return null;
      return YTX.sendToBg({
        type: 'UPLOAD_GIST',
        token: token,
        filename: filename,
        content: content,
        description: description || 'AAtools export'
      }).then(function (resp) {
        if (resp.error) {
          console.warn('[AAtools] Gist 上传失败:', resp.error);
          return null;
        }
        return resp;
      }).catch(function (err) {
        console.warn('[AAtools] Gist 上传异常:', err);
        return null;
      });
    });
  },

  sendToNotionWithGist: function (title, blocks, filename, content, fileLabel, callback) {
    YTX.Export.uploadGist(filename, content, 'AAtools: ' + title).then(function (gist) {
      if (gist && gist.rawUrl) {
        // gist.githubusercontent.com 强制 text/plain，替换为 gist.githack.com 以正确 Content-Type 渲染
        var viewUrl = gist.rawUrl.replace('gist.githubusercontent.com', 'gist.githack.com');
        var gistBlock = {
          type: 'paragraph',
          paragraph: {
            rich_text: [
              { type: 'text', text: { content: fileLabel + '：' } },
              { type: 'text', text: { content: viewUrl, link: { url: viewUrl } } }
            ]
          }
        };
        blocks = [gistBlock].concat(blocks);
      }
      YTX.Export.sendToNotion(title, blocks, callback);
    });
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

  // ── 飞书预留 ─────────────────────────────────────────
  sendToFeishu: function (title, blocks, callback) {
    callback({ error: '飞书导出功能暂未实现，敬请期待' });
  }
};

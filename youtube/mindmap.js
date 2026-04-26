// src/mindmap.js — 思维导图（含 SVG 引擎）

(function () {
  // 布局常量（左右结构，父节点顶部对齐）
  var MM_NODE_HEIGHT = 36;
  var MM_V_GAP = 18;
  var MM_H_GAP = 80;
  var MM_TOGGLE_SPACE = 24;

  var DEPTH_COLORS = ['#7c3aed', '#ede9fe', '#f5f3ff', '#faf5ff'];
  var DEPTH_TEXT_COLORS = ['#ffffff', '#5b21b6', '#6d28d9', '#7c3aed'];
  var DEPTH_BORDER_COLORS = ['#7c3aed', '#c4b5fd', '#ddd6fe', '#e9d5ff'];

  function assignNodeIds(node, path) {
    path = path || '0';
    node._id = path;
    if (node.children) {
      node.children.forEach(function (child, i) { assignNodeIds(child, path + '-' + i); });
    }
  }

  function measureNodeWidth(node) {
    var label = node.label || '';
    var charWidth = 0;
    for (var i = 0; i < label.length; i++) {
      charWidth += label.charCodeAt(i) > 0x7f ? 14 : 8;
    }
    var w = charWidth + 28;
    if (node.time) w += 44;
    return Math.max(90, w);
  }

  function layoutMindmap(node, collapsed, depth) {
    depth = depth || 0;
    node._width = measureNodeWidth(node);
    node._height = MM_NODE_HEIGHT;
    node._depth = depth;

    var isCollapsed = collapsed.has(node._id);
    var visibleChildren = (!isCollapsed && node.children && node.children.length > 0) ? node.children : [];

    if (visibleChildren.length === 0) {
      node._subtreeHeight = MM_NODE_HEIGHT;
    } else {
      visibleChildren.forEach(function (child) { layoutMindmap(child, collapsed, depth + 1); });
      var totalChildHeight = visibleChildren.reduce(function (sum, c) { return sum + c._subtreeHeight; }, 0) + (visibleChildren.length - 1) * MM_V_GAP;
      node._subtreeHeight = Math.max(MM_NODE_HEIGHT, totalChildHeight);
    }
    node._visibleChildren = visibleChildren;
  }

  function positionMindmap(node, x, subtreeTop, alignTop) {
    node._x = x;

    if (node._visibleChildren && node._visibleChildren.length > 0) {
      var hasToggle = node.children && node.children.length > 0;
      var childX = x + node._width + (hasToggle ? MM_TOGGLE_SPACE : 0) + MM_H_GAP;
      var totalChildHeight = node._visibleChildren.reduce(function (sum, c) { return sum + c._subtreeHeight; }, 0) + (node._visibleChildren.length - 1) * MM_V_GAP;
      var childY = subtreeTop + (node._subtreeHeight - totalChildHeight) / 2;
      node._visibleChildren.forEach(function (child) {
        positionMindmap(child, childX, childY, alignTop);
        childY += child._subtreeHeight + MM_V_GAP;
      });
      // 父节点对齐方式
      node._y = alignTop ? node._visibleChildren[0]._y : subtreeTop + (node._subtreeHeight - node._height) / 2;
    } else {
      node._y = subtreeTop + (node._subtreeHeight - node._height) / 2;
    }
  }

  function getMindmapBounds(node) {
    var minX = node._x, minY = node._y;
    var toggleExtra = (node.children && node.children.length > 0) ? MM_TOGGLE_SPACE : 0;
    var maxX = node._x + node._width + toggleExtra, maxY = node._y + node._height;
    if (node._visibleChildren) {
      node._visibleChildren.forEach(function (child) {
        var b = getMindmapBounds(child);
        minX = Math.min(minX, b.minX);
        minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX);
        maxY = Math.max(maxY, b.maxY);
      });
    }
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  function buildEdgesHtml(node, collapsed) {
    var html = '';
    if (!node._visibleChildren) return html;
    node._visibleChildren.forEach(function (child) {
      var hasToggle = node.children && node.children.length > 0;
      var x1 = node._x + node._width + (hasToggle ? MM_TOGGLE_SPACE : 0);
      var y1 = node._y + node._height / 2;
      var x2 = child._x;
      var y2 = child._y + child._height / 2;
      var dx = x2 - x1;
      var cx1 = x1 + dx * 0.45;
      var cx2 = x2 - dx * 0.45;
      html += '<path d="M' + x1 + ',' + y1 + ' C' + cx1 + ',' + y1 + ' ' + cx2 + ',' + y2 + ' ' + x2 + ',' + y2 + '" fill="none" stroke="#c4b5fd" stroke-width="2" opacity="0.7"/>';
      html += buildEdgesHtml(child, collapsed);
    });
    return html;
  }

  function buildNodesHtml(node, collapsed) {
    var html = '';
    var d = Math.min(node._depth, 3);
    var fill = DEPTH_COLORS[d];
    var textColor = DEPTH_TEXT_COLORS[d];
    var borderColor = DEPTH_BORDER_COLORS[d];
    var rx = d === 0 ? 18 : 10;
    var fontSize = d === 0 ? 14 : 12;

    html += '<g class="ytx-mm-node" data-id="' + node._id + '">';
    html += '<rect x="' + node._x + '" y="' + node._y + '" width="' + node._width + '" height="' + node._height + '" rx="' + rx + '" fill="' + fill + '" stroke="' + borderColor + '" stroke-width="1.5"/>';

    var textX = node._x + 14;
    var textY = node._y + node._height / 2;
    var maxTextW = node._width - 28 - (node.time ? 44 : 0);
    html += '<text x="' + textX + '" y="' + textY + '" fill="' + textColor + '" font-size="' + fontSize + '" font-weight="' + (d === 0 ? 600 : 500) + '" text-anchor="start" dominant-baseline="central" font-family="-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif"><tspan textLength="' + Math.max(0, maxTextW) + '" lengthAdjust="spacing">' + YTX.escapeHtml(node.label || '') + '</tspan></text>';

    // Timestamp badge
    var safeT = YTX.safeTime(node.time);
    if (safeT) {
      var badgeW = 40;
      var badgeX = node._x + node._width - badgeW - 6;
      var badgeY = node._y + node._height / 2;
      var secs = YTX.timeToSeconds(safeT);
      html += '<g class="ytx-mm-timestamp" data-time="' + secs + '" style="cursor:pointer">';
      html += '<rect x="' + badgeX + '" y="' + (badgeY - 10) + '" width="' + badgeW + '" height="20" rx="10" fill="' + (d === 0 ? 'rgba(255,255,255,0.25)' : '#ede9fe') + '" stroke="none"/>';
      html += '<text x="' + (badgeX + badgeW / 2) + '" y="' + badgeY + '" fill="' + (d === 0 ? '#fff' : '#7c3aed') + '" font-size="10" font-weight="600" text-anchor="middle" dominant-baseline="central" font-family="Consolas,Monaco,monospace">' + safeT + '</text>';
      html += '</g>';
    }

    // Collapse/expand toggle
    if (node.children && node.children.length > 0) {
      var cx = node._x + node._width + MM_TOGGLE_SPACE / 2;
      var cy = node._y + node._height / 2;
      var isCollapsed = collapsed.has(node._id);
      html += '<g class="ytx-mm-toggle" data-id="' + node._id + '" style="cursor:pointer">';
      html += '<circle cx="' + cx + '" cy="' + cy + '" r="8" fill="#fff" stroke="#c4b5fd" stroke-width="1.5"/>';
      html += '<text x="' + cx + '" y="' + cy + '" fill="#7c3aed" font-size="12" font-weight="700" text-anchor="middle" dominant-baseline="central">' + (isCollapsed ? '+' : '\u2212') + '</text>';
      html += '</g>';
    }

    html += '</g>';

    if (node._visibleChildren) {
      node._visibleChildren.forEach(function (child) { html += buildNodesHtml(child, collapsed); });
    }
    return html;
  }

  // ── 注册功能模块 ──────────────────────────────────────

  YTX.features.mindmap = {
    tab: { key: 'mindmap', label: '导图', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>' },
    prefix: 'MINDMAP',
    contentId: 'ytx-content-mindmap',
    actionsId: 'ytx-actions-mindmap',
    displayMode: 'flex',

    // 状态
    data: null,
    rawText: '',
    isGenerating: false,
    transform: { x: 0, y: 0, scale: 1 },
    collapsed: new Set(),
    alignTop: false,
    _fitted: false,

    reset: function () {
      this.data = null;
      this.rawText = '';
      this.isGenerating = false;
      this.requestId = null;
      this.transform = { x: 0, y: 0, scale: 1 };
      this.collapsed = new Set();
      this._fitted = false;
      // alignTop 不重置，保留用户设置
      if (this._deferred) { this._deferred.reject(new Error('视频已切换')); this._deferred = null; }
    },

    actionsHtml: function () {
      return '<button id="ytx-generate-mindmap" class="ytx-btn ytx-btn-icon ytx-btn-primary" title="生成导图">' + YTX.icons.play + '</button>';
    },

    contentHtml: function () {
      return '<div class="ytx-empty">点击「生成导图」将视频内容生成思维导图</div>';
    },

    bindEvents: function (panel) {
      var self = this;
      panel.querySelector('#ytx-generate-mindmap').addEventListener('click', function () { self.start().catch(function () {}); });
    },

    start: function () {
      var self = this;
      if (this.isGenerating) return Promise.resolve();
      this.isGenerating = true;
      this.rawText = '';
      this.data = null;
      this.collapsed = new Set();
      this.transform = { x: 0, y: 0, scale: 1 };

      if (this._deferred) this._deferred.reject(new Error('已被新请求覆盖'));
      this._deferred = YTX.createDeferred();
      var deferred = this._deferred;

      var startVideoId = YTX.currentVideoId;

      var btn = YTX.panel.querySelector('#ytx-generate-mindmap');
      var contentEl = YTX.panel.querySelector('#ytx-content-mindmap');
      btn.disabled = true;

      function bailSilently() {
        self.isGenerating = false;
        if (self._deferred === deferred) { deferred.resolve(); self._deferred = null; }
      }

      (async function () {
        try {
          btn.innerHTML = YTX.icons.spinner;
          contentEl.innerHTML = '<div class="ytx-empty"><div class="ytx-loading"><div class="ytx-spinner"></div><span>正在获取字幕...</span></div></div>';
          await YTX.ensureTranscript();
          if (YTX.currentVideoId !== startVideoId) return bailSilently();

          contentEl.innerHTML = '<div class="ytx-empty"><div class="ytx-loading"><div class="ytx-spinner"></div><span>正在生成思维导图...</span></div></div>';

          var settings = await YTX.getSettings();
          if (YTX.currentVideoId !== startVideoId) return bailSilently();
          var payload = YTX.getContentPayload();

          self.requestId = YTX.makeRequestId();
          chrome.runtime.sendMessage(Object.assign({
            type: 'GENERATE_MINDMAP',
            prompt: settings.promptMindmap || YTX.prompts.MINDMAP,
            provider: settings.provider,
            model: settings.model,
            requestId: self.requestId,
          }, payload));
        } catch (err) {
          if (YTX.currentVideoId !== startVideoId) return bailSilently();
          contentEl.innerHTML = '<div class="ytx-error" style="margin:14px 16px">' + err.message + '</div>';
          btn.disabled = false;
          YTX.btnPrimary(btn);
          self.isGenerating = false;
          if (self._deferred === deferred) { deferred.reject(err); self._deferred = null; }
        }
      })();

      return deferred.promise;
    },

    onChunk: function (text) {
      this.rawText += text;
    },

    onDone: function () {
      try {
        this.data = YTX.extractJSON(this.rawText, 'object');
        if (!this.data) {
          throw new Error('AI 返回的内容不包含有效 JSON，请重新生成');
        }
        this.render();
      } catch (err) {
        YTX.parseError(YTX.panel.querySelector('#ytx-content-mindmap'), '导图', err);
      }
      YTX.panel.querySelector('#ytx-generate-mindmap').disabled = false;
      YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-mindmap'));
      this.isGenerating = false;
      if (this.data) YTX.cache.save(YTX.currentVideoId, 'mindmap', { data: this.data });
      if (this._deferred) { this._deferred.resolve(); this._deferred = null; }
    },

    onError: function (error) {
      YTX.panel.querySelector('#ytx-content-mindmap').innerHTML = '<div class="ytx-error" style="margin:14px 16px">' + error + '</div>';
      YTX.panel.querySelector('#ytx-generate-mindmap').disabled = false;
      YTX.btnPrimary(YTX.panel.querySelector('#ytx-generate-mindmap'));
      this.isGenerating = false;
      if (this._deferred) { this._deferred.reject(new Error(error)); this._deferred = null; }
    },

    render: function () {
      if (!YTX.panel || !this.data) return;
      var self = this;
      var contentEl = YTX.panel.querySelector('#ytx-content-mindmap');

      assignNodeIds(this.data);
      layoutMindmap(this.data, this.collapsed);
      positionMindmap(this.data, 30, 30, this.alignTop);

      var bounds = getMindmapBounds(this.data);
      var PAD = 40;
      var treeW = bounds.maxX - bounds.minX + PAD * 2;
      var treeH = bounds.maxY - bounds.minY + PAD * 2;

      var edgesHtml = buildEdgesHtml(this.data, this.collapsed);
      var nodesHtml = buildNodesHtml(this.data, this.collapsed);

      contentEl.innerHTML =
        '<div class="ytx-mindmap-toolbar">' +
          '<button class="ytx-mm-zoom-btn" data-action="zoom-in" title="放大">+</button>' +
          '<button class="ytx-mm-zoom-btn" data-action="zoom-out" title="缩小">\u2212</button>' +
          '<button class="ytx-mm-zoom-btn" data-action="zoom-reset" title="重置">\u27F2</button>' +
          '<button class="ytx-mm-zoom-btn ytx-mm-layout-btn" data-action="toggle-align" title="' + (self.alignTop ? '切换居中对齐' : '切换顶部对齐') + '">' + (self.alignTop ? '\u2261' : '\u2550') + '</button>' +
          '<span class="ytx-mm-toolbar-spacer"></span>' +
          '<button class="ytx-mm-tool-btn" data-action="open-tab">新标签打开</button>' +
          '<button class="ytx-mm-tool-btn" data-action="export-svg">导出 SVG</button>' +
          '<button class="ytx-mm-tool-btn" data-action="export-obsidian">导出 Obsidian</button>' +
        '</div>' +
        '<div class="ytx-mindmap-viewport">' +
          '<svg class="ytx-mindmap-svg" xmlns="http://www.w3.org/2000/svg">' +
            '<g class="ytx-mm-canvas">' + edgesHtml + nodesHtml + '</g>' +
          '</svg>' +
        '</div>';

      // Auto-fit
      var viewport = contentEl.querySelector('.ytx-mindmap-viewport');
      var svg = contentEl.querySelector('.ytx-mindmap-svg');
      var canvas = contentEl.querySelector('.ytx-mm-canvas');
      if (viewport && svg && canvas) {
        var vw = viewport.clientWidth;
        var vh = viewport.clientHeight;
        if (vw > 0 && vh > 0) this._fitted = true;
        vw = vw || 400;
        vh = vh || 400;
        svg.setAttribute('width', vw);
        svg.setAttribute('height', vh);

        if (this.transform.scale === 1 && this.transform.x === 0 && this.transform.y === 0) {
          var scaleX = vw / treeW;
          var scaleY = vh / treeH;
          var fitScale = Math.min(scaleX, scaleY, 1.5) * 0.92;
          var offsetX = (vw - treeW * fitScale) / 2;
          var offsetY = (vh - treeH * fitScale) / 2;
          this.transform = { x: offsetX, y: offsetY, scale: fitScale };
        }
        canvas.setAttribute('transform', 'translate(' + this.transform.x + ',' + this.transform.y + ') scale(' + this.transform.scale + ')');
      }

      this.setupZoomPan(contentEl);
      this.setupToolbar(contentEl);
      this.setupInteractions(contentEl);
    },

    setupZoomPan: function (container) {
      var self = this;
      var viewport = container.querySelector('.ytx-mindmap-viewport');
      var svg = container.querySelector('.ytx-mindmap-svg');
      var canvas = container.querySelector('.ytx-mm-canvas');
      if (!viewport || !svg || !canvas) return;

      var isPanning = false;
      var startX, startY, startTx, startTy;

      viewport.addEventListener('mousedown', function (e) {
        if (e.target.closest('.ytx-mm-toggle, .ytx-mm-timestamp, .ytx-mm-node')) return;
        isPanning = true;
        startX = e.clientX;
        startY = e.clientY;
        startTx = self.transform.x;
        startTy = self.transform.y;
        viewport.style.cursor = 'grabbing';
        e.preventDefault();
      });

      document.addEventListener('mousemove', function (e) {
        if (!isPanning) return;
        self.transform.x = startTx + (e.clientX - startX);
        self.transform.y = startTy + (e.clientY - startY);
        canvas.setAttribute('transform', 'translate(' + self.transform.x + ',' + self.transform.y + ') scale(' + self.transform.scale + ')');
      });

      document.addEventListener('mouseup', function () {
        if (!isPanning) return;
        isPanning = false;
        viewport.style.cursor = 'grab';
      });

      viewport.addEventListener('wheel', function (e) {
        e.preventDefault();
        var rect = viewport.getBoundingClientRect();
        var mouseX = e.clientX - rect.left;
        var mouseY = e.clientY - rect.top;

        var oldScale = self.transform.scale;
        var delta = e.deltaY > 0 ? 0.9 : 1.1;
        var newScale = Math.max(0.2, Math.min(3, oldScale * delta));

        self.transform.x = mouseX - (mouseX - self.transform.x) * (newScale / oldScale);
        self.transform.y = mouseY - (mouseY - self.transform.y) * (newScale / oldScale);
        self.transform.scale = newScale;

        canvas.setAttribute('transform', 'translate(' + self.transform.x + ',' + self.transform.y + ') scale(' + self.transform.scale + ')');
      }, { passive: false });
    },

    setupToolbar: function (container) {
      var self = this;
      container.querySelectorAll('.ytx-mm-zoom-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var action = btn.dataset.action;
          var canvas = container.querySelector('.ytx-mm-canvas');
          if (!canvas) return;

          if (action === 'zoom-in') {
            self.transform.scale = Math.min(3, self.transform.scale * 1.2);
          } else if (action === 'zoom-out') {
            self.transform.scale = Math.max(0.2, self.transform.scale * 0.8);
          } else if (action === 'zoom-reset') {
            self.transform = { x: 0, y: 0, scale: 1 };
            self.render();
            return;
          } else if (action === 'toggle-align') {
            self.alignTop = !self.alignTop;
            chrome.storage.sync.set({ mindmapAlignTop: self.alignTop });
            self.transform = { x: 0, y: 0, scale: 1 };
            self.render();
            return;
          }
          canvas.setAttribute('transform', 'translate(' + self.transform.x + ',' + self.transform.y + ') scale(' + self.transform.scale + ')');
        });
      });

      // 导出按钮
      container.querySelectorAll('.ytx-mm-tool-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var action = btn.dataset.action;
          if (action === 'open-tab') self.openInNewTab();
          else if (action === 'export-svg') self.exportSvg();
          else if (action === 'export-obsidian') self.exportObsidian();
        });
      });
    },

    setupInteractions: function (container) {
      var self = this;
      // Toggle collapse/expand
      container.querySelectorAll('.ytx-mm-toggle').forEach(function (toggle) {
        toggle.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = toggle.dataset.id;
          if (self.collapsed.has(id)) {
            self.collapsed.delete(id);
          } else {
            self.collapsed.add(id);
          }
          self.render();
        });
      });

      // Timestamp click → jump video
      container.querySelectorAll('.ytx-mm-timestamp').forEach(function (ts) {
        ts.addEventListener('click', function (e) {
          e.stopPropagation();
          var time = parseInt(ts.dataset.time, 10);
          if (isNaN(time)) return;
          var video = document.querySelector('video');
          if (video) { video.currentTime = time; video.play(); }
        });
      });
    },

    getVideoTitle: function () {
      return YTX.Export.getSafeFilename(YTX.Export.getVideoTitle()) || 'mindmap';
    },

    buildExportSvg: function () {
      var svgEl = YTX.panel.querySelector('.ytx-mindmap-svg');
      if (!svgEl) return null;

      var bounds = getMindmapBounds(this.data);
      var PAD = 40;
      var exportW = bounds.maxX - bounds.minX + PAD * 2;
      var exportH = bounds.maxY - bounds.minY + PAD * 2;

      var clone = svgEl.cloneNode(true);
      clone.setAttribute('width', exportW);
      clone.setAttribute('height', exportH);
      var canvas = clone.querySelector('.ytx-mm-canvas');
      if (canvas) canvas.setAttribute('transform', 'translate(0,0) scale(1)');

      var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('width', exportW);
      bg.setAttribute('height', exportH);
      bg.setAttribute('fill', '#fff');
      clone.insertBefore(bg, clone.firstChild);

      return { svg: clone, width: exportW, height: exportH };
    },

    openInNewTab: function () {
      if (!YTX.panel || !this.data) return;
      var result = this.buildExportSvg();
      if (!result) return;

      var svgData = new XMLSerializer().serializeToString(result.svg);
      var title = this.getVideoTitle();
      var html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + YTX.escapeHtml(title) + ' - 思维导图</title>' +
        '<style>body{margin:0;background:#f5f3ff;display:flex;justify-content:center;align-items:center;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
        '.wrap{background:#fff;border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,.08);padding:24px;margin:24px;max-width:100%;overflow:auto}' +
        'h1{text-align:center;color:#7c3aed;font-size:18px;margin:0 0 16px}</style></head>' +
        '<body><div class="wrap"><h1>' + YTX.escapeHtml(title) + '</h1>' + svgData + '</div></body></html>';

      var blob = new Blob([html], { type: 'text/html' });
      var url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    },

    exportObsidian: function () {
      if (!this.data) return;
      var title = YTX.Export.getVideoTitle() + ' - 导图';
      var md = YTX.Export.mindmapToMarkdown(this.data, 0, { noTime: true });
      YTX.Export.downloadObsidian(md, title);
      var btn = YTX.panel.querySelector('.ytx-mm-tool-btn[data-action="export-obsidian"]');
      if (btn) YTX.Export.flashButton(btn, '已导出', 1500);
    },

    exportSvg: function () {
      if (!YTX.panel || !this.data) return;
      var result = this.buildExportSvg();
      if (!result) return;

      var svgData = new XMLSerializer().serializeToString(result.svg);
      var blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = this.getVideoTitle() + '.svg';
      a.click();
      URL.revokeObjectURL(url);
    },

  };

  // 从存储加载对齐设置
  chrome.storage.sync.get(['mindmapAlignTop'], function (data) {
    if (typeof data.mindmapAlignTop === 'boolean') {
      YTX.features.mindmap.alignTop = data.mindmapAlignTop;
    }
  });
})();

// src/vocab.js — 学英语/词汇

YTX.features.vocab = {
  tab: { key: 'vocab', label: '学单词', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/></svg>' },
  prefix: 'VOCAB',
  contentId: 'ytx-content-vocab',
  actionsId: 'ytx-actions-vocab',
  displayMode: 'flex',

  // 状态
  text: '',
  data: [],
  isGenerating: false,

  reset: function () {
    this.text = '';
    this.data = [];
    this.isGenerating = false;
  },

  actionsHtml: function () {
    return '<button id="ytx-generate-vocab" class="ytx-btn ytx-btn-icon ytx-btn-primary" title="提取词汇">' + YTX.icons.play + '</button>';
  },

  contentHtml: function () {
    return '<div class="ytx-empty">点击「提取词汇」从视频字幕中提取值得学习的词汇和短语</div>';
  },

  bindEvents: function (panel) {
    var self = this;
    panel.querySelector('#ytx-generate-vocab').addEventListener('click', function () { self.start(); });
  },

  start: async function () {
    if (this.isGenerating) return;
    this.isGenerating = true;
    this.text = '';
    this.data = [];

    var btn = YTX.panel.querySelector('#ytx-generate-vocab');
    var contentEl = YTX.panel.querySelector('#ytx-content-vocab');
    btn.disabled = true;

    try {
      btn.innerHTML = YTX.icons.spinner;
      contentEl.innerHTML = '<div class="ytx-loading" style="padding:14px 16px"><div class="ytx-spinner"></div><span>正在获取字幕...</span></div>';
      await YTX.ensureTranscript();

      contentEl.innerHTML = '<div class="ytx-loading" style="padding:14px 16px"><div class="ytx-spinner"></div><span>正在提取词汇短语...</span></div>';

      var settings = await YTX.getSettings();
      var payload = YTX.getContentPayload();

      chrome.runtime.sendMessage(Object.assign({
        type: 'GENERATE_VOCAB',
        prompt: settings.promptVocab || YTX.prompts.VOCAB,
        provider: settings.provider,
        activeKey: settings.activeKey,
        model: settings.model,
      }, payload));
    } catch (err) {
      contentEl.innerHTML = '<div class="ytx-error" style="margin:14px 16px">' + err.message + '</div>';
      btn.disabled = false;
      YTX.btnPrimary(btn);
      this.isGenerating = false;
    }
  },

  onChunk: function (text) {
    this.text += text;
  },

  onDone: function () {
    try {
      this.data = YTX.extractJSON(this.text, 'array');
      if (!this.data) {
        throw new Error('AI 返回的内容不包含有效 JSON，请重新生成');
      }
      this.render();
    } catch (err) {
      YTX.parseError(YTX.panel.querySelector('#ytx-content-vocab'), '词汇', err);
    }
    YTX.panel.querySelector('#ytx-generate-vocab').disabled = false;
    YTX.btnRefresh(YTX.panel.querySelector('#ytx-generate-vocab'));
    this.isGenerating = false;
    if (this.data && this.data.length > 0) YTX.cache.save(YTX.currentVideoId, 'vocab', { data: this.data });
  },

  onError: function (error) {
    YTX.panel.querySelector('#ytx-content-vocab').innerHTML = '<div class="ytx-error" style="margin:14px 16px">' + error + '</div>';
    YTX.panel.querySelector('#ytx-generate-vocab').disabled = false;
    YTX.btnPrimary(YTX.panel.querySelector('#ytx-generate-vocab'));
    this.isGenerating = false;
  },

  render: function () {
    if (!YTX.panel || this.data.length === 0) return;
    var self = this;
    var contentEl = YTX.panel.querySelector('#ytx-content-vocab');

    contentEl.innerHTML =
      '<div class="ytx-vocab-toolbar">' +
        '<span class="ytx-vocab-counter">共 ' + this.data.length + ' 个词汇/短语</span>' +
        '<span class="ytx-mm-toolbar-spacer"></span>' +
        '<button class="ytx-mm-tool-btn" data-action="refresh">换一批</button>' +
        '<button class="ytx-mm-tool-btn" data-action="copy">复制</button>' +
      '</div>' +
      '<div class="ytx-vocab-list">' +
        this.data.map(function (item) {
          return '<div class="ytx-vocab-item">' +
            '<div class="ytx-vocab-header">' +
              '<span class="ytx-vocab-word">' + YTX.escapeHtml(item.word) + '</span>' +
              '<span class="ytx-vocab-phonetic">' + YTX.escapeHtml(item.phonetic || '') + '</span>' +
              (item.time ? '<span class="ytx-timestamp ytx-vocab-time" data-time="' + YTX.timeToSeconds(item.time) + '">[' + item.time + ']</span>' : '') +
            '</div>' +
            '<div class="ytx-vocab-meaning"><span class="ytx-vocab-pos">' + YTX.escapeHtml(item.pos || '') + '</span> ' + YTX.escapeHtml(item.meaning || '') + '</div>' +
            (item.example ? '<div class="ytx-vocab-example">' + YTX.escapeHtml(item.example) + '</div>' : '') +
          '</div>';
        }).join('') +
      '</div>';

    contentEl.querySelectorAll('.ytx-mm-tool-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.dataset.action;
        if (action === 'refresh') self.refresh();
        else if (action === 'copy') self.copy();
      });
    });
  },

  copy: function () {
    if (this.data.length === 0) return;
    var text = this.data.map(function (item) {
      return item.word + ' (' + item.pos + ') - ' + item.meaning;
    }).join('\n');
    var btn = YTX.panel.querySelector('#ytx-content-vocab .ytx-mm-tool-btn[data-action="copy"]');
    navigator.clipboard.writeText(text).then(function () {
      if (btn) { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 1500); }
    }).catch(function () {
      if (btn) { btn.textContent = '复制失败'; setTimeout(function () { btn.textContent = '复制'; }, 1500); }
    });
  },

  refresh: function () {
    if (this.isGenerating) return;
    var excludeList = this.data.map(function (item) { return item.word; }).join(', ');
    this.isGenerating = true;
    this.text = '';
    this.data = [];

    var btn = YTX.panel.querySelector('#ytx-generate-vocab');
    var contentEl = YTX.panel.querySelector('#ytx-content-vocab');
    btn.disabled = true;

    btn.innerHTML = YTX.icons.spinner;
    contentEl.innerHTML = '<div class="ytx-loading" style="padding:14px 16px"><div class="ytx-spinner"></div><span>正在换一批词汇...</span></div>';

    var payload = YTX.getContentPayload();

    YTX.getSettings().then(function (settings) {
      var basePrompt = settings.promptVocab || YTX.prompts.VOCAB;
      var refreshPrompt = basePrompt + '\n\n注意：以下词汇已经提取过，请排除它们，提取其他不同的词汇：\n' + excludeList;
      chrome.runtime.sendMessage(Object.assign({
        type: 'GENERATE_VOCAB',
        prompt: refreshPrompt,
        provider: settings.provider,
        activeKey: settings.activeKey,
        model: settings.model,
      }, payload));
    });
  },
};

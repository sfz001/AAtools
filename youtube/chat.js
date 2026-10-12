// src/chat.js — 互动问答

YTX.features.chat = {
  tab: { key: 'chat', label: '问问AI', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' },
  prefix: 'CHAT',
  contentId: 'ytx-content-chat',
  actionsId: 'ytx-actions-chat',
  displayMode: 'flex',

  // 状态
  messages: [],
  replyText: '',
  isChatting: false,
  _renderTimer: null,
  warning: '',
  truncated: false,

  reset: function () {
    this.cancelReplyRender();
    this.warning = '';
    this.truncated = false;
    this.messages = [];
    this.replyText = '';
    this.isChatting = false;
    if (this.requestId) YTX.cancelRequest(this.requestId);
    this.requestId = null;
  },

  actionsHtml: function () {
    return '<button id="ytx-clear-chat" class="ytx-btn ytx-btn-icon ytx-btn-secondary" title="清空对话">' + YTX.icons.trash + '</button>';
  },

  contentHtml: function () {
    return '<div class="ytx-chat-messages" id="ytx-chat-messages">' +
             '<div class="ytx-empty">基于视频内容提问，AI 助教为你解答</div>' +
           '</div>' +
           '<div class="ytx-chat-input-wrap">' +
             '<input type="text" id="ytx-chat-input" placeholder="输入你的问题..." />' +
             '<button id="ytx-chat-send" class="ytx-btn ytx-btn-primary">发送</button>' +
           '</div>';
  },

  bindEvents: function (panel) {
    var self = this;
    panel.querySelector('#ytx-chat-send').addEventListener('click', function () { self.send(); });
    panel.querySelector('#ytx-chat-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); self.send(); }
    });
    panel.querySelector('#ytx-clear-chat').addEventListener('click', function () { self.clear(); });
  },

  send: async function () {
    if (this.isChatting || !YTX.panel) return;
    var input = YTX.panel.querySelector('#ytx-chat-input');
    var question = input.value.trim();
    if (!question) return;

    input.value = '';
    this.cancelReplyRender();
    this.isChatting = true;
    this.replyText = '';
    this.warning = '';
    this.truncated = false;
    var sendBtn = YTX.panel.querySelector('#ytx-chat-send');
    sendBtn.disabled = true;

    var msgContainer = YTX.panel.querySelector('#ytx-chat-messages');
    var empty = msgContainer.querySelector('.ytx-empty');
    if (empty) empty.remove();

    // 添加用户消息气泡
    var userBubble = document.createElement('div');
    userBubble.className = 'ytx-chat-bubble ytx-chat-user';
    userBubble.textContent = question;
    msgContainer.appendChild(userBubble);

    // 添加 AI 回复气泡（流式填充）
    var aiBubble = document.createElement('div');
    aiBubble.className = 'ytx-chat-bubble ytx-chat-ai';
    aiBubble.innerHTML = '<div class="ytx-loading"><div class="ytx-spinner"></div></div>';
    msgContainer.appendChild(aiBubble);
    msgContainer.scrollTop = msgContainer.scrollHeight;

    this.messages.push({ role: 'user', content: question });
    // 保留最近 40 条消息（约 20 轮对话），防止超 token 限制
    if (this.messages.length > 40) this.messages = this.messages.slice(-40);

    var startVideoId = YTX.currentVideoId;
    if (this.requestId) YTX.cancelRequest(this.requestId);
    var requestId = YTX.makeRequestId();
    this.requestId = requestId;

    try {
      aiBubble.innerHTML = '<div class="ytx-loading"><div class="ytx-spinner"></div><span>获取字幕中...</span></div>';
      await YTX.ensureTranscript();
      if (YTX.currentVideoId !== startVideoId || this.requestId !== requestId) return;
      if (!YTX.transcriptData) throw new Error('字幕已失效，请重新提问');

      var settings = await YTX.getSettings();
      if (YTX.currentVideoId !== startVideoId || this.requestId !== requestId) return;
      var payload = YTX.getContentPayload();

      await YTX.sendToBg(Object.assign({
        type: 'CHAT_ASK',
        messages: this.messages,
        provider: settings.provider,
        model: settings.model,
        requestId: requestId,
      }, payload));
    } catch (err) {
      if (this.requestId !== requestId) return;
      this.cancelReplyRender();
      // 回滚发请求前推入的这轮 user 消息：不回滚的话下一轮会带着它一起发出，
      // 变成连续两条 user，模型可能把上次失败的问题一并作答
      this.rollbackPendingQuestion();
      YTX.cancelRequest(requestId);
      this.requestId = null;
      if (YTX.currentVideoId !== startVideoId) { this.isChatting = false; return; }
      YTX.renderError(aiBubble, err.message);
      this.isChatting = false;
      sendBtn.disabled = false;
    }
  },

  cancelReplyRender: function () {
    if (this._renderTimer !== null) clearTimeout(this._renderTimer);
    this._renderTimer = null;
  },

  flushReply: function () {
    this.cancelReplyRender();
    if (!YTX.panel) return;
    var aiBubble = YTX.panel.querySelector('.ytx-chat-ai:last-child');
    var msgContainer = YTX.panel.querySelector('#ytx-chat-messages');
    if (!aiBubble || !msgContainer) return;
    var followBottom = msgContainer.scrollHeight - msgContainer.clientHeight - msgContainer.scrollTop <= 32;
    var previousTop = msgContainer.scrollTop;
    aiBubble.innerHTML = YTX.renderMarkdown(this.replyText) + YTX.resultWarningHtml(this);
    msgContainer.scrollTop = followBottom ? msgContainer.scrollHeight : previousTop;
  },

  onChunk: function (text) {
    this.replyText += text;
    if (this._renderTimer !== null) return;
    var self = this;
    var requestId = this.requestId;
    var panelAtStart = YTX.panel;
    var renderTimer = setTimeout(function () {
      if (self._renderTimer !== renderTimer) return;
      self._renderTimer = null;
      if (!self.isChatting || self.requestId !== requestId || YTX.panel !== panelAtStart) return;
      self.flushReply();
    }, 80);
    this._renderTimer = renderTimer;
  },

  // 这轮请求失败时丢掉尾部那条尚未配对 assistant 回复的 user 消息
  rollbackPendingQuestion: function () {
    if (this.messages.length && this.messages[this.messages.length - 1].role === 'user') {
      this.messages.pop();
    }
  },

  onDone: function (metadata) {
    this.warning = YTX.resultWarningText(metadata);
    this.truncated = !!(metadata && metadata.truncated);
    this.flushReply();
    this.requestId = null;
    this.messages.push({ role: 'assistant', content: this.replyText });
    this.isChatting = false;
    YTX.panel.querySelector('#ytx-chat-send').disabled = false;
    YTX.panel.querySelector('#ytx-chat-input').focus();
  },

  onError: function (error) {
    this.cancelReplyRender();
    this.requestId = null;
    // 同 send() 的 catch：这轮没有 assistant 回复，user 消息必须回滚
    this.rollbackPendingQuestion();
    var aiBubble = YTX.panel.querySelector('.ytx-chat-ai:last-child');
    if (aiBubble) YTX.renderError(aiBubble, error);
    this.isChatting = false;
    YTX.panel.querySelector('#ytx-chat-send').disabled = false;
  },

  clear: function () {
    this.cancelReplyRender();
    this.warning = '';
    this.truncated = false;
    if (this.requestId) YTX.cancelRequest(this.requestId);
    this.requestId = null;
    this.messages = [];
    this.replyText = '';
    this.isChatting = false;
    if (!YTX.panel) return;
    var sendBtn = YTX.panel.querySelector('#ytx-chat-send');
    if (sendBtn) sendBtn.disabled = false;
    var msgContainer = YTX.panel.querySelector('#ytx-chat-messages');
    msgContainer.innerHTML = '<div class="ytx-empty">基于视频内容提问，AI 助教为你解答</div>';
  },
};

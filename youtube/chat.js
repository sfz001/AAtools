// src/chat.js — 互动问答

// 只保留完整 user/assistant 轮次，并同时限制单条与累计字符。
// 从最新轮次向前选择，超预算的旧轮次直接丢弃，避免下一问永久撞后台上限。
YTX.trimChatHistory = function (messages, maxMessages, maxChars) {
  var turns = [];
  var list = Array.isArray(messages) ? messages : [];
  for (var i = 0; i + 1 < list.length; i++) {
    if (list[i] && list[i].role === 'user' && typeof list[i].content === 'string' &&
        list[i + 1] && list[i + 1].role === 'assistant' && typeof list[i + 1].content === 'string') {
      turns.push([list[i], list[i + 1]]);
      i++;
    }
  }
  var limit = maxMessages == null ? 40 : Number(maxMessages);
  if (!isFinite(limit) || limit < 0) limit = 0;
  var maxTurns = Math.max(0, Math.floor(limit / 2));
  var charBudget = maxChars == null ? YTX.CHAT_HISTORY_MAX_CHARS : Number(maxChars);
  if (!Number.isSafeInteger(charBudget) || charBudget < 0) charBudget = 0;
  var selected = [];
  var used = 0;
  for (var ti = turns.length - 1; ti >= 0 && selected.length < maxTurns; ti--) {
    var turn = turns[ti];
    var userChars = turn[0].content.length;
    var assistantChars = turn[1].content.length;
    if (userChars > YTX.CHAT_HISTORY_MESSAGE_MAX_CHARS ||
        assistantChars > YTX.CHAT_HISTORY_MESSAGE_MAX_CHARS) continue;
    var turnChars = userChars + assistantChars;
    if (turnChars > charBudget - used) continue;
    selected.unshift(turn);
    used += turnChars;
  }
  return selected.reduce(function (out, turn) { return out.concat(turn); }, []);
};

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

  reset: function () {
    this.messages = [];
    this.replyText = '';
    this._newlineCount = 0;
    this.isChatting = false;
    this._pendingTurn = null;
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    if (this.requestId) YTX.cancelRequest(this.requestId);
    this.requestId = null;
    this._frameToken = null;
    this._inputFrame = null;
  },

  actionsHtml: function () {
    return '<button id="ytx-copy-chat" class="ytx-btn ytx-btn-secondary" title="复制完整对话">复制</button>' +
      '<button id="ytx-clear-chat" class="ytx-btn ytx-btn-icon ytx-btn-secondary" title="清空对话">' + YTX.icons.trash + '</button>';
  },

  contentHtml: function () {
    return '<div class="ytx-chat-messages" id="ytx-chat-messages">' +
             '<div class="ytx-empty">基于视频内容提问，AI 助教为你解答</div>' +
           '</div>' +
           '<div class="ytx-chat-input-wrap">' +
             '<iframe id="ytx-chat-input-frame" title="AI 问答输入框"></iframe>' +
           '</div>';
  },

  bindEvents: function (panel) {
    var self = this;
    panel.querySelector('#ytx-copy-chat').addEventListener('click', function (e) {
      if (!YTX.isTrustedEvent(e)) return;
      self.copyConversation();
    });
    panel.querySelector('#ytx-clear-chat').addEventListener('click', function (e) {
      if (!YTX.isTrustedEvent(e)) return;
      self.clear();
    });
    this.mountInputFrame(panel);
  },

  mountInputFrame: function (panel) {
    var frame = panel && panel.querySelector('#ytx-chat-input-frame');
    if (!frame) return;
    var token = YTX.makeCapabilityToken();
    if (!token) {
      this._frameToken = null;
      this._inputFrame = null;
      YTX.renderError(frame.parentNode || panel, '安全随机数不可用，聊天输入已停用，请重新打开面板');
      return;
    }
    this._frameToken = token;
    this._inputFrame = frame;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    var self = this;
    frame.addEventListener('load', function () {
      if (self._inputFrame === frame && self._frameToken === token) {
        self.postInputState({ busy: self.isChatting });
      }
    }, { once: true });
    frame.src = chrome.runtime.getURL('youtube/chat-frame.html') +
      '#token=' + encodeURIComponent(token) +
      '&videoId=' + encodeURIComponent(YTX.currentVideoId || '');
  },

  postInputState: function (state) {
    if (!this._inputFrame || !this._frameToken || !YTX.currentVideoId) return;
    var payload = {
      busy: this.isChatting,
      dark: document.documentElement.hasAttribute('dark'),
    };
    state = state || {};
    ['busy', 'clear', 'focus', 'dark'].forEach(function (key) {
      if (typeof state[key] === 'boolean') payload[key] = state[key];
    });
    if (typeof state.error === 'string') payload.error = state.error.slice(0, 500);
    YTX.sendToBg({
      type: 'YTX_CHAT_FRAME_STATE_RELAY',
      token: this._frameToken,
      videoId: YTX.currentVideoId,
      state: payload,
    }).catch(function () {});
  },

  acceptFrameQuestion: function (question, token, videoId) {
    if (token !== this._frameToken || videoId !== YTX.currentVideoId || this.isChatting || !YTX.panel) return false;
    if (typeof question !== 'string' || !question.trim() || question.trim().length > YTX.CHAT_QUESTION_MAX_CHARS) return false;
    var self = this;
    this.send(question).catch(function (error) {
      self.isChatting = false;
      self.postInputState({ busy: false, error: error && error.message ? error.message : '问答启动失败' });
    });
    return true;
  },

  send: async function (question) {
    if (this.isChatting || !YTX.panel) return;
    question = typeof question === 'string' ? question.trim() : '';
    if (!question) return;
    if (question.length > YTX.CHAT_QUESTION_MAX_CHARS) {
      this.postInputState({ busy: false, error: '问题不能超过 ' + YTX.CHAT_QUESTION_MAX_CHARS + ' 个字符' });
      return;
    }

    this.isChatting = true;
    this.replyText = '';
    this._newlineCount = 0;
    this.postInputState({ busy: true, clear: true, error: '' });

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

    // 请求期间不修改已完成历史；失败时自然回滚 pending user。
    // 为新 user + 最终 assistant 预留两个位置，成功后历史仍不超过 40 条。
    var baseHistory = YTX.trimChatHistory(
      this.messages,
      38,
      Math.max(0, YTX.CHAT_HISTORY_MAX_CHARS - question.length)
    );
    var pendingUser = { role: 'user', content: question };
    var requestMessages = baseHistory.concat([pendingUser]);
    this._pendingTurn = { user: pendingUser, baseHistory: baseHistory };

    var startVideoId = YTX.currentVideoId;
    if (this.requestId) YTX.cancelRequest(this.requestId);
    var requestId = YTX.makeRequestId();
    this.requestId = requestId;

    try {
      aiBubble.innerHTML = '<div class="ytx-loading"><div class="ytx-spinner"></div><span>获取字幕中...</span></div>';
      await YTX.ensureTranscript();
      if (YTX.currentVideoId !== startVideoId || this.requestId !== requestId) return;

      var settings = await YTX.getSettings();
      if (YTX.currentVideoId !== startVideoId || this.requestId !== requestId) return;
      var payload = YTX.getContentPayload();

      await YTX.startStreamRequest(Object.assign({
        type: 'CHAT_ASK',
        messages: requestMessages,
        provider: settings.provider,
        model: settings.model,
        requestId: requestId,
      }, payload));
    } catch (err) {
      if (this.requestId !== requestId) return;
      YTX.cancelRequest(requestId);
      this.requestId = null;
      this._pendingTurn = null;
      if (YTX.currentVideoId !== startVideoId) { this.isChatting = false; this.postInputState({ busy: false }); return; }
      YTX.renderError(aiBubble, err.message);
      this.isChatting = false;
      this.postInputState({ busy: false, error: err.message || '问答失败' });
    }
  },

  onChunk: function (text) {
    var self = this;
    var appended = YTX.appendCappedMarkdown(this.replyText, text, this._newlineCount, YTX.CHAT_REPLY_MAX_CHARS);
    if (appended === null) {
      if (this.requestId) YTX.cancelRequest(this.requestId);
      this.onError('AI 回答过长或行数过多，已超过安全上限并取消回答');
      return;
    }
    this.replyText = appended.text;
    this._newlineCount = appended.newlines;
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(function () {
      self._renderTimer = null;
      self.renderReply();
    }, 80);
  },

  renderReply: function () {
    if (!YTX.panel) return;
    var aiBubble = YTX.panel.querySelector('.ytx-chat-ai:last-child');
    if (!aiBubble) return;
    aiBubble.innerHTML = YTX.renderMarkdown(this.replyText);
    var msgContainer = YTX.panel.querySelector('#ytx-chat-messages');
    if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;
  },

  onDone: function (completion) {
    this.requestId = null;
    var incompleteWarning = YTX.streamCompletionWarning(completion);
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    this.renderReply();
    if (incompleteWarning) {
      var incompleteBubble = YTX.panel.querySelector('.ytx-chat-ai:last-child');
      if (incompleteBubble) YTX.prependOutputWarning(incompleteBubble, incompleteWarning);
    } else if (this._pendingTurn) {
      this.messages = YTX.trimChatHistory(
        this._pendingTurn.baseHistory.concat([
          this._pendingTurn.user,
          { role: 'assistant', content: this.replyText },
        ]),
        40,
        YTX.CHAT_HISTORY_MAX_CHARS
      );
    }
    this._pendingTurn = null;
    this.isChatting = false;
    this.postInputState({ busy: false, focus: true, error: incompleteWarning });
  },

  onError: function (error) {
    this.requestId = null;
    this._pendingTurn = null;
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    var aiBubble = YTX.panel.querySelector('.ytx-chat-ai:last-child');
    if (aiBubble) YTX.renderError(aiBubble, error);
    this.isChatting = false;
    this.postInputState({ busy: false, error: String(error || '问答失败') });
  },

  copyConversation: function () {
    var complete = YTX.trimChatHistory(this.messages, 40, YTX.CHAT_HISTORY_MAX_CHARS);
    if (!complete.length || !navigator.clipboard || !navigator.clipboard.writeText) return;
    var text = complete.map(function (message) {
      return (message.role === 'user' ? '用户：' : 'AI：') + message.content;
    }).join('\n\n');
    var btn = YTX.panel && YTX.panel.querySelector('#ytx-copy-chat');
    navigator.clipboard.writeText(text).then(function () {
      if (btn) YTX.Export.flashButton(btn, '已复制', 1200);
    }).catch(function () {
      if (btn) YTX.Export.flashButton(btn, '复制失败', 1200);
    });
  },

  clear: function () {
    if (this.requestId) YTX.cancelRequest(this.requestId);
    this.requestId = null;
    this.messages = [];
    this.replyText = '';
    this._newlineCount = 0;
    this.isChatting = false;
    this._pendingTurn = null;
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    if (!YTX.panel) return;
    this.postInputState({ busy: false, clear: true, focus: true, error: '' });
    var msgContainer = YTX.panel.querySelector('#ytx-chat-messages');
    msgContainer.innerHTML = '<div class="ytx-empty">基于视频内容提问，AI 助教为你解答</div>';
  },
};

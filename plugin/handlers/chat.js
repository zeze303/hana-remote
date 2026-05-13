// plugin/handlers/chat.js — 聊天消息处理
// 接收 Relay 转发的聊天消息，注入 Hanako 对话流，流式返回回复

/**
 * 聊天处理器
 * @param {object} options
 * @param {function} options.sendToRelay — 向 Relay 发送消息的回调
 * @param {object} options.hanakoApi — Hanako 对话引擎的接口适配器
 */
function createChatHandler({ sendToRelay, hanakoApi }) {
  /**
   * 处理聊天消息
   * @param {object} msg - 消息对象 { id, type, payload: { text } }
   */
  async function handle(msg) {
    const { id, payload } = msg;
    const userText = payload?.text;

    if (!userText) {
      sendToRelay({ id, ok: false, type: 'chat', payload: { error: '消息内容为空' } });
      return;
    }

    if (!hanakoApi || typeof hanakoApi.sendMessage !== 'function') {
      sendToRelay({ id, ok: false, type: 'chat', payload: { error: 'Hanako 对话引擎未连接' } });
      return;
    }

    try {
      // 调用 Hanako 对话引擎，传入流式回调
      await hanakoApi.sendMessage(userText, {
        onChunk(chunk) {
          // 逐块发送回复给 Relay → 浏览器
          sendToRelay({
            id,
            ok: true,
            type: 'chat',
            payload: { text: chunk, done: false },
          });
        },
        onThinking(text) {
          // 发送思考过程到 Relay → 浏览器
          sendToRelay({
            id,
            ok: true,
            type: 'chat',
            payload: { thinking: text },
          });
        },
        onDone() {
          // 标记完成
          sendToRelay({
            id,
            ok: true,
            type: 'chat',
            payload: { text: '', done: true },
          });
        },
        onError(err) {
          sendToRelay({
            id,
            ok: false,
            type: 'chat',
            payload: { error: err.message || '处理消息时出错' },
          });
        },
      });
    } catch (err) {
      sendToRelay({
        id,
        ok: false,
        type: 'chat',
        payload: { error: `对话引擎调用失败: ${err.message}` },
      });
    }
  }

  /**
   * 取消正在进行的聊天（转发 cancel 信号）
   */
  function cancel() {
    if (hanakoApi && typeof hanakoApi.cancelMessage === 'function') {
      hanakoApi.cancelMessage();
    }
  }

  return { handle, cancel };
}

module.exports = { createChatHandler };

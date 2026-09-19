// Run against the real chat after the window probe has opened a conversation.
(() => {
  const chat = document.querySelector('.chat-content');
  const input = chat?.querySelector('.chat-input-textarea');
  const transcript = chat?.querySelector('.overflow-y-auto');
  if (!chat || !input || !transcript) throw new Error('chat, transcript or input missing');
  const style = getComputedStyle(chat);
  if (style.display !== 'flex' || style.flexDirection !== 'column') {
    throw new Error(`chat layout is ${style.display}/${style.flexDirection}, expected flex/column`);
  }
  const body = transcript.getBoundingClientRect();
  const editor = input.getBoundingClientRect();
  const pane = chat.getBoundingClientRect();
  if (body.height <= 0 || editor.width <= 0 || editor.height <= 0) {
    throw new Error('transcript or input has no visible area');
  }
  if (editor.top < body.bottom - 1) throw new Error('input is beside or overlaps the transcript');
  if (editor.left < pane.left - 1 || editor.right > pane.right + 1 ||
      editor.right > innerWidth + 1 || editor.bottom > innerHeight + 1) {
    throw new Error('input extends outside the chat or window');
  }
  if (getComputedStyle(transcript).overflowY !== 'auto') throw new Error('transcript cannot scroll independently');
  if (document.documentElement.scrollWidth > innerWidth + 1) throw new Error('page overflows horizontally');
  return `chat flows vertically; input visible below transcript (${innerWidth}x${innerHeight})`;
})();

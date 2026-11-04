type SendKey = { key: string; keyCode?: number; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing: boolean };
// Enter sends from a hardware keyboard and Shift+Enter adds a line. Touch
// keyboards have no Shift+Enter, so Enter adds a line there. Command/Ctrl+Enter
// always sends. Safari reports the Enter that confirms IME input as keyCode 229.
export function sendsMessage(event: SendKey, touch: boolean) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return false;
  return event.metaKey || event.ctrlKey || (!touch && !event.shiftKey && !event.altKey);
}

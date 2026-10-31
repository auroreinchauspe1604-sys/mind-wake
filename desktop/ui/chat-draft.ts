const KEY = 'mind-wake.chat-compose';
type Field = { value: string; addEventListener(name: string, handler: () => void): void };
type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Preserve the local composition through desktop reloads, never transmit or send it. */
export function bindChatDraft(field: Field, recipient: Field, storage?: Store): () => void {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null');
    if (saved && typeof saved === 'object' && !field.value) {
      const value = saved as Record<string, unknown>;
      if (typeof value['text'] === 'string' && value['text'].length <= 4000 &&
          ['owner', 'auroracle'].includes(String(value['recipient']))) {
        field.value = value['text'];recipient.value = String(value['recipient']);
      }
    }
  } catch { /* Private local display state, storage is optional. */ }
  const save = (): void => {
    try { storage?.setItem(KEY, JSON.stringify({ text: field.value, recipient: recipient.value })); }
    catch { /* Do not block composition or sending. */ }
  };
  field.addEventListener('input', save);recipient.addEventListener('change', save);
  return save;
}

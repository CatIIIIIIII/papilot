// Claude emits partial assistant envelopes whose content array can contain
// just one block. Its array index is not the original streaming block index
// (thinking and tool blocks also occupy indexes in the stream).
export class ClaudeText {
  current = '';
  private blocks = new Map<string, { message: string; text: string; completed: boolean }>();
  private finals = new Map<string, string>();

  delta(index: number, text: string) {
    const id = `${this.current}:${index}`;
    const block = this.blocks.get(id) || { message: this.current, text: '', completed: false };
    block.text += text; this.blocks.set(id, block);
    return id;
  }

  complete(message: string, index: number, text: string, envelope?: string) {
    const key = envelope ? `${envelope}:${index}` : undefined;
    if (key && this.finals.has(key)) return this.finals.get(key)!;
    const matches = [...this.blocks].filter(([, block]) => block.message === message && block.text === text);
    const match = matches.find(([, block]) => !block.completed) || matches.find(([id]) => id === `${message}:${index}`) || matches[0];
    const id = match?.[0] || (envelope ? `${message}:${envelope}:${index}` : `${message}:${index}`);
    if (match) match[1].completed = true;
    if (key) this.finals.set(key, id);
    return id;
  }
}

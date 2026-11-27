// Telegraf ghi URL có token (/bot<id>:<secret>/<method>) vào message của lỗi mạng.
// Secret kết thúc ở dấu "/" của đường dẫn, nên không giới hạn ký tự.
const BOT_TOKEN_IN_URL = /bot\d+:[^/\s]+/g;

export function redactBotToken(text: string): string {
  return text.replace(BOT_TOKEN_IN_URL, 'bot<redacted>');
}

/** Che token trong message và stack của lỗi, giữ nguyên `code` để logic retry vẫn nhận ra lỗi mạng. */
export function redactErrorToken(err: unknown): unknown {
  if (err instanceof Error) {
    err.message = redactBotToken(err.message);
    if (err.stack) err.stack = redactBotToken(err.stack);
  }
  return err;
}

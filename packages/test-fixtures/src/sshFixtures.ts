const encoder = new TextEncoder();

/** ssh2 adapter 測試用的 byte-level fixtures。 */
export const sshFixtures = {
  /** 一般 bash prompt。 */
  promptBytes: encoder.encode('ycchao@gpu-box:~$ '),

  /** ANSI 256 色與 truecolor 混合輸出。 */
  ansiColorBytes: encoder.encode(
    '[38;5;196mred[0m [38;2;0;255;128mtruecolor[0m\r\n',
  ),

  /**
   * 「中」(U+4E2D, e4 b8 ad) 被切成兩個 chunk 送達 —
   * transport 必須原封轉發 bytes，不得在邊界解碼。
   */
  utf8SplitChunks: [new Uint8Array([0xe4, 0xb8]), new Uint8Array([0xad, 0x0a])],

  /** alternate screen 進出（vim/htop 類 TUI 常見）。 */
  alternateScreenBytes: encoder.encode('[?1049h(TUI)[?1049l'),
};

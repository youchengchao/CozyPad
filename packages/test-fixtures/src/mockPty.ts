const encoder = new TextEncoder();

export interface MockPtyEvents {
  onData(data: Uint8Array): void;
  onClose?(info: { exitCode: number | null }): void;
}

const BANNER = [
  '\u001b[38;5;208m   ______                ____            __',
  '  / ____/___  ____  __  / __ \\____ _____/ /',
  ' / /   / __ \\/_  / / / / /_/ / __ `/ __  / ',
  '/ /___/ /_/ / / /_/ /_/ ____/ /_/ / /_/ /  ',
  '\\____/\\____/ /___/\\__, /_/    \\__,_/\\__,_/   ',
  '                 /____/\u001b[0m',
  '',
  '\u001b[1mCozyPad mock shell\u001b[0m — no real host is attached.',
  'Type \u001b[1;33mhelp\u001b[0m to list commands.',
  '',
].join('\r\n');

const PROMPT = '\u001b[1;32mcozy@mock\u001b[0m:\u001b[1;34m~\u001b[0m$ ';

const FILES = [
  'drwxr-xr-x  cozy cozy  \u001b[1;34mprojects\u001b[0m',
  'drwxr-xr-x  cozy cozy  \u001b[1;34mdatasets\u001b[0m',
  '-rw-r--r--  cozy cozy  cozypad.study.yaml',
  '-rw-r--r--  cozy cozy  notes.md',
];

/**
 * 純邏輯的假 PTY：瀏覽器 mock bridge 與 Electron mock transport 共用。
 * 沒有 timer、沒有平台 API，輸入輸出都是 bytes。
 */
export class MockPtyEngine {
  private line = '';
  private closed = false;
  private cols: number;
  private rows: number;
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly events: MockPtyEvents,
    size?: { cols?: number; rows?: number },
  ) {
    this.cols = size?.cols ?? 80;
    this.rows = size?.rows ?? 24;
  }

  start(): void {
    this.emit(BANNER + PROMPT);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  write(data: Uint8Array): void {
    if (this.closed) return;
    const text = this.decoder.decode(data, { stream: true });
    for (const ch of text) {
      if (ch === '\r' || ch === '\n') {
        this.emit('\r\n');
        this.runCommand(this.line.trim());
        this.line = '';
        if (!this.closed) this.emit(PROMPT);
      } else if (ch === '\u007f' || ch === '\b') {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.emit('\b \b');
        }
      } else if (ch === '\u0003') {
        this.line = '';
        this.emit('^C\r\n' + PROMPT);
      } else if (ch >= ' ' || ch === '\t') {
        this.line += ch;
        this.emit(ch);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.events.onClose?.({ exitCode: 0 });
  }

  private runCommand(input: string): void {
    if (input === '') return;
    switch (input) {
      case 'help':
        this.emit(
          [
            'Available mock commands:',
            '  help     show this help',
            '  ls       list fake files',
            '  whoami   print the fake user',
            '  uname    print fake system info',
            '  demo     stream a colorful demo block',
            '  clear    clear the screen',
            '  exit     close the session',
            '',
          ].join('\r\n'),
        );
        break;
      case 'ls':
        this.emit(FILES.join('\r\n') + '\r\n');
        break;
      case 'whoami':
        this.emit('cozy\r\n');
        break;
      case 'uname':
        this.emit('CozyPad-Mock 1.0 x86_64 (no real host)\r\n');
        break;
      case 'pwd':
        this.emit('/home/cozy\r\n');
        break;
      case 'nvidia-smi':
        this.emit(
          [
            '+-----------------------------------------------------------------------------+',
            '| NVIDIA-SMI 555.42 (mock)      Driver Version: 555.42      CUDA Version: 12.5 |',
            '|-------------------------------+----------------------+----------------------|',
            '|   0  RTX 4090            On   | 00000000:01:00.0 Off |  36%   61C   18432MiB |',
            '|   1  RTX 4090            On   | 00000000:02:00.0 Off |  34%   58C   18201MiB |',
            '+-----------------------------------------------------------------------------+',
            '',
          ].join('\r\n'),
        );
        break;
      case 'git status':
        this.emit(
          [
            'On branch main',
            'Changes not staged for commit:',
            '  [31mmodified:   src/train.py[0m',
            '',
          ].join('\r\n'),
        );
        break;
      case 'demo': {
        const rows: string[] = [];
        for (let i = 0; i < 24; i++) {
          let row = '';
          for (let j = 0; j < 48; j++) {
            row += `\u001b[48;5;${16 + ((i * 6 + j) % 216)}m `;
          }
          rows.push(row + '\u001b[0m');
        }
        rows.push('\u001b[1m256-color demo — the PTY stream is alive.\u001b[0m');
        this.emit(rows.join('\r\n') + '\r\n');
        break;
      }
      case 'clear':
        this.emit('\u001b[2J\u001b[H');
        break;
      case 'exit':
        this.emit('logout\r\n');
        this.closed = true;
        this.events.onClose?.({ exitCode: 0 });
        break;
      default:
        this.emit(`mock: command not found: ${input}\r\n`);
    }
  }

  private emit(text: string): void {
    this.events.onData(encoder.encode(text));
  }
}

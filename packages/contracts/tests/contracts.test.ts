import { describe, expect, it } from 'vitest';
import {
  ConnectRequestSchema,
  ConnectionProfileDraftSchema,
  ConnectionProfileSchema,
  ConnectionStateChangedSchema,
  SaveDownloadRequestSchema,
  TerminalInputSchema,
  TerminalOpenRequestSchema,
  TerminalResizeRequestSchema,
  base64ToBytes,
  base64ToText,
  bytesToBase64,
  textToBase64,
} from '../src/index';

describe('ConnectionProfileSchema', () => {
  it('accepts a valid profile and applies the default port', () => {
    const parsed = ConnectionProfileSchema.parse({
      id: 'p1',
      name: 'Lab GPU box',
      host: '192.168.1.10',
      username: 'ycchao',
    });
    expect(parsed.port).toBe(22);
    expect(parsed.authMethod).toBe('password');
  });

  it('accepts private-key authentication without returning key material', () => {
    const parsed = ConnectionProfileDraftSchema.parse({
      name: 'Key host',
      host: 'example.test',
      username: 'cozy',
      authMethod: 'privateKey',
      privateKey: 'test-key-material',
      passphrase: 'test-passphrase',
      rememberCredential: true,
    });
    expect(parsed.authMethod).toBe('privateKey');
    expect(parsed.rememberCredential).toBe(true);
  });

  it('normalizes the legacy rememberPassword input', () => {
    const parsed = ConnectionProfileDraftSchema.parse({
      name: 'Legacy host',
      host: 'example.test',
      username: 'cozy',
      password: 'test-only',
      rememberPassword: true,
    });
    expect(parsed.authMethod).toBe('password');
    expect(parsed.rememberCredential).toBe(true);
    expect('rememberPassword' in parsed).toBe(false);
  });

  it('rejects out-of-range ports', () => {
    expect(() =>
      ConnectionProfileSchema.parse({
        id: 'p1',
        name: 'x',
        host: 'h',
        port: 70000,
        username: 'u',
      }),
    ).toThrow();
  });

  it('rejects empty ids', () => {
    expect(() =>
      ConnectionProfileSchema.parse({ id: '', name: 'x', host: 'h', username: 'u' }),
    ).toThrow();
  });
});

describe('terminal schemas', () => {
  it('accepts a valid open request', () => {
    expect(
      TerminalOpenRequestSchema.parse({ profileId: 'p1', cols: 120, rows: 30 }),
    ).toEqual({ profileId: 'p1', cols: 120, rows: 30 });
  });

  it('rejects non-integer dimensions', () => {
    expect(() =>
      TerminalOpenRequestSchema.parse({ profileId: 'p1', cols: 80.5, rows: 24 }),
    ).toThrow();
  });

  it('rejects zero-sized resize', () => {
    expect(() =>
      TerminalResizeRequestSchema.parse({ terminalId: 't1', cols: 0, rows: 24 }),
    ).toThrow();
  });

  it('rejects terminal input without an id', () => {
    expect(() => TerminalInputSchema.parse({ dataBase64: 'aGk=' })).toThrow();
  });
});

describe('connection events', () => {
  it('accepts every declared state', () => {
    for (const state of ['disconnected', 'connecting', 'connected', 'error']) {
      expect(
        ConnectionStateChangedSchema.parse({ profileId: 'p1', state }).state,
      ).toBe(state);
    }
  });

  it('rejects unknown states', () => {
    expect(() =>
      ConnectionStateChangedSchema.parse({ profileId: 'p1', state: 'zombie' }),
    ).toThrow();
  });

  it('rejects a connect request without profileId', () => {
    expect(() => ConnectRequestSchema.parse({})).toThrow();
  });
});

describe('download schemas', () => {
  it('preserves a safe filename and explicit MIME type', () => {
    expect(
      SaveDownloadRequestSchema.parse({
        fileName: 'weights.final.bin',
        dataBase64: 'AAE=',
        mimeType: 'application/octet-stream',
      }),
    ).toEqual({
      fileName: 'weights.final.bin',
      dataBase64: 'AAE=',
      mimeType: 'application/octet-stream',
    });
  });

  it('rejects path traversal and control characters in download filenames', () => {
    for (const fileName of ['../secret', 'folder/file.txt', 'bad\nname.txt']) {
      expect(() =>
        SaveDownloadRequestSchema.parse({
          fileName,
          dataBase64: '',
          mimeType: 'application/octet-stream',
        }),
      ).toThrow();
    }
  });
});

describe('base64 encoding helpers', () => {
  it('round-trips arbitrary binary bytes', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips CJK text and emoji', () => {
    const text = '繁體中文輸入測試 🍠🛋️ done';
    expect(base64ToText(textToBase64(text))).toBe(text);
  });

  it('round-trips ANSI escape sequences byte-exactly', () => {
    const ansi = '[38;5;208mCozyPad[0m\r\n';
    expect(base64ToText(textToBase64(ansi))).toBe(ansi);
  });
});

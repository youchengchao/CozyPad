interface BufferLike {
  toString(encoding: string): string;
  readonly length: number;
  [index: number]: number;
}

interface BufferCtorLike {
  from(data: Uint8Array | string, encoding?: string): BufferLike;
}

function nodeBuffer(): BufferCtorLike | undefined {
  return (globalThis as { Buffer?: BufferCtorLike }).Buffer;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const BufferCtor = nodeBuffer();
  if (BufferCtor) return BufferCtor.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const BufferCtor = nodeBuffer();
  if (BufferCtor) return new Uint8Array(BufferCtor.from(base64, 'base64'));
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64ToText(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

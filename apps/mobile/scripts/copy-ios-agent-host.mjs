import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(
  new URL('../../desktop/dist/remote-agent-host.cjs', import.meta.url),
);
const destination = fileURLToPath(
  new URL(
    '../../../packages/capacitor-ios-native/Sources/CozypadCapacitorIosNative/Resources/remote-agent-host.cjs',
    import.meta.url,
  ),
);

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);

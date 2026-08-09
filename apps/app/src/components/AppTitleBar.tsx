import type {
  ApplicationMenuId,
  PlatformBridge,
} from '@cozypad/contracts';
import cozyPadLogo from '../assets/cozypad-logo.png';

const APPLICATION_MENUS: ReadonlyArray<{
  id: ApplicationMenuId;
  label: string;
}> = [
  { id: 'file', label: 'File' },
  { id: 'edit', label: 'Edit' },
  { id: 'view', label: 'View' },
  { id: 'window', label: 'Window' },
];

export interface AppTitleBarProps {
  bridge: PlatformBridge;
}

export function AppTitleBar({ bridge }: AppTitleBarProps) {
  if (bridge.showApplicationMenu === undefined) return null;

  return (
    <header className="app-titlebar">
      <img
        className="app-titlebar-logo"
        src={cozyPadLogo}
        alt="CozyPad"
        draggable={false}
      />
      <nav className="app-titlebar-menu" aria-label="Application menu">
        {APPLICATION_MENUS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-haspopup="menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              bridge.showApplicationMenu?.({
                menu: id,
                x: rect.left,
                y: rect.bottom,
              });
            }}
          >
            {label}
          </button>
        ))}
      </nav>
    </header>
  );
}

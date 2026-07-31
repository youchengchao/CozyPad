import { describe, expect, it } from 'vitest';
import { buildFileBreadcrumbs, directoryItems } from '../src/workspaces/fileNavigation';

describe('file navigation', () => {
  it('switches the visible column to the active directory listing', () => {
    const cache = {
      '/home/cozy': ['projects', 'notes.md'],
      '/home/cozy/projects': ['CozyPad', 'Graphify'],
    };

    expect(directoryItems(cache, '/home/cozy')).toEqual(['projects', 'notes.md']);
    expect(directoryItems(cache, '/home/cozy/projects')).toEqual(['CozyPad', 'Graphify']);
  });

  it('builds clickable paths from the current directory', () => {
    expect(buildFileBreadcrumbs('/home/cozy/projects')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'cozy', path: '/home/cozy' },
      { label: 'projects', path: '/home/cozy/projects' },
    ]);
    expect(buildFileBreadcrumbs('/')).toEqual([{ label: '/', path: '/' }]);
  });
});

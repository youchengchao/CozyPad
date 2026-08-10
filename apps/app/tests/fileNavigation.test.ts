import { describe, expect, it } from 'vitest';
import {
  buildFileBreadcrumbs,
  directoryItems,
  filePathsEqual,
  isFileSystemRoot,
  normalizeFilePath,
  parentFilePath,
  parseFileLocation,
} from '../src/workspaces/fileNavigation';

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

  it('separates source line suffixes from file paths', () => {
    expect(parseFileLocation('D:/CozyPad/package.json:1')).toEqual({
      path: 'D:/CozyPad/package.json',
      line: 1,
    });
    expect(parseFileLocation('/home/cozy/app.ts:12:4')).toEqual({
      path: '/home/cozy/app.ts',
      line: 12,
    });
    expect(parseFileLocation('src/app.tsx#L27')).toEqual({
      path: 'src/app.tsx',
      line: 27,
    });
    expect(parseFileLocation('D:/CozyPad/package.json')).toEqual({
      path: 'D:/CozyPad/package.json',
    });
  });

  it('normalizes local paths for directory cache keys', () => {
    expect(normalizeFilePath('D:\\CozyPad\\apps\\')).toBe('D:/CozyPad/apps');
    expect(filePathsEqual('D:\\CozyPad\\Package.json', 'd:/cozypad/package.json')).toBe(true);
    expect(filePathsEqual('/home/cozy/App.ts', '/home/cozy/app.ts')).toBe(false);
  });

  it('moves to the actual parent without escaping a filesystem root', () => {
    expect(parentFilePath('D:\\CozyPad\\apps')).toBe('D:/CozyPad');
    expect(parentFilePath('D:/CozyPad')).toBe('D:/');
    expect(parentFilePath('D:/')).toBe('D:/');
    expect(parentFilePath('/home/cozy')).toBe('/home');
    expect(parentFilePath('/')).toBe('/');
    expect(isFileSystemRoot('D:\\')).toBe(true);
    expect(isFileSystemRoot('/')).toBe(true);
  });
});

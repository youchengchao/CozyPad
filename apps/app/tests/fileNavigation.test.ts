import { describe, expect, it } from 'vitest';
import {
  buildFileBreadcrumbs,
  directoryItems,
  filePathsEqual,
  isFileSystemRoot,
  normalizeFilePath,
  parentFilePath,
  parseFileLocation,
  resolveFileLinkTarget,
  resolveFileReference,
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
    expect(buildFileBreadcrumbs('D:\\CozyPad\\apps')).toEqual([
      { label: 'D:', path: 'D:/' },
      { label: 'CozyPad', path: 'D:/CozyPad' },
      { label: 'apps', path: 'D:/CozyPad/apps' },
    ]);
    expect(buildFileBreadcrumbs('\\\\server\\share\\folder')).toEqual([
      { label: '//server/share', path: '//server/share' },
      { label: 'folder', path: '//server/share/folder' },
    ]);
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
    expect(normalizeFilePath('\\\\server\\share\\folder\\')).toBe(
      '//server/share/folder',
    );
    expect(filePathsEqual('D:\\CozyPad\\Package.json', 'd:/cozypad/package.json')).toBe(true);
    expect(filePathsEqual('\\\\SERVER\\Share\\Note.txt', '//server/share/note.txt')).toBe(
      true,
    );
    expect(filePathsEqual('/home/cozy/App.ts', '/home/cozy/app.ts')).toBe(false);
  });

  it('moves to the actual parent without escaping a filesystem root', () => {
    expect(parentFilePath('D:\\CozyPad\\apps')).toBe('D:/CozyPad');
    expect(parentFilePath('D:/CozyPad')).toBe('D:/');
    expect(parentFilePath('D:/')).toBe('D:/');
    expect(parentFilePath('/home/cozy')).toBe('/home');
    expect(parentFilePath('/')).toBe('/');
    expect(parentFilePath('\\\\server\\share\\folder')).toBe('//server/share');
    expect(parentFilePath('//server/share')).toBe('//server/share');
    expect(isFileSystemRoot('D:\\')).toBe(true);
    expect(isFileSystemRoot('/')).toBe(true);
    expect(isFileSystemRoot('\\\\server\\share')).toBe(true);
  });

  it('keeps absolute Windows and POSIX symlink targets absolute', () => {
    expect(
      resolveFileLinkTarget(
        'C:/Users/ycchao/My Documents',
        'C:\\Users\\ycchao\\Documents',
      ),
    ).toBe('C:/Users/ycchao/Documents');
    expect(
      resolveFileLinkTarget('/home/ycchao/cozy', '/home/ycchao/.cozypad'),
    ).toBe('/home/ycchao/.cozypad');
    expect(resolveFileLinkTarget('/home/ycchao/link', '../shared')).toBe('/home/shared');
  });

  it('preserves the host root when resolving file URLs from agent replies', () => {
    expect(resolveFileReference('file:///home/ycchao/.cozypad/session.json:91')).toEqual({
      path: '/home/ycchao/.cozypad/session.json',
      line: 91,
    });
    expect(resolveFileReference('file:///C:/Users/ycchao/My%20Documents/note.txt')).toEqual({
      path: 'C:/Users/ycchao/My Documents/note.txt',
    });
    expect(resolveFileReference('file://server/share/folder/note.txt#L8')).toEqual({
      path: '//server/share/folder/note.txt',
      line: 8,
    });
  });

  it('resolves agent-relative links against the session cwd on either host OS', () => {
    expect(resolveFileReference('src/../package.json#L4', '/home/ycchao/CozyPad')).toEqual({
      path: '/home/ycchao/CozyPad/package.json',
      line: 4,
    });
    expect(resolveFileReference('/d/CozyPad/package.json', 'D:/CozyPad')).toEqual({
      path: 'D:/CozyPad/package.json',
    });
    expect(resolveFileReference('src/app.ts', undefined)).toBeNull();
    expect(resolveFileReference('../../outside.txt', '//server/share/folder')).toEqual({
      path: '//server/share/outside.txt',
    });
  });
});

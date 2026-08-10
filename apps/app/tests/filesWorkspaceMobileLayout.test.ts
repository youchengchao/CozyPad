import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('FilesWorkspace mobile layout', () => {
  it('switches between a full-height file tree and a full file preview', () => {
    const workspace = readFileSync(
      resolve(__dirname, '../src/workspaces/FilesWorkspace.tsx'),
      'utf-8',
    );
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf-8');

    expect(workspace).toContain("useState<'tree' | 'preview'>('tree')");
    expect(workspace).toContain('files-workspace mobile-pane-${mobilePane}');
    expect(workspace).toContain("setMobilePane('preview')");
    expect(workspace).toContain("setMobilePane('tree')");
    expect(workspace).toContain('const closeFile = () =>');
    expect(workspace).toContain('aria-label="Close file and return to file list"');

    expect(css).toContain('.files-workspace.mobile-pane-tree .files-tree');
    expect(css).toContain('.files-workspace.mobile-pane-tree .files-preview');
    expect(css).toContain('.files-workspace.mobile-pane-preview .files-tree');
    expect(css).toContain('.files-workspace.mobile-pane-preview .files-preview');
    expect(css).toContain('.mobile-file-close');
  });
});

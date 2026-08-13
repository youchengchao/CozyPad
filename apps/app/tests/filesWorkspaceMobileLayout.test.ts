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
    expect(workspace).toContain('aria-label="Return to file list"');
    expect(workspace).toContain('onClick={() => setMobilePane(\'tree\')}');

    expect(css).toContain('.files-workspace.mobile-pane-tree .files-tree');
    expect(css).toContain('.files-workspace.mobile-pane-tree .files-preview');
    expect(css).toContain('.files-workspace.mobile-pane-preview .files-tree');
    expect(css).toContain('.files-workspace.mobile-pane-preview .files-preview');
    expect(css).toContain('.mobile-file-close');
    expect(css).toContain(
      '@media (max-width: 480px), (hover: none) and (pointer: coarse)',
    );
    expect(css).toContain(
      '@media (max-width: 820px), (hover: none) and (pointer: coarse)',
    );
  });

  it('keeps open files in tabs and offers list or grid browsing', () => {
    const workspace = readFileSync(
      resolve(__dirname, '../src/workspaces/FilesWorkspace.tsx'),
      'utf-8',
    );

    expect(workspace).toContain('role="tablist" aria-label="Open files"');
    expect(workspace).toContain('closeFile(tab.item.path)');
    expect(workspace).toContain("useState<'list' | 'grid'>('list')");
    expect(workspace).toContain('aria-label="List view"');
    expect(workspace).toContain('aria-label="Grid view"');
  });

  it('provides a persisted, adaptive drag handle for the desktop file sidebar', () => {
    const workspace = readFileSync(
      resolve(__dirname, '../src/workspaces/FilesWorkspace.tsx'),
      'utf-8',
    );
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf-8');

    expect(workspace).toContain("'cozypad-files-sidebar-width'");
    expect(workspace).toContain('className="pane-resize-handle files-resize-handle"');
    expect(workspace).toContain('onPointerDown={onResizePointerDown}');
    expect(workspace).toContain('onPointerMove={onResizePointerMove}');
    expect(workspace).toContain('onPointerUp={onResizePointerUp}');
    expect(workspace).toContain('ref={workspaceRef}');
    expect(workspace).toContain('style={{ width: displayedSidebarWidth }}');
    expect(css).toContain('width: auto !important;');
    expect(css).toContain('width: 100% !important;');
  });
  it('uses a full-width browser until a file opens and supports collapsing the desktop sidebar', () => {
    const workspace = readFileSync(
      resolve(__dirname, '../src/workspaces/FilesWorkspace.tsx'),
      'utf-8',
    );
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf-8');

    expect(workspace).toContain("bridge.kind === 'capacitor'");
    expect(workspace).toContain("' files-browser-only'");
    expect(workspace).toContain("' files-has-open-files'");
    expect(workspace).toContain('aria-label="Collapse file sidebar"');
    expect(workspace).toContain('aria-label="Show file sidebar"');

    expect(css).toContain('.files-browser-only > .files-tree');
    expect(css).toContain('.files-browser-only > .files-preview');
    expect(css).toContain('.files-has-open-files.files-sidebar-collapsed > .files-tree');
    expect(css).toContain('.files-workspace.native-mobile.mobile-pane-tree > .files-tree');
    expect(css).toContain('.files-workspace.native-mobile.mobile-pane-preview > .files-preview');
  });

  it('moves native-mobile file actions into an overlay menu without consuming list height', () => {
    const workspace = readFileSync(
      resolve(__dirname, '../src/workspaces/FilesWorkspace.tsx'),
      'utf-8',
    );
    const css = readFileSync(resolve(__dirname, '../src/styles.css'), 'utf-8');

    expect(workspace).toContain('className="files-mobile-menu"');
    expect(workspace).toContain('aria-label="File browser menu"');
    expect(workspace).toContain('aria-label="Enter file path"');
    expect(workspace).toContain("openCreateDialog('new-file')");
    expect(workspace).toContain("openCreateDialog('new-folder')");
    expect(workspace).toContain('onClick={openPathDialog}');

    expect(css).toContain('.files-workspace.native-mobile .files-roots,');
    expect(css).toContain('.files-workspace.native-mobile .files-mobile-menu');
    expect(css).toContain('.files-mobile-menu-panel');
    expect(css).toContain('position: absolute;');
  });

});

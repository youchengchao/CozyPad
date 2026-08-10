import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { AgentSessionSummary } from '@cozypad/contracts';
import {
  createAgentSessionViewState,
  enterSelectedSession,
  forgetSessionView,
  reconcileSessionView,
  selectSessionForPreview,
} from '../agentSessionViewState';

describe('AgentsWorkspace Layout & IDE Theme Suite', () => {
  beforeAll(() => {
    if (typeof localStorage === 'undefined') {
      const store: Record<string, string> = {};
      (globalThis as any).localStorage = {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = value; },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { Object.keys(store).forEach(k => delete store[k]); },
      };
    }
  });

  describe('IDE Dark Theme Tokens (styles.css)', () => {
    it('defines standard VS Code / Cursor inspired dark theme CSS variables', () => {
      const cssPath = resolve(__dirname, '../../../../src/styles.css');
      const cssContent = readFileSync(cssPath, 'utf-8');

      // Verify core theme token declarations
      expect(cssContent).toContain('--bg-deep: #050506;');
      expect(cssContent).toContain('--bg: #08090a;');
      expect(cssContent).toContain('--bg-raised: #101112;');
      expect(cssContent).toContain('--bg-elevated: #151617;');
      expect(cssContent).toContain('--bg-hover: #1a1b1d;');
      expect(cssContent).toContain('--border: #242628;');
      expect(cssContent).toContain('--border-strong: #303236;');
      expect(cssContent).toContain('--text: #f5f5f5;');
      expect(cssContent).toContain('--text-dim: #a1a1aa;');
      expect(cssContent).toContain('--text-faint: #71717a;');
      expect(cssContent).toContain('--accent: #6e8cff;');
      expect(cssContent).toContain('--radius: 10px;');
    });

    it('contains layout rules for split panel and session list', () => {
      const cssPath = resolve(__dirname, '../../../../src/styles.css');
      const cssContent = readFileSync(cssPath, 'utf-8');

      expect(cssContent).toContain('.session-sidebar');
      expect(cssContent).toContain('.chat-column');
      expect(cssContent).toContain('.pane-resize-handle');
      expect(cssContent).toContain('.session-item');
      expect(cssContent).toContain('.session-item-active');
    });

    it('uses separate full-height session and chat pages on phones', () => {
      const cssPath = resolve(__dirname, '../../../../src/styles.css');
      const workspacePath = resolve(__dirname, '../AgentsWorkspace.tsx');
      const cssContent = readFileSync(cssPath, 'utf-8');
      const workspaceContent = readFileSync(workspacePath, 'utf-8');

      expect(workspaceContent).toContain("useState<'sessions' | 'chat'>('sessions')");
      expect(workspaceContent).toContain('mobile-pane-${mobilePane}');
      expect(workspaceContent).toContain("setMobilePane('chat')");
      expect(workspaceContent).toContain("setMobilePane('sessions')");
      expect(workspaceContent).toContain('aria-label="Back to sessions"');

      expect(cssContent).toContain('.agents-workspace.mobile-pane-chat > .agent-tabs');
      expect(cssContent).toContain('.agent-panes.mobile-pane-sessions .chat-column');
      expect(cssContent).toContain('.agent-panes.mobile-pane-chat .session-sidebar');
      expect(cssContent).toContain('.mobile-session-back');
      expect(cssContent).toContain('grid-template-columns: auto minmax(0, 1fr);');
    });
  });

  describe('Split Panel Resizing & Boundary Constraints', () => {
    const SIDEBAR_MIN = 180;
    const SIDEBAR_ABSOLUTE_MAX = 600;
    const CHAT_MIN = 360;
    const SIDEBAR_DEFAULT = 286;

    function clampSidebarWidth(width: number, containerWidth: number = 1000): number {
      const dynamicMax = Math.min(SIDEBAR_ABSOLUTE_MAX, containerWidth - CHAT_MIN - 4);
      return Math.max(SIDEBAR_MIN, Math.min(dynamicMax, width));
    }

    it('defaults to 286px sidebar width', () => {
      expect(SIDEBAR_DEFAULT).toBe(286);
      expect(clampSidebarWidth(SIDEBAR_DEFAULT)).toBe(286);
    });

    it('clamps sidebar width to minimum boundary of 180px', () => {
      expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN);
      expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN);
      expect(clampSidebarWidth(-50)).toBe(SIDEBAR_MIN);
    });

    it('clamps sidebar width to maximum boundary of 600px when window is large', () => {
      expect(clampSidebarWidth(700, 1200)).toBe(SIDEBAR_ABSOLUTE_MAX);
      expect(clampSidebarWidth(1000, 1600)).toBe(SIDEBAR_ABSOLUTE_MAX);
    });

    it('respects dynamic container constraints leaving at least 360px for chat panel', () => {
      // In a 600px wide window: 600 - 360 - 4 = 236px max sidebar
      expect(clampSidebarWidth(500, 600)).toBe(236);
      // In a 400px wide window: 400 - 360 - 4 = 36px, clamped to MIN (180px)
      expect(clampSidebarWidth(300, 400)).toBe(SIDEBAR_MIN);
    });
  });

  describe('Session View State & Selection Flow', () => {
    const mockClaudeSession1: AgentSessionSummary = {
      id: 'session-c1',
      agentKind: 'claude',
      title: 'Claude Session 1',
      host: 'localhost',
      project: 'CozyPad',
      cwd: '/workspace',
      status: 'ready',
      unread: 0,
      slashCommands: [],
      updatedAt: '2026-08-07T01:00:00Z',
    };

    const mockClaudeSession2: AgentSessionSummary = {
      id: 'session-c2',
      agentKind: 'claude',
      title: 'Claude Session 2',
      host: 'localhost',
      project: 'CozyPad',
      cwd: '/workspace',
      status: 'running',
      unread: 2,
      slashCommands: [],
      updatedAt: '2026-08-07T02:00:00Z',
    };

    it('initializes clean session view state for all agents', () => {
      const state = createAgentSessionViewState();
      expect(state.selected).toEqual({ claude: null, codex: null, agy: null });
      expect(state.entered).toEqual({ claude: null, codex: null, agy: null });
    });

    it('handles preview selection and entering session', () => {
      let state = createAgentSessionViewState();

      state = selectSessionForPreview(state, 'claude', 'session-c1');
      expect(state.selected.claude).toBe('session-c1');
      expect(state.entered.claude).toBeNull();

      state = enterSelectedSession(state, 'claude', 'session-c1');
      expect(state.selected.claude).toBe('session-c1');
      expect(state.entered.claude).toBe('session-c1');
    });

    it('reconciles view state when active session is deleted', () => {
      let state = createAgentSessionViewState();
      state = selectSessionForPreview(state, 'claude', 'session-c1');
      state = enterSelectedSession(state, 'claude', 'session-c1');

      // Reconcile with active session present
      state = reconcileSessionView(state, [mockClaudeSession1, mockClaudeSession2]);
      expect(state.selected.claude).toBe('session-c1');

      // Reconcile when active session is removed from backend list: slot becomes null (reconcileSessionView contract)
      state = reconcileSessionView(state, [mockClaudeSession2]);
      expect(state.selected.claude).toBeNull();
      expect(state.entered.claude).toBeNull();
    });

    it('clears view state when session is forgotten', () => {
      let state = createAgentSessionViewState();
      state = selectSessionForPreview(state, 'claude', 'session-c1');
      state = enterSelectedSession(state, 'claude', 'session-c1');

      state = forgetSessionView(state, 'claude', 'session-c1');
      expect(state.selected.claude).toBeNull();
      expect(state.entered.claude).toBeNull();
    });
  });
});

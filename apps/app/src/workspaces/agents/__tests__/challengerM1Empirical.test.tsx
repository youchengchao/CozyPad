import { describe, expect, it } from 'vitest';
import type { AgentSessionSummary } from '@cozypad/contracts';

describe('Challenger 1 M1 Empirical Verification Suite', () => {

  describe('2. Split Panel Width Clamping Logic', () => {
    const SIDEBAR_MIN = 180;
    const SIDEBAR_ABSOLUTE_MAX = 600;
    const CHAT_MIN = 360;
    const SIDEBAR_DEFAULT = 286;

    function clampSidebarWidth(width: number, containerWidth: number = 1000): number {
      const available = containerWidth - CHAT_MIN - 4;
      const dynamicMax = Math.min(SIDEBAR_ABSOLUTE_MAX, Math.max(SIDEBAR_MIN, available));
      return Math.max(SIDEBAR_MIN, Math.min(dynamicMax, width));
    }

    it('clamps negative width (-50px) to MIN boundary (180px)', () => {
      expect(clampSidebarWidth(-50)).toBe(SIDEBAR_MIN);
    });

    it('clamps zero width (0px) to MIN boundary (180px)', () => {
      expect(clampSidebarWidth(0)).toBe(SIDEBAR_MIN);
    });

    it('clamps below-minimum width (100px) to MIN boundary (180px)', () => {
      expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN);
    });

    it('clamps above-maximum width (700px) to MAX boundary (600px) in 1200px container', () => {
      expect(clampSidebarWidth(700, 1200)).toBe(SIDEBAR_ABSOLUTE_MAX);
    });

    it('clamps extreme width (9999px) to MAX boundary (600px)', () => {
      expect(clampSidebarWidth(9999, 1600)).toBe(SIDEBAR_ABSOLUTE_MAX);
    });

    it('respects narrow dynamic container constraints (500px container)', () => {
      // 500 - 360 - 4 = 136px available. Math.max(180, 136) = 180px. dynamicMax = min(600, 180) = 180px.
      expect(clampSidebarWidth(400, 500)).toBe(180);
    });

    it('respects medium container constraints (800px container)', () => {
      // 800 - 360 - 4 = 436px available. dynamicMax = min(600, 436) = 436px.
      expect(clampSidebarWidth(500, 800)).toBe(436);
    });

    it('handles localStorage parsing safely for corrupt inputs', () => {
      function parseStoredSidebarWidth(stored: string | null): number {
        try {
          if (stored !== null) {
            const parsed = Number(stored);
            if (Number.isFinite(parsed)) return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_ABSOLUTE_MAX, parsed));
          }
        } catch { /* ignore */ }
        return SIDEBAR_DEFAULT;
      }

      expect(parseStoredSidebarWidth('invalid')).toBe(286);
      expect(parseStoredSidebarWidth('NaN')).toBe(286);
      expect(parseStoredSidebarWidth('-50')).toBe(180);
      expect(parseStoredSidebarWidth('9999')).toBe(600);
      expect(parseStoredSidebarWidth('')).toBe(180); // Number("") is 0 -> clamped to 180
      expect(parseStoredSidebarWidth(null)).toBe(286);
    });
  });

  describe('3. Search Filter Behavior & Special Characters', () => {
    const mockSessions: AgentSessionSummary[] = [
      {
        id: 's1',
        agentKind: 'claude',
        title: 'Refactor [Core] Service (v2.0)',
        host: 'localhost',
        project: 'CozyPad/App',
        cwd: '/work',
        status: 'ready',
        unread: 0,
        slashCommands: [],
        updatedAt: '2026-08-07T01:00:00Z',
      },
      {
        id: 's2',
        agentKind: 'claude',
        title: 'Fix regex: /\\d+/ in parser.ts',
        host: 'remote-srv-1',
        project: 'backend-api',
        cwd: '/work',
        status: 'running',
        unread: 1,
        slashCommands: [],
        updatedAt: '2026-08-07T02:00:00Z',
      },
      {
        id: 's3',
        agentKind: 'claude',
        title: '✦ Special Emoji & symbols $100% #1',
        host: 'dev.host.io',
        project: 'CozyPad/Core',
        cwd: '/work',
        status: 'ready',
        unread: 0,
        slashCommands: [],
        updatedAt: '2026-08-07T03:00:00Z',
      },
    ];

    function filterSessions(sessions: AgentSessionSummary[], filterText: string): AgentSessionSummary[] {
      return sessions.filter((session) =>
        filterText === ''
          ? true
          : `${session.title} ${session.host} ${session.project}`
              .toLowerCase()
              .includes(filterText.toLowerCase()),
      );
    }

    it('returns all sessions when filter query is empty string', () => {
      expect(filterSessions(mockSessions, '')).toHaveLength(3);
    });

    it('handles special characters safely without throwing regex syntax errors', () => {
      // Brackets, parens, asterisks, question marks, slashes, backslashes
      expect(() => filterSessions(mockSessions, '[Core]')).not.toThrow();
      expect(filterSessions(mockSessions, '[Core]')).toHaveLength(1);
      expect(filterSessions(mockSessions, '[Core]')[0]!.id).toBe('s1');

      expect(() => filterSessions(mockSessions, '(v2.0)')).not.toThrow();
      expect(filterSessions(mockSessions, '(v2.0)')).toHaveLength(1);

      expect(() => filterSessions(mockSessions, '*')).not.toThrow();
      expect(() => filterSessions(mockSessions, '?')).not.toThrow();
      expect(() => filterSessions(mockSessions, '+')).not.toThrow();
      expect(() => filterSessions(mockSessions, '\\d+')).not.toThrow();
      expect(filterSessions(mockSessions, '\\d+')).toHaveLength(1);
      expect(filterSessions(mockSessions, '\\d+')[0]!.id).toBe('s2');
    });

    it('handles currency and percentage symbols ($100%)', () => {
      expect(filterSessions(mockSessions, '$100%')).toHaveLength(1);
      expect(filterSessions(mockSessions, '$100%')[0]!.id).toBe('s3');
    });

    it('performs case-insensitive filtering across title, host, and project fields', () => {
      // Match by title
      expect(filterSessions(mockSessions, 'REFACTOR')).toHaveLength(1);
      // Match by host
      expect(filterSessions(mockSessions, 'REMOTE-SRV')).toHaveLength(1);
      // Match by project
      expect(filterSessions(mockSessions, 'cozypad/app')).toHaveLength(1);
    });

    it('returns empty array when query does not match any session', () => {
      expect(filterSessions(mockSessions, 'nonexistent-query-xyz')).toHaveLength(0);
    });

    it('handles unicode and emoji search terms', () => {
      expect(filterSessions(mockSessions, '✦')).toHaveLength(1);
    });
  });
});

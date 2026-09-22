import { describe, expect, it } from 'vitest';
import { buildPostStats } from '@/lib/post-stats';

const NOW = Date.parse('2026-08-04T15:00:00.000Z');

describe('buildPostStats', () => {
  it('returns an empty series when nothing was posted', () => {
    expect(buildPostStats([], NOW)).toEqual({ postCount: 0, postsOverTime: [] });
  });

  it('fills missing UTC days with zero through today and keeps a later note', () => {
    const stats = buildPostStats(
      [
        { day: '2026-08-04', postCount: 2 },
        { day: '2026-08-01', postCount: 1 },
        { day: '2026-08-06', postCount: 4 },
      ],
      NOW,
    );
    expect(stats.postCount).toBe(7);
    expect(stats.postsOverTime).toEqual([
      { day: '2026-08-01', postCount: 1 },
      { day: '2026-08-02', postCount: 0 },
      { day: '2026-08-03', postCount: 0 },
      { day: '2026-08-04', postCount: 2 },
      { day: '2026-08-05', postCount: 0 },
      { day: '2026-08-06', postCount: 4 },
    ]);
  });
});

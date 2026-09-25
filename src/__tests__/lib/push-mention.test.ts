import { describe, expect, it } from 'vitest';
import { buildForumMentionPushPayload } from '@/lib/push';

describe('buildForumMentionPushPayload', () => {
  it('localizes the mark sentence and falls back to English', () => {
    expect(buildForumMentionPushPayload({ messageId: 'm', name: 'Ada', locale: 'de' }).body).toBe(
      'Ada hat dich markiert',
    );
    expect(buildForumMentionPushPayload({ messageId: 'm', name: 'Ada', locale: 'es' }).body).toBe(
      'Ada te marcó',
    );
    expect(buildForumMentionPushPayload({ messageId: 'm', name: 'Ada', locale: 'fil' }).body).toBe(
      'Minarkahan ka ni Ada',
    );
    expect(buildForumMentionPushPayload({ messageId: 'm', name: 'Ada', locale: null }).body).toBe(
      'Ada marked you',
    );
    expect(buildForumMentionPushPayload({ messageId: 'm', name: 'Ada' }).tag).toBe(
      'forum_mention:m',
    );
  });
});

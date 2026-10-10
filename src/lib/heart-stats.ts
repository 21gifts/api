/**
 * Attach claimed-heart counts to public forum JSON.
 *
 * `serializeMessage` stays unchanged. Callers pass already serialized
 * objects and get new objects with `heartCount` and `hearted`.
 */

/**
 * Copy each message and set `heartCount` / `hearted` from one stats lookup.
 *
 * Missing stats are `heartCount` 0 and `hearted` false. Calls `statsFor`
 * once with every id in `messages`. Does not mutate the input objects.
 * Order is preserved.
 *
 * @param statsFor - `MessageStore.heartStats` or the same shape.
 * @param viewerAccountId - Session account id, or `null` when unsigned.
 * @param messages - Already serialized public messages.
 * @returns New objects with both keys set.
 */
export async function attachHeartStats<T extends { id: string }>(
  statsFor: (
    ids: readonly string[],
    viewerAccountId: string | null,
  ) => Promise<ReadonlyMap<string, { heartCount: number; hearted: boolean }>>,
  viewerAccountId: string | null,
  messages: readonly T[],
): Promise<Array<T & { heartCount: number; hearted: boolean }>> {
  const stats = await statsFor(
    messages.map((message) => message.id),
    viewerAccountId,
  );
  return messages.map((message) => {
    const row = stats.get(message.id);
    return {
      ...message,
      heartCount: row === undefined ? 0 : row.heartCount,
      hearted: row === undefined ? false : row.hearted,
    };
  });
}

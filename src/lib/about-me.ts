/**
 * About me on public and owner profile cards.
 *
 * The auto-created profile forum note stores the display name as `text`.
 * That row still exists for Nostr / PM; it is not a filled bio.
 */

/**
 * Profile-note text to expose as About me, or `null` when it is empty or
 * only the auto-generated display-name copy.
 *
 * Trims all arguments. Empty text is not a bio. When trimmed `name` is
 * non-empty and equals the trimmed text case-insensitively, the note is
 * treated as unfilled. When trimmed `storedNoteName` is non-empty and
 * equals the trimmed text case-insensitively, the note is also unfilled
 * (auto name-copy after a display-name rename).
 *
 * @param name - Account display name, or `null`.
 * @param text - Profile-note body, or `null`.
 * @param storedNoteName - `MessageRow.name` on the live profile note, or
 *   `null` when the caller has no row (two-arg unit tests).
 * @returns Trimmed bio text, or `null`.
 */
export function aboutMeFromNote(
  name: string | null,
  text: string | null,
  storedNoteName: string | null = null,
): string | null {
  const trimmedText = text === null ? '' : text.trim();
  if (trimmedText === '') {
    return null;
  }
  const trimmedName = name === null ? '' : name.trim();
  if (trimmedName !== '' && trimmedText.toLowerCase() === trimmedName.toLowerCase()) {
    return null;
  }
  const trimmedStored = storedNoteName === null ? '' : storedNoteName.trim();
  if (trimmedStored !== '' && trimmedText.toLowerCase() === trimmedStored.toLowerCase()) {
    return null;
  }
  return trimmedText;
}

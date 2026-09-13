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
 * Trims both arguments. Empty text is not a bio. When `name` is non-empty
 * after trim and the trimmed texts are equal case-insensitively, the note
 * is treated as unfilled.
 *
 * @param name - Account display name, or `null`.
 * @param text - Profile-note body, or `null`.
 * @returns Trimmed bio text, or `null`.
 */
export function aboutMeFromNote(name: string | null, text: string | null): string | null {
  const trimmedText = text === null ? '' : text.trim();
  if (trimmedText === '') {
    return null;
  }
  const trimmedName = name === null ? '' : name.trim();
  if (trimmedName !== '' && trimmedText.toLowerCase() === trimmedName.toLowerCase()) {
    return null;
  }
  return trimmedText;
}

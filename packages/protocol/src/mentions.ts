/**
 * Extracts @handles from a chat message. A mention starts at the beginning of the text or after
 * whitespace/punctuation, so e-mail addresses (a@b.com) are not mentions. Returns lowercase,
 * de-duplicated handles in order of first appearance.
 */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s(\[{,;:!?"'])@([A-Za-z][A-Za-z0-9_-]{1,31})/g;
  for (const m of body.matchAll(re)) {
    const handle = m[2]!.toLowerCase().replace(/[-_]+$/, "");
    if (handle.length >= 2 && !out.includes(handle)) out.push(handle);
  }
  return out;
}

/** Removes leading @mentions that address agents so the prompt reads naturally. */
export function stripLeadingMentions(body: string): string {
  return body.replace(/^(\s*@[A-Za-z][A-Za-z0-9_-]*[,:]?\s*)+/, "").trim();
}

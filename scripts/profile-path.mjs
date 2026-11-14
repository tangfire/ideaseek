/**
 * PATH wiring helpers for scripts/install.mjs (PACKAGING: the installer
 * may only touch the user's shell profile after explicit confirmation,
 * and only inside an idempotent marked block).
 */
import { readFileSync, writeFileSync } from 'node:fs';

export const PROFILE_MARKER = '# ideaseek install';

/** The block appended to a shell profile (marker keeps it idempotent). */
export function renderProfileBlock(binDir) {
  return `\n${PROFILE_MARKER}\nexport PATH="${binDir}:$PATH"\n`;
}

/** True when the profile already carries our block. */
export function hasProfileMarker(profileText) {
  return profileText.includes(PROFILE_MARKER);
}

/**
 * Appends the PATH block when absent; returns 'added' | 'already'.
 * Throws (caller reports) when the profile exists without our marker in
 * a shape we do not recognize — never rewrites foreign content.
 */
export function appendProfilePath(profilePath, binDir) {
  let text = '';
  try {
    text = readFileSync(profilePath, 'utf8');
  } catch {
    text = ''; // missing profile — create it with just our block
  }
  if (hasProfileMarker(text)) return 'already';
  const next = text.length > 0 && !text.endsWith('\n') ? `${text}\n` : text;
  writeFileSync(profilePath, `${next}${renderProfileBlock(binDir)}`, 'utf8');
  return 'added';
}

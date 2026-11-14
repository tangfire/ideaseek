/** Type declarations for profile-path.mjs (consumed by tests/typecheck). */
export declare const PROFILE_MARKER: string;
export declare function renderProfileBlock(binDir: string): string;
export declare function hasProfileMarker(profileText: string): boolean;
export declare function appendProfilePath(profilePath: string, binDir: string): 'added' | 'already';

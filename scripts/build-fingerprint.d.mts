/** Type declarations for build-fingerprint.mjs (imported from TS tests). */
export interface BuildFingerprint {
  inputs: string;
  outputs: string;
}

export interface BuildPlan {
  mode: 'skip' | 'incremental' | 'full';
  reason: string;
}

export declare function inputDigest(root: string): string;
export declare function outputDigest(root: string): string;
export declare function fingerprintPath(root: string): string;
export declare function readFingerprint(root: string): BuildFingerprint | null;
export declare function writeFingerprint(root: string, fingerprint: BuildFingerprint): void;
export declare function planBuild(options: {
  force?: boolean;
  fingerprint: BuildFingerprint | null;
  inputs: string;
  outputs: string;
}): BuildPlan;

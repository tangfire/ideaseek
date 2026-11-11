/**
 * Vendored ARIS skill manifest (docs/ARIS_INTEGRATION_PLAN.md, ADR-008/009).
 * The P0 capabilities must not depend on the upstream repo being installed,
 * so the skill files live under aris-skills/ with their MIT license and a
 * pinned source commit. Every file's SHA-256 is recorded here; loading
 * verifies integrity and refuses a tampered or stale file.
 */

export const ARIS_SOURCE = {
  repository: 'https://github.com/wanshuiyin/Auto-claude-code-research-in-sleep',
  commit: '8f493923f28c3f991dcca1287db97aa780d0969b',
  license: 'MIT',
  copyright: 'Copyright (c) 2026 wanshuiyin',
  vendoredAt: '2026-11-11',
} as const;

/** P0 skills vendored for the six Phase 4.5 capability migrations. */
export const VENDORED_SKILLS: readonly string[] = [
  'ablation-planner',
  'analyze-results',
  'auto-review-loop',
  'experiment-audit',
  'experiment-bridge',
  'experiment-plan',
  'idea-creator',
  'idea-discovery',
  'integrity-forensics',
  'novelty-check',
  'prior-art-search',
];

export interface VendoredFile {
  /** Path relative to the aris-skills root, posix separators. */
  path: string;
  sha256: string;
}

/** SHA-256 of every vendored content file (LICENSE/NOTICE excluded). */
export const VENDORED_FILES: readonly VendoredFile[] = [
  {
    path: 'shared-references/acceptance-gate.md',
    sha256: 'acfe2e790d97445396ff4eb605b91e4de756082d617b89cf9278bff76dc25623',
  },
  {
    path: 'shared-references/citation-discipline.md',
    sha256: '01fc1cf751d7e0e6bef04897df6ef1bcf1e1b20e5b56d9f208e020cc48ba6725',
  },
  {
    path: 'shared-references/compute-env-contract.md',
    sha256: '285f908370e0a1a2cd29525e7c401cebc7237a1cd92b75da6dc417184139c4f3',
  },
  {
    path: 'shared-references/experiment-integrity.md',
    sha256: '22150fbdc5867e7790c88f968bccb367079c2db4c190ddce980709aea7e76f60',
  },
  {
    path: 'shared-references/external-cadence.md',
    sha256: 'd0d8e92c9c8f5e60555c8ddf32cf15c78d0bdc61a367ef35d8b0fef8dab906f3',
  },
  {
    path: 'shared-references/fan-out-pattern.md',
    sha256: 'e7322641c88b77e62d9cc2848cea0e99600492744fe65453d51abbb099255068',
  },
  {
    path: 'shared-references/injection-hygiene.md',
    sha256: '80295bfe5d6389890464529b41d47cb1a9ffb4d571b558b6226ef39ace9f0440',
  },
  {
    path: 'shared-references/integration-contract.md',
    sha256: '2a182e6ab3cd8e035b92874bcd8173b421ed6d403b280b3df3a49fa5d488e0f3',
  },
  {
    path: 'shared-references/output-composition.md',
    sha256: '8de81708431091a21a641be5f91db7958bb9f9a4b85d4fe03f52c5b496948651',
  },
  {
    path: 'shared-references/output-language.md',
    sha256: '7b326400dca5130ce4beedf72fc2010680afe96eb56a6ab21210d323adc9a52e',
  },
  {
    path: 'shared-references/output-manifest.md',
    sha256: '28e29bc8e53c52afe4eeeb590df8893282a3bbced08e105e154ad228b6cd1922',
  },
  {
    path: 'shared-references/output-versioning.md',
    sha256: '73a4269b537be728b0ecc35789f11fa6d1fafa6d0430d07ad2738f064b1e4da3',
  },
  {
    path: 'shared-references/prior-art-databases.md',
    sha256: '8225843987fbabb5f11788c19ed8a739f10691319865485d5cb876e7bc2a3cb7',
  },
  {
    path: 'shared-references/review-tracing.md',
    sha256: 'fcf521283ee275708ca6f1a34ad836ca7e9c913f69e49fdd735a13d6f3ad964d',
  },
  {
    path: 'shared-references/reviewer-backends.md',
    sha256: 'e0aea16315faaec6ea468272aed7bf9d4a1b1d5261302a8ba357a9dce7bd9c33',
  },
  {
    path: 'shared-references/reviewer-independence.md',
    sha256: 'fbbfcb6e7ff53010b596e8e01ce456d1906734f5bd198745f76ccd62787af3e3',
  },
  {
    path: 'shared-references/reviewer-routing.md',
    sha256: '9668f548d6ed5ecbbf3d9f350e370dfc6623ad0567e9e7050ccc01b69d3b29d1',
  },
  {
    path: 'skills/ablation-planner/SKILL.md',
    sha256: 'ce51bfff265e5f0a6e8fd03333bfa8dee679e728e0d325830988ca5bd31307da',
  },
  {
    path: 'skills/analyze-results/SKILL.md',
    sha256: '2b97b8ae1a279ac8a7db14e7d7bea67934c88352d55c95e20fcfb681a8640930',
  },
  {
    path: 'skills/auto-review-loop/SKILL.md',
    sha256: '2a553de8f498aa8224b0bc941a3c4c4dba351d5c61ebf48beaecb6a24aaa4a60',
  },
  {
    path: 'skills/experiment-audit/SKILL.md',
    sha256: '6a8b6817a30e1bef03ad2bd679155ce39c2b0977bca38874485f7f5c1fd2567c',
  },
  {
    path: 'skills/experiment-bridge/SKILL.md',
    sha256: '8afba310ad8a381b3cecfa4549780af30e1cbebaca37c45338ea3232bf188856',
  },
  {
    path: 'skills/experiment-plan/SKILL.md',
    sha256: 'c5b53692ff95b0b55e80702e33afc79d9fe8d4f55a69e2a39714013f97ac595e',
  },
  {
    path: 'skills/idea-creator/SKILL.md',
    sha256: '4752ae46d1a67c181838f0dbe15812e36d384751b1e5c9e3d7b8abb608cb58b2',
  },
  {
    path: 'skills/idea-discovery/SKILL.md',
    sha256: '3ff798ce7c0f501eea9daf1cdee79ad4b02a506a107685103ce8ea349b8c0a80',
  },
  {
    path: 'skills/integrity-forensics/SKILL.md',
    sha256: '33cdf3f4fd2a8dea073a73e2cba870576c576b1d201efa3d0a4bde2e7e7256ed',
  },
  {
    path: 'skills/novelty-check/SKILL.md',
    sha256: 'a1f257297405c9948f570d51672f50b0176177001e74118c926b149c9ccb9af4',
  },
  {
    path: 'skills/prior-art-search/SKILL.md',
    sha256: '8793fb26c522de4c44a64b68df81e5d12718a99866c639658261cea680bd58b2',
  },
];

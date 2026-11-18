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

/** Vendored skills for the Phase 4.5 capability migrations (P0 + P1 wiki). */
export const VENDORED_SKILLS: readonly string[] = [
  'ablation-planner',
  'analyze-results',
  'auto-review-loop',
  'citation-crosscheck',
  'experiment-audit',
  'experiment-bridge',
  'experiment-plan',
  'figure-spec',
  'idea-creator',
  'idea-discovery',
  'integrity-forensics',
  'monitor-experiment',
  'novelty-check',
  'overleaf-sync',
  'paper-claim-audit',
  'paper-compile',
  'paper-figure',
  'paper-plan',
  'paper-slides',
  'paper-talk',
  'paper-write',
  'prior-art-search',
  'rebuttal',
  'render-html',
  'result-to-claim',
  'research-wiki',
];

export interface VendoredFile {
  /** Path relative to the aris-skills root, posix separators. */
  path: string;
  sha256: string;
}

/** SHA-256 of every vendored content file (LICENSE/NOTICE excluded). */
export const VENDORED_FILES: readonly VendoredFile[] = [
  // >>> aris-vendor:begin
  // Entries between these sentinels are managed by `node scripts/aris-vendor.mjs
  // --apply`, which copies from an ARIS checkout at a clean commit and hashes
  // what it copied. Anything OUTSIDE them is hand-maintained history; the
  // tool refuses to run when the markers are missing rather than splicing a
  // table by regex, which is how a hash gets quietly lost.
  // >>> BEGIN-REGISTERED-ENTRIES
  {
    path: 'skills/figure-spec/scripts/figure_renderer.py',
    sha256: '02b4e01e46b51aeca12722ddd7b21bb7da3c3b175bba5d129c45d671fb07a0bc',
  },
  {
    path: 'skills/figure-spec/SKILL.md',
    sha256: 'f5b4b8e806a0131b3aef787a7bbfbb395cdfb814a56d3acf2f454bfa4289ee49',
  },
  {
    path: 'skills/result-to-claim/SKILL.md',
    sha256: 'b12d10bdb51440f65e4112e6643712f172a7e37c1e15066e15d81eaee5838a8f',
  },
  {
    path: 'skills/paper-claim-audit/SKILL.md',
    sha256: '3cf3ecdf14899aa011c7f5baf5efcba7a67e940a65e7938170426f4af2b032ea',
  },
  {
    path: 'skills/citation-crosscheck/scripts/cx_verify.py',
    sha256: 'ae731cb5bfbc26bfa12f007516e4b0b8591c9384d4512d1d5c4d74737d3f250f',
  },
  {
    path: 'skills/citation-crosscheck/SKILL.md',
    sha256: '8556f29c677b93d465df6b7309914e0b1c387213f73d132b5182fa4d0af42758',
  },
  {
    path: 'skills/overleaf-sync/SKILL.md',
    sha256: 'f3c1f35a77a81ebf902eb2e9434cb61e7494e0152b8d29fe337e75d2d7524557',
  },
  // >>> END-REGISTERED-ENTRIES
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
    path: 'shared-references/assurance-contract.md',
    sha256: '4320cc8f8614f95914a1b8594759a8e0264f9e8ba02b7dca8305acab0c43b282',
  },
  {
    path: 'shared-references/venue-checklists.md',
    sha256: '712396be66d4db85f0038c5ff5479a5fc66db03bc7175c8ed931f7284802f4e2',
  },
  {
    path: 'shared-references/writing-principles.md',
    sha256: '23142c901d034ab0b640a7f2c1ee3899f273020d9bf911134ef06ebfad61e5d8',
  },
  {
    path: 'shared-references/effort-contract.md',
    sha256: 'c1cb84a099d7d465ce71e0fc6c8fe7449c8273072b4cb977e0e58744d767f482',
  },
  {
    path: 'skills/rebuttal/SKILL.md',
    sha256: '52ec75bf57fb3ffe6ffdc8c468f69815a12dba4679b0a4f9ac2acb64ebadcb03',
  },
  {
    path: 'skills/paper-slides/SKILL.md',
    sha256: 'b20083823df5238ad94f6ff4431481ef65424a876fdd09102c1a936f0e5fde1a',
  },
  {
    path: 'skills/paper-talk/SKILL.md',
    sha256: '54c73cc91084ad64aa8bdb53887c58178146d4c608916818b2156161a8cbcb2a',
  },
  {
    path: 'skills/paper-compile/SKILL.md',
    sha256: 'ca064e9b7dffe80d9c3bcabb060f81c651e4926eb1c069a04c6416a8e58fed93',
  },
  {
    path: 'skills/paper-figure/SKILL.md',
    sha256: '7d115c37bc7de777a12ccc0211d44305d513a017d6a07e8ac8dd7d2e99dab21f',
  },
  {
    path: 'skills/paper-plan/SKILL.md',
    sha256: '536e720d0570fe9124f5320ac061df3fbf890c8e13161e485bac0c20cbab9c4f',
  },
  {
    path: 'skills/paper-write/SKILL.md',
    sha256: '752887e18d48e87a3156384d95abb2a6bb987d2eae1c72631d8f00a9bfcad6f2',
  },
  {
    path: 'skills/paper-write/templates/IEEEtran.bst',
    sha256: '314f0ece704568faf827011bac498650691b2b5ee06320720830e782416d5a5f',
  },
  {
    path: 'skills/paper-write/templates/IEEEtran.cls',
    sha256: 'da751920a317ed318b7b5cd7fa585a6cc7d28502d457856382e9be24b10a3bd7',
  },
  {
    path: 'skills/paper-write/templates/iclr2026.tex',
    sha256: '1e4c20b3c5b7445966194151d33c3e2023e828e621be8baf7ffb234b987cfc23',
  },
  {
    path: 'skills/paper-write/templates/iclr2026_conference.bst',
    sha256: '2d67552db7ed38ccfccb5957b52f95656e25c249724761d3cf5f7922ad1844c5',
  },
  {
    path: 'skills/paper-write/templates/iclr2026_conference.sty',
    sha256: 'a4852f68e080d6c5245057ca2039100b409e31727898aa93c03d78ddb84374a3',
  },
  {
    path: 'skills/paper-write/templates/icml2025.tex',
    sha256: 'd346d4b5b96276a4e04ccd7590ad158cce4aabcc090281dca7c4b0900d11530b',
  },
  {
    path: 'skills/paper-write/templates/ieee_conference.tex',
    sha256: 'a3dc3a175a7dd1512f4a2fdb844a0a482a9e919162e37dc27373d501fbafafbc',
  },
  {
    path: 'skills/paper-write/templates/ieee_journal.tex',
    sha256: 'bdff7ff0aa376d8a46675bdb6e96c4dd715463360735706aa5fbaa5f834b7604',
  },
  {
    path: 'skills/paper-write/templates/math_commands.tex',
    sha256: '3efe4556b2c33b4a93c1b6e86b99b9a3ecbd9c9565ccc06bf8a1f51293470dc6',
  },
  {
    path: 'skills/paper-write/templates/neurips2025.tex',
    sha256: 'fef6448048e58b748d67f438dce6fcfedcc49467542a951d1986dc5b81ca256c',
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
    path: 'skills/monitor-experiment/SKILL.md',
    sha256: '0527977308bb7b26139ffb56cd2d45ecc72a9dd2961073ad51fac4aac106961d',
  },
  {
    path: 'skills/novelty-check/SKILL.md',
    sha256: 'a1f257297405c9948f570d51672f50b0176177001e74118c926b149c9ccb9af4',
  },
  {
    path: 'skills/prior-art-search/SKILL.md',
    sha256: '8793fb26c522de4c44a64b68df81e5d12718a99866c639658261cea680bd58b2',
  },
  {
    path: 'skills/research-wiki/SKILL.md',
    sha256: '564eea3ad9e8763ba2120605e61b18260b201976e9d6035643d8f65982052c06',
  },
  {
    path: 'skills/render-html/SKILL.md',
    sha256: '83d2608faaa09c1faf135c4c4a26415fcf9f96e98ed1d1884b207b6c1f1514d3',
  },
  {
    path: 'skills/render-html/scripts/render_html.py',
    sha256: 'f563872737d1fafbc38ea6a6de85451063daa196b219e163dcb32c3abeb6d58f',
  },
  {
    path: 'skills/render-html/scripts/templates/academic.html',
    sha256: 'af3a2f998091edd2804b9e64eab21bf77b6caa57349fcfbbe767b1a8d16380cc',
  },
  {
    path: 'skills/render-html/scripts/templates/dashboard.html',
    sha256: '156e0825a131279debe55d1b91d7aa7c5f85e755458414932110687c9c3b3779',
  },
  {
    path: 'tools/research_wiki.py',
    sha256: '5836740a1fcb6e15d6cf2dc87847ddb2abb23c0dd6a69a2b9cf0cd5b3a0ac0bb',
  },
];

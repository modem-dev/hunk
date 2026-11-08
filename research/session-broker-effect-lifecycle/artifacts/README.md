# Retained artifacts

This directory keeps the smallest practical evidence set for reconstructing and reviewing both arms.
It deliberately omits generated bundles, declarations, and repetitive raw test logs.

Each arm contains:

- `complete-experiment.patch` — binary-safe patch against the recorded base, including untracked
  experiment files at collection time;
- `result.json` — runtime metadata, raw benchmark samples, derived measurements, and command results;
- `semantics.json` — characterized and intentionally changed semantics;
- `ownership-inventory.json` — lifecycle ownership analysis;
- `source-identity.json` — source and support-file identities at collection time;
- `validation-manifest.json` — validation commands, statuses, and transcript hashes;
- `canary.json` — bounded sensitive-defect canary result;
- `original-MANIFEST.sha256` and `original-MANIFEST.attestation.sha256` — manifests from the original
  local evidence directory. Some referenced bulky files are intentionally not copied here, so use
  the archive-level `MANIFEST.sha256` for direct verification of retained files.

The treatment patch is the authoritative reconstruction artifact for the discarded implementation.
The current worktree or later report edits may not equal the source identity captured by that patch.
No manifest in this directory proves authorship or trusted time.

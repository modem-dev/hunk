---
"hunkdiff": patch
---

npm installs now fall back to the bundled JavaScript runtime when the prebuilt binary cannot run on the machine, report signal exits as 128 + signal, and pick the native arm64 build under Rosetta.

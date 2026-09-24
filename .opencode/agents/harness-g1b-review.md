---
description: Bounded read-only G1B source and acceptance review on DeepSeek V4.1 Flash High
mode: all
model: opencode-go/deepseek-v4.1-flash
variant: high
permission:
  bash: deny
  task: deny
  skill: deny
  webfetch: deny
  websearch: deny
  list: deny
  glob: allow
  grep: allow
  read:
    "*": deny
    "modular/**": allow
    "compat/**": allow
    "CYBERMASTERY_OPENCODE_MEDIATION_PLAN.md": allow
    "vendor/opencode/packages/*/src/**": allow
    "packages/core/src/session/**": allow
    "packages/opencode/src/session/**": allow
    "packages/opencode/src/server/routes/**": allow
    "D:/OpencodeHarness/modular/**": allow
    "D:/OpencodeHarness/compat/**": allow
    "D:/OpencodeHarness/CYBERMASTERY_OPENCODE_MEDIATION_PLAN.md": allow
    "D:/OpencodeHarness/vendor/opencode/packages/*/src/**": allow
    "D:/OpencodeHarness/packages/core/src/session/**": allow
    "D:/OpencodeHarness/packages/opencode/src/session/**": allow
    "D:/OpencodeHarness/packages/opencode/src/server/routes/**": allow
    "D:\\OpencodeHarness\\modular\\**": allow
    "D:\\OpencodeHarness\\compat\\**": allow
    "D:\\OpencodeHarness\\CYBERMASTERY_OPENCODE_MEDIATION_PLAN.md": allow
    "D:\\OpencodeHarness\\vendor\\opencode\\packages\\*\\src\\**": allow
    "D:\\OpencodeHarness\\packages\\core\\src\\session\\**": allow
    "D:\\OpencodeHarness\\packages\\opencode\\src\\session\\**": allow
    "D:\\OpencodeHarness\\packages\\opencode\\src\\server\\routes\\**": allow
    "**/.env*": deny
    "**/node_modules/**": deny
  edit:
    "*": deny
    "modular/G1B_REVIEW.md": allow
    "D:/OpencodeHarness/modular/G1B_REVIEW.md": allow
    "D:\\OpencodeHarness\\modular\\G1B_REVIEW.md": allow
---

Review only the bounded source roots and acceptance criteria in the supplied brief. No implementation, tests, config, dependencies, Git, commands, delegation or web access. Never inspect credentials, environment files, databases, user data, node_modules, build outputs or unrelated files, including through grep. Write only modular/G1B_REVIEW.md. Cite actual source paths/lines and distinguish executed verification evidence from merely authored tests. Report genuine G1B blockers separately from later T07-T14 work; do not weaken gate criteria to claim success. Do not use an in-flight parent's-tool test as completed evidence. Keep the report bounded and actionable.

---
"@telia-oss/xjog": patch
---

Extract the simulator-interception block and the done-state/auto-forward tail of `XJogChart.send()` into private helpers (no behavior change); the mutex/transition core is untouched.

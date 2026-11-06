// plugin-package/index.ts — Flexibility Phase 1 dual-mode layout (design §D.1).
// Re-exports the plugin (and its test seams) from src/dispatch-policy.ts so the
// object-form `plugins` entry in opencode.json can load the plugin as a PACKAGE and
// carry `options`:
//
//   { "plugins": [ { "package": "/path/to/opencode-mandator/plugin-package",
//                    "options": { ... } } ] }
//
// Configured local package paths MUST be directories (a single file path is skipped by
// the v2 loader) — that is why this directory exists beside the file-discovery symlink
// install. Default install mode is UNCHANGED (file symlink via install.sh).
// One mode at a time: the symlink file AND a plugins-array entry for the same plugin id
// may double-load the plugin (PRIMER injected twice) until the runtime's dedupe behavior
// is probed (design §D.1/D.4) — switching modes = remove one AND add the other in the
// same step, then `opencode service restart`.
export { default, _testStat, _djb2 } from "../src/dispatch-policy.ts"

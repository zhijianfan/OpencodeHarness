# Worker provenance: official source attestation

Implement ONLY these new files in D:/OpencodeHarness:
- modular/packages/compat/src/upstream.ts
- modular/packages/compat/src/upstream.test.ts

Do not inspect repo. No tests/tools beyond writing the two owned files. No edits to vendor or Git state by you. Runtime of the implementation may run read-only Git inspection; tests may create their own disposable git repositories using explicit git -C commands. Use Bun APIs, node:path and node:fs/promises where needed; no any, aliases, or star imports. Tests use bun:test. Do not skip tests because installed parent vendor is absent: unit tests create real fixture repos under os.tmpdir and remove them in finally.

Required exports:
type UpstreamPin = {readonly commit:string;readonly repository:string}
type Attestation = {readonly commit:string;readonly tree:string;readonly repository:string;readonly trackedFiles:number;readonly sourceDigest:string}
async function attestUpstream(directory:string,pin:UpstreamPin):Promise<Attestation>
class UpstreamIntegrityError extends Error (name exactly UpstreamIntegrityError)

Implementation behavior:
- Verify directory is the root of its own Git worktree (git rev-parse --show-toplevel), actual HEAD exactly matches pin.commit, and remote origin URL exactly equals pin.repository. No fetch/no Git configuration mutation.
- Get full recursively tracked tree with `git ls-tree -r -z HEAD` (format mode SP type SP hash TAB path NUL). Read raw byte stdout from Bun.spawn, parse UTF8 paths robustly including spaces. Reject git command nonzero with helpful errors.
- Check staged/unstaged/untracked nonignored source edits with git status --porcelain --untracked-files=all. Allow ignored node_modules/build outputs.
- Independently verify every tracked blob even if assume-unchanged/skip-worktree hides it: hash working files using Git's clean conversion (`git hash-object --stdin-paths` batched, paths newline separated, quoted as needed). Compare ordered hash results to tree entries. For real symlinks read link text then git hash-object --stdin (with pipe) so the target file is not hashed; Windows core.symlinks=false has regular link-text files, handled normally. Missing files fail. Gitlinks: verify staged gitlink mode/SHA matches HEAD entry; a present initialized submodule must have matching HEAD and clean tracked state; empty uninitialized directory is allowed. Do not follow submodules recursively without bounds. Explain in code comments if raw-byte fingerprint vs Git canonical content differs due to EOL conversion.
- sourceDigest is SHA256 over deterministic sorted records containing mode, object hash, path. Use node:crypto createHash. It is an integrity manifest, not a claim that temporary modifications during an unobserved build were impossible.
- Catch expected operational failures into UpstreamIntegrityError; do not swallow them into successful attestations.

Test with real local git repos: create tracked plain file and ignored node_modules, add remote origin (a local fixture URL allowed), configure user with `git -c user.name=... -c user.email=... commit` command flags not persistent config, then obtain actual commit SHA. Check valid attestation incl ignored files; wrong pin; wrong remote; changed tracked contents; assume-unchanged edit detected; untracked nonignored file detected. Fixtures not in production repo; NEVER git add/commit the user's workspace.

This is an execution guard used before and after native proof tests, NOT full read-only mount enforcement. Exact official production pin is b02acc1e30ef55f7f181fec8d2f241d26f022683 and URL https://github.com/anomalyco/opencode.git; implementation itself is parameterized for testability.

Return files written and uncertainties. Master owns package manifests and runs package-level tests after all workers return.

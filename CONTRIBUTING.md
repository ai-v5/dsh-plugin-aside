# Contributing

## Every change goes through a pull request

`main` is release-only. Nothing is pushed to it directly:

```powershell
git switch -c fix/short-description      # or feat/, docs/, chore/
# ... work ...
node --test "test/**/*.test.mjs"
git commit -m "..." && git push -u origin HEAD
gh pr create --fill
```

A pull request is ready to merge when:

- `node --test "test/**/*.test.mjs"` passes locally (CI runs the same suite on
  Node 22 and 24, Windows and Linux);
- `npm run check` passes (`node --check` over every shipped module);
- for anything touching the sidebar, the fork flow or the relay tool, the change
  was **exercised against a running DSH**, and the pull request says what was
  observed rather than what was expected;
- the pull request description names the failure mode that was ruled out, not
  only the feature that was added.

Squash-merge is the default. Delete the branch afterwards.

## What this repository will not do

- **Ship an unverified claim.** "It should work" is not a result. If a path was
  not executed, say so in the pull request and in the README's verification
  table.
- **Pretend the two halves are symmetric.** The browser half needs no host work;
  the host half exists only where the browser cannot reach. Keep that boundary
  explicit — a host service that browser code could call directly is a design
  smell here.
- **Add model surface for convenience.** Every tool, prompt section and command
  is permanent context cost for every turn. `aside_tell_main` earns its place by
  closing a direction the UI cannot express; that is the bar.

## Testing expectations

`test/unit/` must not require a running DSH. The suite loads the **shipped**
`client.js` through a stubbed module loader (`test/support/loader.mjs`) and a
recording plugin context (`test/support/fake-context.mjs`), so assertions run
against the real bundle rather than a reimplementation of it.

Anything that needs live DSH behaviour (forking, the sidebar tab, the relay)
belongs in a manual or scripted end-to-end run, and its outcome belongs in the
pull request description.

## Style

- Plain ESM, no build step, no runtime dependencies. Node `>= 22`.
- JSDoc on exported functions, because there is no TypeScript here to carry the
  contract.
- Comments explain *why* a non-obvious line exists — especially where a DSH
  behaviour forced a workaround. Cite the package and line when a decision hangs
  on framework internals.

# Workflows waiting for the `workflow` scope

`ci.yml` (from `f90fdba`, which never reached GitHub) and `recorder.yml` belong in `.github/workflows/`. The agent server's GitHub token has no `workflow` scope, so GitHub refuses any push that touches that folder. From a machine whose token has it:

```sh
git mv .github/pending-workflows/ci.yml .github/pending-workflows/recorder.yml .github/workflows/
git rm .github/pending-workflows/README.md
git commit -m "CI: the workflows into place"
git push
```

Or once on the agent server: `gh auth refresh -h github.com -s workflow`.

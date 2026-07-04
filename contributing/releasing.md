# Releasing

XJog is published as 15 independently-versioned packages under the `@telia-oss/*`
scope, to Telia's **JFrog Artifactory** npm repository (`ecom-npm-local`), driven
by [Changesets](https://github.com/changesets/changesets).

Publishing goes to JFrog from **any branch** — the registry is pinned two ways:

- **`publishConfig.registry`** in every package's `package.json` — the publish
  target.
- **`@telia-oss:registry`** in the repo `.npmrc` — so Changesets' "is this version
  already published?" check queries JFrog too (without it, the check hits npmjs,
  wrongly concludes the version is new, and then fails on a duplicate).

There is no special publish branch — that setup was removed in favour of the two
config points above.

## Prerequisites: authentication

The `.npmrc` points the scope at JFrog but carries **no credentials**. Put a token
in your **`~/.npmrc`** (user-level, never commit it):

```
//jfrog.teliacompany.io/artifactory/api/npm/ecom-npm-local/:_authToken=<your-token>
```

Get the exact line from JFrog Artifactory → **Set Me Up** → npm. Verify:

```bash
npm whoami --registry=https://jfrog.teliacompany.io/artifactory/api/npm/ecom-npm-local/
```

## Release steps (maintainers)

A change is only released once its version is **bumped past what's on the
registry** — that takes two distinct Changesets stages, `version` then `publish`.
Skipping the `version` stage is the most common mistake (see
[Troubleshooting](#troubleshooting)).

```bash
git checkout main                    # release from the default branch
git pull

# 1. Ensure a changeset describing the release exists (normally committed with
#    the PRs). If not, add one:
pnpm changeset                        # keep bumps `patch` during alpha

# 2. VERSION — consume changesets: bump package.json versions + write CHANGELOGs.
#    This is the step people skip. Without it, versions don't move and step 4
#    finds nothing new to publish.
pnpm version-packages                 # e.g. 0.1.0 -> 0.1.1 across affected packages
pnpm install                         # refresh the lockfile after the bumps
git commit -am "Version packages"

# 3. (sanity) preview what would be published, without pushing:
pnpm -r publish --dry-run --no-git-checks

# 4. PUBLISH — build, then publish versions not yet on JFrog.
pnpm release                          # = turbo run build && changeset publish

# 5. push the git tags Changesets created (e.g. @telia-oss/xjog@0.2.0):
git push origin --tags
```

## Good to know

- **Idempotent.** `changeset publish` only pushes versions **not already** on the
  registry. Re-running after a partial failure publishes just the missing ones.
- **`access: restricted`** (in `publishConfig` and `.changeset/config.json`) →
  published as private, correct for an internal Artifactory repo.
- **Workspace deps** (`workspace:^`) are rewritten to real version ranges by pnpm
  at publish time — no manual step.
- **Alpha versioning:** keep bumps `patch` so versions stay `0.1.x`.

## Troubleshooting

**`warn ... is not being published because version X is already published` /
`No unpublished projects to publish`** — the version in `package.json` already
exists on JFrog. Almost always:

1. **You skipped `pnpm version-packages`.** The changeset is still pending and
   versions are unchanged, so `changeset publish` sees the current (already
   published) version and skips. Run `version-packages`, commit, then `release`.
2. **The version genuinely is already on JFrog** — nothing to do; cut a new
   version to publish again (you can't overwrite an existing version).

**Check where a version actually lives** (a scope override is required — a bare
`--registry` is ignored for scoped packages because `@telia-oss:registry` in
`.npmrc` wins):

```bash
# On JFrog?
npm view @telia-oss/xjog@0.2.0 version \
  --@telia-oss:registry=https://jfrog.teliacompany.io/artifactory/api/npm/ecom-npm-local/

# On public npmjs? (should always 404 — these are private)
npm view @telia-oss/xjog@0.2.0 version \
  --@telia-oss:registry=https://registry.npmjs.org
```

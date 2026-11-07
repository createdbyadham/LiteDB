#!/usr/bin/env bash
# Open or update a pull request against an upstream repo from a fork owned by
# the GitHub user of GH_TOKEN.
#
#   fork-pr.sh <upstream> <branch> <title>
#   COMMIT_MESSAGE, PR_BODY
#   FILES: newline-separated DEST=SRC. SRC may be absolute.
set -euo pipefail

upstream=$1
branch=$2
title=$3
root=$(pwd)
login=$(gh api user --jq .login)
fork="${login}/$(basename "$upstream")"

if ! gh repo view "$fork" >/dev/null 2>&1; then
  gh repo fork "$upstream" --clone=false --default-branch-only
fi

work=$(mktemp -d)
gh repo clone "$fork" "$work" -- --depth 1
cd "$work"
git remote add upstream "https://github.com/${upstream}.git"
git fetch --depth 1 upstream
default=$(gh repo view "$upstream" --json defaultBranchRef --jq .defaultBranchRef.name)

if git fetch --depth 1 origin "$branch" >/dev/null 2>&1; then
  git checkout -B "$branch" "origin/${branch}"
else
  git checkout -B "$branch" "upstream/${default}"
fi

while IFS= read -r mapping || [ -n "$mapping" ]; do
  [ -z "$mapping" ] && continue
  dest=${mapping%%=*}
  src=${mapping#*=}
  case "$src" in
    /*|[A-Za-z]:*) ;;
    *) src="${root}/${src}" ;;
  esac
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  git add -- "$dest"
done <<< "$FILES" || true

if git diff --cached --quiet; then
  echo "No changes for ${upstream}"
  exit 0
fi

export GIT_AUTHOR_NAME="Adham Ehab"
export GIT_AUTHOR_EMAIL="createdbyadham@gmail.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
git commit -m "$COMMIT_MESSAGE"
git push --set-upstream origin "$branch"

existing=$(gh pr list --repo "$upstream" --head "${login}:${branch}" --state open --json number --jq '.[0].number')
if [ -n "$existing" ] && [ "$existing" != "null" ]; then
  echo "Updated ${upstream}#${existing}"
  exit 0
fi

gh pr create --repo "$upstream" --head "${login}:${branch}" --base "$default" --title "$title" --body "$PR_BODY"

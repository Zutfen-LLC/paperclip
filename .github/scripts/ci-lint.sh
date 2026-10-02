#!/usr/bin/env bash
# Lint workflow files with actionlint and CI shell scripts with shellcheck.
#
#   .github/scripts/ci-run.sh --no-install -- .github/scripts/ci-lint.sh [BASE HEAD]
#
# The fork-owned workflows are always linted. With BASE and HEAD, any other
# workflow file that range changes is linted too. actionlint also runs the
# shell linter over every `run:` block, so inline workflow scripts are covered.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

workflows=(.github/workflows/ci.yml .github/workflows/ci-full.yml)
if [ $# -ge 2 ]; then
  while IFS= read -r file; do
    case "$file" in
      .github/workflows/*.yml | .github/workflows/*.yaml)
        [ -f "$file" ] || continue
        case " ${workflows[*]} " in *" $file "*) ;; *) workflows+=("$file") ;; esac
        ;;
    esac
  done < <(git diff --name-only --no-renames "$1...$2")
fi

# SC2016 (single-quoted $VAR) is ignored for workflow scripts on purpose: the
# commands handed to ci-run.sh are single-quoted so the container shell, not
# the runner's, expands them. Every other shellcheck finding still fails.
echo "actionlint: ${workflows[*]}"
actionlint -no-color -ignore 'SC2016:info' "${workflows[@]}"

echo "shellcheck: .github/scripts/*.sh"
shellcheck .github/scripts/*.sh

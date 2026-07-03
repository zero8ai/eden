# shellcheck shell=bash
#
# clawd — coding-agent worktree launcher
#
# Sourced from ~/.bashrc, ~/.zshrc, or ~/.bash_profile (git-bash on Windows).
# Defines a `clawd` shell function that creates a per-feature git worktree,
# wires up an isolated dev port + Postgres DB + env, and launches a coding
# agent inside it. Defaults to Claude Code; pass --codex or --pi to launch a
# different agent instead.
#
# INSTALL (pick your shell):
#   zsh:         echo "source $(pwd)/scripts/clawd.sh" >> ~/.zshrc
#   bash:        echo "source $(pwd)/scripts/clawd.sh" >> ~/.bashrc
#   git-bash:    echo "source /c/path/to/eden/scripts/clawd.sh" >> ~/.bash_profile
# Then open a new terminal, or `source` the rc file once to load this session.
#
# USAGE:
#   clawd                                  # launch the default agent (claude) here
#   clawd -w <prefix>/<kebab-name>         # claude in a fresh worktree
#   clawd --codex -w <prefix>/<kebab-name> # codex in a fresh worktree
#   clawd --pi -w <prefix>/<kebab-name>    # pi in a fresh worktree
#   clawd -w --skip-validate <any-name>
#
# AGENT SELECT (default: claude):
#   --claude   launch Claude Code (command: claude --dangerously-skip-permissions)
#   --codex    launch Codex        (command: codex --dangerously-bypass-approvals-and-sandbox)
#   --pi       launch pi           (command: pi)
# The flag may appear anywhere in the args and is consumed (not forwarded to
# the agent). Anything else is passed through to the agent verbatim.
#
# Valid prefixes: feature, feat, bugfix, hotfix, chore, refactor, docs, experiment, issue
# <kebab-name>   lowercase letters/digits with single hyphens (e.g. tanga-integration)
#
# For input `feature/tanga-integration`:
#   - branch        feature/tanga-integration
#   - worktree dir  .worktrees/feature-tanga-integration
#   - session name  tanga-integration (terminal title + claude --name)
#   - postgres db   eden_feature_tanga_integration
#
# For input `regen` with --skip-validate:
#   - branch        regen
#   - worktree dir  .worktrees/regen
#   - session name  regen
#   - postgres db   eden_regen
#
# --skip-validate bypasses the prefix convention check. Use it to attach to
# legacy worktrees (branches created before the prefix convention) or for
# one-off non-conforming names. Default path still enforces the convention —
# opting out is deliberate.
#
# If the branch already exists locally, the worktree is checked out onto it
# (after a Y/n confirm). If only a remote branch exists, a warning is printed
# and a new local branch is created from HEAD — `git fetch && git checkout`
# first if you wanted the remote one.
#
# REMOVE A WORKTREE:
#   clawd -r <name>           # -r and --remove are equivalent
#   clawd --remove <name>
#
# Removal does NOT validate the name format — it just tears down whatever
# worktree (and its DB / port slot) exists under the given name. The local
# branch is preserved so its commits aren't lost. The agent-select flag is
# irrelevant to removal (all agents share one .worktrees dir).
#
# Requires bash 3.1+ or zsh 5+. Tested on macOS zsh/bash and Windows git-bash.

clawd() {
  local _clawd_prefix_re='^(feature|feat|bugfix|hotfix|chore|refactor|docs|experiment|issue)/[a-z0-9]+(-[a-z0-9]+)*$'
  local _clawd_prefix_hint='<prefix>/<kebab-name> where prefix is one of: feature, feat, bugfix, hotfix, chore, refactor, docs, experiment, issue'

  local args=() feature=""
  local want_worktree=0 next_is_name=0 skip_validate=0 want_remove=0 next_is_remove=0
  local agent="claude"
  for a in "$@"; do
    if (( next_is_name )); then feature="$a"; next_is_name=0; continue; fi
    if (( next_is_remove )); then feature="$a"; next_is_remove=0; continue; fi
    case "$a" in
      -w|-W) want_worktree=1; next_is_name=1 ;;
      -r|--remove) want_remove=1; next_is_remove=1 ;;
      --skip-validate) skip_validate=1 ;;
      --claude) agent="claude" ;;
      --codex) agent="codex" ;;
      --pi) agent="pi" ;;
      *) args+=("$a") ;;
    esac
  done

  if (( want_remove )); then
    [[ -z "$feature" ]] && { echo "clawd --remove: feature name required" >&2; return 1; }
    local root; root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "clawd --remove: not inside a git repo" >&2; return 1; }
    ( cd "$root" && node scripts/worktree-teardown.mjs "$feature" )
    return $?
  fi

  if (( want_worktree )); then
    [[ -z "$feature" ]] && { echo "clawd -w: feature name required ($_clawd_prefix_hint)" >&2; return 1; }
    if (( ! skip_validate )) && [[ ! "$feature" =~ $_clawd_prefix_re ]]; then
      echo "clawd -w: invalid feature name '$feature'. expected $_clawd_prefix_hint. Pass --skip-validate to bypass (e.g. for legacy worktrees)." >&2
      return 1
    fi
    local root; root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "clawd -w: not inside a git repo" >&2; return 1; }
    # Agnostic derivation — works with or without a slash in $feature:
    #   feature/tanga-integration -> short=tanga-integration, dir=feature-tanga-integration
    #   regen                     -> short=regen,             dir=regen
    local short="${feature##*/}"
    local dir_name="${feature//\//-}"
    local wt="$root/.worktrees/$dir_name"
    git -C "$root" worktree prune
    if [[ -d "$wt" ]]; then
      local reply
      printf "Worktree '%s' already exists. Use it? [Y/n] " "$dir_name"
      read -r reply
      if [[ "$reply" =~ ^[Nn]$ ]]; then
        git -C "$root" worktree remove --force "$wt" || return 1
        git -C "$root" branch -D "$feature" 2>/dev/null
        git -C "$root" worktree add "$wt" -b "$feature" HEAD || return 1
      fi
    elif git -C "$root" show-ref --verify --quiet "refs/heads/$feature"; then
      # Local branch already exists — the happy path for picking up a branch
      # that predates the worktree convention, or one a teammate created.
      # Reuse is non-destructive; the confirm is just an FYI so you don't
      # accidentally attach to the wrong branch when you meant to start fresh.
      local reply
      printf "Branch '%s' already exists locally. Reusing it for this worktree — no changes to the branch itself. Continue? [Y/n] " "$feature"
      read -r reply
      if [[ "$reply" =~ ^[Nn]$ ]]; then
        echo "clawd -w: aborted." >&2
        return 1
      fi
      git -C "$root" worktree add "$wt" "$feature" || return 1
    else
      # No local branch. Warn if a same-named remote branch exists so the user
      # knows they're about to create an unrelated branch; do NOT fetch or
      # check out the remote automatically — that's their call.
      if git -C "$root" show-ref --verify --quiet "refs/remotes/origin/$feature"; then
        echo "clawd -w: warning: remote branch 'origin/$feature' exists but isn't checked out locally. Creating a NEW unrelated branch from HEAD. Abort with Ctrl-C and run 'git fetch && git checkout $feature' first if you meant to resume the remote branch." >&2
      fi
      git -C "$root" worktree add "$wt" -b "$feature" HEAD || return 1
    fi
    local setup_args=("$feature")
    (( skip_validate )) && setup_args+=("--skip-validate")
    ( cd "$root" && node scripts/worktree-setup.mjs "${setup_args[@]}" ) || return 1
    printf "\033]0;%s\007" "$short"
    case "$agent" in
      codex) ( cd "$wt" && command codex --dangerously-bypass-approvals-and-sandbox "${args[@]}" ) ;;
      pi)    ( cd "$wt" && command pi "${args[@]}" ) ;;
      *)     ( cd "$wt" && command claude --dangerously-skip-permissions --name "$short" "${args[@]}" ) ;;
    esac
  else
    printf "\033]0;%s\007" "$agent"
    case "$agent" in
      codex) command codex --dangerously-bypass-approvals-and-sandbox "${args[@]}" ;;
      pi)    command pi "${args[@]}" ;;
      *)     command claude --dangerously-skip-permissions "${args[@]}" ;;
    esac
  fi
}

# wt — jump to a clawd worktree by short name
#
# USAGE:
#   wt              list available worktree names (basenames, one per line)
#   wt <name>       cd to <main-repo-root>/.worktrees/<name>
#
# Works from the main checkout AND from inside any worktree. Resolves the
# main repo root via `git rev-parse --git-common-dir` so it's stable from
# linked worktrees (where --show-toplevel returns the worktree path).
# Tab-completion lists current worktree basenames, computed fresh per call.
wt() {
  local main_root wtdir
  main_root=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd) || {
    echo "wt: not inside a git repo" >&2; return 1;
  }
  if [[ -z "$main_root" ]]; then
    echo "wt: not inside a git repo" >&2; return 1
  fi
  wtdir="$main_root/.worktrees"
  if [[ ! -d "$wtdir" ]]; then
    echo "wt: no worktrees dir at $wtdir" >&2; return 1
  fi
  if [[ -z "$1" ]]; then
    local entry
    for entry in "$wtdir"/*/; do
      [[ -d "$entry" ]] || continue
      entry="${entry%/}"
      printf '%s\n' "${entry##*/}"
    done
    return 0
  fi
  local target="$wtdir/$1"
  if [[ ! -d "$target" ]]; then
    echo "wt: no worktree '$1'" >&2; return 1
  fi
  cd "$target" || return 1
}

if [[ -n "$ZSH_VERSION" ]]; then
  _wt_complete_zsh() {
    local main_root wtdir
    main_root=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd) || return 0
    wtdir="$main_root/.worktrees"
    [[ -d "$wtdir" ]] || return 0
    local -a names
    local entry
    for entry in "$wtdir"/*/; do
      [[ -d "$entry" ]] || continue
      entry="${entry%/}"
      names+=("${entry##*/}")
    done
    compadd -- "${names[@]}"
  }
  compdef _wt_complete_zsh wt
fi

if [[ -n "$BASH_VERSION" ]]; then
  _wt_complete_bash() {
    local main_root wtdir
    main_root=$(cd "$(git rev-parse --git-common-dir 2>/dev/null)/.." 2>/dev/null && pwd) || return 0
    wtdir="$main_root/.worktrees"
    [[ -d "$wtdir" ]] || return 0
    local names=() entry
    for entry in "$wtdir"/*/; do
      [[ -d "$entry" ]] || continue
      entry="${entry%/}"
      names+=("${entry##*/}")
    done
    local cur="${COMP_WORDS[COMP_CWORD]}"
    COMPREPLY=( $(compgen -W "${names[*]}" -- "$cur") )
  }
  complete -F _wt_complete_bash wt
fi

# clawd worktree-branch completion. Fires after -w/-W (create/attach) and
# after -r/--remove (teardown) — both operate on existing .worktrees branches.
# The typed word matches either the full branch (feature/foo) or just the part
# after the slash (foo), so you don't need to remember the prefix.
if [[ -n "$ZSH_VERSION" ]]; then
  _clawd_complete_zsh() {
    local prev="${words[CURRENT-1]}"
    case "$prev" in -w|-W|-r|--remove) ;; *) return 0 ;; esac
    git rev-parse --git-dir >/dev/null 2>&1 || return 0
    local -a names
    local line cur_path=""
    while IFS= read -r line; do
      case "$line" in
        "worktree "*) cur_path="${line#worktree }" ;;
        "branch refs/heads/"*)
          if [[ "$cur_path" == *"/.worktrees/"* ]]; then
            names+=("${line#branch refs/heads/}")
          fi
          ;;
        "") cur_path="" ;;
      esac
    done < <(git worktree list --porcelain 2>/dev/null)
    local cur="${words[CURRENT]}" n
    local -a matches
    for n in "${names[@]}"; do
      if [[ "$n" == "$cur"* || "${n##*/}" == "$cur"* ]]; then
        matches+=("$n")
      fi
    done
    # -U: insert the full branch even when the typed word (short name) isn't
    # a literal prefix of it.
    compadd -U -- "${matches[@]}"
  }
  compdef _clawd_complete_zsh clawd
fi

if [[ -n "$BASH_VERSION" ]]; then
  _clawd_complete_bash() {
    local prev="${COMP_WORDS[COMP_CWORD-1]}"
    case "$prev" in -w|-W|-r|--remove) ;; *) return 0 ;; esac
    git rev-parse --git-dir >/dev/null 2>&1 || return 0
    local names=() line cur_path=""
    while IFS= read -r line; do
      case "$line" in
        "worktree "*) cur_path="${line#worktree }" ;;
        "branch refs/heads/"*)
          if [[ "$cur_path" == *"/.worktrees/"* ]]; then
            names+=("${line#branch refs/heads/}")
          fi
          ;;
        "") cur_path="" ;;
      esac
    done < <(git worktree list --porcelain 2>/dev/null)
    local cur="${COMP_WORDS[COMP_CWORD]}" n
    COMPREPLY=()
    for n in "${names[@]}"; do
      if [[ "$n" == "$cur"* || "${n##*/}" == "$cur"* ]]; then
        COMPREPLY+=("$n")
      fi
    done
  }
  complete -F _clawd_complete_bash clawd
fi

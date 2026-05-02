# sconl-space/lib/scope.sh
# Scope command handlers — daily rhythm layer.
# Covers: inbox, today, tasks, goals, reflection, cycle, identity, plan.
#
# ─────────────────────────────────────────────────────────────────────────────
# CHANGELOG
# ─────────────────────────────────────────────────────────────────────────────
#   v1.0.0 — Initial. Full daily loop: inbox capture/triage, task CRUD,
#             goal tracking with KPI, guided reflection, cycle display,
#             identity layer (north star + season). Flat-file + SQLite routing.
# ─────────────────────────────────────────────────────────────────────────────

[[ -n "${_SCOPE_LOADED:-}" ]] && return 0
_SCOPE_LOADED=1

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

_SCOPE_STALE_INBOX_DAYS=14     # inbox items older than this are flagged
_SCOPE_DRIFT_DAYS=7            # goals with no task activity → "drifting"
_SCOPE_DEFERRED_WARN=3         # tasks deferred >= this many times → highlighted

# Task status values
_SCOPE_STATUS_BACKLOG="backlog"
_SCOPE_STATUS_TODAY="today"
_SCOPE_STATUS_DEFERRED="deferred"
_SCOPE_STATUS_DONE="done"
_SCOPE_STATUS_ARCHIVED="archived"

# Goal levels
_SCOPE_LEVEL_CYCLE="cycle"
_SCOPE_LEVEL_ANNUAL="annual"
_SCOPE_LEVEL_MULTI="multi_year"

# ─────────────────────────────────────────────────────────────────────────────
# ROUTER
# ─────────────────────────────────────────────────────────────────────────────

_scope_route() {
  local cmd="${1:-dashboard}"
  shift || true
  case "$cmd" in
    ""|dashboard)      _scope_dashboard ;;
    inbox)             _scope_inbox_route "$@" ;;
    today)             _scope_today_route "$@" ;;
    task)              _scope_task_route "$@" ;;
    goal)              _scope_goal_route "$@" ;;
    reflect|reflection) _scope_reflect_route "$@" ;;
    cycle)             _scope_cycle_route "$@" ;;
    identity)          _scope_identity_route "$@" ;;
    plan)              _scope_plan ;;
    *)                 _ui_err "Unknown scope command: $cmd" >&2
                       printf '\n  Usage: sconlx scope [inbox|today|task|goal|reflect|cycle|identity|plan]\n\n' >&2 ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
# SCOPE DASHBOARD
# ─────────────────────────────────────────────────────────────────────────────

_scope_dashboard() {
  local eq_str; eq_str="$(_eq_today_short)"
  local today; today="$(_db_today)"
  local day_theme; day_theme="$(_db_day_theme)"
  local current_block; current_block="$(_db_current_block)"
  local theme_line="$day_theme"
  [[ -n "$current_block" ]] && theme_line="$day_theme  ·  $(_ui_bold "$current_block block")"

  _ui_section_scope "SCOPE" "$eq_str  ·  $(_ui_dim "$theme_line")"

  # Identity line
  if _db_identity_exists; then
    _db_identity_load
    printf '  %s  %s\n' \
      "$(_ui_dim "*")" \
      "$(_ui_italic "${SEASON_THEME:-${SEASON_NAME:-Unnamed Season}}")" >&2
    printf '  %s  %s\n' "$(_ui_dim "  ")" \
      "$(_ui_dim "${CORE_VALUES:-}")" >&2
  fi

  # Inbox
  local inbox_count inbox_stale
  inbox_count="$(_tsv_count "$_FLAT_SCOPE_INBOX" '$4=="new"')"
  inbox_stale="$(_scope_inbox_stale_count)"
  if [[ "$inbox_count" -gt 0 ]]; then
    local stale_note=""
    [[ "$inbox_stale" -gt 0 ]] && stale_note=" $(_ui_yellow "($inbox_stale stale)")"
    printf '\n  %s  %s  %s%s\n' \
      "Inbox" \
      "$(_ui_bold "INBOX")" \
      "$inbox_count item(s)" \
      "$stale_note" >&2
  else
    printf '\n  %s  %s  %s\n' \
      "Inbox" "$(_ui_bold "INBOX")" "$(_ui_dim "empty")" >&2
  fi

  # Today's tasks
  local today_count today_done_count
  today_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3=="today"')"
  today_done_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3=="done" && $10==strftime("%Y-%m-%d",systime())')" 2>/dev/null || today_done_count=0
  printf '\n  %s  %s\n' "Today" "$(_ui_bold "TODAY")" >&2
  if [[ "$today_count" -gt 0 ]]; then
    _scope_task_list_compact "today" 5
  else
    printf '  %s\n' "$(_ui_dim "  No tasks selected for today  → sconlx scope today add")" >&2
  fi

  # Goals
  local goal_count
  goal_count="$(_tsv_count "$_FLAT_SCOPE_GOALS" '$7=="active"')"
  printf '\n  %s  %s  %s\n' "Goals" "$(_ui_bold "GOALS")" \
    "$(_ui_dim "$goal_count active")" >&2
  if [[ "$goal_count" -gt 0 ]]; then
    _scope_goal_list_compact 3
  fi

  # Cycle
  printf '\n  %s  %s\n' "Cycle" "$(_ui_bold "CYCLE")" >&2
  _scope_cycle_compact

  # Reflection prompt
  local today_reflection
  today_reflection="$(_tsv_get "$_FLAT_SCOPE_REFLECTIONS_DIR/../reflections.tsv" "$today" 1 2>/dev/null || true)"
  if [[ -z "$today_reflection" ]]; then
    printf '\n  %s  %s\n' "$(_ui_yellow "○")" \
      "No reflection today  → $(_ui_dim "sconlx scope reflect")" >&2
  else
    printf '\n  %s  %s\n' "$(_ui_green "✓")" "Today's reflection done" >&2
  fi

  printf '\n  %s\n\n' "$(_ui_dim "sconlx scope --help  for all commands")" >&2
}

# ─────────────────────────────────────────────────────────────────────────────
# INBOX
# ─────────────────────────────────────────────────────────────────────────────

_scope_inbox_route() {
  case "${1:-list}" in
    list|"")   _scope_inbox_list ;;
    add)       shift; _scope_inbox_add "$*" ;;
    triage)    _scope_inbox_triage ;;
    *)         _ui_err "Usage: sconlx scope inbox [list|add|triage]" >&2 ;;
  esac
}

_scope_inbox_list() {
  local count; count="$(_tsv_count "$_FLAT_SCOPE_INBOX" '$4=="new"')"
  local stale; stale="$(_scope_inbox_stale_count)"

  _ui_section_scope "INBOX" "$count item(s)"

  if [[ "$stale" -gt 0 ]]; then
    _ui_warn "$stale item(s) stale  (>14 days — triage recommended)"
  fi

  if [[ "$count" -eq 0 ]]; then
    printf '  %s\n\n' "$(_ui_dim "Empty. Add something: sconlx scope inbox add \"Your thought\"")" >&2
    return 0
  fi

  local today; today="$(_db_today)"
  awk -F'\t' -v today="$today" 'NR>1 && $4=="new" {
    days=int(( \
      mktime(substr(today,1,4) " " substr(today,6,2) " " substr(today,9,2) " 0 0 0") - \
      mktime(substr($6,1,4) " " substr($6,6,2) " " substr($6,9,2) " 0 0 0") \
    ) / 86400)
    stale=(days>14) ? " !" : ""
    printf "  %-8s  %s%s\n", $1, $2, stale
  }' "$_FLAT_SCOPE_INBOX" >&2 || true

  printf '\n  %s\n\n' "$(_ui_dim "sconlx scope inbox triage  — process items one by one")" >&2
}

_scope_inbox_add() {
  local title="${1:-}"
  if [[ -z "$title" ]]; then
    title="$(_ui_prompt "Capture")" || { _ui_info "Cancelled." >&2; return 0; }
  fi
  [[ -z "$title" ]] && { _ui_warn "Nothing captured." >&2; return 0; }

  local id; id="$(_db_next_id "C" "$_FLAT_SCOPE_INBOX")"
  local now; now="$(_db_now)"
  local today; today="$(_db_today)"
  local eq_year eq_cycle eq_day eq_theme
  IFS=$'\t' read -r eq_year eq_cycle eq_day eq_theme <<< "$(_eq_today_fields)"

  local safe_title; safe_title="$(_tsv_safe "$title")"
  printf '%s\t%s\t\tnew\tsconlx\t%s\t%s\t%s\t%s\n' \
    "$id" "$safe_title" "$today" "$eq_year" "$eq_cycle" "$eq_day" \
    >> "$_FLAT_SCOPE_INBOX"

  _ev_write "sconlx.capture" "{\"title\":\"$safe_title\",\"inbox_id\":\"$id\"}"
  _ui_cap "Captured [$id] — Cycle $eq_cycle, Day $eq_day"
}

_scope_inbox_stale_count() {
  [[ -f "$_FLAT_SCOPE_INBOX" ]] || { printf '0'; return 0; }
  local today; today="$(_db_today)"
  awk -F'\t' -v today="$today" '
    NR>1 && $4=="new" {
      cmd="date -d " $6 " +%s 2>/dev/null || date -jf %Y-%m-%d " $6 " +%s 2>/dev/null"
      cmd | getline d_epoch; close(cmd)
      cmd2="date -d " today " +%s 2>/dev/null || date -jf %Y-%m-%d " today " +%s 2>/dev/null"
      cmd2 | getline t_epoch; close(cmd2)
      if ((t_epoch - d_epoch) / 86400 > 14) count++
    }
    END {print count+0}
  ' "$_FLAT_SCOPE_INBOX" 2>/dev/null || printf '0'
}

_scope_inbox_triage() {
  local pending
  pending="$(awk -F'\t' 'NR>1 && $4=="new" {print}' "$_FLAT_SCOPE_INBOX" 2>/dev/null || true)"
  local count; count="$(printf '%s\n' "$pending" | wc -l | tr -d ' ')"
  count="${count:-0}"

  [[ "$count" -eq 0 ]] && { _ui_ok "Inbox empty — nothing to triage." >&2; return 0; }

  printf '\n  %s  TRIAGE  (%s items)\n' "Inbox" "$count" >&2
  printf '  %s\n\n' "$(_ui_dim "For each item: [t]ask  [g]oal  [s]omeday  [d]elete  [k]eep  [q]uit")" >&2

  while IFS=$'\t' read -r id title body status source captured eq_yr eq_c eq_d; do
    [[ -z "$id" ]] && continue
    printf '  %-8s  %s\n' "$(_ui_bold "$id")" "$title" >&2
    printf '  %s\n' "$(_ui_dim "captured: $captured")" >&2
    printf '  Action: ' >&2
    local action
    IFS= read -r action

    case "${action,,}" in
      t|task)
        _scope_task_add_from_inbox "$id" "$title"
        _tsv_update_field "$_FLAT_SCOPE_INBOX" "$id" 4 "archived"
        _ui_ok "→ Added to tasks" >&2
        ;;
      g|goal)
        _scope_goal_add_from_inbox "$id" "$title"
        _tsv_update_field "$_FLAT_SCOPE_INBOX" "$id" 4 "archived"
        _ui_ok "→ Added as goal" >&2
        ;;
      s|someday)
        _tsv_update_field "$_FLAT_SCOPE_INBOX" "$id" 4 "someday"
        _ui_ok "→ Moved to someday" >&2
        ;;
      d|delete)
        _tsv_update_field "$_FLAT_SCOPE_INBOX" "$id" 4 "archived"
        _ui_ok "→ Deleted" >&2
        ;;
      q|quit)
        _ui_info "Triage paused." >&2; return 0 ;;
      *)
        # keep — no change
        _ui_dim "→ Kept in inbox" >&2 ;;
    esac
    printf '\n' >&2
  done <<< "$pending"

  _ui_ok "Triage complete." >&2
}

# ─────────────────────────────────────────────────────────────────────────────
# TODAY
# ─────────────────────────────────────────────────────────────────────────────

_scope_today_route() {
  case "${1:-list}" in
    list|"") _scope_today_list ;;
    add)     shift; _scope_today_add "$@" ;;
    clear)   _scope_today_clear ;;
    *)       _ui_err "Usage: sconlx scope today [list|add|clear]" >&2 ;;
  esac
}

_scope_today_list() {
  local eq_str; eq_str="$(_eq_today_short)"
  printf '\n  %s  TODAY  ·  %s\n' "Today" "$eq_str" >&2
  _ui_hr
  _scope_task_list_compact "today" 20
  local deferred_count
  deferred_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3=="deferred"')"
  [[ "$deferred_count" -gt 0 ]] && \
    printf '  %s  %s deferred task(s)\n' "$(_ui_yellow "↩")" "$deferred_count" >&2
  printf '\n  %s\n\n' "$(_ui_dim "sconlx scope task add  ·  sconlx scope task done <id>")" >&2
}

_scope_today_add() {
  local task_id="${1:-}"
  [[ -z "$task_id" ]] && { _ui_err "Usage: sconlx scope today add <task-id>" >&2; return 1; }
  if ! _tsv_exists "$_FLAT_SCOPE_TASKS" "$task_id"; then
    _ui_err "Task $task_id not found." >&2; return 1
  fi
  _tsv_update_field "$_FLAT_SCOPE_TASKS" "$task_id" 3 "today"
  _tsv_update_field "$_FLAT_SCOPE_TASKS" "$task_id" 10 "$(_db_today)"
  _ui_ok "Task $task_id moved to Today." >&2
}

_scope_today_clear() {
  _ui_confirm "Move all today's tasks back to backlog?" || return 0
  local tmp; tmp="$(mktemp)"
  awk -F'\t' -v OFS='\t' \
    'NR==1 {print; next} $3=="today" {$3="backlog"; print; next} {print}' \
    "$_FLAT_SCOPE_TASKS" > "$tmp"
  mv "$tmp" "$_FLAT_SCOPE_TASKS"
  _ui_ok "Cleared today's task list." >&2
}

# ─────────────────────────────────────────────────────────────────────────────
# TASKS
# ─────────────────────────────────────────────────────────────────────────────

_scope_task_route() {
  case "${1:-list}" in
    list|"")  shift; _scope_task_list "$@" ;;
    add)      shift; _scope_task_add "$*" ;;
    done)     shift; _scope_task_done "$1" ;;
    defer)    shift; _scope_task_defer "$1" ;;
    del)      shift; _scope_task_del "$1" ;;
    show)     shift; _scope_task_show "$1" ;;
    *)        _ui_err "Usage: sconlx scope task [list|add|done|defer|del|show] [id]" >&2 ;;
  esac
}

_scope_task_list() {
  local filter="${1:-}"
  local eq_str; eq_str="$(_eq_today_short)"
  _ui_section_scope "TASKS" "$eq_str" >&2
  _ui_hr

  # Determine which statuses to show
  local show_today=1 show_backlog=1 show_deferred=1 show_done=1
  case "$filter" in
    --today)    show_backlog=0; show_deferred=0; show_done=0 ;;
    --backlog)  show_today=0; show_deferred=0; show_done=0 ;;
    --all)      : ;;  # show everything
  esac

  if [[ $show_today -eq 1 ]]; then
    local today_count; today_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3=="today"')"
    [[ "$today_count" -gt 0 ]] && {
      printf '\n  %s\n' "$(_ui_bold "TODAY ($today_count)")" >&2
      _scope_task_list_compact "today" 20
    }
  fi

  if [[ $show_deferred -eq 1 ]]; then
    local def_count; def_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3=="deferred"')"
    [[ "$def_count" -gt 0 ]] && {
      printf '\n  %s\n' "$(_ui_yellow "DEFERRED ($def_count)")" >&2
      _scope_task_list_compact "deferred" 10
    }
  fi

  if [[ $show_backlog -eq 1 ]]; then
    local bl_count; bl_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3=="backlog"')"
    [[ "$bl_count" -gt 0 ]] && {
      printf '\n  %s\n' "$(_ui_dim "BACKLOG ($bl_count)")" >&2
      _scope_task_list_compact "backlog" 8
    }
  fi

  if [[ $show_done -eq 1 ]]; then
    local done_count; done_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3=="done"')"
    [[ "$done_count" -gt 0 ]] && \
      printf '\n  %s\n' "$(_ui_dim "DONE this cycle: $done_count")" >&2
  fi

  printf '\n  %s\n\n' "$(_ui_dim "sconlx scope task add  ·  done <id>  ·  defer <id>")" >&2
}

_scope_task_list_compact() {
  local status="${1:-backlog}" limit="${2:-5}"
  [[ -f "$_FLAT_SCOPE_TASKS" ]] || return 0
  awk -F'\t' -v s="$status" -v lim="$limit" -v warn="$_SCOPE_DEFERRED_WARN" '
    NR>1 && $3==s {
      badge = (s=="done") ? "+" : (s=="deferred") ? "~" : (s=="today") ? ">" : "○"
      cf = ($6+0 > 0) ? " ×" $6 : ""
      pri = ($4=="high") ? " [high]" : ($4=="low") ? " [low]" : ""
      due = ($7!="-" && $7!="") ? "  due:" $7 : ""
      printf "  %-8s  %s  %-40s%s%s%s\n", $1, badge, substr($2,1,40), pri, cf, due
      if (++count >= lim) {
        if (NR < 999) printf "  %s\n", "  … more items"
        exit
      }
    }' "$_FLAT_SCOPE_TASKS" >&2 || true
}

_scope_task_add() {
  local title="${1:-}"

  _ui_section "ADD TASK"

  if [[ -z "$title" ]]; then
    title="$(_ui_prompt "Title")" || { _ui_info "Cancelled." >&2; return 0; }
  fi
  [[ -z "$title" ]] && { _ui_warn "No title given." >&2; return 0; }

  local priority
  priority="$(_ui_prompt "Priority [high/med/low]" "med")"
  case "${priority,,}" in h|high) priority="high" ;; l|low) priority="low" ;; *) priority="med" ;; esac

  local due
  due="$(_ui_prompt "Due date [YYYY-MM-DD or blank]" "")"
  [[ -z "$due" ]] && due="-"

  local add_today
  _ui_confirm "Add to Today's list?" "n" && add_today=1 || add_today=0

  local id; id="$(_db_next_id "T" "$_FLAT_SCOPE_TASKS")"
  local now; now="$(_db_today)"
  local status="backlog"
  [[ $add_today -eq 1 ]] && status="today"

  printf '%s\t%s\t%s\t%s\t\t0\t%s\tmedium\t%s\t%s\n' \
    "$id" "$(_tsv_safe "$title")" "$status" "$priority" "$due" "$now" "$now" \
    >> "$_FLAT_SCOPE_TASKS"

  _ui_cap "Task $id created: $title"
  [[ $add_today -eq 1 ]] && _ui_info "Added to today's list." >&2
}

_scope_task_add_from_inbox() {
  local inbox_id="${1:-}" title="${2:-}"
  local id; id="$(_db_next_id "T" "$_FLAT_SCOPE_TASKS")"
  local now; now="$(_db_today)"
  printf '%s\t%s\tbacklog\tmed\t\t0\t-\tmedium\t%s\t%s\n' \
    "$id" "$(_tsv_safe "$title")" "$now" "$now" \
    >> "$_FLAT_SCOPE_TASKS"
  _ui_ok "Task $id: $title" >&2
}

_scope_task_done() {
  local id="${1:-}"
  [[ -z "$id" ]] && { _ui_err "Usage: sconlx scope task done <id>" >&2; return 1; }
  if ! _tsv_exists "$_FLAT_SCOPE_TASKS" "$id"; then
    _ui_err "Task $id not found." >&2; return 1
  fi
  _tsv_update_field "$_FLAT_SCOPE_TASKS" "$id" 3 "done"
  _tsv_update_field "$_FLAT_SCOPE_TASKS" "$id" 10 "$(_db_today)"
  local title; title="$(_tsv_get "$_FLAT_SCOPE_TASKS" "$id" 2)"
  _ui_cap "Done: $title  [$id]"
  _ev_write "scope.task.completed" "{\"task_id\":\"$id\",\"title\":\"$title\"}"
}

_scope_task_defer() {
  local id="${1:-}"
  [[ -z "$id" ]] && { _ui_err "Usage: sconlx scope task defer <id>" >&2; return 1; }
  if ! _tsv_exists "$_FLAT_SCOPE_TASKS" "$id"; then
    _ui_err "Task $id not found." >&2; return 1
  fi
  # Increment carry_forward count
  local cf; cf="$(_tsv_get "$_FLAT_SCOPE_TASKS" "$id" 6)"
  cf=$(( ${cf:-0} + 1 ))
  _tsv_update_field "$_FLAT_SCOPE_TASKS" "$id" 3 "deferred"
  _tsv_update_field "$_FLAT_SCOPE_TASKS" "$id" 6 "$cf"
  _tsv_update_field "$_FLAT_SCOPE_TASKS" "$id" 10 "$(_db_today)"
  local title; title="$(_tsv_get "$_FLAT_SCOPE_TASKS" "$id" 2)"
  _ui_warn "Deferred: $title ×$cf"
  [[ $cf -ge $_SCOPE_DEFERRED_WARN ]] && \
    _ui_warn "Deferred $cf times — consider removing or breaking this down."
}

_scope_task_del() {
  local id="${1:-}"
  [[ -z "$id" ]] && { _ui_err "Usage: sconlx scope task del <id>" >&2; return 1; }
  local title; title="$(_tsv_get "$_FLAT_SCOPE_TASKS" "$id" 2)"
  _ui_confirm "Archive task '$title'?" || return 0
  _tsv_update_field "$_FLAT_SCOPE_TASKS" "$id" 3 "archived"
  _ui_ok "Task $id archived." >&2
}

_scope_task_show() {
  local id="${1:-}"
  [[ -z "$id" ]] && { _ui_err "Usage: sconlx scope task show <id>" >&2; return 1; }
  if ! _tsv_exists "$_FLAT_SCOPE_TASKS" "$id"; then
    _ui_err "Task $id not found." >&2; return 1
  fi
  awk -F'\t' -v id="$id" 'NR>1 && $1==id {
    printf "\n  Task:      %s\n", $1
    printf "  Title:     %s\n", $2
    printf "  Status:    %s\n", $3
    printf "  Priority:  %s\n", $4
    printf "  Deferred:  %s time(s)\n", $6
    printf "  Due:       %s\n", $7
    printf "  Created:   %s\n", $9
    printf "\n"
  }' "$_FLAT_SCOPE_TASKS" >&2 || true
}

# ─────────────────────────────────────────────────────────────────────────────
# GOALS
# ─────────────────────────────────────────────────────────────────────────────

_scope_goal_route() {
  case "${1:-list}" in
    list|"")  _scope_goal_list ;;
    add)      _scope_goal_add ;;
    show)     shift; _scope_goal_show "$1" ;;
    kpi)      shift; _scope_goal_kpi "$1" "$2" ;;
    done)     shift; _scope_goal_done "$1" ;;
    *)        _ui_err "Usage: sconlx scope goal [list|add|show|kpi|done] [id]" >&2 ;;
  esac
}

_scope_goal_list() {
  local count; count="$(_tsv_count "$_FLAT_SCOPE_GOALS" '$7=="active"')"
  printf '\n  %s  GOALS  (%s active)\n' "Goals" "$count" >&2
  _ui_hr

  if [[ "$count" -eq 0 ]]; then
    printf '  %s\n\n' "$(_ui_dim "No active goals. Add one: sconlx scope goal add")" >&2
    return 0
  fi

  awk -F'\t' '
    NR>1 && $7=="active" {
      pct = ($4+0 > 0) ? int($5*100/$4) : 0
      bar = ""
      for (i=1; i<=10; i++) bar = bar (i <= int(pct/10) ? "█" : "░")
      printf "  %-8s  %-35s  %s %d%%\n", $1, substr($2,1,35), bar, pct
    }' "$_FLAT_SCOPE_GOALS" >&2 || true

  printf '\n  %s\n\n' "$(_ui_dim "sconlx scope goal show <id>  ·  sconlx scope goal kpi <id> <value>")" >&2
}

_scope_goal_list_compact() {
  local limit="${1:-3}"
  [[ -f "$_FLAT_SCOPE_GOALS" ]] || return 0
  awk -F'\t' -v lim="$limit" '
    NR>1 && $7=="active" {
      pct = ($4+0 > 0) ? int($5*100/$4) : 0
      bar = ""
      for (i=1; i<=8; i++) bar = bar (i <= int(pct/8) ? "█" : "░")
      printf "  %-8s  %-35s  %s%d%%\n", $1, substr($2,1,35), bar, pct
      if (++count >= lim) exit
    }' "$_FLAT_SCOPE_GOALS" >&2 || true
}

_scope_goal_add() {
  printf '\n  %s  ADD GOAL\n' "$(_ui_bold "+")" >&2
  _ui_hr

  local title; title="$(_ui_prompt "Goal title")" || { _ui_info "Cancelled." >&2; return 0; }
  [[ -z "$title" ]] && { _ui_warn "No title given." >&2; return 0; }

  local kpi; kpi="$(_ui_prompt "KPI (what you'll measure, e.g. 'pages written')" "")"
  local target; target="$(_ui_prompt "Target value" "1")"
  local level
  level="$(_ui_menu "Level" "cycle (4 weeks)" "annual (this year)" "multi-year")"
  case "$level" in
    *cycle*)   level="cycle" ;;
    *annual*)  level="annual" ;;
    *)         level="multi_year" ;;
  esac

  local id; id="$(_db_next_id "G" "$_FLAT_SCOPE_GOALS")"
  local now; now="$(_db_today)"

  printf '%s\t%s\t%s\t%s\t0\t%s\tactive\t1\t%s\t%s\n' \
    "$id" "$(_tsv_safe "$title")" "$(_tsv_safe "$kpi")" "$target" \
    "$level" "$now" "$now" \
    >> "$_FLAT_SCOPE_GOALS"

  _ui_cap "Goal $id: $title"
  _ui_info "Track progress: sconlx scope goal kpi $id <value>" >&2
}

_scope_goal_add_from_inbox() {
  local inbox_id="${1:-}" title="${2:-}"
  local id; id="$(_db_next_id "G" "$_FLAT_SCOPE_GOALS")"
  local now; now="$(_db_today)"
  printf '%s\t%s\t\t1\t0\tcycle\tactive\t1\t%s\t%s\n' \
    "$id" "$(_tsv_safe "$title")" "$now" "$now" \
    >> "$_FLAT_SCOPE_GOALS"
  _ui_ok "Goal $id: $title" >&2
}

_scope_goal_show() {
  local id="${1:-}"
  [[ -z "$id" ]] && { _ui_err "Usage: sconlx scope goal show <id>" >&2; return 1; }
  awk -F'\t' -v id="$id" 'NR>1 && $1==id {
    pct = ($4+0 > 0) ? int($5*100/$4) : 0
    printf "\n  Goal:      %s\n", $1
    printf "  Title:     %s\n", $2
    printf "  KPI:       %s\n", $3
    printf "  Progress:  %s / %s  (%d%%)\n", $5, $4, pct
    printf "  Level:     %s\n", $6
    printf "  Status:    %s\n", $7
    printf "  Created:   %s\n", $9
    printf "\n"
  }' "$_FLAT_SCOPE_GOALS" >&2 || true
}

_scope_goal_kpi() {
  local id="${1:-}" value="${2:-}"
  [[ -z "$id" || -z "$value" ]] && {
    _ui_err "Usage: sconlx scope goal kpi <id> <value>" >&2; return 1
  }
  if ! _tsv_exists "$_FLAT_SCOPE_GOALS" "$id"; then
    _ui_err "Goal $id not found." >&2; return 1
  fi
  local prev_value; prev_value="$(_tsv_get "$_FLAT_SCOPE_GOALS" "$id" 5)"
  _tsv_update_field "$_FLAT_SCOPE_GOALS" "$id" 5 "$value"
  _tsv_update_field "$_FLAT_SCOPE_GOALS" "$id" 10 "$(_db_today)"
  local title; title="$(_tsv_get "$_FLAT_SCOPE_GOALS" "$id" 2)"
  local target; target="$(_tsv_get "$_FLAT_SCOPE_GOALS" "$id" 4)"
  local pct=$(( target > 0 ? value * 100 / target : 0 ))
  _ui_cap "KPI updated: $title"
  printf '  %s → %s / %s  (%d%%)\n\n' "$prev_value" "$value" "$target" "$pct" >&2
  _ev_write "scope.goal.progress" "{\"goal_id\":\"$id\",\"value\":$value,\"pct\":$pct}"
}

_scope_goal_done() {
  local id="${1:-}"
  [[ -z "$id" ]] && { _ui_err "Usage: sconlx scope goal done <id>" >&2; return 1; }
  _ui_confirm "Mark goal $id as complete?" || return 0
  _tsv_update_field "$_FLAT_SCOPE_GOALS" "$id" 7 "completed"
  local title; title="$(_tsv_get "$_FLAT_SCOPE_GOALS" "$id" 2)"
  _ui_cap "Goal completed: $title"
}

# ─────────────────────────────────────────────────────────────────────────────
# REFLECTION
# ─────────────────────────────────────────────────────────────────────────────

_scope_reflect_route() {
  case "${1:-}" in
    view)    _scope_reflect_view ;;
    history) _scope_reflect_history ;;
    *)       _scope_reflect_guided ;;
  esac
}

_scope_reflect_guided() {
  local today; today="$(_db_today)"
  local eq_str; eq_str="$(_eq_today_short)"
  local reflection_file="$_FLAT_SCOPE_REFLECTIONS_DIR/${today}.md"

  if [[ -f "$reflection_file" ]]; then
    printf '\n  Reflection already written today.\n' >&2
    _ui_confirm "Write a new/additional reflection anyway?" "n" || return 0
  fi

  printf '\n  Daily Reflection  ·  %s\n' "$eq_str" >&2
  _ui_hr
  printf '  %s\n\n' "$(_ui_dim "Answer honestly — this is for you, not for show.")" >&2

  printf '  %s\n' "$(_ui_bold "1. What happened today?")" >&2
  local q1; q1="$(_ui_prompt "  >")"

  printf '\n  %s\n' "$(_ui_bold "2. What mattered most?")" >&2
  local q2; q2="$(_ui_prompt "  >")"

  printf '\n  %s\n' "$(_ui_bold "3. What resisted you?")" >&2
  local q3; q3="$(_ui_prompt "  >")"

  # Context-aware prompt based on deferred tasks
  local most_deferred
  most_deferred="$(awk -F'\t' 'NR>1 && $3=="deferred" {print $6"\t"$2}' \
    "$_FLAT_SCOPE_TASKS" 2>/dev/null | sort -rn | head -1 | cut -f2- || true)"
  if [[ -n "$most_deferred" ]]; then
    printf '\n  %s\n' "$(_ui_bold "4. \"$(_ui_truncate "$most_deferred" 40)\" keeps getting deferred. What's in the way?")" >&2
    local q4; q4="$(_ui_prompt "  >")"
  else
    local q4=""
  fi

  printf '\n  %s  ' "$(_ui_bold "Mood (one word):")" >&2
  local mood; IFS= read -r mood
  printf '  %s  ' "$(_ui_bold "Energy (1-10):")" >&2
  local energy; IFS= read -r energy

  # Write the reflection markdown file
  cat > "$reflection_file" <<REFLECT
# Reflection — $today
**Equicycle:** $eq_str
**Mood:** $mood  **Energy:** $energy

## What happened today?
$q1

## What mattered most?
$q2

## What resisted you?
$q3

$([ -n "$q4" ] && printf '## Context prompt\n%s\n' "$q4")
REFLECT

  # Track in TSV for stats
  local ref_tsv="$_FLAT_SCOPE_DIR/reflections.tsv"
  _db_init_tsv "$ref_tsv" "DATE\tMOOD\tENERGY\tHAS_CONTENT"
  local existing; existing="$(grep -F "$today" "$ref_tsv" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$existing" -eq 0 ]]; then
    printf '%s\t%s\t%s\t1\n' "$today" "$mood" "$energy" >> "$ref_tsv"
  fi

  printf '\n' >&2
  _ui_cap "Reflection saved."
  _ui_info "Open in Spark: sconlx spark journal — you'll be offered an expansion." >&2
  _ev_write "scope.reflection.saved" "{\"date\":\"$today\",\"mood\":\"$mood\"}"
}

_scope_reflect_view() {
  local today; today="$(_db_today)"
  local reflection_file="$_FLAT_SCOPE_REFLECTIONS_DIR/${today}.md"
  if [[ -f "$reflection_file" ]]; then
    cat "$reflection_file" >&2
  else
    _ui_info "No reflection for today. Run: sconlx scope reflect" >&2
  fi
}

_scope_reflect_history() {
  printf '\n  REFLECTION HISTORY\n' >&2
  _ui_hr
  local ref_tsv="$_FLAT_SCOPE_DIR/reflections.tsv"
  if [[ -f "$ref_tsv" ]]; then
    awk -F'\t' 'NR>1 {printf "  %-12s  %-15s  %s/10\n", $1, $2, $3}' \
      "$ref_tsv" | tail -14 >&2 || true
  else
    _ui_info "No reflections yet." >&2
  fi
  printf '\n' >&2
}

# ─────────────────────────────────────────────────────────────────────────────
# CYCLE
# ─────────────────────────────────────────────────────────────────────────────

_scope_cycle_route() {
  case "${1:-}" in
    list)    _scope_cycle_list ;;
    plan)    _scope_cycle_plan ;;
    review)  _scope_cycle_review ;;
    *)       _scope_cycle_view ;;
  esac
}

_scope_cycle_view() {
  local eq_year eq_cycle eq_day eq_theme
  IFS=$'\t' read -r eq_year eq_cycle eq_day eq_theme <<< "$(_eq_today_fields)"

  local start_date end_date
  IFS=$'\t' read -r start_date end_date <<< "$(_eq_cycle_range "$eq_year" "$eq_cycle")"

  printf '\n  %s  CYCLE %s  —  %s\n' "Cycle" "$eq_cycle" "$eq_theme" >&2
  _ui_hr
  printf '  %s → %s\n\n' "$start_date" "$end_date" >&2

  local progress; progress="$(_eq_progress)"
  printf '  %s\n' "$progress" >&2

  # Reflection streak
  local ref_tsv="$_FLAT_SCOPE_DIR/reflections.tsv"
  if [[ -f "$ref_tsv" ]]; then
    local done_days
    done_days="$(tail -n +2 "$ref_tsv" 2>/dev/null | wc -l | tr -d ' ')"
    printf '\n  Reflections: %s / %s days\n' "$done_days" "$eq_day" >&2
  fi

  # Cycle objectives (from cycles.tsv)
  local cycle_row
  cycle_row="$(awk -F'\t' -v y="$eq_year" -v c="$eq_cycle" \
    'NR>1 && $2==y && $3==c {print; exit}' "$_FLAT_SCOPE_CYCLES" 2>/dev/null || true)"
  if [[ -n "$cycle_row" ]]; then
    printf '\n  %s\n' "$(_ui_bold "Objectives:")" >&2
    local obj1 obj2 obj3
    IFS=$'\t' read -r _ _ _ _ _ _ _ obj1 obj2 obj3 <<< "$cycle_row"
    [[ -n "$obj1" ]] && printf '  %s  %s\n' "○" "$obj1" >&2
    [[ -n "$obj2" ]] && printf '  %s  %s\n' "○" "$obj2" >&2
    [[ -n "$obj3" ]] && printf '  %s  %s\n' "○" "$obj3" >&2
  fi

  printf '\n  %s\n\n' "$(_ui_dim "sconlx scope cycle plan  ·  sconlx scope cycle review")" >&2
}

_scope_cycle_compact() {
  local eq_year eq_cycle eq_day eq_theme
  IFS=$'\t' read -r eq_year eq_cycle eq_day eq_theme <<< "$(_eq_today_fields)"
  local progress; progress="$(_eq_progress)"
  printf '  Cycle %s · %s\n' "$eq_cycle" "$eq_theme" >&2
  printf '  %s\n' "$progress" >&2
}

_scope_cycle_list() {
  printf '\n  CYCLES  ·  Equicycle Year %s\n' "$(date +%Y)" >&2
  _ui_hr
  local i theme
  local eq_year; eq_year="$(python3 "$_EQUICYCLE_PY" --format fields 2>/dev/null | cut -f1)"
  for i in $(seq 1 13); do
    theme="$(python3 -c "
themes=['Genesis','Momentum','Ascent','Harvest','Depth','Synthesis','Renewal',
        'Vision','Growth','Creation','Flow','Preparation','Reflection']
print(themes[$i-1])" 2>/dev/null || echo "Cycle $i")"
    local start end
    IFS=$'\t' read -r start end <<< "$(_eq_cycle_range "$eq_year" "$i")"
    printf '  Cycle %-2s  %-15s  %s → %s\n' "$i" "$theme" "$start" "$end" >&2
  done
  printf '\n' >&2
}

_scope_cycle_plan() {
  local eq_year eq_cycle eq_day eq_theme
  IFS=$'\t' read -r eq_year eq_cycle eq_day eq_theme <<< "$(_eq_today_fields)"

  printf '\n  CYCLE PLANNING  ·  Cycle %s — %s\n' "$eq_cycle" "$eq_theme" >&2
  _ui_hr
  printf '  %s\n\n' "$(_ui_dim "What are the 3 most important things to complete this cycle?")" >&2

  local obj1; obj1="$(_ui_prompt "Objective 1")"
  local obj2; obj2="$(_ui_prompt "Objective 2 (optional)" "")"
  local obj3; obj3="$(_ui_prompt "Objective 3 (optional)" "")"

  # Record cycle plan
  local id; id="$(_db_next_id "CY" "$_FLAT_SCOPE_CYCLES")"
  local start end
  IFS=$'\t' read -r start end <<< "$(_eq_cycle_range "$eq_year" "$eq_cycle")"

  _db_init_tsv "$_FLAT_SCOPE_CYCLES" "ID\tEQ_YEAR\tCYCLE_NUM\tTHEME\tSTART_DATE\tEND_DATE\tSTATUS\tOBJ1\tOBJ2\tOBJ3"

  # Check if this cycle already has a record — update if so
  local existing; existing="$(awk -F'\t' -v y="$eq_year" -v c="$eq_cycle" \
    'NR>1 && $2==y && $3==c {print $1; exit}' "$_FLAT_SCOPE_CYCLES" 2>/dev/null || true)"

  if [[ -n "$existing" ]]; then
    _tsv_update_field "$_FLAT_SCOPE_CYCLES" "$existing" 8 "$obj1"
    _tsv_update_field "$_FLAT_SCOPE_CYCLES" "$existing" 9 "$obj2"
    _tsv_update_field "$_FLAT_SCOPE_CYCLES" "$existing" 10 "$obj3"
  else
    printf '%s\t%s\t%s\t%s\t%s\t%s\tactive\t%s\t%s\t%s\n' \
      "$id" "$eq_year" "$eq_cycle" "$eq_theme" "$start" "$end" \
      "$(_tsv_safe "$obj1")" "$(_tsv_safe "$obj2")" "$(_tsv_safe "$obj3")" \
      >> "$_FLAT_SCOPE_CYCLES"
  fi

  _ui_cap "Cycle $eq_cycle plan saved."
}

_scope_cycle_review() {
  local eq_year eq_cycle eq_day eq_theme
  IFS=$'\t' read -r eq_year eq_cycle eq_day eq_theme <<< "$(_eq_today_fields)"

  printf '\n  CYCLE REVIEW  ·  Cycle %s — %s\n' "$eq_cycle" "$eq_theme" >&2
  _ui_hr
  printf '  %s\n\n' "$(_ui_dim "Reflection on this cycle before you close it.")" >&2

  local done_count; done_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3=="done"')"
  local total_count; total_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3!="archived"')"
  printf '  Tasks completed this cycle: %s / %s\n\n' "$done_count" "$total_count" >&2

  printf '  %s\n' "$(_ui_bold "What did you accomplish?")" >&2
  local q1; q1="$(_ui_prompt "  >")"

  printf '\n  %s\n' "$(_ui_bold "What will you carry into the next cycle?")" >&2
  local q2; q2="$(_ui_prompt "  >")"

  local today; today="$(_db_today)"
  local review_file="$_FLAT_SCOPE_REFLECTIONS_DIR/cycle_${eq_cycle}_review.md"
  cat > "$review_file" <<REVIEW
# Cycle $eq_cycle Review — $today
**Theme:** $eq_theme

## Accomplishments
$q1

## Carrying Forward
$q2
REVIEW

  _ui_cap "Cycle review saved."
}

# ─────────────────────────────────────────────────────────────────────────────
# IDENTITY
# ─────────────────────────────────────────────────────────────────────────────

_scope_identity_route() {
  case "${1:-view}" in
    view|"")      _scope_identity_view ;;
    north-star)   _scope_identity_north_star ;;
    season)       _scope_identity_season ;;
    edit)         _scope_identity_edit ;;
    *)            _scope_identity_view ;;
  esac
}

_scope_identity_view() {
  _ui_section "IDENTITY"

  if ! _db_identity_exists; then
    _ui_info "Identity not set up yet."
    _ui_hint "Run: sconlx scope identity edit"
    _ui_blank
    return 0
  fi

  _db_identity_load

  # North Star
  _ui_subsection "North Star"
  printf '%s  %s\n' "$_UI_INDENT" "${NORTH_STAR:-—}" >&2
  [[ -n "${DECADE_VISION:-}" ]] &&     printf '%s  %s\n' "$_UI_INDENT" "$(_ui_dim "${DECADE_VISION}")" >&2

  # Core Values
  _ui_blank
  _ui_subsection "Core Values"
  IFS='|' read -ra vals <<< "${CORE_VALUES:-—}"
  for v in "${vals[@]}"; do
    [[ -n "${v// /}" ]] && printf '%s  %s  %s\n' "$_UI_INDENT" "$(_ui_dim "·")" "${v## }" >&2
  done

  # Current Season
  _ui_blank
  _ui_subsection "Season  ·  ${SEASON_NAME:-}"
  printf '%s  %s\n' "$_UI_INDENT" "${SEASON_THEME:-}" >&2
  printf '%s  %s\n' "$_UI_INDENT" "$(_ui_dim "${SEASON_WORD:-}  ·  ${SEASON_YEAR:-}")" >&2

  # Annual Intentions
  if [[ -n "${ANNUAL_INTENTIONS:-}" ]]; then
    _ui_blank
    _ui_subsection "This Year"
    IFS='|' read -ra ints <<< "${ANNUAL_INTENTIONS}"
    for intent in "${ints[@]}"; do
      local trimmed="${intent## }"
      [[ -n "${trimmed// /}" ]] && printf '%s  %s  %s\n' "$_UI_INDENT" "$(_ui_dim "·")" "$trimmed" >&2
    done
  fi

  # Birthday / age
  if [[ -n "${BIRTHDAY:-}" ]]; then
    _ui_blank
    _ctx_load 2>/dev/null || true
    [[ -n "${CTX_AGE_SHORT:-}" ]] &&       printf '%s  %s  %s\n' "$_UI_INDENT" "$(_ui_dim "Age")" "${CTX_AGE_SHORT}  $(_ui_dim "·  ${CTX_DAYS_TO_BDAY}d to birthday (turning ${CTX_TURNING})")" >&2
  fi
  _ui_blank
}

_scope_identity_edit() {
  _ui_section "IDENTITY SETUP"
  _ui_hint "Your foundation layer. Take a few minutes — this anchors everything else."
  _ui_hint "Type [q] at any prompt to cancel without saving."
  _ui_blank

  _db_identity_load 2>/dev/null || true

  # ── North Star ──
  _ui_subsection "North Star"
  _ui_hint "Your life purpose in one sentence. The thing you're ultimately about."
  local north_star
  north_star="$(_ui_prompt "North Star" "${NORTH_STAR:-}")" || {
    _ui_info "Identity setup cancelled."; return 0
  }

  # ── Decade Vision ──
  _ui_subsection "Decade Vision"
  _ui_hint "Where are you in 10 years? One or two sentences."
  local decade
  decade="$(_ui_prompt "10-year vision" "${DECADE_VISION:-}")" || {
    _ui_info "Identity setup cancelled."; return 0
  }

  # ── Core Values ──
  _ui_subsection "Core Values"
  _ui_hint "3–5 values that define how you operate. Separate with |"
  _ui_hint "Example: Integrity|Mastery|Impact|Curiosity"
  local values
  values="$(_ui_prompt "Values" "${CORE_VALUES:-}")" || {
    _ui_info "Identity setup cancelled."; return 0
  }

  # ── Current Season ──
  _ui_subsection "Current Season"
  _ui_hint "A season is your current life chapter — roughly a year."
  local season_name
  season_name="$(_ui_prompt "Season name" "${SEASON_NAME:-}" "e.g. 'Mastery & Creation'")" || {
    _ui_info "Identity setup cancelled."; return 0
  }
  local season_word
  season_word="$(_ui_prompt "Season word  (one word)" "${SEASON_WORD:-}" "e.g. 'Build'")" || {
    _ui_info "Identity setup cancelled."; return 0
  }
  local season_theme
  season_theme="$(_ui_prompt "Season theme statement" "${SEASON_THEME:-}" "e.g. 'This year is for building deeply'")" || {
    _ui_info "Identity setup cancelled."; return 0
  }
  local season_year
  season_year="$(_ui_prompt "Season year" "${SEASON_YEAR:-$(date +%Y)}")" || {
    _ui_info "Identity setup cancelled."; return 0
  }

  # ── Annual Intentions ──
  _ui_subsection "Annual Intentions"
  _ui_hint "2–4 big things you intend to do this year. Separate with |"
  local intentions
  intentions="$(_ui_prompt "Intentions" "${ANNUAL_INTENTIONS:-}")" || {
    _ui_info "Identity setup cancelled."; return 0
  }

  # ── Birthday ──
  _ui_subsection "Birthday"
  _ui_hint "Used to show your exact age and countdown to your next birthday."
  local birthday
  birthday="$(_ui_prompt "Date of birth  YYYY-MM-DD" "${BIRTHDAY:-}")" || {
    _ui_info "Identity setup cancelled."; return 0
  }

  # ── Save ──
  _db_identity_write \
    "$north_star" "$decade" "$values" \
    "$season_name" "$season_word" "$season_theme" \
    "$season_year" "$intentions" "$birthday"

  _ui_blank
  _ui_cap "Identity saved."
  _scope_identity_view
}

_scope_identity_north_star() {
  _db_identity_load 2>/dev/null || true
  _ui_section "NORTH STAR"
  _ui_blank
  printf '%s  %s\n\n' "$_UI_INDENT" "${NORTH_STAR:-Not set}" >&2
  _ui_confirm "Edit?" "n" && _scope_identity_edit || true
}

_scope_identity_season() {
  _db_identity_load 2>/dev/null || true
  _ui_section "CURRENT SEASON"
  _ui_blank
  _ui_row "Name"  "${SEASON_NAME:-Not set}"
  _ui_row "Word"  "${SEASON_WORD:-}"
  _ui_row "Theme" "${SEASON_THEME:-}"
  _ui_blank
  _ui_confirm "Edit?" "n" && _scope_identity_edit || true
}

# ─────────────────────────────────────────────────────────────────────────────
# PLAN (weekly planner — legacy alias target)
# ─────────────────────────────────────────────────────────────────────────────

_scope_plan() {
  local eq_str; eq_str="$(_eq_today_short)"
  local day_theme; day_theme="$(_db_day_theme)"

  _ui_section_scope "WEEKLY PLAN" "$eq_str"

  # Today's theme
  _ui_subsection "Today  ·  $(_ui_dim "$day_theme")"

  # Show focus blocks for the day
  _ui_blank
  printf '%s  %s
' "$_UI_INDENT" "$(_ui_bold "Focus Blocks")" >&2
  local block current_block; current_block="$(_db_current_block)"
  for block in "${_FOCUS_BLOCKS[@]}"; do
    local start="${block%%:*}"; local rest="${block#*:}"
    local end="${rest%%:*}";   local rest2="${rest#*:}"
    local bname="${rest2%%:*}"; local bdesc="${rest2#*:}"
    local marker="  "; [[ "$bname" == "$current_block" ]] && marker="> "
    printf '%s  %s%s  %s:%s0 – %s:%s0  %s
'       "$_UI_INDENT" "$marker" "$(_ui_bold "$bname")"       "$start" "0" "$end" "0"       "$(_ui_dim "$bdesc")" >&2
  done

  # Goals context
  local goal_count; goal_count="$(_tsv_count "$_FLAT_SCOPE_GOALS" '$7=="active"')"
  if [[ "$goal_count" -gt 0 ]]; then
    _ui_blank
    _ui_subsection "Active Goals"
    _scope_goal_list_compact 4
  fi

  # Backlog — filtered by today's focus area
  local day_focus; day_focus="$(_db_day_focus)"
  local backlog_count; backlog_count="$(_tsv_count "$_FLAT_SCOPE_TASKS" '$3=="backlog"')"

  if [[ "$backlog_count" -gt 0 ]]; then
    _ui_blank
    _ui_subsection "Backlog tasks  $(_ui_dim "(all $backlog_count)")"
    _scope_task_list_compact "backlog" 10

    # Suggest which tasks match today's focus
    if [[ -n "$day_focus" ]] && [[ -f "$_FLAT_SCOPE_TASKS" ]]; then
      _ui_blank
      local focus_pattern; focus_pattern="$(printf '%s' "$day_focus" | tr '|' '\|')"
      local matches
      matches="$(awk -F'	' -v pat="$focus_pattern"         'NR>1 && $3=="backlog" && tolower($2)~pat {printf "  %-8s  %s
",$1,$2}'         "$_FLAT_SCOPE_TASKS" 2>/dev/null | head -5)"
      if [[ -n "$matches" ]]; then
        _ui_subsection "Suggested for today  $(_ui_dim "(matches: $day_theme)")"
        printf '%s
' "$matches" >&2
      fi
    fi
  fi

  _ui_blank
  _ui_hint "sconlx scope today add <id>  — move a task to today"
  _ui_hint "sconlx scope task add        — create a new task"
  _ui_blank
}
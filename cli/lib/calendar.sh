# isconl-space/lib/calendar.sh
# Calendar command handlers for sconlx.
# Covers: today's context (holidays, history, birthdays, journal on this day),
# upcoming events, birthday management, custom events, monthly view.
# Data stored in: isconl-space/data/calendar.json (human-editable)
# Python backend: isconl-space/lib/calendar_data.py
#
# ─────────────────────────────────────────────────────────────────────────────
# CHANGELOG
# ─────────────────────────────────────────────────────────────────────────────
#   v1.1.0 — Fixed: path fallback for calendar_data.py after sconl→isconl
#             rename. Fixed: _cal_py no longer silently swallows errors.
#             UX: added blank-line breathing room throughout all views.
#   v1.0.0 — Initial. today/upcoming/birthdays/events/month/add/remove.
# ─────────────────────────────────────────────────────────────────────────────

[[ -n "${_CALENDAR_LOADED:-}" ]] && return 0
_CALENDAR_LOADED=1

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

_CAL_DATA_FILE="${_FLAT_DIR}/calendar.json"
_CAL_REGIONS="KE,INT"

# ── Path resolution for calendar_data.py ─────────────────────────────────────
# v2.2.0 renamed the folder from sconl-space/ → isconl-space/.
# If the Python file was never moved, fall back to the old location so the
# calendar works immediately without a manual file move.
_CAL_PY="${_CAL_PY:-${_ISCONLSPACE_LIB_DIR}/calendar_data.py}"
if [[ ! -f "$_CAL_PY" ]]; then
  _CAL_PY_LEGACY="${_XSPACE_ROOT:-}/sconl-space/lib/calendar_data.py"
  if [[ -f "$_CAL_PY_LEGACY" ]]; then
    _CAL_PY="$_CAL_PY_LEGACY"
    printf '  !  calendar_data.py found at legacy path.\n' >&2
    printf '     Move it: mv "%s" "%s"\n' \
      "$_CAL_PY_LEGACY" "${_ISCONLSPACE_LIB_DIR}/calendar_data.py" >&2
  else
    printf '  x  calendar_data.py not found.\n' >&2
    printf '     Expected: %s\n' "${_ISCONLSPACE_LIB_DIR}/calendar_data.py" >&2
  fi
fi

_cal_journal_dir() { printf '%s' "${_FLAT_JOURNAL_DIR:-${_FLAT_DIR}/journal}"; }

# ─────────────────────────────────────────────────────────────────────────────
# ROUTER
# ─────────────────────────────────────────────────────────────────────────────

_cal_route() {
  local cmd="${1:-today}"
  shift || true
  case "$cmd" in
    today|"")       _cal_today ;;
    upcoming|up)    _cal_upcoming "$@" ;;
    month)          _cal_month "$@" ;;
    birthday|bday)  _cal_birthday_route "$@" ;;
    event)          _cal_event_route "$@" ;;
    add)            _cal_add_interactive ;;
    edit)           _cal_edit_raw ;;
    sync-dia)       _cal_sync_from_dia ;;
    *)
      _ui_err "Unknown cal command: $cmd"
      printf '\n%s  Usage: isconl cal [today|upcoming|month|birthday|event|add|edit|sync-dia]\n\n' \
        "$_UI_INDENT" >&2 ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
# PYTHON HELPER
# ─────────────────────────────────────────────────────────────────────────────

# Call calendar_data.py and return JSON.
# Errors are printed to stderr so failures are visible instead of silent.
_cal_py() {
  if [[ ! -f "$_CAL_PY" ]]; then
    printf '  x  calendar_data.py missing — run: isconl x status\n' >&2
    return 1
  fi
  python3 "$_CAL_PY" \
    --calendar-file "$_CAL_DATA_FILE" \
    --journal-dir   "$(_cal_journal_dir)" \
    --regions       "$_CAL_REGIONS" \
    "$@" </dev/null
}

# Ensure calendar.json exists with default structure
_cal_ensure_data() {
  [[ -f "$_CAL_DATA_FILE" ]] && return 0
  mkdir -p "$(dirname "$_CAL_DATA_FILE")"
  cat > "$_CAL_DATA_FILE" << 'JSON'
{
  "_comment": "isconl-space/data/calendar.json — personal calendar data. Edit directly or: isconl cal edit",
  "_format_notes": {
    "birthdays": "date is MM-DD. year_of_birth optional. source: manual|dia",
    "custom_events": "date YYYY-MM-DD for one-time, MM-DD for annual recurring",
    "categories": "birthday|anniversary|memorial|holiday|personal|work|health"
  },
  "birthdays": [],
  "custom_events": [],
  "settings": {
    "upcoming_days_ahead": 30,
    "birthday_warn_days": 7,
    "show_holidays": true,
    "holiday_regions": ["KE", "INT"],
    "show_today_in_history": true,
    "history_facts_per_day": 3
  }
}
JSON
  _ui_ok "Created calendar.json"
}

# ─────────────────────────────────────────────────────────────────────────────
# TODAY VIEW
# ─────────────────────────────────────────────────────────────────────────────

_cal_today() {
  _cal_ensure_data
  _ctx_load 2>/dev/null || true

  local today; today="$(_db_today)"
  local day_theme; day_theme="$(_db_day_theme)"

  _ui_section "CALENDAR  ·  TODAY"
  _ui_blank

  # Date context
  printf '%s  %s\n' "$_UI_INDENT" "$(_ui_bold "$CTX_GREGORIAN")" >&2
  _ui_blank
  printf '%s  %s\n' "$_UI_INDENT" "$(_ui_dim "$CTX_EQ_SHORT  ·  $CTX_SPRINT_SHORT")" >&2
  printf '%s  %s  %s\n' "$_UI_INDENT" "$(_ui_dim "Day theme:")" "$day_theme" >&2
  _ui_blank

  # Focus blocks today
  _ui_subsection "Focus Blocks"
  _ui_blank
  local current_block; current_block="$(_db_current_block)"
  local block_status; block_status="$(_db_block_status)"
  for block in "${_FOCUS_BLOCKS[@]}"; do
    local start="${block%%:*}"; local rest="${block#*:}"
    local end="${rest%%:*}";    local rest2="${rest#*:}"
    local bname="${rest2%%:*}"; local bdesc="${rest2#*:}"
    local indicator="  "
    if [[ "$bname" == "$current_block" ]]; then
      indicator="> "
      printf '%s  %s%s  %02d:00–%02d:00  %s\n' \
        "$_UI_INDENT" "$indicator" "$(_ui_bold "$(_ui_scope "$bname")")" \
        "$start" "$end" "$(_ui_dim "$bdesc")" >&2
    else
      printf '%s  %s%s  %02d:00–%02d:00  %s\n' \
        "$_UI_INDENT" "$indicator" "$bname" \
        "$start" "$end" "$(_ui_dim "$bdesc")" >&2
    fi
  done
  case "$block_status" in
    IN:*)
      local rem="${block_status##*:}"
      _ui_blank
      _ui_info "$(_ui_scope "In $current_block block")  $(_ui_dim "$rem")" ;;
    NEXT:*)
      local binfo="${block_status#NEXT:}"; local bname="${binfo%%:*}"
      local buntil="${binfo##*:}"
      _ui_blank
      _ui_hint "Next: $bname  ($buntil)" ;;
    DONE:*)
      _ui_blank
      _ui_hint "All focus blocks complete for today" ;;
  esac

  # Fetch today's calendar data from Python
  local cal_json
  cal_json="$(_cal_py --action today --date "$today")" || {
    _ui_blank
    _ui_warn "Calendar data unavailable — check: isconl x status"
    _ui_blank
    return 0
  }

  [[ -z "$cal_json" ]] && {
    _ui_blank
    _ui_warn "Calendar returned empty data."
    _ui_blank
    return 0
  }

  # Holidays
  local holidays; holidays="$(printf '%s' "$cal_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for h in d.get('holidays',[]): print(h['name'] + '  (' + h['region'] + ')')
" 2>/dev/null)"
  if [[ -n "$holidays" ]]; then
    _ui_blank
    _ui_subsection "Holidays & Observances"
    _ui_blank
    while IFS= read -r h; do
      printf '%s  %s  %s\n' "$_UI_INDENT" "$(_ui_dim "·")" "$h" >&2
    done <<< "$holidays"
  fi

  # Birthdays today
  local bdays; bdays="$(printf '%s' "$cal_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for b in d.get('birthdays_today',[]):
    t = f' — turning {b[\"turning\"]}' if b.get('turning') else ''
    print(b['name'] + t)
" 2>/dev/null)"
  if [[ -n "$bdays" ]]; then
    _ui_blank
    _ui_subsection "Birthdays Today"
    _ui_blank
    while IFS= read -r b; do
      printf '%s  %s  %s\n' "$_UI_INDENT" "$(_ui_green "*")" "$(_ui_bold "$b")" >&2
    done <<< "$bdays"
  fi

  # Custom events today
  local evs; evs="$(printf '%s' "$cal_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d.get('events_today',[]): print('[' + e['category'] + ']  ' + e['title'])
" 2>/dev/null)"
  if [[ -n "$evs" ]]; then
    _ui_blank
    _ui_subsection "Events Today"
    _ui_blank
    while IFS= read -r ev; do
      printf '%s  %s  %s\n' "$_UI_INDENT" "$(_ui_dim "·")" "$ev" >&2
    done <<< "$evs"
  fi

  # Today in history
  local history; history="$(printf '%s' "$cal_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for f in d.get('history',[]): print(f)
" 2>/dev/null)"
  if [[ -n "$history" ]]; then
    _ui_blank
    _ui_subsection "Today in History"
    _ui_blank
    while IFS= read -r fact; do
      printf '%s  %s  %s\n' "$_UI_INDENT" "$(_ui_dim "·")" "$(_ui_dim "$fact")" >&2
    done <<< "$history"
  fi

  # Journal on this day (previous years)
  local on_this_day; on_this_day="$(printf '%s' "$cal_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for j in d.get('journal_on_this_day',[]):
    ago = j['years_ago']
    y = j['date'][:4]
    prev = j.get('preview','')
    print(f'{ago} year(s) ago ({y}): {prev}')
" 2>/dev/null)"
  if [[ -n "$on_this_day" ]]; then
    _ui_blank
    _ui_subsection "Journal  ·  On This Day"
    _ui_blank
    while IFS= read -r line; do
      printf '%s  %s  %s\n' "$_UI_INDENT" "$(_ui_dim "·")" \
        "$(_ui_italic "$(_ui_truncate "$line" 55)")" >&2
    done <<< "$on_this_day"
    _ui_blank
    _ui_hint "isconl journal  to write today's entry"
  fi

  _ui_blank
}

# ─────────────────────────────────────────────────────────────────────────────
# UPCOMING VIEW
# ─────────────────────────────────────────────────────────────────────────────

_cal_upcoming() {
  local days="${1:-30}"
  _cal_ensure_data

  _ui_section "UPCOMING" "next $days days"
  _ui_blank

  local up_json
  up_json="$(_cal_py --action upcoming --days-ahead "$days")" || {
    _ui_warn "Calendar data unavailable."
    _ui_blank
    return 0
  }

  [[ -z "$up_json" ]] && { _ui_warn "Calendar data unavailable."; _ui_blank; return 0; }

  # Birthdays
  local bdays; bdays="$(printf '%s' "$up_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for b in d.get('birthdays',[]):
    t = f' (turning {b[\"turning\"]})' if b.get('turning') else ''
    n = b['days_until']
    soon = ' TODAY' if n==0 else (f' in {n}d' if n>0 else '')
    print(f'{b[\"date_fmt\"]:15}{b[\"name\"]}{t}{soon}')
" 2>/dev/null)"
  if [[ -n "$bdays" ]]; then
    _ui_subsection "Birthdays"
    _ui_blank
    while IFS= read -r b; do
      printf '%s  %s\n' "$_UI_INDENT" "$b" >&2
    done <<< "$bdays"
    _ui_blank
  fi

  # Upcoming holidays
  local holidays; holidays="$(printf '%s' "$up_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
seen=set()
for h in d.get('holidays',[]):
    key=h['date']+'|'+h['name']
    if key in seen: continue
    seen.add(key)
    n=h['days_until']
    soon=' TODAY' if n==0 else (f' in {n}d' if n>0 else '')
    print(f'{h[\"date_fmt\"]:15}{h[\"name\"]}  ({h[\"region\"]}){soon}')
" 2>/dev/null)"
  if [[ -n "$holidays" ]]; then
    _ui_subsection "Holidays"
    _ui_blank
    while IFS= read -r h; do
      printf '%s  %s\n' "$_UI_INDENT" "$(_ui_dim "$h")" >&2
    done <<< "$holidays"
    _ui_blank
  fi

  # Custom events
  local evs; evs="$(printf '%s' "$up_json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for e in d.get('events',[]):
    n=e['days_until']
    soon=' TODAY' if n==0 else (f' in {n}d' if n>0 else '')
    print(f'{e[\"date_fmt\"]:15}{e[\"title\"]}  [{e[\"category\"]}]{soon}')
" 2>/dev/null)"
  if [[ -n "$evs" ]]; then
    _ui_subsection "Events"
    _ui_blank
    while IFS= read -r ev; do
      printf '%s  %s\n' "$_UI_INDENT" "$ev" >&2
    done <<< "$evs"
    _ui_blank
  fi

  [[ -z "$bdays" && -z "$holidays" && -z "$evs" ]] && {
    _ui_hint "Nothing coming up in the next $days days."
    _ui_blank
  }
}

# ─────────────────────────────────────────────────────────────────────────────
# MONTH VIEW (text calendar)
# ─────────────────────────────────────────────────────────────────────────────

_cal_month() {
  _cal_ensure_data
  local today; today="$(_db_today)"

  _ui_section "CALENDAR  ·  $(date '+%B %Y')"
  _ui_blank

  local month_json
  month_json="$(_cal_py --action month --date "$today")" || {
    _ui_warn "Calendar data unavailable."
    _ui_blank
    return 0
  }
  [[ -z "$month_json" ]] && { _ui_warn "Calendar data unavailable."; _ui_blank; return 0; }

  printf '%s' "$month_json" | python3 - << 'PYEOF'
import json, sys
data = json.load(sys.stdin)
indent = "  "
header = f"{indent}  Mo  Tu  We  Th  Fr  Sa  Su"
print(header)
print(indent + "  " + "─" * 32)

days = data["days"]
from datetime import date
first_day = date.fromisoformat(days[0]["date"])
start_dow = first_day.weekday()

week = ["    "] * start_dow
for day_data in days:
    d = day_data["day"]
    is_today = day_data["is_today"]
    has_event = bool(day_data["holidays"] or day_data["birthdays"] or day_data["events"])

    if is_today:
        cell = f"[{d:2d}]"
    elif has_event:
        cell = f" {d:2d}*"
    else:
        cell = f"  {d:2d}"
    week.append(cell)

    if len(week) == 7:
        print(indent + "  " + "".join(week))
        week = []

if week:
    while len(week) < 7:
        week.append("    ")
    print(indent + "  " + "".join(week))

print()
print(f"{indent}  [n] = today   n* = has event")
print()
print(f"{indent}  Events this month:")
print()
for day_data in days:
    items = []
    for h in day_data["holidays"]: items.append(h["name"])
    for b in day_data["birthdays"]: items.append(f"Birthday: {b}")
    for e in day_data["events"]: items.append(e)
    if items:
        d_str = date.fromisoformat(day_data["date"]).strftime("%b %d")
        for item in items:
            print(f"{indent}    {d_str:8}  {item}")
PYEOF
  printf '\n' >&2
}

# ─────────────────────────────────────────────────────────────────────────────
# BIRTHDAY MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

_cal_birthday_route() {
  case "${1:-list}" in
    list|"")  _cal_birthday_list ;;
    add)      _cal_birthday_add ;;
    remove)   shift; _cal_birthday_remove "$@" ;;
    *)        _cal_birthday_list ;;
  esac
}

_cal_birthday_list() {
  _cal_ensure_data
  _ui_section "BIRTHDAYS"
  _ui_blank

  local data; data="$(_cal_py --action list-birthdays 2>/dev/null)"
  [[ -z "$data" ]] && { _ui_info "No birthdays yet."; _ui_blank; return 0; }

  local count; count="$(printf '%s' "$data" | python3 -c \
    "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)"
  if [[ "$count" -eq 0 ]]; then
    _ui_info "No birthdays on record."
    _ui_blank
    _ui_hint "Add one: isconl cal birthday add"
    _ui_blank
    return 0
  fi

  printf '%s' "$data" | python3 - << 'PYEOF'
import json,sys
from datetime import date
today = date.today()
entries = json.load(sys.stdin)
indent = "  "
for i, b in enumerate(entries):
    raw = b.get("date",""); parts = raw.split("-")
    if len(parts)==2:
        try:
            this_yr = date(today.year, int(parts[0]), int(parts[1]))
            if this_yr < today: this_yr = date(today.year+1, int(parts[0]), int(parts[1]))
            days_until = (this_yr-today).days
            soon = " TODAY" if days_until==0 else (f" — in {days_until}d" if days_until<=30 else "")
        except: soon=""
    else: soon=""
    yob = b.get("year_of_birth","")
    yob_str = f" ({yob})" if yob else ""
    src = b.get("source","")
    src_str = f" [{src}]" if src and src!="manual" else ""
    notes = b.get("notes","")
    notes_str = f"  {notes}" if notes else ""
    print(f"{indent}  [{i}]  {b['name']:22}  {raw:6}{yob_str:8}{soon}{src_str}{notes_str}")
    print()
PYEOF
  _ui_hint "isconl cal birthday add  ·  isconl cal birthday remove <index>"
  _ui_blank
}

_cal_birthday_add() {
  _cal_ensure_data
  _ui_section "ADD BIRTHDAY"
  _ui_blank

  local name; name="$(_ui_prompt "Name")" || { _ui_info "Cancelled."; return 0; }
  [[ -z "$name" ]] && { _ui_warn "Name required."; return 0; }

  local bday_date; bday_date="$(_ui_prompt "Birthday  MM-DD  (e.g. 05-27)")" \
    || { _ui_info "Cancelled."; return 0; }
  [[ -z "$bday_date" ]] && { _ui_warn "Date required."; return 0; }
  if ! [[ "$bday_date" =~ ^[0-9]{2}-[0-9]{2}$ ]]; then
    _ui_warn "Format must be MM-DD  (e.g. 05-27)"; return 0
  fi

  local year_born; year_born="$(_ui_prompt "Year of birth  (YYYY, optional)" "")" || true
  local notes;     notes="$(_ui_prompt "Notes  (optional)" "")" || true

  local -a py_args=(--action add-birthday --name "$name" --bday-date "$bday_date")
  [[ -n "$year_born" ]] && py_args+=(--year-born "$year_born")
  [[ -n "$notes"     ]] && py_args+=(--notes "$notes")

  _cal_py "${py_args[@]}" >/dev/null
  _ui_blank
  _ui_cap "Birthday saved: $name  ($bday_date)"
  _ui_blank
}

_cal_birthday_remove() {
  local idx="${1:-}"
  if [[ -z "$idx" ]]; then
    _cal_birthday_list
    idx="$(_ui_prompt "Enter index to remove")" || { _ui_info "Cancelled."; return 0; }
  fi
  _ui_confirm "Remove birthday at index $idx?" "n" || return 0
  _cal_py --action remove-birthday --remove-index "$idx" >/dev/null
  _ui_blank
  _ui_ok "Removed."
  _ui_blank
}

# ─────────────────────────────────────────────────────────────────────────────
# CUSTOM EVENT MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

_cal_event_route() {
  case "${1:-list}" in
    list|"")  _cal_event_list ;;
    add)      _cal_event_add ;;
    remove)   shift; _cal_event_remove "$@" ;;
    *)        _cal_event_list ;;
  esac
}

_cal_event_list() {
  _cal_ensure_data
  _ui_section "CUSTOM EVENTS"
  _ui_blank

  local data; data="$(_cal_py --action list-events 2>/dev/null)"
  local count; count="$(printf '%s' "$data" | python3 -c \
    "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)"
  if [[ "$count" -eq 0 ]]; then
    _ui_info "No custom events."
    _ui_blank
    _ui_hint "isconl cal event add"
    _ui_blank
    return 0
  fi

  printf '%s' "$data" | python3 - << 'PYEOF'
import json,sys
entries = json.load(sys.stdin)
indent = "  "
for i, e in enumerate(entries):
    cat = e.get("category","")
    notes = f"  {e['notes']}" if e.get("notes") else ""
    print(f"{indent}  [{i}]  {e['date']:12}  {e['title']:30}  [{cat}]{notes}")
    print()
PYEOF
  _ui_blank
}

_cal_event_add() {
  _cal_ensure_data
  _ui_section "ADD EVENT"
  _ui_blank
  _ui_hint "Date: YYYY-MM-DD for one-time, MM-DD for annual recurring"
  _ui_blank

  local title; title="$(_ui_prompt "Event title")" || { _ui_info "Cancelled."; return 0; }
  [[ -z "$title" ]] && { _ui_warn "Title required."; return 0; }

  local ev_date; ev_date="$(_ui_prompt "Date  (YYYY-MM-DD or MM-DD)")" \
    || { _ui_info "Cancelled."; return 0; }
  [[ -z "$ev_date" ]] && { _ui_warn "Date required."; return 0; }

  local category
  category="$(_ui_menu_choice "Category" \
    "personal" "work" "birthday" "anniversary" "memorial" "holiday" "health")" \
    || category="personal"

  local notes; notes="$(_ui_prompt "Notes  (optional)" "")" || true

  local -a py_args=(--action add-event --event-title "$title" --event-date "$ev_date" --category "$category")
  [[ -n "$notes" ]] && py_args+=(--notes "$notes")

  _cal_py "${py_args[@]}" >/dev/null
  _ui_blank
  _ui_cap "Event saved: $title  ($ev_date)"
  _ui_blank
}

_cal_event_remove() {
  local idx="${1:-}"
  if [[ -z "$idx" ]]; then
    _cal_event_list
    idx="$(_ui_prompt "Enter index to remove")" || { _ui_info "Cancelled."; return 0; }
  fi
  _ui_confirm "Remove event at index $idx?" "n" || return 0
  _cal_py --action remove-event --remove-index "$idx" >/dev/null
  _ui_blank
  _ui_ok "Removed."
  _ui_blank
}

# ─────────────────────────────────────────────────────────────────────────────
# INTERACTIVE ADD
# ─────────────────────────────────────────────────────────────────────────────

_cal_add_interactive() {
  local choice
  choice="$(_ui_menu_choice "What would you like to add?" \
    "Birthday" "Custom event")" || return 0
  case "$choice" in
    Birthday)       _cal_birthday_add ;;
    "Custom event") _cal_event_add ;;
  esac
}

# ─────────────────────────────────────────────────────────────────────────────
# EDIT RAW JSON
# ─────────────────────────────────────────────────────────────────────────────

_cal_edit_raw() {
  _cal_ensure_data
  local editor_cmd; editor_cmd="$(_db_editor)"
  _ui_blank
  _ui_info "Opening calendar.json in editor..."
  eval "$editor_cmd \"$_CAL_DATA_FILE\""
  _ui_blank
  _ui_ok "Done. Run 'isconl cal today' to verify."
  _ui_blank
}

# ─────────────────────────────────────────────────────────────────────────────
# SYNC FROM DIA PROFILES
# ─────────────────────────────────────────────────────────────────────────────

_cal_sync_from_dia() {
  _cal_ensure_data
  _ui_section "SYNC BIRTHDAYS FROM DIA"
  _ui_blank

  if [[ ! -f "$_FLAT_SPARK_DIA" ]]; then
    _ui_info "No DIA profiles found."
    _ui_blank
    return 0
  fi

  local existing_names; existing_names="$(_cal_py --action list-birthdays 2>/dev/null | \
    python3 -c "import json,sys; [print(b['name'].lower()) for b in json.load(sys.stdin)]" \
    2>/dev/null || true)"

  local synced=0
  while IFS=$'\t' read -r id name role type depth last_contact traj created; do
    [[ -z "$name" || "$name" == "NAME" ]] && continue
    if printf '%s' "$existing_names" | grep -qi "^${name}$" 2>/dev/null; then
      _ui_hint "Already in calendar: $name"
      continue
    fi
    _ui_blank
    printf '%s  DIA profile: %s  (%s)\n' "$_UI_INDENT" "$(_ui_bold "$name")" "$role" >&2
    _ui_blank
    if _ui_confirm "Add birthday for $name?" "n"; then
      local bday; bday="$(_ui_prompt "Birthday  MM-DD" "")" || continue
      [[ -z "$bday" ]] && continue
      local yob; yob="$(_ui_prompt "Year of birth  (optional)" "")" || true
      local -a args=(--action add-birthday --name "$name" --bday-date "$bday")
      [[ -n "$yob" ]] && args+=(--year-born "$yob")
      args+=(--notes "from DIA")
      _cal_py "${args[@]}" >/dev/null
      _ui_ok "Added: $name"
      _ui_blank
      (( ++synced )) || true
    fi
  done < <(tail -n +2 "$_FLAT_SPARK_DIA" 2>/dev/null)

  _ui_blank
  _ui_ok "Sync complete — $synced birthday(s) added."
  _ui_blank
}
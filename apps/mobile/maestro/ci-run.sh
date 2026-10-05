#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner (contracts/slice-15.md §13.3, slice-16 §15.2),
# whose `script` executes line by line; this file keeps the steps together. CI only.
#   API_PID_FILE     where the job wrote the running API's pid
#   WORKER_PID_FILE  where the job wrote the running worker's pid
#   APK              the e2e APK (development profile, release variant: JS embedded, no dev launcher)
#   SCHOOL_CODE, PRINCIPAL_CNIC, TEACHER_CNIC, GUARDIAN_CNIC   the seeded people (default password
#                    = the same digits; DEV_SCHOOL_CLASSROOM=1 seeded the classroom)
#   AIRPLANE_MECHANISM  maestro (default: the flow's setAirplaneMode) or adb (the stated fallback:
#                    `adb shell cmd connectivity airplane-mode`, between the flow's steps)
set -euo pipefail

export PATH="$HOME/.maestro/bin:$PATH"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
flows="$root/apps/mobile/maestro/flows"
out="$root/apps/mobile/maestro/out"
api="http://127.0.0.1:3461/api/v1"
mkdir -p "$out"

wait_for() { # url, what
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "$1"; then return 0; fi
    sleep 2
  done
  echo "$2 did not answer $1"; tail -n 50 "$root/api.log" "$root/worker.log" || true; return 1
}

stop() { # pid file. Waits for the process to exit: Nest's graceful shutdown outlasted a fixed
  # two seconds, so the restarted API hit EADDRINUSE and the old one kept answering (2026-10-05).
  [ -f "$1" ] || return 0
  local pid
  pid="$(cat "$1")"
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
  sleep 1
}

# The API and the worker restart together whenever MOBILE_MIN_APP_VERSION changes. Without the
# worker no day status is ever materialised and the parent's card never says "Absent".
start_api() {
  stop "$API_PID_FILE"
  stop "$WORKER_PID_FILE"
  # The old processes must be gone, or the new API's listen fails while the old one answers. `exec`
  # below makes $! the node pid itself (without it, $! was the subshell, and stop missed node).
  for _ in $(seq 1 30); do
    curl -fs -o /dev/null "$api/health" || curl -fs -o /dev/null "http://127.0.0.1:3002/health" || break
    sleep 1
  done
  if curl -fs -o /dev/null "$api/health"; then echo "the previous API is still answering"; return 1; fi
  (cd "$root" && set -a && . ./.env && set +a && MOBILE_MIN_APP_VERSION="$1" exec nohup node apps/api/dist/main.js >>"$root/api.log" 2>&1 & echo $! >"$API_PID_FILE")
  (cd "$root" && set -a && . ./.env && set +a && MOBILE_MIN_APP_VERSION="$1" WORKER_HEALTH_PORT=3002 exec nohup node apps/api/dist/worker.js >>"$root/worker.log" 2>&1 & echo $! >"$WORKER_PID_FILE")
  wait_for "$api/health" "API"
  wait_for "http://127.0.0.1:3002/health" "worker"
}

flow() { # name, file, extra -e args...
  local name="$1" file="$2"
  shift 2
  if ! maestro test --format junit --output "$out/$name.xml" --debug-output "$out/$name" \
    -e SCHOOL_CODE="$SCHOOL_CODE" -e PRINCIPAL_CNIC="$PRINCIPAL_CNIC" \
    -e TEACHER_CNIC="$TEACHER_CNIC" -e GUARDIAN_CNIC="$GUARDIAN_CNIC" \
    "$@" "$flows/$file"; then
    # Evidence in the job log itself, in case the artifact upload never runs. The app's log is
    # scrubbed of identity numbers and tokens (src/platform/scrub.ts); the API logs no values.
    echo "::group::flow $name failed: API log, worker log, app log"
    tail -n 80 "$root/api.log" || true
    tail -n 30 "$root/worker.log" || true
    # A release build writes no app log, so the screen itself is the evidence: a screenshot, the
    # element tree, and warnings or worse from everything but Maestro's own dump.
    adb exec-out screencap -p >"$out/$name.png" 2>/dev/null || true
    maestro hierarchy >"$out/$name-hierarchy.json" 2>/dev/null || true
    adb logcat -d '*:W' Maestro:S >"$out/$name-logcat.txt" 2>&1 || true
    grep -E "ReactNative|AndroidRuntime|pk\.asms|expo" "$out/$name-logcat.txt" | tail -n 80 || true
    grep -oE '"(text|resource-id|accessibilityText)" *: *"[^"]+"' "$out/$name-hierarchy.json" | head -n 60 || true
    echo "::endgroup::"
    return 1
  fi
}

json() { # a JavaScript expression over `b` (the parsed stdin)
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const b=JSON.parse(s);console.log($1)})"
}

token_of() { # identity digits -> a bearer token (never printed). The body goes on stdin, so the
  # digits never appear in a process listing (review L7).
  printf '{"schoolCode":"%s","username":"%s","password":"%s","channel":"bearer"}' \
    "$SCHOOL_CODE" "$1" "$1" \
    | curl -fs -H 'Content-Type: application/json' -H 'X-App-Version: 0.1.0' -X POST \
      "$api/auth/login" -d @- \
    | json 'b.bearerToken'
}

get() { # token, path
  curl -fs -H "Authorization: Bearer $1" -H 'X-App-Version: 0.1.0' "$api$2"
}

airplane() { adb shell cmd connectivity airplane-mode "$1"; sleep 3; }

adb install -r "$APK"

# The software-rendered emulator's launcher is slow to settle, and its "isn't responding" dialog
# covered the app on a run (2026-10-05). Hide system error dialogs, let the launcher settle, and
# dismiss anything already showing.
adb shell settings put global hide_error_dialogs 1 || true
sleep 20
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS >/dev/null 2>&1 || true
adb shell input keyevent KEYCODE_HOME || true

# --- slice 15 ---------------------------------------------------------------------------------
start_api 0.0.0
flow sign-in sign-in-shell-sign-out.yaml

start_api 99.0.0
flow update update-required.yaml

start_api 0.0.0

# --- slice 16a: the ids the flows select by, read as the seeded people would see them ------------
today="$(TZ=Asia/Karachi date +%F)"
teacher_token="$(token_of "$TEACHER_CNIC")"
teacher_me="$(get "$teacher_token" /me)"
SECTION_A="$(echo "$teacher_me" | json "b.assignments.find(a=>a.role==='class_teacher').sectionId")"
SECTION_B="$(echo "$teacher_me" | json "b.assignments.find(a=>a.role==='subject_teacher').sectionId")"
view="$(get "$teacher_token" "/sections/$SECTION_A/register?date=$today&period=1")"
ENROLMENT_1="$(echo "$view" | json 'b.roster[0].enrolmentId')"
ENROLMENT_2="$(echo "$view" | json 'b.roster[1].enrolmentId')"
guardian_token="$(token_of "$GUARDIAN_CNIC")"
STUDENT_ID="$(get "$guardian_token" /me | json 'b.children[0].studentId')"
ids=(-e SECTION_A="$SECTION_A" -e SECTION_B="$SECTION_B" -e ENROLMENT_1="$ENROLMENT_1"
  -e ENROLMENT_2="$ENROLMENT_2" -e STUDENT_ID="$STUDENT_ID")

# The offline register. The mechanism that worked is recorded in WORKLOG after the first run.
if [ "${AIRPLANE_MECHANISM:-maestro}" = "adb" ]; then
  flow register-offline-1 register-offline-adb-1.yaml "${ids[@]}"
  airplane enable
  flow register-offline-2 register-offline-adb-2.yaml "${ids[@]}"
  airplane disable
  flow register-offline-3 register-offline-adb-3.yaml "${ids[@]}"
else
  flow register-offline register-offline.yaml "${ids[@]}"
fi

# "The server has it", checked outside the app: the register exists with two absent marks.
absent="$(get "$teacher_token" "/sections/$SECTION_A/register?date=$today&period=1" \
  | json "b.register===null ? -1 : b.roster.filter(r=>r.mark&&r.mark.status==='absent').length")"
if [ "$absent" != "2" ]; then echo "the server's register has $absent absent marks, wanted 2"; exit 1; fi

flow teacher-diary teacher-diary.yaml "${ids[@]}"

# The parent's card says "Absent" only once the worker's rollup has run: wait for it (≤ 90 s).
status=""
for _ in $(seq 1 45); do
  status="$(get "$guardian_token" "/me/children/$STUDENT_ID/attendance?dateFrom=$today&dateTo=$today" \
    | json "(b.days.find(d=>d.date==='$today')||{}).status")"
  [ "$status" = "absent" ] && break
  sleep 2
done
if [ "$status" != "absent" ]; then echo "the rollup never marked today absent (got '$status')"; exit 1; fi
flow parent-child parent-child.yaml "${ids[@]}"

# --- slice 16b: Today and Announce -------------------------------------------------------------
# Today: the unrecorded 5 B register, recorded from "Record now"; the server has it.
flow principal-today principal-today.yaml "${ids[@]}"
principal_token="$(token_of "$PRINCIPAL_CNIC")"
recorded="$(get "$principal_token" "/sections/$SECTION_B/register?date=$today&period=1" | json 'b.register!==null')"
if [ "$recorded" != "true" ]; then echo "the principal's 5 B register is not on the server"; exit 1; fi

# Announce: a short notice to 5 A, then the guardian's inbox shows it.
CLASS_ID="$(echo "$view" | json 'b.section.classId')"
flow principal-announce principal-announce.yaml "${ids[@]}" -e CLASS_ID="$CLASS_ID"

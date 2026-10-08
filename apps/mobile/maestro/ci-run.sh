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
  # The identity digits reach Maestro through its MAESTRO_-prefixed environment variables (the
  # flows read ${MAESTRO_PRINCIPAL_CNIC} etc.), never through `-e` on its command line, so they
  # appear in no process listing (the slice-31 security review).
  if ! MAESTRO_PRINCIPAL_CNIC="$PRINCIPAL_CNIC" MAESTRO_TEACHER_CNIC="$TEACHER_CNIC" \
    MAESTRO_GUARDIAN_CNIC="$GUARDIAN_CNIC" \
    maestro test --format junit --output "$out/$name.xml" --debug-output "$out/$name" \
    -e SCHOOL_CODE="$SCHOOL_CODE" "$@" "$flows/$file"; then
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

auth() { # token -> a curl config naming the bearer header, read through -K <(auth ...): printf
  # is a builtin, so the token never appears on a command line or in a process listing.
  printf 'header = "Authorization: Bearer %s"\n' "$1"
}

get() { # token, path
  curl -fs -K <(auth "$1") -H 'X-App-Version: 0.1.0' "$api$2"
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

# --- Phase 4 slice 30: marks entered offline ---------------------------------------------------
# Seeded over curl: English on Class 5's subject list (the principal), and a weekly test in 5 B
# by the teacher, who teaches English there. The flow enters two marks in airplane mode.
principal_token="$(token_of "$PRINCIPAL_CNIC")"
CLASS_5="$(echo "$view" | json 'b.section.classId')"
ENGLISH="$(echo "$teacher_me" | json "b.assignments.find(a=>a.role==='subject_teacher').subjectId")"
printf '{"subjects":[{"subjectId":"%s","sortOrder":1,"examMaxMarks":100}]}' "$ENGLISH" \
  | curl -fs -K <(auth "$principal_token") -H 'X-App-Version: 0.1.0' \
    -H 'Content-Type: application/json' -X PATCH "$api/classes/$CLASS_5" -d @- >/dev/null
class_subject="$(get "$teacher_token" "/classes/$CLASS_5/subjects" | json "b.data.find(s=>s.subjectId==='$ENGLISH').id")"
ASSESSMENT_ID="$(printf '{"classSubjectId":"%s","sectionId":"%s","testType":"weekly","name":"Maestro spelling test","maxMarks":20,"heldOn":"%s"}' \
  "$class_subject" "$SECTION_B" "$today" \
  | curl -fs -K <(auth "$teacher_token") -H 'X-App-Version: 0.1.0' -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(node -e "console.log(require('node:crypto').randomUUID())")" -X POST "$api/assessments" -d @- \
  | json 'b.id')"
marks_grid="$(get "$teacher_token" "/assessments/$ASSESSMENT_ID/marks")"
MARKS_E1="$(echo "$marks_grid" | json 'b.rows[0].enrolmentId')"
MARKS_E2="$(echo "$marks_grid" | json 'b.rows[1].enrolmentId')"
flow teacher-marks-offline teacher-marks-offline.yaml "${ids[@]}" -e ASSESSMENT_ID="$ASSESSMENT_ID" \
  -e MARKS_E1="$MARKS_E1" -e MARKS_E2="$MARKS_E2"
# "The server has it": a live 17 and a live absence.
marked="$(get "$teacher_token" "/assessments/$ASSESSMENT_ID/marks" \
  | json "b.rows.filter(r=>r.status==='live'&&((r.enrolmentId==='$MARKS_E1'&&r.obtained===17)||(r.enrolmentId==='$MARKS_E2'&&r.absent))).length")"
if [ "$marked" != "2" ]; then echo "the server holds $marked of the two marks"; exit 1; fi

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

# --- Phase 3 slice 21: a deposit slip sent in airplane mode, verified by the office, receipted --
# The school takes deposits only with an active payment account (R196): the principal adds one
# if the seed has none.
accounts="$(get "$principal_token" '/payment-accounts?status=active' | json 'b.total')"
if [ "$accounts" = "0" ]; then
  printf '{"kind":"jazzcash","title":"Demo School","accountNo":"0300-0000000"}' \
    | curl -fs -K <(auth "$principal_token") -H 'X-App-Version: 0.1.0' \
      -H 'Content-Type: application/json' -X POST "$api/payment-accounts" -d @- >/dev/null
fi
flow parent-deposit-slip parent-deposit-slip.yaml "${ids[@]}"
# The office verifies it over curl (the principal holds payment.verify); with nothing owed the
# money is the child's advance.
claim_id="$(get "$principal_token" "/payment-claims?status=pending&studentId=$STUDENT_ID" | json 'b.data[0].id')"
if [ -z "$claim_id" ] || [ "$claim_id" = "undefined" ]; then echo "the parent's claim is not in the office queue"; exit 1; fi
printf '{"advanceForStudentId":"%s"}' "$STUDENT_ID" \
  | curl -fs -K <(auth "$principal_token") -H 'X-App-Version: 0.1.0' \
    -H 'Content-Type: application/json' -X POST "$api/payment-claims/$claim_id/verify" -d @- >/dev/null
flow parent-receipt parent-receipt.yaml "${ids[@]}"

# --- Phase 3 slice 27: the principal decides from the Approvals tab -----------------------------
# Seeded over curl: a second deposit slip from the guardian (the slip uploaded, then the claim),
# and an open cash handover by the teacher, whom the principal grants payment.record for the run
# (the principal may not confirm a handover they collected or opened, R194).
key() { node -e "console.log(require('node:crypto').randomUUID())"; }
post_as() { # token, path, idempotency key ('' for none); the JSON body on stdin
  local headers=(-H 'X-App-Version: 0.1.0' -H 'Content-Type: application/json')
  [ -n "$3" ] && headers+=(-H "Idempotency-Key: $3")
  curl -fs -K <(auth "$1") "${headers[@]}" -X POST "$api$2" -d @-
}
teacher_id="$(echo "$teacher_me" | json 'b.id')"
printf '{"capability":"payment.record","effect":"grant","reason":"Maestro cash handover"}' \
  | post_as "$principal_token" "/users/$teacher_id/grants" '' >/dev/null
year_id="$(get "$teacher_token" '/academic-years?status=active' | json 'b.data[0].id')"
printf '{"academicYearId":"%s","payerName":"Maestro payer","studentIds":["%s"],"amount":500,"method":"cash","receivedOn":"%s","advanceForStudentId":"%s"}' \
  "$year_id" "$STUDENT_ID" "$today" "$STUDENT_ID" \
  | post_as "$teacher_token" /payments "$(key)" >/dev/null
HANDOVER_ID="$(printf '{}' | post_as "$teacher_token" /me/staff/cash-handovers '' | json 'b.id')"
upload_id="$(curl -fs -K <(auth "$guardian_token") -H 'X-App-Version: 0.1.0' \
  -F "file=@$root/apps/mobile/maestro/assets/deposit-slip.png;type=image/png" "$api/me/uploads" | json 'b.id')"
CLAIM_ID="$(printf '{"method":"jazzcash","claimedAmount":700,"paidOn":"%s","reference":"MAESTRO-27","stagedUploadId":"%s"}' \
  "$today" "$upload_id" | post_as "$guardian_token" "/me/children/$STUDENT_ID/payment-claims" "$(key)" | json 'b.id')"
flow principal-approvals principal-approvals.yaml "${ids[@]}" -e CLAIM_ID="$CLAIM_ID" -e HANDOVER_ID="$HANDOVER_ID"
# The capture of the open slip under FLAG_SECURE (a black frame compresses to a few kilobytes).
# Maestro writes takeScreenshot into the run's own output folder (under --debug-output).
find "$out" -name 'principal-approvals-claim-sheet*.png' -exec ls -l {} \; || true
claim_status="$(get "$principal_token" "/payment-claims/$CLAIM_ID" | json 'b.status')"
if [ "$claim_status" != "verified" ]; then echo "the claim is '$claim_status', wanted verified"; exit 1; fi
handover_status="$(get "$principal_token" "/cash-handovers/$HANDOVER_ID" | json 'b.status')"
if [ "$handover_status" != "confirmed" ]; then echo "the handover is '$handover_status', wanted confirmed"; exit 1; fi

# --- Phase 4 slice 31: the principal approves a result sheet on the phone ----------------------
# Seeded over curl: the exams of the term holding today (Class 5), a mark for every gap the 5 A
# sheet lists (entered by the principal, whose marks.enter is school-wide), and the 5 A sheet,
# opened and submitted by its class teacher. The flow approves it from Approvals → Results.
TERM_ID="$(get "$principal_token" "/academic-years/$year_id/terms" \
  | json "(b.data.find(t=>t.startsOn<='$today'&&t.endsOn>='$today')||{}).id")"
if [ -z "$TERM_ID" ] || [ "$TERM_ID" = "undefined" ]; then echo "no term of the year holds $today"; exit 1; fi
printf '{"classIds":["%s"]}' "$CLASS_5" | post_as "$principal_token" "/terms/$TERM_ID/set-up-exams" '' >/dev/null
SHEET_ID="$(printf '{"termId":"%s"}' "$TERM_ID" | post_as "$teacher_token" "/sections/$SECTION_A/result-sheets" '' | json 'b.id')"
gaps="$(get "$teacher_token" "/result-sheets/$SHEET_ID" | json "b.flags.missing.map(g=>g.assessmentId+' '+g.enrolmentId).join('\n')")"
while read -r assessment enrolment; do
  [ -z "$assessment" ] && continue
  # An absence is a valid entry on any assessment, whatever its maximum.
  printf '{"entries":[{"enrolmentId":"%s","absent":true,"clientEntryKey":"%s","basedOnMarkId":null}]}' \
    "$enrolment" "maestro-result-$(node -e "console.log(require('node:crypto').randomBytes(9).toString('hex').replace(/[0-9]/g,'x'))")" \
    | post_as "$principal_token" "/assessments/$assessment/submit-marks" '' >/dev/null
done <<<"$gaps"
submitted="$(printf '{}' | post_as "$teacher_token" "/result-sheets/$SHEET_ID/submit" '' | json 'b.status')"
if [ "$submitted" != "submitted" ]; then echo "the 5 A sheet is '$submitted', wanted submitted"; exit 1; fi
flow principal-approve-result principal-approve-result.yaml "${ids[@]}" -e SHEET_ID="$SHEET_ID"
sheet_status="$(get "$principal_token" "/result-sheets/$SHEET_ID" | json 'b.status')"
if [ "$sheet_status" != "published" ]; then echo "the sheet is '$sheet_status', wanted published"; exit 1; fi

# --- Phase 4 slice 33: the parent opens the child's report card --------------------------------
# The published 5 A result of the guardian's child, read as the guardian would (R274).
RESULT_ID="$(get "$guardian_token" "/me/children/$STUDENT_ID/results" | json "(b.terms.find(t=>t.termId==='$TERM_ID')||{}).id")"
if [ -z "$RESULT_ID" ] || [ "$RESULT_ID" = "undefined" ]; then echo "the guardian sees no published result"; exit 1; fi
flow parent-report-card parent-report-card.yaml "${ids[@]}" -e RESULT_ID="$RESULT_ID"

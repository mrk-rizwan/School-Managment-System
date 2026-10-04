#!/usr/bin/env bash
# Runs inside reactivecircus/android-emulator-runner (contracts/slice-15.md §13.3), whose `script`
# executes line by line; this file keeps the steps together. CI only.
#   API_PID_FILE  where the job wrote the running API's pid
#   APK           the e2e APK (development profile, release variant: JS embedded, no dev launcher)
set -euo pipefail

export PATH="$HOME/.maestro/bin:$PATH"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
out="$root/apps/mobile/maestro/out"
mkdir -p "$out"

wait_for_api() {
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null http://127.0.0.1:3461/api/v1/health; then return 0; fi
    sleep 2
  done
  echo "API did not answer /api/v1/health"; tail -n 50 "$root/api.log"; return 1
}

start_api() {
  if [ -f "$API_PID_FILE" ]; then kill "$(cat "$API_PID_FILE")" 2>/dev/null || true; sleep 2; fi
  (cd "$root" && set -a && . ./.env && set +a && MOBILE_MIN_APP_VERSION="$1" nohup node apps/api/dist/main.js >>"$root/api.log" 2>&1 & echo $! >"$API_PID_FILE")
  wait_for_api
}

adb install -r "$APK"

start_api 0.0.0
maestro test --format junit --output "$out/sign-in.xml" --debug-output "$out/sign-in" \
  -e SCHOOL_CODE="$SCHOOL_CODE" -e PRINCIPAL_CNIC="$PRINCIPAL_CNIC" \
  "$root/apps/mobile/maestro/flows/sign-in-shell-sign-out.yaml"

start_api 99.0.0
maestro test --format junit --output "$out/update.xml" --debug-output "$out/update" \
  -e SCHOOL_CODE="$SCHOOL_CODE" -e PRINCIPAL_CNIC="$PRINCIPAL_CNIC" \
  "$root/apps/mobile/maestro/flows/update-required.yaml"

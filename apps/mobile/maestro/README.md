# Maestro flows — CI only

These flows drive the e2e APK on an Android emulator. They run in the `mobile` job of
`.github/workflows/ci.yml` (slice-15 §13.3, slice-16 §15.2), in this order, through `ci-run.sh`;
they are **not** a local gate, because a development machine is not guaranteed an Android SDK or
emulator.

| Flow                                | API state                       | Proves                                                                                   |
| ----------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `flows/sign-in-shell-sign-out.yaml` | `MOBILE_MIN_APP_VERSION=0.0.0`  | sign-in → role-aware shell → calendar "as of" → sign-out with the school code remembered |
| `flows/update-required.yaml`        | `MOBILE_MIN_APP_VERSION=99.0.0` | a 426 shows only the update screen, with the minimum version                             |
| `flows/register-offline.yaml`       | API and worker                  | a register marked in airplane mode says "Saved on device", then "Saved on server" when the connection returns; `ci-run.sh` then checks over `curl` that the server holds it with two absent marks |
| `flows/teacher-diary.yaml`          | API and worker                  | a diary entry reaches the server                                                         |
| `flows/teacher-marks-offline.yaml` | API and worker                  | (Phase 4 slice 30) `ci-run.sh` puts English on Class 5's subject list (the principal) and creates a 5 B weekly test (the teacher) over `curl`; the teacher opens it from the Marks tab, enters a mark and an absence in airplane mode ("Saved on device"), and sees "Saved on server" when the connection returns; `ci-run.sh` checks both marks over `curl` |
| `flows/parent-child.yaml`           | API, worker, object storage     | after the worker's rollup, the parent's card says "Absent"; the month opens; the seeded diary photo's thumbnail loads on a tap; the inbox opens |
| `flows/principal-today.yaml`        | API and worker                  | Today lists the unrecorded 5 B register; "Record now" records it pre-filled; the row leaves Today; `ci-run.sh` checks over `curl` that the server has it |
| `flows/principal-announce.yaml`     | API and worker                  | a short notice to 5 A shows "Reaches … · SMS …" before sending, appears on the list, and is in the guardian's inbox |
| `flows/parent-deposit-slip.yaml`    | API, worker, object storage     | (Phase 3 slice 21) a parent saves a deposit slip in airplane mode (the image added to the gallery with `addMedia`, `assets/deposit-slip.png`); claim and slip reach the school when the connection returns; `ci-run.sh` then verifies the claim over `curl` as the principal (adding a payment account first if the seed has none) |
| `flows/parent-receipt.yaml`         | API and worker                  | (slice 21) the verified slip and the receipt it issued appear on the child's Fees screen, rendered natively with Share |
| `flows/principal-approvals.yaml`    | API, worker, object storage     | (slice 27) `ci-run.sh` seeds a deposit slip (the guardian, over `curl`) and an open cash handover (the teacher, granted `payment.record`); the principal opens the Approvals tab, shows the slip on a tap and captures it (`takeScreenshot` to `out/`: black under FLAG_SECURE), verifies the claim (as the child's advance when nothing is owed) and confirms the handover; `ci-run.sh` checks both over `curl` |
| `flows/principal-approve-result.yaml` | API and worker | (Phase 4 slice 31) `ci-run.sh` sets up the term's exams for Class 5, enters an absence for every gap the 5 A result sheet lists (the principal) and has the class teacher open and submit the sheet over `curl`; the principal opens it from Approvals → Result sheets and approves it (published, as they hold `result.publish`); `ci-run.sh` checks over `curl` that it is published |

They read `SCHOOL_CODE` and the identity digits `MAESTRO_PRINCIPAL_CNIC`, `MAESTRO_TEACHER_CNIC`
and `MAESTRO_GUARDIAN_CNIC` — shell environment variables Maestro picks up by their prefix, so the
digits never appear on its command line (`ci-run.sh` sets them from `PRINCIPAL_CNIC`,
`TEACHER_CNIC` and `GUARDIAN_CNIC`) (the seeded people;
each default password is the same digits; `seed:dev-school` with `DEV_SCHOOL_CLASSROOM=1`), and the
ids `ci-run.sh` reads over the API as those people: `SECTION_A`, `SECTION_B`, `ENROLMENT_1`,
`ENROLMENT_2`, `STUDENT_ID`, `CLASS_ID`, the seeded `CLAIM_ID` and `HANDOVER_ID`, and (slice 30) `ASSESSMENT_ID`, `MARKS_E1`, `MARKS_E2`. Elements are selected by `testID`, `screen.element[.id]` — for
example `signIn.schoolCode`, `classes.section.<id>.register`, `register.chip.<enrolmentId>`,
`children.card.<studentId>.today`.

Airplane mode is Maestro's `setAirplaneMode`. If the emulator ignores it, run the job with
`AIRPLANE_MECHANISM=adb`: `ci-run.sh` then runs `register-offline-adb-1/2/3.yaml` and toggles
airplane mode with `adb shell cmd connectivity airplane-mode enable|disable` between them. The
mechanism that worked is recorded in the WORKLOG after the first CI run.

To run them by hand on a machine with an emulator and Maestro 2.x:

```sh
pnpm --filter @asms/api seed:dev-school          # with the classroom variables; see the README's "Mobile app"
adb install android/app/build/outputs/apk/debug/app-debug.apk
MAESTRO_PRINCIPAL_CNIC=<13 digits> maestro test -e SCHOOL_CODE=demo maestro/flows/sign-in-shell-sign-out.yaml
```

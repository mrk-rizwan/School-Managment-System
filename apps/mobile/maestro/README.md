# Maestro flows — CI only

These flows drive the debug APK on an Android emulator. They run in the `mobile` job of
`.github/workflows/ci.yml` (slice-15 §13.3); they are **not** a local gate, because a development
machine is not guaranteed an Android SDK or emulator.

| Flow                                | API state                       | Proves                                                                                   |
| ----------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `flows/sign-in-shell-sign-out.yaml` | `MOBILE_MIN_APP_VERSION=0.0.0`  | sign-in → role-aware shell → calendar "as of" → sign-out with the school code remembered |
| `flows/update-required.yaml`        | `MOBILE_MIN_APP_VERSION=99.0.0` | a 426 shows only the update screen, with the minimum version                             |

Both read `SCHOOL_CODE` and `PRINCIPAL_CNIC` (the seeded principal: `seed:dev-school`; the default
password is the same digits). Elements are selected by `testID`, `screen.element` — for example
`signIn.schoolCode`, `tabs.home`, `account.signOut`.

To run them by hand on a machine with an emulator and Maestro 2.x:

```sh
pnpm --filter @asms/api seed:dev-school          # DEV_SCHOOL_PRINCIPAL_CNIC and _PHONE in the environment; a non-localhost database also needs ALLOW_DEV_SEED=1
adb install android/app/build/outputs/apk/debug/app-debug.apk
maestro test -e SCHOOL_CODE=demo -e PRINCIPAL_CNIC=<13 digits> maestro/flows/sign-in-shell-sign-out.yaml
```

Slice 16 adds `register-offline.yaml` (airplane mode through `adb shell`) and the parent and
principal flows to the same job.

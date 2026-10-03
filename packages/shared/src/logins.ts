/**
 * R57: every issue-login audit row carries a reason. The issue-login bodies take an optional
 * `reason`; when none is given, the row records where the login was issued, in these words.
 * Defined once here so the API and the web (the admission wizard) use the same strings.
 */
export const LOGIN_ISSUED_REASONS = {
  staff: 'Login issued from the staff record',
  guardian: 'Login issued from the guardian record',
  student: 'Login issued from the student record',
  admission: 'Login issued at admission',
  platformPrincipal: 'Principal login issued by the platform',
} as const;

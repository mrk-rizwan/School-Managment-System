// The remembered school code is the ONLY value the web app writes to browser storage
// (plan §3.10). Identity digits, wizard state and API data never go to localStorage.
const KEY = 'asms.schoolCode';

export function getRememberedSchoolCode(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null; // storage disabled or unavailable: behave as if nothing was remembered
  }
}

export function rememberSchoolCode(code: string): void {
  try {
    window.localStorage.setItem(KEY, code.trim());
  } catch {
    // remembering is a convenience; failing to remember is not an error
  }
}

export function forgetSchoolCode(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // as above
  }
}

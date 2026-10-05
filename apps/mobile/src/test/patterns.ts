// The R16 identity regex, the phone regex and the token shape: nothing in a log may match them.
export const IDENTITY_PATTERN = /\d{5}-?\d{7}-?\d/;
export const PHONE_PATTERN = /(\+?92[\s-]?|0)3\d{2}[\s-]?\d{3}[\s-]?\d{4}/;
export const TOKEN_PATTERN = /[A-Za-z0-9_-]{43}/;

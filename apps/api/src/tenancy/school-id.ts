// The tenant key. A plain bigint cannot be passed where a SchoolId is expected, so a repository
// call cannot be fed an id taken from a request body, query string or route parameter. Values are
// minted only in ./school-id.mint.ts, whose importers are restricted by lint.
declare const schoolIdBrand: unique symbol;

export type SchoolId = bigint & { readonly [schoolIdBrand]: true };

// The tenant key. A plain bigint cannot be passed where a SchoolId is expected, so a repository
// call cannot be fed an id taken from a request body, query string or route parameter. Values are
// minted only in ./school-id.mint.ts, whose importers are restricted by lint.
declare const schoolIdBrand: unique symbol;

export type SchoolId = bigint & { readonly [schoolIdBrand]: true };

declare const createdSchoolBrand: unique symbol;

/**
 * A school row SchoolRepository.create has just inserted, and nothing else. It is the only thing
 * fromPlatformSchool accepts, so a route parameter or a row read back by id cannot become a
 * SchoolId inside the platform module. Branded in ./school-id.mint.ts.
 */
export type CreatedSchoolRow = { readonly id: bigint } & { readonly [createdSchoolBrand]: true };

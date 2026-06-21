// DI token for the Meilisearch client, kept in its own leaf module.
//
// `meilisearch.module.ts` imports `SearchService`, and `SearchService` needs
// this token — if the token lived in the module file, that import cycle would
// resolve the token to `undefined` at decoration time (Nest then reports a
// spurious "circular dependency inside MeilisearchModule"). Defining it here,
// where nothing else is imported, breaks the cycle.
export const MEILI_CLIENT = Symbol('MEILI_CLIENT');

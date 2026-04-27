// Global Meilisearch module — exposes a ready-to-use MeiliSearch client and the
// SearchService that wraps node indexing / full-text search. See spec §6.1
// (GET /graph/search) and the Phase 2 DoD.

import { Global, Module } from '@nestjs/common';
import MeiliSearch from 'meilisearch';
import { loadEnv } from '../../config/env';
import { SearchService } from './search.service';

export const MEILI_CLIENT = Symbol('MEILI_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: MEILI_CLIENT,
      useFactory: (): MeiliSearch => {
        const env = loadEnv();
        return new MeiliSearch({
          host: env.MEILI_HOST,
          apiKey: env.MEILI_MASTER_KEY,
        });
      },
    },
    SearchService,
  ],
  exports: [MEILI_CLIENT, SearchService],
})
export class MeilisearchModule {}

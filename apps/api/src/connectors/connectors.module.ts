// Phases 4–7 (per §12) implement individual connectors. The module shell exists
// in Phase 0 so config endpoints + the BaseConnector contract can be wired up.

import { Module } from '@nestjs/common';
import { BaseConnector } from './base.connector';

@Module({
  providers: [{ provide: BaseConnector, useValue: null }],
})
export class ConnectorsModule {}

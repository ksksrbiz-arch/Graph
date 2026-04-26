// Holds the shared ConnectorConfigStore. Made global so OAuthModule and
// ConnectorsModule can both read/write it without importing each other —
// breaking what would otherwise be a circular module dependency.

import { Global, Module } from '@nestjs/common';
import { ConnectorConfigStore } from './connector-config.store';

@Global()
@Module({
  providers: [ConnectorConfigStore],
  exports: [ConnectorConfigStore],
})
export class ConnectorConfigsModule {}

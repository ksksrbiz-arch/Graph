import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import {
  IdempotencyInterceptor,
  IdempotencyService,
} from './shared/idempotency';

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  app.enableCors({ origin: true, credentials: true });

  // Apply the idempotency interceptor globally — it is a no-op for handlers
  // that aren't decorated with `@Idempotent()`, so this is free for endpoints
  // that don't opt in.
  app.useGlobalInterceptors(
    new IdempotencyInterceptor(app.get(IdempotencyService), app.get(Reflector)),
  );

  const swagger = new DocumentBuilder()
    .setTitle('PKG-VS API')
    .setDescription('Personal Knowledge Graph Visualization System — REST API. See spec §6.')
    .setVersion('1.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));

  await app.listen(env.API_PORT, env.API_HOST);
  // eslint-disable-next-line no-console
  console.log(`[pkg-api] listening on http://${env.API_HOST}:${env.API_PORT}`);
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[pkg-api] bootstrap failed', err);
  process.exit(1);
});

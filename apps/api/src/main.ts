import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { splitCsvEnv } from './config/env-utils';
import {
  IdempotencyInterceptor,
  IdempotencyService,
} from './shared/idempotency';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const allowedOrigins = splitCsvEnv(env.CORS_ORIGINS);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'health/ready', 'metrics'] });
  // Raise the default body limit so the public/ingest endpoints can accept
  // a pasted text/markdown blob up to PUBLIC_INGEST_MAX_BYTES. The service
  // layer enforces the per-request cap; this is a guard rail one notch above.
  const bodyLimit = Math.max(env.PUBLIC_INGEST_MAX_BYTES * 2, 1024 * 1024);
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  app.enableCors({
    origin:
      allowedOrigins.length === 0
        ? true
        : (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) callback(null, true);
            else callback(new Error('origin not allowed by CORS'));
          },
    credentials: true,
  });

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

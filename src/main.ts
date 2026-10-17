import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { join } from 'path';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { LoggerService } from './common/logger.service';
import { LoggingInterceptor } from './common/logging.interceptor';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true, // capture early logs
    bodyParser: false,
  });

  const config = app.get(ConfigService);
  const logger = app.get(LoggerService);
  const nodeEnv = config.get<string>('NODE_ENV') ?? 'development';
  const isProduction = nodeEnv === 'production';

  // Security: Remove X-Powered-By header
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Security: Apply HTTP response headers to protect against common web vulnerabilities
  app.use(
    (
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      next();
    },
  );

  // Security: Validate and sanitize all incoming payloads
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unallowed properties from input
      transform: true, // transform incoming types to match DTOs
      forbidNonWhitelisted: false,
    }),
  );

  // Univer workbook snapshots can be large because they store cell styles,
  // merges, dimensions and multi-sheet rubric templates as JSON.
  app.use(express.json({ limit: '150mb' }));
  app.use(express.urlencoded({ limit: '150mb', extended: true }));

  // Replace Nest default logger with custom Winston logger
  app.useLogger(logger);

  // CORS: restrict to approved domains in production
  const allowedOrigins = (
    config.get<string>('CORS_ORIGINS') ??
    'http://localhost:3000,http://localhost:3001,http://localhost:5000,https://classroomconnect.la'
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: isProduction
      ? (origin, callback) => {
          if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
          } else {
            callback(new Error('Not allowed by CORS'));
          }
        }
      : true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    allowedHeaders: 'Content-Type,Authorization,Cache-Control,cache-control',
    exposedHeaders: ['X-Refreshed-Token'],
    credentials: true,
  });

  // Set global API prefix from .env (e.g., /api or UUID)
  const prefix = config.get<string>('API_PREFIX') ?? '/api';
  app.setGlobalPrefix(prefix);

  // Serve static uploads at /uploads
  app.useStaticAssets(join(process.cwd(), 'uploads'), {
    prefix: '/uploads/',
  });

  // Optional: log all requests/responses
  app.useGlobalInterceptors(new LoggingInterceptor(logger));

  // Swagger docs: only enable in development or when explicitly turned on
  if (!isProduction || config.get<string>('ENABLE_SWAGGER') === 'true') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Alpha School API')
      .setDescription('Alpha School REST API documentation')
      .setVersion('2.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${prefix}/docs`, app, document);
    logger.log(
      `Swagger docs enabled at http://localhost:${config.get('PORT') ?? 3000}${prefix}/docs`,
    );
  }

  const port = Number(config.get<string>('PORT') ?? 3000);

  await app.listen(port, config.get<string>('LISTEN_HOST') ?? '127.0.0.1');
  logger.log(`Server running at http://localhost:${port}${prefix}`);
}

bootstrap();

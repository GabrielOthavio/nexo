import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { json, NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';

/** Espelha o corte por tamanho que o app faz no push (ver TAMANHO_MAXIMO_LOTE_BYTES em syncService.ts). */
const LIMITE_BODY_JSON = '10mb';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('HTTP');

  app.use(json({ limit: LIMITE_BODY_JSON }));

  // Log de cada requisição (método, origem, rota, status) — útil em dev para
  // diagnosticar se um cliente (ex.: o app mobile numa rede diferente) está
  // de fato alcançando o servidor, distinguindo isso de uma falha de rede
  // antes mesmo de chegar aqui.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const inicio = Date.now();
    res.on('finish', () => {
      logger.log(`${req.method} ${req.originalUrl} <- ${req.ip} — ${res.statusCode} (${Date.now() - inicio}ms)`);
    });
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Sem CORS: os únicos clientes são o app mobile nativo (Axios, não sujeito
  // a CORS — é uma regra de navegador) e testes locais via curl/Postman.
  // Não há build web em produção consumindo esta API; se um dia houver,
  // trocar por app.enableCors({ origin: allowlist, credentials: false }).

  const port = process.env.PORT ?? 3333;
  // Em produção este serviço fica ATRÁS do nginx: escutar só em 127.0.0.1
  // impede que a porta 3333 seja alcançável de fora, mesmo que o firewall
  // seja mal configurado (defesa em profundidade — o ufw é a outra camada).
  // O padrão continua 0.0.0.0 porque em desenvolvimento o app precisa
  // alcançar esta porta pela rede local; o .env de produção define 127.0.0.1.
  const host = process.env.SYNC_HOST ?? '0.0.0.0';
  await app.listen(port, host);
  logger.log(`Sync backend rodando em http://${host}:${port}`);
}
bootstrap().catch((erro) => {
  // Sem este catch, uma falha ao subir (porta 3333 ocupada, Postgres fora
  // do ar) virava um unhandled rejection com stack trace cru e nenhuma
  // pista do que fazer.
  Logger.error(
    `Falha ao iniciar o sync-backend: ${erro instanceof Error ? erro.message : String(erro)}`,
    'Bootstrap',
  );
  process.exit(1);
});

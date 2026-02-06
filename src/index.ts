import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import instancesRouter from './routes/instances.js';
import messagesRouter from './routes/messages.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '2mb' }));

function apiKeyMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const key = req.headers['x-api-key'];
  if (!config.apiKey || config.apiKey === '') {
    return next();
  }
  if (key !== config.apiKey) {
    return res.status(401).json({ ok: false, error: 'invalid_api_key' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'rsalcara' });
});

// API key só nas rotas /v1 (a interface em / carrega sem key)
app.use('/v1/instances', apiKeyMiddleware, instancesRouter);
app.use('/v1/messages', apiKeyMiddleware, messagesRouter);

const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.listen(config.port, () => {
  console.log(`[rsalcara] API rodando em http://localhost:${config.port}`);
  console.log(`[rsalcara] Interface: http://localhost:${config.port}`);
  if (config.apiKey) {
    console.log('[rsalcara] API Key ativa. Use header: x-api-key');
  }
});

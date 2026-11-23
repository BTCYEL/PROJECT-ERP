import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { closeDatabase, initSchema, seedDatabase } from './server/db.ts';
import { apiRouter } from './server/routes.ts';

async function bootstrap() {
  initSchema();
  seedDatabase();

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.use(
    '/api/v1',
    (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      next();
    },
    apiRouter,
  );

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = Number(process.env.PORT || 3000);
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Maximus Barbecue ERP listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = () => {
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    setTimeout(() => {
      closeDatabase();
      process.exit(0);
    }, 2000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Failed to start Maximus Barbecue ERP server:', err);
  closeDatabase();
  process.exit(1);
});

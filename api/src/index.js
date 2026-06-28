import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import questsRouter from './routes/quests.js';

const app = express();
const PORT = process.env.PORT ?? 3000;
const API_SECRET = process.env.API_SECRET;

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (API_SECRET) {
    const auth = req.headers['x-api-secret'];
    if (auth !== API_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/quests', questsRouter);

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`✅ NeverDie Quest API running on port ${PORT}`);
});

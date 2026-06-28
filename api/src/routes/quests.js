import { Router } from 'express';
import * as db from '../db.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(db.getAll());
});

router.get('/stats', (_req, res) => {
  res.json(db.stats());
});

router.get('/:id', (req, res) => {
  const quest = db.getById(Number(req.params.id));
  if (!quest) return res.status(404).json({ error: 'Quest not found' });
  res.json(quest);
});

router.post('/', (req, res) => {
  const { name, deadline, note } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: '`name` is required' });
  }
  if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) {
    return res.status(400).json({ error: '`deadline` must be YYYY-MM-DD' });
  }
  const quest = db.insert({ name: name.trim(), deadline: deadline ?? null, note: note ?? null });
  res.status(201).json(quest);
});

router.patch('/:id/done', (req, res) => {
  const quest = db.getById(Number(req.params.id));
  if (!quest) return res.status(404).json({ error: 'Quest not found' });
  res.json(db.markDone(Number(req.params.id)));
});

router.patch('/:id', (req, res) => {
  const quest = db.getById(Number(req.params.id));
  if (!quest) return res.status(404).json({ error: 'Quest not found' });
  const { name, deadline, note, done } = req.body;
  res.json(db.update(Number(req.params.id), { name, deadline, note, done }));
});

router.delete('/:id', (req, res) => {
  const removed = db.remove(Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Quest not found' });
  res.json(removed);
});

export default router;

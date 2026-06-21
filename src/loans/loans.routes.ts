// Loans router (CONTRACT §12(d)).
// Exported but NOT mounted here — the controller mounts it at `/api/loans`.

import { Router } from 'express';
import { loansReport } from './loans';

export const loansRouter: Router = Router();

// GET /api/loans → the full loans report (loans + totals).
loansRouter.get('/', (_req, res) => {
  res.json(loansReport());
});

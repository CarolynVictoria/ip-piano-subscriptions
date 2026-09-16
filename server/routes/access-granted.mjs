import express from 'express';

import { getPool } from '../db.mjs';

const router = express.Router();

/* =========================================================
   Access Granted summary
   ========================================================= */

router.get('/count', async (_req, res, next) => {
	try {
		const pool = await getPool();

		const result = await pool.request().query(`
			SELECT
				COUNT(DISTINCT user_uid) AS access_granted_users
			FROM dbo.access_granted;
		`);

		const row = result.recordset[0];

		return res.json({
			accessGrantedUsers: Number(row.access_granted_users ?? 0),
		});
	} catch (error) {
		next(error);
	}
});

export default router;

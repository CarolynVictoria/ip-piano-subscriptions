import process from 'node:process';

import express from 'express';

import { closePool, getPool } from './db.mjs';

import subscriptionsRouter from './routes/subscriptions.mjs';

const app = express();

const PORT = Number(process.env.PORT || 3001);

if (!Number.isInteger(PORT) || PORT <= 0) {
	throw new Error(
		`PORT must be a positive integer. Received: ${process.env.PORT}`,
	);
}

/* =========================================================
   Express configuration
   ========================================================= */

app.disable('x-powered-by');

app.use(
	express.json({
		limit: '100kb',
	}),
);

/* =========================================================
   API status
   ========================================================= */

app.get('/api/status', async (_req, res) => {
	try {
		const pool = await getPool();

		const result = await pool.request().query(`
			SELECT
				DB_NAME() AS database_name,
				SYSDATETIMEOFFSET() AS database_time;
		`);

		const row = result.recordset[0];

		return res.json({
			ok: true,
			database: row.database_name,
			databaseTime: row.database_time,
		});
	} catch (error) {
		console.error('GET /api/status failed:', error);

		return res.status(500).json({
			ok: false,
			error: 'Database status check failed.',
		});
	}
});

/* =========================================================
   Subscription API
   ========================================================= */

app.use('/api/subscriptions', subscriptionsRouter);

/* =========================================================
   API error handler
   ========================================================= */

app.use((error, req, res, _next) => {
	console.error(`${req.method} ${req.originalUrl} failed:`, error);

	if (res.headersSent) {
		return;
	}

	res.status(500).json({
		ok: false,
		error: 'Internal server error.',
	});
});

/* =========================================================
   Server startup
   ========================================================= */

const server = app.listen(PORT, () => {
	console.log(`API server listening on http://localhost:${PORT}`);
});

/* =========================================================
   Graceful shutdown
   ========================================================= */

let shuttingDown = false;

async function shutdown(signal) {
	if (shuttingDown) {
		return;
	}

	shuttingDown = true;

	console.log(`Received ${signal}; shutting down.`);

	server.close(async (serverError) => {
		let exitCode = 0;

		if (serverError) {
			console.error('HTTP server shutdown failed:', serverError);

			exitCode = 1;
		}

		try {
			await closePool();
		} catch (error) {
			console.error('SQL pool shutdown failed:', error);

			exitCode = 1;
		}

		process.exit(exitCode);
	});
}

process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('SIGTERM', () => void shutdown('SIGTERM'));

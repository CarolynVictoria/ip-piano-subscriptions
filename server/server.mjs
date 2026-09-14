import express from 'express';

import { closePool, getPool } from './db.mjs';

const PORT = Number(process.env.PORT || 3001);

const app = express();

app.use(express.json());

app.get('/api/status', async (request, response) => {
	try {
		const pool = await getPool();

		const result = await pool.request().query(`
			SELECT
				DB_NAME() AS database_name,
				SYSDATETIMEOFFSET() AS database_time;
		`);

		response.json({
			ok: true,
			database: result.recordset[0].database_name,
			databaseTime: result.recordset[0].database_time,
		});
	} catch (error) {
		console.error('Database status check failed:', error);

		response.status(500).json({
			ok: false,
			error: 'Database connection failed.',
		});
	}
});

const server = app.listen(PORT, () => {
	console.log(`API server listening on http://localhost:${PORT}`);
});

async function shutdown(signal) {
	console.log(`Received ${signal}. Shutting down.`);

	server.close(async () => {
		try {
			await closePool();
			process.exit(0);
		} catch (error) {
			console.error('Error while shutting down:', error);
			process.exit(1);
		}
	});
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

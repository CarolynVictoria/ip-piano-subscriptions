import sql from 'mssql';

const REQUIRED_ENV = ['SQL_SERVER', 'SQL_USER', 'SQL_PASSWORD', 'SQL_DATABASE'];

const CONNECT_ATTEMPTS = 4;
const CONNECT_RETRY_DELAY_MS = 5000;

for (const name of REQUIRED_ENV) {
	if (!process.env[name]) {
		throw new Error(`Missing ${name} in environment.`);
	}
}

const sqlConfig = {
	server: process.env.SQL_SERVER,
	port: Number(process.env.SQL_PORT || 1433),
	user: process.env.SQL_USER,
	password: process.env.SQL_PASSWORD,
	database: process.env.SQL_DATABASE,

	connectionTimeout: 60000,
	requestTimeout: 30000,

	options: {
		encrypt:
			String(process.env.SQL_ENCRYPT || 'false').toLowerCase() === 'true',

		trustServerCertificate:
			String(
				process.env.SQL_TRUST_SERVER_CERTIFICATE || 'true',
			).toLowerCase() === 'true',
	},
};

let poolPromise = null;

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function connectWithRetry() {
	let lastError;

	for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt += 1) {
		const pool = new sql.ConnectionPool(sqlConfig);

		try {
			console.log(
				`Connecting to SQL Server: attempt ${attempt} of ${CONNECT_ATTEMPTS}...`,
			);

			await pool.connect();

			console.log('Connected to SQL Server.');

			return pool;
		} catch (error) {
			lastError = error;

			console.warn(
				`SQL Server connection attempt ${attempt} failed:`,
				error.message,
			);

			try {
				await pool.close();
			} catch {
				// The pool may not have opened successfully.
			}

			if (attempt < CONNECT_ATTEMPTS) {
				console.log(
					`Retrying SQL Server connection in ${CONNECT_RETRY_DELAY_MS / 1000} seconds...`,
				);

				await delay(CONNECT_RETRY_DELAY_MS);
			}
		}
	}

	throw lastError;
}

export function getPool() {
	if (!poolPromise) {
		poolPromise = connectWithRetry().catch((error) => {
			poolPromise = null;
			throw error;
		});
	}

	return poolPromise;
}

export async function closePool() {
	if (!poolPromise) {
		return;
	}

	try {
		const pool = await poolPromise;
		await pool.close();
	} finally {
		poolPromise = null;
	}
}

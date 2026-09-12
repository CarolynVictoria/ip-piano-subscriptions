import sql from 'mssql';

const required = ['SQL_SERVER', 'SQL_USER', 'SQL_PASSWORD', 'SQL_DATABASE'];

for (const name of required) {
	if (!process.env[name]) {
		throw new Error(`Missing ${name} in .env`);
	}
}

const config = {
	server: process.env.SQL_SERVER,
	port: Number(process.env.SQL_PORT || 1433),
	user: process.env.SQL_USER,
	password: process.env.SQL_PASSWORD,
	database: process.env.SQL_DATABASE,

	options: {
		encrypt: false,
		trustServerCertificate: true,
	},
};

let pool;

try {
	pool = await sql.connect(config);

	const result = await pool.request().query(`
		SELECT
			DB_NAME() AS database_name,
			@@SERVERNAME AS server_name;

		SELECT
			name AS table_name
		FROM sys.tables
		WHERE name IN (
			'extract_runs',
			'licensees',
			'contracts',
			'contract_users',
			'contract_domains',
			'contract_domain_users'
		)
		ORDER BY name;
	`);

	console.log('SQL Server connection successful.');
	console.log('');
	console.log('Connection:');
	console.table(result.recordsets[0]);

	console.log('Expected tables found:');
	console.table(result.recordsets[1]);
} catch (error) {
	console.error('SQL Server connection failed.');
	console.error(error);
	process.exitCode = 1;
} finally {
	if (pool) {
		await pool.close();
	}
}

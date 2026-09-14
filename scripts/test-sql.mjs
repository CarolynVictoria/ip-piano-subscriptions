import sql from 'mssql';

const required = ['SQL_SERVER', 'SQL_USER', 'SQL_PASSWORD', 'SQL_DATABASE'];

for (const name of required) {
	if (!process.env[name]) {
		throw new Error(`Missing ${name} in environment.`);
	}
}

const config = {
	server: process.env.SQL_SERVER,
	port: Number(process.env.SQL_PORT || 1433),
	user: process.env.SQL_USER,
	password: process.env.SQL_PASSWORD,
	database: process.env.SQL_DATABASE,

	options: {
		encrypt:
			String(process.env.SQL_ENCRYPT || 'false').toLowerCase() === 'true',

		trustServerCertificate:
			String(
				process.env.SQL_TRUST_SERVER_CERTIFICATE || 'true',
			).toLowerCase() === 'true',
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

			'resources',
			'terms',
			'term_billing_plan_rows',
			'term_change_options',
			'term_change_option_show_options',

			'site_licensees',
			'site_contracts',
			'site_contract_users',
			'site_contract_domains',
			'site_contract_domain_users',

			'subscriptions',
			'subscription_shared_accounts',

			'previous_resources',
			'previous_terms',
			'previous_term_billing_plan_rows',
			'previous_term_change_options',
			'previous_term_change_option_show_options',

			'previous_site_licensees',
			'previous_site_contracts',
			'previous_site_contract_users',
			'previous_site_contract_domains',
			'previous_site_contract_domain_users',

			'previous_subscriptions',
			'previous_subscription_shared_accounts'
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

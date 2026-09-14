import fs from 'node:fs/promises';
import path from 'node:path';
import sql from 'mssql';

const API_BASE_URL = (
	process.env.PIANO_API_BASE_URL || 'https://api.piano.io/api/v3'
).replace(/\/$/, '');

const AID = process.env.PIANO_AID;
const API_TOKEN = process.env.PIANO_API_TOKEN;

const SQL_SERVER = process.env.SQL_SERVER;
const SQL_PORT = Number(process.env.SQL_PORT || 1433);
const SQL_USER = process.env.SQL_USER;
const SQL_PASSWORD = process.env.SQL_PASSWORD;
const SQL_DATABASE = process.env.SQL_DATABASE;

const EXTRACT_ROOT = path.resolve(process.env.EXTRACT_ROOT || './extracts');

const PAGE_SIZE = 50;
const MAX_PAGES = 10000;
const MAX_RETRIES = 3;

const SQL_BULK_BATCH_SIZE = Number(process.env.SQL_BULK_BATCH_SIZE || 1000);

const ENDPOINTS = {
	licensees: '/publisher/licensing/licensee/list',

	contracts: '/publisher/licensing/contract/list',

	contractUsers: '/publisher/licensing/contractUser/list',

	contractDomains: '/publisher/licensing/contractDomain/list',

	contractDomainUsers: '/publisher/licensing/contractDomain/contractUser/list',
};

const REQUIRED_ENV = [
	'PIANO_AID',
	'PIANO_API_TOKEN',
	'SQL_SERVER',
	'SQL_USER',
	'SQL_PASSWORD',
	'SQL_DATABASE',
];

for (const name of REQUIRED_ENV) {
	if (!process.env[name]) {
		throw new Error(`Missing ${name} in environment.`);
	}
}

if (!Number.isInteger(SQL_BULK_BATCH_SIZE) || SQL_BULK_BATCH_SIZE <= 0) {
	throw new Error(
		'SQL_BULK_BATCH_SIZE must be a positive integer. ' +
			`Received: ${SQL_BULK_BATCH_SIZE}`,
	);
}

const sqlConfig = {
	server: SQL_SERVER,
	port: SQL_PORT,
	user: SQL_USER,
	password: SQL_PASSWORD,
	database: SQL_DATABASE,

	options: {
		encrypt:
			String(process.env.SQL_ENCRYPT || 'false').toLowerCase() === 'true',

		trustServerCertificate:
			String(
				process.env.SQL_TRUST_SERVER_CERTIFICATE || 'true',
			).toLowerCase() === 'true',
	},
};

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function valueOrNull(value) {
	return value === undefined ? null : value;
}

function jsonOrNull(value) {
	if (value === undefined) {
		return null;
	}

	return JSON.stringify(value);
}

function redactUrl(url) {
	const copy = new URL(url);

	if (copy.searchParams.has('api_token')) {
		copy.searchParams.set('api_token', '[REDACTED]');
	}

	return copy.toString();
}

async function pianoGet(endpoint, params = {}) {
	const url = new URL(`${API_BASE_URL}${endpoint}`);

	url.searchParams.set('aid', AID);
	url.searchParams.set('api_token', API_TOKEN);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null) {
			url.searchParams.set(key, String(value));
		}
	}

	let lastError;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
		try {
			const response = await fetch(url, {
				method: 'GET',
				headers: {
					Accept: 'application/json',
				},
				signal: AbortSignal.timeout(60000),
			});

			const text = await response.text();

			let body;

			try {
				body = text ? JSON.parse(text) : {};
			} catch {
				throw new Error(
					`Non-JSON response from ` +
						`${redactUrl(url)}: ` +
						`HTTP ${response.status}`,
				);
			}

			if (!response.ok) {
				const error = new Error(
					`HTTP ${response.status} from ` + `${redactUrl(url)}`,
				);

				error.status = response.status;
				error.body = body;

				throw error;
			}

			/*
			 * Piano may return HTTP 200 while reporting
			 * an API-level error in the JSON body.
			 */
			if (
				body &&
				!Array.isArray(body) &&
				body.code !== undefined &&
				Number(body.code) !== 0
			) {
				const error = new Error(
					`Piano API error ${body.code} from ` + `${redactUrl(url)}`,
				);

				error.body = body;

				throw error;
			}

			return body;
		} catch (error) {
			lastError = error;

			const retryable =
				error?.status === 429 ||
				error?.status >= 500 ||
				error?.name === 'TimeoutError';

			if (!retryable || attempt === MAX_RETRIES) {
				throw error;
			}

			const waitMs = 500 * (attempt + 1);

			console.log(`Retrying after error: ` + `${error.message}`);

			await sleep(waitMs);
		}
	}

	throw lastError;
}

function findArray(body, preferredKeys, label) {
	if (Array.isArray(body)) {
		return body;
	}

	for (const preferredKey of preferredKeys) {
		const actualKey = Object.keys(body || {}).find(
			(key) => key.toLowerCase() === preferredKey.toLowerCase(),
		);

		if (actualKey && Array.isArray(body[actualKey])) {
			return body[actualKey];
		}
	}

	/*
	 * Some Piano list responses use wrapper names that
	 * are not documented. If there is exactly one array
	 * in the response, use that array.
	 */
	const arrays = Object.entries(body || {}).filter(([, value]) =>
		Array.isArray(value),
	);

	if (arrays.length === 1) {
		return arrays[0][1];
	}

	throw new Error(
		`Could not identify ${label} array. ` +
			`Response keys: ` +
			Object.keys(body || {}).join(', '),
	);
}

async function listAll({ endpoint, params = {}, preferredKeys, label }) {
	const records = [];

	let offset = 0;
	let page = 1;

	while (true) {
		if (page > MAX_PAGES) {
			throw new Error(`Exceeded MAX_PAGES while retrieving ${label}.`);
		}

		const body = await pianoGet(endpoint, {
			...params,
			offset,
			limit: PAGE_SIZE,
		});

		const items = findArray(body, preferredKeys, label);

		console.log(`${label}: offset=${offset}, returned=${items.length}`);

		if (items.length === 0) {
			break;
		}

		records.push(...items);

		offset += items.length;
		page += 1;
	}

	return records;
}

async function writeJson(filePath, data) {
	await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

async function createRunRow(pool, runName) {
	const result = await pool
		.request()
		.input('run_name', sql.NVarChar(255), runName)
		.input('status', sql.VarChar(30), 'RUNNING').query(`
			INSERT INTO dbo.extract_runs (
				run_name,
				status
			)
			OUTPUT INSERTED.extract_run_id
			VALUES (
				@run_name,
				@status
			);
		`);

	return result.recordset[0].extract_run_id;
}

async function markRunComplete(pool, extractRunId) {
	await pool.request().input('extract_run_id', sql.BigInt, extractRunId).query(`
			UPDATE dbo.extract_runs
			SET
				status = 'COMPLETE',
				completed_at_utc = SYSUTCDATETIME()
			WHERE extract_run_id = @extract_run_id;
		`);
}

async function markRunFailed(pool, extractRunId, error) {
	if (!extractRunId) {
		return;
	}

	await pool
		.request()
		.input('extract_run_id', sql.BigInt, extractRunId)
		.input(
			'notes',
			sql.NVarChar(sql.MAX),
			String(error?.stack || error?.message || error),
		).query(`
			UPDATE dbo.extract_runs
			SET
				status = 'FAILED',
				completed_at_utc = SYSUTCDATETIME(),
				notes = @notes
			WHERE extract_run_id = @extract_run_id;
		`);
}

async function backupCurrentTables(transaction) {
	await transaction.request().batch(`
		TRUNCATE TABLE dbo.previous_site_contract_domain_users;
		TRUNCATE TABLE dbo.previous_site_contract_domains;
		TRUNCATE TABLE dbo.previous_site_contract_users;
		TRUNCATE TABLE dbo.previous_site_contracts;
		TRUNCATE TABLE dbo.previous_site_licensees;

		INSERT INTO dbo.previous_site_licensees (
			extract_run_id,
			aid,
			licensee_id,
			name,
			description,
			logo_url,
			representatives_json,
			managers_json,
			extracted_at_utc
		)
		SELECT
			extract_run_id,
			aid,
			licensee_id,
			name,
			description,
			logo_url,
			representatives_json,
			managers_json,
			extracted_at_utc
		FROM dbo.site_licensees;

		INSERT INTO dbo.previous_site_contracts (
			extract_run_id,
			licensee_id,
			licensee_name,
			contract_id,
			aid,
			name,
			description,
			create_date,
			landing_page_url,
			seats_number,
			is_hard_seats_limit_type,
			rid,
			schedule_id,
			contract_is_active,
			contract_type,
			contract_periods_json,
			contract_conversions_count,
			extracted_at_utc
		)
		SELECT
			extract_run_id,
			licensee_id,
			licensee_name,
			contract_id,
			aid,
			name,
			description,
			create_date,
			landing_page_url,
			seats_number,
			is_hard_seats_limit_type,
			rid,
			schedule_id,
			contract_is_active,
			contract_type,
			contract_periods_json,
			contract_conversions_count,
			extracted_at_utc
		FROM dbo.site_contracts;

		INSERT INTO dbo.previous_site_contract_users (
			extract_run_id,
			licensee_id,
			licensee_name,
			contract_id,
			contract_name,
			contract_type,
			contract_user_id,
			status,
			email,
			first_name,
			last_name,
			extracted_at_utc
		)
		SELECT
			extract_run_id,
			licensee_id,
			licensee_name,
			contract_id,
			contract_name,
			contract_type,
			contract_user_id,
			status,
			email,
			first_name,
			last_name,
			extracted_at_utc
		FROM dbo.site_contract_users;

		INSERT INTO dbo.previous_site_contract_domains (
			extract_run_id,
			licensee_id,
			licensee_name,
			contract_id,
			contract_name,
			contract_type,
			contract_domain_id,
			status,
			contract_domain_value,
			contract_users_count,
			active_contract_users_count,
			extracted_at_utc
		)
		SELECT
			extract_run_id,
			licensee_id,
			licensee_name,
			contract_id,
			contract_name,
			contract_type,
			contract_domain_id,
			status,
			contract_domain_value,
			contract_users_count,
			active_contract_users_count,
			extracted_at_utc
		FROM dbo.site_contract_domains;

		INSERT INTO dbo.previous_site_contract_domain_users (
			extract_run_id,
			licensee_id,
			licensee_name,
			contract_id,
			contract_name,
			contract_type,
			contract_domain_id,
			contract_domain_value,
			domain_json,
			contract_user_id,
			status,
			email,
			first_name,
			last_name,
			extracted_at_utc
		)
		SELECT
			extract_run_id,
			licensee_id,
			licensee_name,
			contract_id,
			contract_name,
			contract_type,
			contract_domain_id,
			contract_domain_value,
			domain_json,
			contract_user_id,
			status,
			email,
			first_name,
			last_name,
			extracted_at_utc
		FROM dbo.site_contract_domain_users;
	`);
}

async function truncateCurrentTables(transaction) {
	await transaction.request().batch(`
		TRUNCATE TABLE dbo.site_contract_domain_users;
		TRUNCATE TABLE dbo.site_contract_domains;
		TRUNCATE TABLE dbo.site_contract_users;
		TRUNCATE TABLE dbo.site_contracts;
		TRUNCATE TABLE dbo.site_licensees;
	`);
}

const SQL_TABLE_SPECS = {
	site_licensees: {
		columns: {
			aid: sql.VarChar(64),
			licensee_id: sql.VarChar(64),
			name: sql.NVarChar(500),
			description: sql.NVarChar(sql.MAX),
			logo_url: sql.NVarChar(2000),
			representatives_json: sql.NVarChar(sql.MAX),
			managers_json: sql.NVarChar(sql.MAX),
		},
	},

	site_contracts: {
		columns: {
			licensee_id: sql.VarChar(64),
			licensee_name: sql.NVarChar(500),
			contract_id: sql.VarChar(64),
			aid: sql.VarChar(64),
			name: sql.NVarChar(500),
			description: sql.NVarChar(sql.MAX),
			create_date: sql.BigInt,
			landing_page_url: sql.NVarChar(2000),
			seats_number: sql.Int,
			is_hard_seats_limit_type: sql.Bit,
			rid: sql.VarChar(64),
			schedule_id: sql.VarChar(64),
			contract_is_active: sql.Bit,
			contract_type: sql.VarChar(100),
			contract_periods_json: sql.NVarChar(sql.MAX),
			contract_conversions_count: sql.Int,
		},
	},

	site_contract_users: {
		columns: {
			licensee_id: sql.VarChar(64),
			licensee_name: sql.NVarChar(500),
			contract_id: sql.VarChar(64),
			contract_name: sql.NVarChar(500),
			contract_type: sql.VarChar(100),
			contract_user_id: sql.VarChar(64),
			status: sql.VarChar(50),
			email: sql.NVarChar(320),
			first_name: sql.NVarChar(255),
			last_name: sql.NVarChar(255),
		},
	},

	site_contract_domains: {
		columns: {
			licensee_id: sql.VarChar(64),
			licensee_name: sql.NVarChar(500),
			contract_id: sql.VarChar(64),
			contract_name: sql.NVarChar(500),
			contract_type: sql.VarChar(100),
			contract_domain_id: sql.VarChar(64),
			status: sql.VarChar(50),
			contract_domain_value: sql.NVarChar(500),
			contract_users_count: sql.Int,
			active_contract_users_count: sql.Int,
		},
	},

	site_contract_domain_users: {
		columns: {
			licensee_id: sql.VarChar(64),
			licensee_name: sql.NVarChar(500),
			contract_id: sql.VarChar(64),
			contract_name: sql.NVarChar(500),
			contract_type: sql.VarChar(100),
			contract_domain_id: sql.VarChar(64),
			contract_domain_value: sql.NVarChar(500),
			domain_json: sql.NVarChar(sql.MAX),
			contract_user_id: sql.VarChar(64),
			status: sql.VarChar(50),
			email: sql.NVarChar(320),
			first_name: sql.NVarChar(255),
			last_name: sql.NVarChar(255),
		},
	},
};

async function bulkInsertRows(transaction, extractRunId, tableName, rows) {
	if (rows.length === 0) {
		return;
	}

	const spec = SQL_TABLE_SPECS[tableName];

	if (!spec) {
		throw new Error(`No SQL table specification for ${tableName}`);
	}

	const dataColumns = Object.keys(spec.columns);

	/*
	 * Use node-mssql's TDS bulk-load path rather than issuing one
	 * INSERT request per row. row_id and extracted_at_utc are
	 * intentionally omitted so SQL Server continues to generate
	 * the IDENTITY value and apply the extracted_at_utc default.
	 */
	const table = new sql.Table(`dbo.${tableName}`);

	table.create = false;

	table.columns.add('extract_run_id', sql.BigInt, {
		nullable: true,
	});

	for (const column of dataColumns) {
		table.columns.add(column, spec.columns[column], {
			nullable: true,
		});
	}

	for (const row of rows) {
		table.rows.add(
			extractRunId,
			...dataColumns.map((column) => valueOrNull(row[column])),
		);
	}

	const request = new sql.Request(transaction);

	await request.bulk(table, {
		checkConstraints: true,
		keepNulls: true,
	});
}

async function bulkInsertBatches(transaction, extractRunId, tableName, rows) {
	if (rows.length === 0) {
		console.log(`SQL bulk load ${tableName}: 0 row(s).`);
		return;
	}

	console.log(
		`SQL bulk load ${tableName}: ${rows.length} row(s), ` +
			`batch size ${SQL_BULK_BATCH_SIZE}.`,
	);

	let loaded = 0;

	while (loaded < rows.length) {
		const batch = rows.slice(loaded, loaded + SQL_BULK_BATCH_SIZE);

		await bulkInsertRows(transaction, extractRunId, tableName, batch);

		loaded += batch.length;
	}
}

async function insertLicensees(transaction, extractRunId, licensees) {
	const rows = licensees.map((licensee) => ({
		aid: valueOrNull(licensee.aid),
		licensee_id: valueOrNull(licensee.licensee_id),
		name: valueOrNull(licensee.name),
		description: valueOrNull(licensee.description),
		logo_url: valueOrNull(licensee.logo_url),
		representatives_json: jsonOrNull(licensee.representatives),
		managers_json: jsonOrNull(licensee.managers),
	}));

	await bulkInsertBatches(transaction, extractRunId, 'site_licensees', rows);
}

async function insertContracts(transaction, extractRunId, contractGroups) {
	const rows = [];

	for (const group of contractGroups) {
		for (const contract of group.contracts) {
			rows.push({
				licensee_id: valueOrNull(group.licensee_id),
				licensee_name: valueOrNull(group.licensee_name),
				contract_id: valueOrNull(contract.contract_id),
				aid: valueOrNull(contract.aid),
				name: valueOrNull(contract.name),
				description: valueOrNull(contract.description),
				create_date: valueOrNull(contract.create_date),
				landing_page_url: valueOrNull(contract.landing_page_url),
				seats_number: valueOrNull(contract.seats_number),
				is_hard_seats_limit_type: valueOrNull(
					contract.is_hard_seats_limit_type,
				),
				rid: valueOrNull(contract.rid),
				schedule_id: valueOrNull(contract.schedule_id),
				contract_is_active: valueOrNull(contract.contract_is_active),
				contract_type: valueOrNull(contract.contract_type),
				contract_periods_json: jsonOrNull(contract.contract_periods),
				contract_conversions_count: valueOrNull(
					contract.contract_conversions_count,
				),
			});
		}
	}

	await bulkInsertBatches(transaction, extractRunId, 'site_contracts', rows);
}

async function insertContractUsers(transaction, extractRunId, groups) {
	const rows = [];

	for (const group of groups) {
		for (const user of group.users) {
			rows.push({
				licensee_id: valueOrNull(group.licensee_id),
				licensee_name: valueOrNull(group.licensee_name),
				contract_id: valueOrNull(group.contract_id),
				contract_name: valueOrNull(group.contract_name),
				contract_type: valueOrNull(group.contract_type),
				contract_user_id: valueOrNull(user.contract_user_id),
				status: valueOrNull(user.status),
				email: valueOrNull(user.email),
				first_name: valueOrNull(user.first_name),
				last_name: valueOrNull(user.last_name),
			});
		}
	}

	await bulkInsertBatches(
		transaction,
		extractRunId,
		'site_contract_users',
		rows,
	);
}

async function insertContractDomains(transaction, extractRunId, groups) {
	const rows = [];

	for (const group of groups) {
		for (const domain of group.domains) {
			rows.push({
				licensee_id: valueOrNull(group.licensee_id),
				licensee_name: valueOrNull(group.licensee_name),
				contract_id: valueOrNull(group.contract_id),
				contract_name: valueOrNull(group.contract_name),
				contract_type: valueOrNull(group.contract_type),
				contract_domain_id: valueOrNull(domain.contract_domain_id),
				status: valueOrNull(domain.status),
				contract_domain_value: valueOrNull(domain.contract_domain_value),
				contract_users_count: valueOrNull(domain.contract_users_count),
				active_contract_users_count: valueOrNull(
					domain.active_contract_users_count,
				),
			});
		}
	}

	await bulkInsertBatches(
		transaction,
		extractRunId,
		'site_contract_domains',
		rows,
	);
}

async function insertContractDomainUsers(transaction, extractRunId, groups) {
	const rows = [];

	for (const group of groups) {
		for (const user of group.users) {
			rows.push({
				licensee_id: valueOrNull(group.licensee_id),
				licensee_name: valueOrNull(group.licensee_name),
				contract_id: valueOrNull(group.contract_id),
				contract_name: valueOrNull(group.contract_name),
				contract_type: valueOrNull(group.contract_type),
				contract_domain_id: valueOrNull(group.contract_domain_id),
				contract_domain_value: valueOrNull(group.contract_domain_value),
				domain_json: jsonOrNull(group.domain),
				contract_user_id: valueOrNull(user.contract_user_id),
				status: valueOrNull(user.status),
				email: valueOrNull(user.email),
				first_name: valueOrNull(user.first_name),
				last_name: valueOrNull(user.last_name),
			});
		}
	}

	await bulkInsertBatches(
		transaction,
		extractRunId,
		'site_contract_domain_users',
		rows,
	);
}

async function getSqlCounts(transaction) {
	const result = await transaction.request().query(`
			SELECT 'licensees' AS table_name, COUNT(*) AS row_count
			FROM dbo.site_licensees

			UNION ALL

			SELECT 'contracts', COUNT(*)
			FROM dbo.site_contracts

			UNION ALL

			SELECT 'contract_users', COUNT(*)
			FROM dbo.site_contract_users

			UNION ALL

			SELECT 'contract_domains', COUNT(*)
			FROM dbo.site_contract_domains

			UNION ALL

			SELECT 'contract_domain_users', COUNT(*)
			FROM dbo.site_contract_domain_users;
		`);

	return Object.fromEntries(
		result.recordset.map((row) => [row.table_name, Number(row.row_count)]),
	);
}

function assertCountsMatch(expected, actual) {
	for (const [name, expectedCount] of Object.entries(expected)) {
		const actualCount = actual[name];

		if (actualCount !== expectedCount) {
			throw new Error(
				`SQL row count mismatch for ${name}: ` +
					`expected ${expectedCount}, got ${actualCount}`,
			);
		}
	}
}

async function main() {
	const startedAt = new Date();

	const runName = `run-site-licenses-${startedAt.toISOString().replace(/[:.]/g, '-')}`;

	const runDir = path.join(EXTRACT_ROOT, runName);

	await fs.mkdir(runDir, { recursive: false });

	console.log(`Run directory: ${runDir}`);
	console.log('');

	let pool;
	let extractRunId = null;
	let transaction = null;
	let transactionCommitted = false;

	const counts = {
		licensees: 0,
		contracts: 0,
		contract_users: 0,
		contract_domains: 0,
		contract_domain_users: 0,
	};

	try {
		pool = await sql.connect(sqlConfig);

		extractRunId = await createRunRow(pool, runName);

		console.log(`extract_run_id: ${extractRunId}`);
		console.log('');

		/*
		 * ------------------------------------------------
		 * Retrieve licensees
		 * ------------------------------------------------
		 */
		const licensees = await listAll({
			endpoint: ENDPOINTS.licensees,

			preferredKeys: ['LicenseeList', 'licensees', 'items', 'results'],

			label: 'licensees',
		});

		counts.licensees = licensees.length;

		const contractGroups = [];
		const contractUserGroups = [];
		const contractDomainGroups = [];
		const contractDomainUserGroups = [];

		/*
		 * ------------------------------------------------
		 * Retrieve contracts for each licensee
		 * ------------------------------------------------
		 */
		for (let index = 0; index < licensees.length; index += 1) {
			const licensee = licensees[index];

			const licenseeId = licensee.licensee_id;

			if (!licenseeId) {
				throw new Error(`Licensee at index ${index} has no licensee_id.`);
			}

			console.log(
				`[Licensee ${index + 1}/${licensees.length}] ` + `${licenseeId}`,
			);

			const contracts = await listAll({
				endpoint: ENDPOINTS.contracts,

				params: {
					licensee_id: licenseeId,
				},

				preferredKeys: ['ContractList', 'contracts', 'items', 'results'],

				label: `contracts for licensee ${licenseeId}`,
			});

			contractGroups.push({
				licensee_id: licenseeId,

				licensee_name: valueOrNull(licensee.name),

				contracts,
			});

			counts.contracts += contracts.length;

			/*
			 * --------------------------------------------
			 * Retrieve child structures by contract type
			 * --------------------------------------------
			 */
			for (const contract of contracts) {
				const contractId = contract.contract_id;

				if (!contractId) {
					throw new Error(
						`Contract under licensee ${licenseeId} ` + `has no contract_id.`,
					);
				}

				if (contract.contract_type === 'SPECIFIC_EMAIL_ADDRESSES_CONTRACT') {
					const users = await listAll({
						endpoint: ENDPOINTS.contractUsers,

						params: {
							contract_id: contractId,
						},

						preferredKeys: [
							'ContractUserList',
							'contract_users',
							'users',
							'items',
							'results',
						],

						label: `users for contract ${contractId}`,
					});

					contractUserGroups.push({
						licensee_id: licenseeId,

						licensee_name: valueOrNull(licensee.name),

						contract_id: contractId,

						contract_name: valueOrNull(contract.name),

						contract_type: valueOrNull(contract.contract_type),

						users,
					});

					counts.contract_users += users.length;
				}

				if (contract.contract_type === 'EMAIL_DOMAIN_CONTRACT') {
					const domains = await listAll({
						endpoint: ENDPOINTS.contractDomains,

						params: {
							contract_id: contractId,
						},

						preferredKeys: [
							'ContractDomainList',
							'contract_domains',
							'domains',
							'items',
							'results',
						],

						label: `domains for contract ${contractId}`,
					});

					contractDomainGroups.push({
						licensee_id: licenseeId,

						licensee_name: valueOrNull(licensee.name),

						contract_id: contractId,

						contract_name: valueOrNull(contract.name),

						contract_type: valueOrNull(contract.contract_type),

						domains,
					});

					counts.contract_domains += domains.length;

					for (const domain of domains) {
						const contractDomainId = domain.contract_domain_id;

						if (!contractDomainId) {
							throw new Error(
								`Domain under contract ${contractId} ` +
									`has no contract_domain_id.`,
							);
						}

						const users = await listAll({
							endpoint: ENDPOINTS.contractDomainUsers,

							params: {
								contract_id: contractId,

								contract_domain_id: contractDomainId,
							},

							preferredKeys: [
								'ContractUserList',
								'contract_users',
								'users',
								'items',
								'results',
							],

							label: `users for domain ${contractDomainId}`,
						});

						contractDomainUserGroups.push({
							licensee_id: licenseeId,

							licensee_name: valueOrNull(licensee.name),

							contract_id: contractId,

							contract_name: valueOrNull(contract.name),

							contract_type: valueOrNull(contract.contract_type),

							contract_domain_id: contractDomainId,

							contract_domain_value: valueOrNull(domain.contract_domain_value),

							domain,

							users,
						});

						counts.contract_domain_users += users.length;
					}
				}
			}

			console.log('');
		}

		/*
		 * ------------------------------------------------
		 * Write extraction files before touching the
		 * current SQL snapshot.
		 * ------------------------------------------------
		 */
		await writeJson(path.join(runDir, 'licensees.json'), licensees);

		await writeJson(path.join(runDir, 'contracts.json'), contractGroups);

		await writeJson(
			path.join(runDir, 'contract-users.json'),
			contractUserGroups,
		);

		await writeJson(
			path.join(runDir, 'contract-domains.json'),
			contractDomainGroups,
		);

		await writeJson(
			path.join(runDir, 'contract-domain-users.json'),
			contractDomainUserGroups,
		);

		console.log('API extraction files written successfully.');
		console.log('');
		console.log(`SQL bulk batch size: ${SQL_BULK_BATCH_SIZE}`);
		console.log('');

		/*
		 * ------------------------------------------------
		 * Replace SQL snapshot in one transaction.
		 * ------------------------------------------------
		 */
		transaction = new sql.Transaction(pool);

		await transaction.begin();

		await backupCurrentTables(transaction);

		await truncateCurrentTables(transaction);

		await insertLicensees(transaction, extractRunId, licensees);

		await insertContracts(transaction, extractRunId, contractGroups);

		await insertContractUsers(transaction, extractRunId, contractUserGroups);

		await insertContractDomains(
			transaction,
			extractRunId,
			contractDomainGroups,
		);

		await insertContractDomainUsers(
			transaction,
			extractRunId,
			contractDomainUserGroups,
		);

		const sqlCounts = await getSqlCounts(transaction);

		assertCountsMatch(counts, sqlCounts);

		await transaction.commit();
		transactionCommitted = true;

		await markRunComplete(pool, extractRunId);

		const manifest = {
			extract_run_id: extractRunId,

			run_name: runName,

			started_at_utc: startedAt.toISOString(),

			completed_at_utc: new Date().toISOString(),

			status: 'COMPLETE',

			counts,
		};

		await writeJson(path.join(runDir, 'manifest.json'), manifest);

		console.log('Extraction complete.');
		console.log('');

		console.log(`Licensees: ${counts.licensees}`);
		console.log(`Contracts: ${counts.contracts}`);
		console.log(`Contract users: ${counts.contract_users}`);
		console.log(`Contract domains: ${counts.contract_domains}`);
		console.log(`Contract domain users: ${counts.contract_domain_users}`);

		console.log('');
		console.log(`Saved: ${runDir}`);
	} catch (error) {
		if (transaction && !transactionCommitted) {
			try {
				await transaction.rollback();
			} catch {
				/*
				 * Preserve the original failure below.
				 */
			}
		}

		if (pool && extractRunId) {
			try {
				await markRunFailed(pool, extractRunId, error);
			} catch {
				/*
				 * Preserve the original failure below.
				 */
			}
		}

		try {
			await writeJson(path.join(runDir, 'manifest.json'), {
				extract_run_id: extractRunId,

				run_name: runName,

				started_at_utc: startedAt.toISOString(),

				completed_at_utc: new Date().toISOString(),

				status: 'FAILED',

				counts,

				error: String(error?.stack || error?.message || error),
			});
		} catch {
			/*
			 * Do not replace the original error if the
			 * failure manifest cannot be written.
			 */
		}

		throw error;
	} finally {
		if (pool) {
			await pool.close();
		}
	}
}

main().catch((error) => {
	console.error('');
	console.error('Extraction failed:');
	console.error(error?.stack || error);
	process.exit(1);
});

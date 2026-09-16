import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sql from 'mssql';

/*
 * Piano active Access Granted extract
 *
 * Flow:
 *   1. Find candidate users with:
 *        converted_term_types=7
 *        has_access=true
 *   2. For each candidate UID, inspect /publisher/conversion/list.
 *   3. Keep only currently active grant_access conversions.
 *   4. Save the candidate-search pages and filtered active grants.
 *   5. Refresh dbo.access_granted in Azure SQL inside one transaction.
 *
 * A user may also have a paid subscription. Subscription presence is not
 * used to include or exclude an active Access Granted record.
 */

const API_BASE_URL = (
	process.env.PIANO_API_BASE_URL || 'https://api.piano.io/api/v3'
).replace(/\/$/, '');

const AID = process.env.PIANO_AID;
const API_TOKEN = process.env.PIANO_API_TOKEN;
const EXTRACT_ROOT = process.env.EXTRACT_ROOT || './extracts';

const USER_SEARCH_LIMIT = Number(
	process.env.ACCESS_GRANTED_USER_SEARCH_LIMIT || 1000,
);

const CONVERSION_LIMIT = Number(
	process.env.ACCESS_GRANTED_CONVERSION_LIMIT || 100,
);

const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60000);

const SQL_SERVER = process.env.SQL_SERVER;
const SQL_PORT = Number(process.env.SQL_PORT || 1433);
const SQL_USER = process.env.SQL_USER;
const SQL_PASSWORD = process.env.SQL_PASSWORD;
const SQL_DATABASE = process.env.SQL_DATABASE;

const SQL_ENCRYPT = parseBoolean(process.env.SQL_ENCRYPT, true);

const SQL_TRUST_SERVER_CERTIFICATE = parseBoolean(
	process.env.SQL_TRUST_SERVER_CERTIFICATE,
	false,
);

const TABLE_SCHEMA = 'dbo';
const TABLE_NAME = 'access_granted';

const FULL_TABLE_NAME = `[${TABLE_SCHEMA}].[${TABLE_NAME}]`;

const RUN_NAME = 'run-access-granted';

const EXPECTED_COLUMNS = [
	'access_id',
	'term_conversion_id',
	'user_uid',
	'user_email',
	'first_name',
	'last_name',
	'display_name',
	'term_id',
	'term_name',
	'term_type',
	'conversion_type',
	'resource_id',
	'resource_name',
	'granted',
	'revoked',
	'start_date',
	'expire_date',
	'conversion_create_date',
];

/* =========================================================
   Configuration
   ========================================================= */

function failConfiguration(message) {
	console.error(message);
	process.exit(1);
}

function parseBoolean(value, defaultValue) {
	if (value === undefined || value === '') {
		return defaultValue;
	}

	const normalized = String(value).trim().toLowerCase();

	if (normalized === 'true') {
		return true;
	}

	if (normalized === 'false') {
		return false;
	}

	throw new Error(`Expected boolean value true/false; received: ${value}`);
}

if (!AID) {
	failConfiguration('Missing required environment variable: PIANO_AID');
}

if (!API_TOKEN) {
	failConfiguration('Missing required environment variable: PIANO_API_TOKEN');
}

if (!SQL_SERVER) {
	failConfiguration('Missing required environment variable: SQL_SERVER');
}

if (!SQL_USER) {
	failConfiguration('Missing required environment variable: SQL_USER');
}

if (!SQL_PASSWORD) {
	failConfiguration('Missing required environment variable: SQL_PASSWORD');
}

if (!SQL_DATABASE) {
	failConfiguration('Missing required environment variable: SQL_DATABASE');
}

if (
	!Number.isInteger(USER_SEARCH_LIMIT) ||
	USER_SEARCH_LIMIT <= 0 ||
	USER_SEARCH_LIMIT > 1000
) {
	failConfiguration(
		'ACCESS_GRANTED_USER_SEARCH_LIMIT must be an integer from 1 to 1000',
	);
}

if (!Number.isInteger(CONVERSION_LIMIT) || CONVERSION_LIMIT <= 0) {
	failConfiguration(
		'ACCESS_GRANTED_CONVERSION_LIMIT must be a positive integer',
	);
}

if (!Number.isInteger(MAX_RETRIES) || MAX_RETRIES < 0) {
	failConfiguration('MAX_RETRIES must be a non-negative integer');
}

if (!Number.isFinite(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS <= 0) {
	failConfiguration('REQUEST_TIMEOUT_MS must be a positive number');
}

if (!Number.isInteger(SQL_PORT) || SQL_PORT <= 0 || SQL_PORT > 65535) {
	failConfiguration('SQL_PORT must be an integer between 1 and 65535');
}

/* =========================================================
   General helpers
   ========================================================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timestampForPath(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, '-');
}

function paddedOffset(offset) {
	return String(offset).padStart(6, '0');
}

function makeError(message, { status = null, body = null } = {}) {
	const error = new Error(message);

	error.status = status;
	error.body = body;

	return error;
}

function isRetryable(error) {
	return (
		error?.name === 'TimeoutError' ||
		error?.name === 'AbortError' ||
		error?.status === 408 ||
		error?.status === 429 ||
		(typeof error?.status === 'number' && error.status >= 500)
	);
}

function safeError(error) {
	return {
		message: error?.message || String(error),

		name: error?.name || null,

		status: error?.status ?? null,

		body: error?.body ?? null,

		stack: error?.stack || null,
	};
}

/* =========================================================
   Piano API
   ========================================================= */

async function fetchWithRetry(url, options = {}) {
	let lastError;

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
		try {
			const response = await fetch(url, {
				...options,

				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});

			if (!response.ok) {
				const text = await response.text();

				let body = text;

				try {
					body = text ? JSON.parse(text) : null;
				} catch {
					/*
					 * Keep text response.
					 */
				}

				throw makeError(`HTTP ${response.status} from Piano API`, {
					status: response.status,

					body,
				});
			}

			return response;
		} catch (error) {
			lastError = error;

			if (!isRetryable(error) || attempt === MAX_RETRIES) {
				throw error;
			}

			const delayMs = Math.min(1000 * 2 ** attempt, 30000);

			console.warn(
				`Transient Piano request failure. ` +
					`Retrying in ${delayMs} ms ` +
					`(${attempt + 1}/${MAX_RETRIES})...`,
			);

			await sleep(delayMs);
		}
	}

	throw lastError;
}

async function parsePianoJson(response, endpoint) {
	const text = await response.text();

	let body;

	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		throw makeError(`Non-JSON response from ${endpoint}`, {
			status: response.status,

			body: text.slice(0, 1000),
		});
	}

	if (
		body &&
		typeof body === 'object' &&
		body.code !== undefined &&
		Number(body.code) !== 0
	) {
		throw makeError(
			`Piano API error from ${endpoint}: ` + `code ${body.code}`,
			{
				status: response.status,

				body,
			},
		);
	}

	return body;
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

	const response = await fetchWithRetry(url, {
		method: 'GET',

		headers: {
			Accept: 'application/json',
		},
	});

	return parsePianoJson(response, endpoint);
}

async function pianoPost(endpoint, params = {}) {
	const url = new URL(`${API_BASE_URL}${endpoint}`);

	const form = new URLSearchParams();

	form.set('aid', AID);

	form.set('api_token', API_TOKEN);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null) {
			form.set(key, String(value));
		}
	}

	const response = await fetchWithRetry(url, {
		method: 'POST',

		headers: {
			Accept: 'application/json',

			'Content-Type': 'application/x-www-form-urlencoded',
		},

		body: form,
	});

	return parsePianoJson(response, endpoint);
}

/* =========================================================
   Response validation
   ========================================================= */

function validateUserSearchPage(body, expectedOffset) {
	if (!body || typeof body !== 'object' || !Array.isArray(body.users)) {
		throw new Error(
			`Invalid user search response ` + `at offset ${expectedOffset}`,
		);
	}

	const total = Number(body.total);

	const count = Number(body.count);

	const offset = Number(body.offset);

	const limit = Number(body.limit);

	if (!Number.isInteger(total) || total < 0) {
		throw new Error(
			`Invalid user search total ` + `at offset ${expectedOffset}`,
		);
	}

	if (!Number.isInteger(count) || count < 0) {
		throw new Error(
			`Invalid user search count ` + `at offset ${expectedOffset}`,
		);
	}

	if (!Number.isInteger(offset) || offset !== expectedOffset) {
		throw new Error(
			`User search offset mismatch: ` +
				`requested ${expectedOffset}, ` +
				`received ${body.offset}`,
		);
	}

	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error(
			`Invalid user search limit ` + `at offset ${expectedOffset}`,
		);
	}

	if (count !== body.users.length) {
		throw new Error(
			`User search count mismatch ` +
				`at offset ${expectedOffset}: ` +
				`count=${count}, ` +
				`users.length=${body.users.length}`,
		);
	}

	return {
		total,
		count,
		offset,
		limit,
	};
}

function validateConversionPage(body, uid, expectedOffset) {
	if (!body || typeof body !== 'object' || !Array.isArray(body.conversions)) {
		throw new Error(
			`Invalid conversion response ` +
				`for UID ${uid} ` +
				`at offset ${expectedOffset}`,
		);
	}

	const total = Number(body.total);

	const count = Number(body.count);

	const offset = Number(body.offset);

	if (!Number.isInteger(total) || total < 0) {
		throw new Error(`Invalid conversion total ` + `for UID ${uid}`);
	}

	if (!Number.isInteger(count) || count < 0) {
		throw new Error(`Invalid conversion count ` + `for UID ${uid}`);
	}

	if (!Number.isInteger(offset) || offset !== expectedOffset) {
		throw new Error(
			`Conversion offset mismatch ` +
				`for UID ${uid}: ` +
				`requested ${expectedOffset}, ` +
				`received ${body.offset}`,
		);
	}

	if (count !== body.conversions.length) {
		throw new Error(
			`Conversion count mismatch ` +
				`for UID ${uid} ` +
				`at offset ${expectedOffset}`,
		);
	}

	return {
		total,
		count,
		offset,
	};
}

/* =========================================================
   Candidate users
   ========================================================= */

async function fetchCandidateUsers(runDir) {
	const endpoint = '/publisher/user/search';

	const users = [];

	let offset = 0;
	let expectedTotal = null;

	while (true) {
		console.log(
			`Retrieving Access Granted candidates ` + `at offset ${offset}...`,
		);

		const body = await pianoPost(endpoint, {
			converted_term_types: 7,

			has_access: true,

			limit: USER_SEARCH_LIMIT,

			offset,
		});

		const info = validateUserSearchPage(body, offset);

		if (expectedTotal === null) {
			expectedTotal = info.total;

			console.log(`Candidate users reported by Piano: ` + `${expectedTotal}`);
		} else if (info.total !== expectedTotal) {
			throw new Error(
				`User search total changed ` +
					`during extraction: ` +
					`${expectedTotal} -> ` +
					`${info.total}`,
			);
		}

		const outputPath = path.join(
			runDir,

			`candidate-users-offset-` + `${paddedOffset(offset)}.json`,
		);

		await fs.writeFile(outputPath, JSON.stringify(body, null, 2), 'utf8');

		users.push(...body.users);

		if (users.length >= expectedTotal || info.count === 0) {
			break;
		}

		offset += info.count;
	}

	if (users.length !== expectedTotal) {
		throw new Error(
			`Candidate user count mismatch: ` +
				`expected ${expectedTotal}, ` +
				`retrieved ${users.length}`,
		);
	}

	return users;
}

/* =========================================================
   Conversion lookup
   ========================================================= */

async function fetchConversionsForUser(uid) {
	const endpoint = '/publisher/conversion/list';

	const conversions = [];

	let offset = 0;
	let expectedTotal = null;

	while (true) {
		const body = await pianoGet(endpoint, {
			uid,

			limit: CONVERSION_LIMIT,

			offset,
		});

		const info = validateConversionPage(body, uid, offset);

		if (expectedTotal === null) {
			expectedTotal = info.total;
		} else if (info.total !== expectedTotal) {
			throw new Error(
				`Conversion total changed ` +
					`for UID ${uid}: ` +
					`${expectedTotal} -> ` +
					`${info.total}`,
			);
		}

		conversions.push(...body.conversions);

		if (conversions.length >= expectedTotal || info.count === 0) {
			break;
		}

		offset += info.count;
	}

	return conversions;
}

/* =========================================================
   Active Access Granted filtering
   ========================================================= */

function isActiveGrantAccessConversion(conversion, nowUnixSeconds) {
	if (conversion?.term?.type !== 'grant_access') {
		return false;
	}

	const access = conversion?.user_access;

	if (!access || access.granted !== true) {
		return false;
	}

	if (access.revoked === true) {
		return false;
	}

	if (access.expire_date === null || access.expire_date === undefined) {
		return true;
	}

	const expireDate = Number(access.expire_date);

	return Number.isFinite(expireDate) && expireDate > nowUnixSeconds;
}

function unixSecondsToDate(value, fieldName) {
	if (value === null || value === undefined || value === '') {
		return null;
	}

	const seconds = Number(value);

	if (!Number.isFinite(seconds)) {
		throw new Error(`Invalid Unix timestamp ` + `for ${fieldName}: ${value}`);
	}

	return new Date(seconds * 1000);
}

function activeGrantRow(candidateUser, conversion) {
	const access = conversion.user_access;

	const term = conversion.term;

	const resource = access?.resource ?? term?.resource ?? null;

	return {
		access_id: access?.access_id ?? null,

		term_conversion_id: conversion?.term_conversion_id ?? null,

		user_uid: candidateUser?.uid ?? access?.user?.uid ?? null,

		user_email: candidateUser?.email ?? access?.user?.email ?? null,

		first_name: candidateUser?.first_name ?? access?.user?.first_name ?? null,

		last_name: candidateUser?.last_name ?? access?.user?.last_name ?? null,

		display_name:
			candidateUser?.display_name ?? access?.user?.display_name ?? null,

		term_id: term?.term_id ?? null,

		term_name: term?.name ?? null,

		term_type: term?.type ?? null,

		conversion_type: conversion?.type ?? null,

		resource_id: resource?.rid ?? null,

		resource_name: resource?.name ?? null,

		granted: access?.granted ?? null,

		revoked: access?.revoked ?? null,

		start_date: unixSecondsToDate(access?.start_date, 'start_date'),

		expire_date: unixSecondsToDate(access?.expire_date, 'expire_date'),

		conversion_create_date: unixSecondsToDate(
			conversion?.create_date,
			'conversion_create_date',
		),
	};
}

async function extractActiveGrants(candidateUsers) {
	const nowUnixSeconds = Math.floor(Date.now() / 1000);

	const rowsByAccessId = new Map();

	const usersWithActiveGrant = new Set();

	for (let index = 0; index < candidateUsers.length; index += 1) {
		const user = candidateUsers[index];

		const uid = user?.uid;

		if (typeof uid !== 'string' || uid.length === 0) {
			throw new Error(`Candidate user at index ${index} ` + `is missing uid`);
		}

		const conversions = await fetchConversionsForUser(uid);

		for (const conversion of conversions) {
			if (!isActiveGrantAccessConversion(conversion, nowUnixSeconds)) {
				continue;
			}

			const row = activeGrantRow(user, conversion);

			if (!row.access_id) {
				throw new Error(
					`Active grant_access conversion ` +
						`for UID ${uid} ` +
						`has no access_id`,
				);
			}

			rowsByAccessId.set(row.access_id, row);

			usersWithActiveGrant.add(uid);
		}

		if ((index + 1) % 25 === 0 || index + 1 === candidateUsers.length) {
			console.log(
				`Checked ${index + 1} / ` +
					`${candidateUsers.length} ` +
					`candidate users; ` +
					`${rowsByAccessId.size} ` +
					`active Access Granted row(s) found...`,
			);
		}
	}

	return {
		rows: [...rowsByAccessId.values()],

		usersWithActiveGrant: usersWithActiveGrant.size,
	};
}

/* =========================================================
   Azure SQL
   ========================================================= */

function sqlConfig() {
	return {
		server: SQL_SERVER,

		port: SQL_PORT,

		user: SQL_USER,

		password: SQL_PASSWORD,

		database: SQL_DATABASE,

		options: {
			encrypt: SQL_ENCRYPT,

			trustServerCertificate: SQL_TRUST_SERVER_CERTIFICATE,
		},

		pool: {
			max: 5,
			min: 0,
			idleTimeoutMillis: 30000,
		},

		connectionTimeout: 30000,
		requestTimeout: 300000,
	};
}

async function getTableColumns(pool) {
	const result = await pool
		.request()

		.input('table_schema', sql.NVarChar(128), TABLE_SCHEMA)

		.input('table_name', sql.NVarChar(128), TABLE_NAME).query(`
				SELECT
					ORDINAL_POSITION
						AS ordinal_position,

					COLUMN_NAME
						AS column_name

				FROM
					INFORMATION_SCHEMA.COLUMNS

				WHERE
					TABLE_SCHEMA = @table_schema
					AND TABLE_NAME = @table_name

				ORDER BY
					ORDINAL_POSITION;
			`);

	return result.recordset;
}

function validateDestinationColumns(columns) {
	if (columns.length === 0) {
		throw new Error(`Destination table ` + `${FULL_TABLE_NAME} does not exist`);
	}

	const actual = columns.map((column) => column.column_name);

	if (
		actual.length !== EXPECTED_COLUMNS.length ||
		actual.some((column, index) => column !== EXPECTED_COLUMNS[index])
	) {
		throw new Error(
			`Destination table schema does not ` +
				`match expected columns.\n` +
				`Expected: ` +
				`${EXPECTED_COLUMNS.join(', ')}\n` +
				`Actual:   ` +
				`${actual.join(', ')}`,
		);
	}
}

function buildBulkTable(rows) {
	const table = new sql.Table(`${TABLE_SCHEMA}.${TABLE_NAME}`);

	table.create = false;

	table.columns.add('access_id', sql.NVarChar(50), {
		nullable: true,
	});

	table.columns.add('term_conversion_id', sql.NVarChar(50), {
		nullable: true,
	});

	table.columns.add('user_uid', sql.NVarChar(50), {
		nullable: true,
	});

	table.columns.add('user_email', sql.NVarChar(sql.MAX), {
		nullable: true,
	});

	table.columns.add('first_name', sql.NVarChar(sql.MAX), {
		nullable: true,
	});

	table.columns.add('last_name', sql.NVarChar(sql.MAX), {
		nullable: true,
	});

	table.columns.add('display_name', sql.NVarChar(sql.MAX), {
		nullable: true,
	});

	table.columns.add('term_id', sql.NVarChar(50), {
		nullable: true,
	});

	table.columns.add('term_name', sql.NVarChar(sql.MAX), {
		nullable: true,
	});

	table.columns.add('term_type', sql.NVarChar(50), {
		nullable: true,
	});

	table.columns.add('conversion_type', sql.NVarChar(50), {
		nullable: true,
	});

	table.columns.add('resource_id', sql.NVarChar(50), {
		nullable: true,
	});

	table.columns.add('resource_name', sql.NVarChar(sql.MAX), {
		nullable: true,
	});

	table.columns.add('granted', sql.Bit, {
		nullable: true,
	});

	table.columns.add('revoked', sql.Bit, {
		nullable: true,
	});

	table.columns.add('start_date', sql.DateTime, {
		nullable: true,
	});

	table.columns.add('expire_date', sql.DateTime, {
		nullable: true,
	});

	table.columns.add('conversion_create_date', sql.DateTime, {
		nullable: true,
	});

	for (const row of rows) {
		table.rows.add(
			row.access_id,
			row.term_conversion_id,
			row.user_uid,
			row.user_email,
			row.first_name,
			row.last_name,
			row.display_name,
			row.term_id,
			row.term_name,
			row.term_type,
			row.conversion_type,
			row.resource_id,
			row.resource_name,
			row.granted,
			row.revoked,
			row.start_date,
			row.expire_date,
			row.conversion_create_date,
		);
	}

	return table;
}

async function refreshAzure(rows) {
	const pool = new sql.ConnectionPool(sqlConfig());

	let transaction = null;

	try {
		console.log('\nConnecting to Azure SQL Database...');

		await pool.connect();

		const columns = await getTableColumns(pool);

		validateDestinationColumns(columns);

		const beforeResult = await pool.request().query(`
					SELECT
						COUNT_BIG(*) AS row_count

					FROM
						${FULL_TABLE_NAME};
				`);

		const rowsBefore = Number(beforeResult.recordset[0].row_count);

		console.log(`Azure table: ` + `${SQL_DATABASE}.` + `${FULL_TABLE_NAME}`);

		console.log(`Rows before refresh: ` + `${rowsBefore.toLocaleString()}`);

		console.log(`Rows to load: ` + `${rows.length.toLocaleString()}`);

		transaction = new sql.Transaction(pool);

		await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

		console.log(
			`Truncating ` + `${FULL_TABLE_NAME} ` + `inside transaction...`,
		);

		await new sql.Request(transaction).query(`
			TRUNCATE TABLE
				${FULL_TABLE_NAME};
		`);

		if (rows.length > 0) {
			const table = buildBulkTable(rows);

			await new sql.Request(transaction).bulk(table);
		}

		const verificationResult = await new sql.Request(transaction).query(`
				SELECT
					COUNT_BIG(*) AS row_count

				FROM
					${FULL_TABLE_NAME};
			`);

		const rowsBeforeCommit = Number(verificationResult.recordset[0].row_count);

		if (rowsBeforeCommit !== rows.length) {
			throw new Error(
				`Azure row-count verification ` +
					`failed before commit: ` +
					`expected ${rows.length}, ` +
					`found ${rowsBeforeCommit}`,
			);
		}

		await transaction.commit();

		transaction = null;

		const finalResult = await pool.request().query(`
					SELECT
						COUNT_BIG(*) AS row_count

					FROM
						${FULL_TABLE_NAME};
				`);

		const rowsAfter = Number(finalResult.recordset[0].row_count);

		if (rowsAfter !== rows.length) {
			throw new Error(
				`Azure row-count verification ` +
					`failed after commit: ` +
					`expected ${rows.length}, ` +
					`found ${rowsAfter}`,
			);
		}

		console.log(
			`Azure refresh complete: ` + `${rowsAfter.toLocaleString()} rows.`,
		);

		return {
			rows_before: rowsBefore,

			rows_after: rowsAfter,
		};
	} catch (error) {
		if (transaction) {
			try {
				await transaction.rollback();

				console.error('Azure transaction rolled back.');
			} catch (rollbackError) {
				console.error('Azure rollback also failed:', rollbackError);
			}
		}

		throw error;
	} finally {
		await pool.close();
	}
}

/* =========================================================
   Main
   ========================================================= */

async function main() {
	const startedAt = new Date();

	const runTimestamp = timestampForPath(startedAt);

	const runDir = path.resolve(
		EXTRACT_ROOT,

		`${RUN_NAME}-` + `${runTimestamp}`,
	);

	await fs.mkdir(runDir, {
		recursive: true,
	});

	try {
		console.log('\nPiano active Access Granted extract');

		console.log(`API: ${API_BASE_URL}`);

		console.log(
			'Candidate filter: ' + 'converted_term_types=7, ' + 'has_access=true',
		);

		console.log('Final filter: ' + 'active grant_access conversion');

		console.log('Subscription presence is not used as a filter.');

		console.log('');

		const candidateUsers = await fetchCandidateUsers(runDir);

		const activeGrantResult = await extractActiveGrants(candidateUsers);

		const activeRows = activeGrantResult.rows;

		await fs.writeFile(
			path.join(runDir, 'active-access-granted.json'),

			JSON.stringify(activeRows, null, 2),

			'utf8',
		);

		console.log('');

		console.log(`Candidate users checked: ` + `${candidateUsers.length}`);

		console.log(
			`Users with active Access Granted: ` +
				`${activeGrantResult.usersWithActiveGrant}`,
		);

		console.log(`Active Access Granted rows: ` + `${activeRows.length}`);

		const azure = await refreshAzure(activeRows);

		const completedAt = new Date();

		const summary = {
			extract_name: RUN_NAME,

			started_at_utc: startedAt.toISOString(),

			completed_at_utc: completedAt.toISOString(),

			api_base_url: API_BASE_URL,

			candidate_filter: {
				converted_term_types: 7,
				has_access: true,
			},

			active_grant_rule: {
				term_type: 'grant_access',

				granted: true,

				revoked: false,

				expire_date: 'null or future',
			},

			candidate_user_count: candidateUsers.length,

			users_with_active_grant: activeGrantResult.usersWithActiveGrant,

			active_access_granted_row_count: activeRows.length,

			azure_table: `${TABLE_SCHEMA}.${TABLE_NAME}`,

			azure_rows_before: azure.rows_before,

			azure_rows_after: azure.rows_after,

			complete: true,
		};

		await fs.writeFile(
			path.join(runDir, 'summary.json'),

			JSON.stringify(summary, null, 2),

			'utf8',
		);

		console.log('');

		console.log('Access Granted extract and Azure refresh complete.');

		console.log(`Output: ${runDir}`);
	} catch (error) {
		const failure = {
			extract_name: RUN_NAME,

			failed_at_utc: new Date().toISOString(),

			error: safeError(error),

			complete: false,
		};

		try {
			await fs.writeFile(
				path.join(runDir, 'errors.json'),

				JSON.stringify(failure, null, 2),

				'utf8',
			);
		} catch {
			/*
			 * Do not mask
			 * the original failure.
			 */
		}

		console.error('\nAccess Granted extract failed.');

		console.error(error);

		console.error(`Output: ${runDir}`);

		process.exitCode = 1;
	}
}

await main();

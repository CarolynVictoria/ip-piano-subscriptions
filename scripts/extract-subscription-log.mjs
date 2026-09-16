import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sql from 'mssql';

/*
 * Piano VX Subscription Log raw export
 *
 * Current Report Export API flow:
 *   POST /export/schedule/vx/subscriptionLog
 *   GET  /export/status
 *   GET  /export/download/url
 *   GET  <temporary download URL>
 *
 * This script:
 *   - requests the complete, unfiltered Subscription Log
 *   - requests every documented attribute group
 *   - saves the returned CSV unchanged
 *   - validates CSV structure and Subscription ID uniqueness
 *   - records headers/counts for comparison with the dashboard export
 *   - refreshes dbo.subscription_log_export in Azure SQL
 *   - truncates and bulk-loads inside one transaction
 *   - verifies the Azure row count before commit
 */

const REPORT_API_BASE_URL = (
	process.env.PIANO_REPORT_API_BASE_URL || 'https://reports-api.piano.io/rest'
).replace(/\/$/, '');

const AID = process.env.PIANO_AID;
const API_TOKEN = process.env.PIANO_API_TOKEN;
const EXTRACT_ROOT = process.env.EXTRACT_ROOT || './extracts';

const POLL_INTERVAL_MS = Number(
	process.env.PIANO_EXPORT_POLL_INTERVAL_MS || 10000,
);

const MAX_WAIT_MS = Number(process.env.PIANO_EXPORT_MAX_WAIT_MS || 7200000);

const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60000);

const SCHEDULE_ENDPOINT = '/export/schedule/vx/subscriptionLog';

const STATUS_ENDPOINT = '/export/status';

const DOWNLOAD_URL_ENDPOINT = '/export/download/url';

const RUN_NAME = 'run-subscription-log';

const ATTRIBUTE_GROUPS = [
	'DEFAULT',
	'RENEWABLE_GIFT',
	'USER',
	'PAYMENT',
	'UPGRADES',
	'AUTORENEW',
	'MODIFY_TIME',
];

const CONTROL_HEADERS = [
	'Subscription ID',
	'Term type',
	'Shared subscriptions',
	'Modify time',
];

const SQL_SERVER = process.env.SQL_SERVER;
const SQL_PORT = Number(process.env.SQL_PORT || 1433);
const SQL_USER = process.env.SQL_USER;
const SQL_PASSWORD = process.env.SQL_PASSWORD;
const SQL_DATABASE = process.env.SQL_DATABASE;

const SQL_ENCRYPT =
	String(process.env.SQL_ENCRYPT || 'true').toLowerCase() !== 'false';

const SQL_TRUST_SERVER_CERTIFICATE =
	String(process.env.SQL_TRUST_SERVER_CERTIFICATE || 'false').toLowerCase() ===
	'true';

const SQL_BULK_BATCH_SIZE = Number(process.env.SQL_BULK_BATCH_SIZE || 500);

const SQL_TABLE_SCHEMA = 'dbo';
const SQL_TABLE_NAME = 'subscription_log_export';
const SQL_FULL_TABLE_NAME = `[${SQL_TABLE_SCHEMA}].[${SQL_TABLE_NAME}]`;

/* =========================================================
   Configuration validation
   ========================================================= */

function failConfiguration(message) {
	console.error(message);
	process.exit(1);
}

if (!AID) {
	failConfiguration('Missing required environment variable: PIANO_AID');
}

if (!API_TOKEN) {
	failConfiguration('Missing required environment variable: PIANO_API_TOKEN');
}

if (!Number.isFinite(POLL_INTERVAL_MS) || POLL_INTERVAL_MS <= 0) {
	failConfiguration('PIANO_EXPORT_POLL_INTERVAL_MS must be a positive number');
}

if (!Number.isFinite(MAX_WAIT_MS) || MAX_WAIT_MS <= 0) {
	failConfiguration('PIANO_EXPORT_MAX_WAIT_MS must be a positive number');
}

if (!Number.isInteger(MAX_RETRIES) || MAX_RETRIES < 0) {
	failConfiguration('MAX_RETRIES must be a non-negative integer');
}

if (!Number.isFinite(REQUEST_TIMEOUT_MS) || REQUEST_TIMEOUT_MS <= 0) {
	failConfiguration('REQUEST_TIMEOUT_MS must be a positive number');
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

if (!Number.isInteger(SQL_PORT) || SQL_PORT <= 0 || SQL_PORT > 65535) {
	failConfiguration('SQL_PORT must be an integer between 1 and 65535');
}

if (!Number.isInteger(SQL_BULK_BATCH_SIZE) || SQL_BULK_BATCH_SIZE <= 0) {
	failConfiguration('SQL_BULK_BATCH_SIZE must be a positive integer');
}

/* =========================================================
   General helpers
   ========================================================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timestampForPath(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, '-');
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
   Piano Report Export API
   ========================================================= */

function buildApiUrl(endpoint, params = {}) {
	const url = new URL(`${REPORT_API_BASE_URL}${endpoint}`);

	url.searchParams.set('api_token', API_TOKEN);

	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) {
			continue;
		}

		if (Array.isArray(value)) {
			for (const item of value) {
				url.searchParams.append(key, String(item));
			}
		} else {
			url.searchParams.set(key, String(value));
		}
	}

	return url;
}

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
					 * Keep response
					 * body as text.
					 */
				}

				throw makeError(
					`HTTP ${response.status} from Piano Report Export API`,
					{
						status: response.status,

						body,
					},
				);
			}

			return response;
		} catch (error) {
			lastError = error;

			if (!isRetryable(error) || attempt === MAX_RETRIES) {
				throw error;
			}

			const delayMs = Math.min(1000 * 2 ** attempt, 30000);

			console.warn(
				`Transient request failure. Retrying in ${delayMs} ms ` +
					`(${attempt + 1}/${MAX_RETRIES})...`,
			);

			await sleep(delayMs);
		}
	}

	throw lastError;
}

async function parseJsonResponse(response, description) {
	const text = await response.text();

	let body;

	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		throw makeError(`${description} returned non-JSON content`, {
			status: response.status,

			body: text.slice(0, 1000),
		});
	}

	/*
	 * Some Piano endpoints may include
	 * a traditional Piano "code" field.
	 */
	if (
		body &&
		typeof body === 'object' &&
		Object.prototype.hasOwnProperty.call(body, 'code') &&
		Number.isFinite(Number(body.code)) &&
		Number(body.code) !== 0
	) {
		throw makeError(`${description} returned Piano API code ${body.code}`, {
			status: response.status,

			body,
		});
	}

	return body;
}

async function reportApiGet(endpoint, params = {}) {
	const url = buildApiUrl(endpoint, params);

	const response = await fetchWithRetry(url, {
		method: 'GET',

		headers: {
			Accept: 'application/json',
		},
	});

	return parseJsonResponse(response, endpoint);
}

async function reportApiPost(endpoint, params = {}) {
	const url = buildApiUrl(endpoint, params);

	const response = await fetchWithRetry(url, {
		method: 'POST',

		headers: {
			Accept: 'application/json',
		},
	});

	return parseJsonResponse(response, endpoint);
}

/* =========================================================
   Report-response helpers
   ========================================================= */

function unwrapObject(body) {
	if (!body || typeof body !== 'object') {
		return body;
	}

	if (body.data && typeof body.data === 'object') {
		return body.data;
	}

	if (body.export && typeof body.export === 'object') {
		return body.export;
	}

	return body;
}

function extractExportId(body) {
	const value = unwrapObject(body)?.export_id;

	return value === undefined || value === null || value === ''
		? null
		: String(value);
}

function extractJobStatus(body) {
	const value = unwrapObject(body)?.job_status;

	return value === undefined || value === null || value === ''
		? null
		: String(value).trim().toUpperCase();
}

function extractPercentComplete(body) {
	const value = unwrapObject(body)?.percent_complete;

	if (value === undefined || value === null || value === '') {
		return null;
	}

	const number = Number(value);

	return Number.isFinite(number) ? number : null;
}

function extractDownloadUrl(body) {
	if (typeof body === 'string') {
		return body;
	}

	const object = unwrapObject(body);

	const value = object?.url;

	if (typeof value === 'string' && value.startsWith('http')) {
		return value;
	}

	if (typeof body?.data === 'string' && body.data.startsWith('http')) {
		return body.data;
	}

	return null;
}

/* =========================================================
   Raw report download
   ========================================================= */

async function downloadRawFile(downloadUrl) {
	const response = await fetchWithRetry(new URL(downloadUrl), {
		method: 'GET',

		headers: {
			Accept: 'text/csv,application/octet-stream,*/*',
		},
	});

	const buffer = Buffer.from(await response.arrayBuffer());

	if (buffer.length === 0) {
		throw new Error('Downloaded Subscription Log is empty');
	}

	return {
		buffer,

		contentType: response.headers.get('content-type'),

		contentDisposition: response.headers.get('content-disposition'),
	};
}

/* =========================================================
   CSV inspection

   The source CSV is never rewritten.
   This parser reads it only for validation metadata.
   ========================================================= */

function inspectCsv(buffer) {
	const text = buffer.toString('utf8');

	let field = '';
	let row = [];
	let inQuotes = false;

	let headers = null;
	let subscriptionIdIndex = -1;

	let dataRowCount = 0;
	let mismatchedRowCount = 0;
	let missingSubscriptionIdCount = 0;
	let duplicateSubscriptionIdCount = 0;

	const subscriptionIds = new Set();
	const dataRows = [];

	const processRow = (completedRow) => {
		/*
		 * Ignore completely
		 * empty rows.
		 */
		if (completedRow.length === 1 && completedRow[0] === '') {
			return;
		}

		if (headers === null) {
			headers = [...completedRow];

			/*
			 * Remove a UTF-8 BOM
			 * from the first header.
			 */
			if (headers.length > 0) {
				headers[0] = headers[0].replace(/^\uFEFF/, '');
			}

			subscriptionIdIndex = headers.indexOf('Subscription ID');

			return;
		}

		dataRowCount += 1;
		dataRows.push([...completedRow]);

		if (completedRow.length !== headers.length) {
			mismatchedRowCount += 1;
		}

		if (subscriptionIdIndex >= 0) {
			const subscriptionId = completedRow[subscriptionIdIndex] ?? '';

			if (subscriptionId === '') {
				missingSubscriptionIdCount += 1;
			} else if (subscriptionIds.has(subscriptionId)) {
				duplicateSubscriptionIdCount += 1;
			} else {
				subscriptionIds.add(subscriptionId);
			}
		}
	};

	const finishField = () => {
		row.push(field);

		field = '';
	};

	const finishRow = () => {
		processRow(row);

		row = [];
	};

	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];

		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}

			continue;
		}

		if (char === '"') {
			inQuotes = true;
			continue;
		}

		if (char === ',') {
			finishField();
			continue;
		}

		if (char === '\r' || char === '\n') {
			finishField();
			finishRow();

			if (char === '\r' && text[i + 1] === '\n') {
				i += 1;
			}

			continue;
		}

		field += char;
	}

	if (inQuotes) {
		throw new Error('Downloaded CSV ended inside a quoted field');
	}

	if (field !== '' || row.length > 0) {
		finishField();
		finishRow();
	}

	if (headers === null) {
		throw new Error('Downloaded CSV contains no header row');
	}

	const controlHeaderPresence = Object.fromEntries(
		CONTROL_HEADERS.map((header) => [header, headers.includes(header)]),
	);

	return {
		inspection: {
			column_count: headers.length,

			headers,

			data_row_count: dataRowCount,

			subscription_id_column_present: subscriptionIdIndex >= 0,

			unique_subscription_id_count: subscriptionIds.size,

			missing_subscription_id_count: missingSubscriptionIdCount,

			duplicate_subscription_id_count: duplicateSubscriptionIdCount,

			rows_with_column_count_mismatch: mismatchedRowCount,

			control_header_presence: controlHeaderPresence,
		},

		dataRows,
	};
}

/* =========================================================
   Azure SQL refresh
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
			useUTC: true,
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

async function getSqlTableColumns(pool) {
	const result = await pool
		.request()
		.input('table_schema', sql.NVarChar(128), SQL_TABLE_SCHEMA)
		.input('table_name', sql.NVarChar(128), SQL_TABLE_NAME).query(`
			SELECT
				ORDINAL_POSITION AS ordinal_position,
				COLUMN_NAME AS column_name,
				DATA_TYPE AS data_type,
				CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
				IS_NULLABLE AS is_nullable
			FROM INFORMATION_SCHEMA.COLUMNS
			WHERE
				TABLE_SCHEMA = @table_schema
				AND TABLE_NAME = @table_name
			ORDER BY ORDINAL_POSITION;
		`);

	if (result.recordset.length === 0) {
		throw new Error(`Azure table ${SQL_FULL_TABLE_NAME} does not exist`);
	}

	return result.recordset;
}

async function getSqlRowCount(pool) {
	const result = await pool.request().query(`
		SELECT COUNT_BIG(*) AS row_count
		FROM ${SQL_FULL_TABLE_NAME};
	`);

	return Number(result.recordset[0].row_count);
}

function normalizedColumnKey(value) {
	return String(value ?? '')
		.replace(/^\uFEFF/, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
}

function buildColumnBindings(headers, columns) {
	const headerIndexes = new Map();

	for (let index = 0; index < headers.length; index += 1) {
		const header = headers[index];
		const key = normalizedColumnKey(header);

		if (!key) {
			throw new Error(`CSV header ${index + 1} is empty`);
		}

		if (headerIndexes.has(key)) {
			throw new Error(`CSV contains duplicate normalized header: ${header}`);
		}

		headerIndexes.set(key, {
			header,
			index,
		});
	}

	const usedHeaderIndexes = new Set();
	const bindings = [];

	for (const column of columns) {
		const key = normalizedColumnKey(column.column_name);
		const match = headerIndexes.get(key);

		if (!match) {
			throw new Error(
				`CSV header could not be matched to Azure column ` +
					`${column.column_name}`,
			);
		}

		usedHeaderIndexes.add(match.index);

		bindings.push({
			...column,
			csv_header: match.header,
			csv_index: match.index,
		});
	}

	const unmatchedHeaders = headers.filter(
		(_header, index) => !usedHeaderIndexes.has(index),
	);

	if (unmatchedHeaders.length > 0) {
		throw new Error(
			`CSV contains header(s) not present in ${SQL_FULL_TABLE_NAME}: ` +
				unmatchedHeaders.join(', '),
		);
	}

	if (headers.length !== columns.length) {
		throw new Error(
			`CSV has ${headers.length} columns but ${SQL_FULL_TABLE_NAME} ` +
				`has ${columns.length}`,
		);
	}

	return bindings;
}

function sqlTypeForColumn(column) {
	const type = String(column.data_type).toLowerCase();
	const length =
		column.character_maximum_length === null
			? null
			: Number(column.character_maximum_length);

	switch (type) {
		case 'nvarchar':
			return sql.NVarChar(length === -1 ? sql.MAX : length);

		case 'varchar':
			return sql.VarChar(length === -1 ? sql.MAX : length);

		case 'datetime':
			return sql.DateTime;

		case 'int':
			return sql.Int;

		case 'smallint':
			return sql.SmallInt;

		case 'tinyint':
			return sql.TinyInt;

		case 'bit':
			return sql.Bit;

		case 'money':
			return sql.Money;

		case 'float':
			return sql.Float;

		default:
			throw new Error(
				`Unsupported SQL type ${column.data_type} for column ` +
					`${column.column_name}`,
			);
	}
}

function makeUtcDate(
	year,
	month,
	day,
	hour = 0,
	minute = 0,
	second = 0,
	millisecond = 0,
) {
	const date = new Date(
		Date.UTC(year, month - 1, day, hour, minute, second, millisecond),
	);

	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hour ||
		date.getUTCMinutes() !== minute ||
		date.getUTCSeconds() !== second
	) {
		return null;
	}

	return date;
}

function parseDateTime(value) {
	const text = value.trim();

	let match = text.match(
		/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/,
	);

	if (match) {
		const milliseconds = Number(
			(match[7] || '').padEnd(3, '0').slice(0, 3) || 0,
		);

		return makeUtcDate(
			Number(match[1]),
			Number(match[2]),
			Number(match[3]),
			Number(match[4] || 0),
			Number(match[5] || 0),
			Number(match[6] || 0),
			milliseconds,
		);
	}

	match = text.match(
		/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i,
	);

	if (match) {
		let hour = Number(match[4] || 0);
		const ampm = match[7]?.toUpperCase();

		if (ampm === 'AM' && hour === 12) {
			hour = 0;
		} else if (ampm === 'PM' && hour < 12) {
			hour += 12;
		}

		return makeUtcDate(
			Number(match[3]),
			Number(match[1]),
			Number(match[2]),
			hour,
			Number(match[5] || 0),
			Number(match[6] || 0),
			0,
		);
	}

	const fallback = new Date(text);

	return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function parseNumber(value) {
	const normalized = value.trim().replace(/,/g, '').replace(/^\$/, '');
	const number = Number(normalized);

	return Number.isFinite(number) ? number : null;
}

function convertCsvValue(value, column, rowNumber) {
	if (value === undefined || value === null || value === '') {
		return null;
	}

	const type = String(column.data_type).toLowerCase();

	if (type === 'nvarchar' || type === 'varchar') {
		return value;
	}

	const trimmed = String(value).trim();

	if (trimmed === '') {
		return null;
	}

	if (type === 'datetime') {
		const date = parseDateTime(trimmed);

		if (!date) {
			throw new Error(
				`Invalid datetime in CSV row ${rowNumber}, column ` +
					`${column.csv_header}: ${trimmed}`,
			);
		}

		return date;
	}

	if (type === 'bit') {
		const normalized = trimmed.toLowerCase();

		if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
			return true;
		}

		if (normalized === '0' || normalized === 'false' || normalized === 'no') {
			return false;
		}

		throw new Error(
			`Invalid bit value in CSV row ${rowNumber}, column ` +
				`${column.csv_header}: ${trimmed}`,
		);
	}

	if (type === 'int' || type === 'smallint' || type === 'tinyint') {
		const number = parseNumber(trimmed);

		if (number === null || !Number.isInteger(number)) {
			throw new Error(
				`Invalid integer in CSV row ${rowNumber}, column ` +
					`${column.csv_header}: ${trimmed}`,
			);
		}

		return number;
	}

	if (type === 'money' || type === 'float') {
		const number = parseNumber(trimmed);

		if (number === null) {
			throw new Error(
				`Invalid number in CSV row ${rowNumber}, column ` +
					`${column.csv_header}: ${trimmed}`,
			);
		}

		return number;
	}

	throw new Error(
		`Unsupported SQL type ${column.data_type} for column ` +
			`${column.column_name}`,
	);
}

function buildBulkTable(bindings, rows, startingDataRowIndex) {
	const table = new sql.Table(`${SQL_TABLE_SCHEMA}.${SQL_TABLE_NAME}`);

	table.create = false;

	for (const column of bindings) {
		table.columns.add(column.column_name, sqlTypeForColumn(column), {
			nullable: column.is_nullable === 'YES',
		});
	}

	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		const csvRowNumber = startingDataRowIndex + index + 2;

		table.rows.add(
			...bindings.map((column) =>
				convertCsvValue(row[column.csv_index], column, csvRowNumber),
			),
		);
	}

	return table;
}

async function refreshAzureSubscriptionLog(headers, dataRows) {
	const pool = new sql.ConnectionPool(sqlConfig());
	let transaction = null;

	try {
		console.log('\nConnecting to Azure SQL Database...');
		await pool.connect();

		const columns = await getSqlTableColumns(pool);
		const bindings = buildColumnBindings(headers, columns);
		const rowsBefore = await getSqlRowCount(pool);

		console.log(`Azure table: ${SQL_DATABASE}.${SQL_FULL_TABLE_NAME}`);
		console.log(`Schema/header columns matched: ${bindings.length}`);
		console.log(`Rows before refresh: ${rowsBefore.toLocaleString()}`);
		console.log(`Rows to load: ${dataRows.length.toLocaleString()}`);

		transaction = new sql.Transaction(pool);

		await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

		console.log(`Truncating ${SQL_FULL_TABLE_NAME} inside transaction...`);

		await new sql.Request(transaction).query(
			`TRUNCATE TABLE ${SQL_FULL_TABLE_NAME};`,
		);

		let inserted = 0;

		for (
			let offset = 0;
			offset < dataRows.length;
			offset += SQL_BULK_BATCH_SIZE
		) {
			const batchRows = dataRows.slice(offset, offset + SQL_BULK_BATCH_SIZE);

			const bulkTable = buildBulkTable(bindings, batchRows, offset);
			const request = new sql.Request(transaction);

			await request.bulk(bulkTable);

			inserted += batchRows.length;

			console.log(
				`Loaded ${inserted.toLocaleString()} / ` +
					`${dataRows.length.toLocaleString()} rows...`,
			);
		}

		const verification = await new sql.Request(transaction).query(`
			SELECT COUNT_BIG(*) AS row_count
			FROM ${SQL_FULL_TABLE_NAME};
		`);

		const rowsBeforeCommit = Number(verification.recordset[0].row_count);

		if (rowsBeforeCommit !== dataRows.length) {
			throw new Error(
				`Azure verification failed before commit: expected ` +
					`${dataRows.length} rows, found ${rowsBeforeCommit}`,
			);
		}

		await transaction.commit();
		transaction = null;

		const rowsAfter = await getSqlRowCount(pool);

		if (rowsAfter !== dataRows.length) {
			throw new Error(
				`Azure verification failed after commit: expected ` +
					`${dataRows.length} rows, found ${rowsAfter}`,
			);
		}

		console.log(`Azure refresh complete: ${rowsAfter.toLocaleString()} rows.`);

		return {
			table: `${SQL_TABLE_SCHEMA}.${SQL_TABLE_NAME}`,
			rows_before: rowsBefore,
			rows_loaded: inserted,
			rows_after: rowsAfter,
			bulk_batch_size: SQL_BULK_BATCH_SIZE,
			complete: true,
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
		await pool.close().catch(() => {});
	}
}

/* =========================================================
   Main
   ========================================================= */

async function main() {
	const startedAt = new Date();

	const runTimestamp = timestampForPath(startedAt);

	const runDir = path.resolve(EXTRACT_ROOT, `${RUN_NAME}-${runTimestamp}`);

	const fileName = `subscription-log-${runTimestamp}`;

	await fs.mkdir(runDir, {
		recursive: true,
	});

	try {
		console.log('\nScheduling Piano VX Subscription Log export...');

		console.log(`API: ${REPORT_API_BASE_URL}`);

		console.log(`Attribute groups: ${ATTRIBUTE_GROUPS.join(', ')}`);

		/*
		 * No filters are supplied.
		 * This requests the complete
		 * Subscription Log.
		 */
		const scheduleResponse = await reportApiPost(SCHEDULE_ENDPOINT, {
			aid: AID,

			file_name: fileName,

			attribute_groups: ATTRIBUTE_GROUPS,
		});

		await fs.writeFile(
			path.join(runDir, 'schedule-response.json'),

			JSON.stringify(scheduleResponse, null, 2),
		);

		const exportId = extractExportId(scheduleResponse);

		const initialStatus = extractJobStatus(scheduleResponse);

		if (!exportId) {
			throw makeError('Schedule response did not contain export_id', {
				body: scheduleResponse,
			});
		}

		console.log(`Export ID: ${exportId}`);

		console.log(`Initial status: ${initialStatus ?? '(missing)'}`);

		/*
		 * DUPLICATE is valid here.
		 *
		 * Piano may return an existing
		 * export if an identical report
		 * was generated recently.
		 */
		const statusHistory = [];

		const pollStartedAt = Date.now();

		let finalStatusResponse = null;

		while (true) {
			if (Date.now() - pollStartedAt > MAX_WAIT_MS) {
				throw new Error(
					`Subscription Log export did not finish within ${MAX_WAIT_MS} ms`,
				);
			}

			const statusResponse = await reportApiGet(STATUS_ENDPOINT, {
				aid: AID,

				export_id: exportId,
			});

			const status = extractJobStatus(statusResponse);

			const percent = extractPercentComplete(statusResponse);

			statusHistory.push({
				checked_at_utc: new Date().toISOString(),

				response: statusResponse,
			});

			await fs.writeFile(
				path.join(runDir, 'status-history.json'),

				JSON.stringify(statusHistory, null, 2),
			);

			console.log(
				`Status: ${status ?? '(missing)'}` +
					(percent !== null ? ` (${percent}%)` : ''),
			);

			if (status === 'FINISHED') {
				finalStatusResponse = statusResponse;

				break;
			}

			if (status === 'INTERNAL_ERROR' || status === 'REMOVED') {
				const detail =
					unwrapObject(statusResponse)?.error_text ??
					'No error detail supplied';

				throw makeError(
					`Subscription Log export ended with status ${status}: ${detail}`,
					{
						body: statusResponse,
					},
				);
			}

			if (
				status !== 'CREATED' &&
				status !== 'IN_PROGRESS' &&
				status !== 'REPROCESS' &&
				status !== 'DUPLICATE'
			) {
				throw makeError(
					`Unexpected Subscription Log job status: ${status ?? '(missing)'}`,
					{
						body: statusResponse,
					},
				);
			}

			await sleep(POLL_INTERVAL_MS);
		}

		console.log('Requesting temporary download URL...');

		const downloadUrlResponse = await reportApiGet(DOWNLOAD_URL_ENDPOINT, {
			aid: AID,

			export_id: exportId,
		});

		const downloadUrl = extractDownloadUrl(downloadUrlResponse);

		if (!downloadUrl) {
			throw makeError('Download URL response did not contain a URL', {
				body: downloadUrlResponse,
			});
		}

		/*
		 * Do not persist or print the
		 * temporary signed download URL.
		 * Fetch it immediately.
		 */
		console.log('Downloading Subscription Log CSV...');

		const download = await downloadRawFile(downloadUrl);

		const csvPath = path.join(runDir, 'subscription-log.csv');

		/*
		 * Preserve the raw report
		 * exactly as Piano returned it.
		 */
		await fs.writeFile(csvPath, download.buffer);

		const { inspection, dataRows } = inspectCsv(download.buffer);

		if (!inspection.subscription_id_column_present) {
			throw new Error(
				'Downloaded CSV does not contain a "Subscription ID" column',
			);
		}

		if (inspection.rows_with_column_count_mismatch !== 0) {
			throw new Error(
				`Downloaded CSV has ${inspection.rows_with_column_count_mismatch} ` +
					'row(s) whose column count differs from the header',
			);
		}

		if (inspection.data_row_count === 0) {
			throw new Error('Downloaded CSV contains no data rows');
		}

		if (inspection.missing_subscription_id_count !== 0) {
			throw new Error(
				`Downloaded CSV has ${inspection.missing_subscription_id_count} ` +
					'row(s) with a missing Subscription ID',
			);
		}

		if (inspection.duplicate_subscription_id_count !== 0) {
			throw new Error(
				`Downloaded CSV has ${inspection.duplicate_subscription_id_count} ` +
					'duplicate Subscription ID row(s)',
			);
		}

		const azureLoad = await refreshAzureSubscriptionLog(
			inspection.headers,
			dataRows,
		);

		const completedAt = new Date();

		const summary = {
			extract_name: RUN_NAME,

			started_at_utc: startedAt.toISOString(),

			completed_at_utc: completedAt.toISOString(),

			report_api_base_url: REPORT_API_BASE_URL,

			schedule_endpoint: SCHEDULE_ENDPOINT,

			status_endpoint: STATUS_ENDPOINT,

			download_url_endpoint: DOWNLOAD_URL_ENDPOINT,

			aid: AID,

			export_id: exportId,

			requested_file_name: fileName,

			requested_attribute_groups: ATTRIBUTE_GROUPS,

			final_job_status: extractJobStatus(finalStatusResponse),

			final_percent_complete: extractPercentComplete(finalStatusResponse),

			poll_count: statusHistory.length,

			download_content_type: download.contentType,

			download_content_disposition: download.contentDisposition,

			download_bytes: download.buffer.length,

			...inspection,

			azure_sql: azureLoad,

			complete: true,
		};

		const manifest = {
			extract_name: RUN_NAME,

			generated_at_utc: completedAt.toISOString(),

			files: [
				'subscription-log.csv',
				'schedule-response.json',
				'status-history.json',
				'summary.json',
				'manifest.json',
			],

			export_id: exportId,

			data_row_count: inspection.data_row_count,

			column_count: inspection.column_count,

			unique_subscription_id_count: inspection.unique_subscription_id_count,

			azure_sql_table: azureLoad.table,

			azure_sql_row_count: azureLoad.rows_after,

			complete: true,
		};

		await Promise.all([
			fs.writeFile(
				path.join(runDir, 'summary.json'),

				JSON.stringify(summary, null, 2),
			),

			fs.writeFile(
				path.join(runDir, 'manifest.json'),

				JSON.stringify(manifest, null, 2),
			),
		]);

		console.log('\nSubscription Log export and Azure refresh complete.');

		console.log(`Rows: ${inspection.data_row_count}`);

		console.log(`Columns: ${inspection.column_count}`);

		console.log(
			`Unique Subscription IDs: ${inspection.unique_subscription_id_count}`,
		);

		console.log(
			'Control headers: ' + JSON.stringify(inspection.control_header_presence),
		);

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
			);
		} catch {
			/*
			 * Do not mask the
			 * original failure.
			 */
		}

		console.error('\nSubscription Log export/Azure refresh failed.');

		console.error(error);

		console.error(`Output: ${runDir}`);

		process.exitCode = 1;
	}
}

await main();

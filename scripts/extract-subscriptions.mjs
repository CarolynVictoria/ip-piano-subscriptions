import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sql from 'mssql';

/* =========================================================
   Piano.io subscription extractor

   Source:
   - GET /publisher/subscription/list

   Purpose:
   - Extract the complete unfiltered subscription population.
   - Preserve every API page as JSON.
   - Build one combined subscription JSON file without modifying
     the subscription objects returned by Piano.
   - Validate row counts and subscription_id uniqueness.
   - Detect common source changes while the live extract runs.

   - Populate the current subscription SQL snapshot only after
     the source extract passes its stability controls.
   - Preserve the prior current SQL snapshot in previous_* tables.
   ========================================================= */

/* =========================================================
   Configuration
   ========================================================= */

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

const EXTRACT_ROOT = process.env.EXTRACT_ROOT || './extracts';

/*
 * 50 is the page size verified by probe-subscriptions.mjs.
 *
 * Use a subscription-specific environment variable so that a
 * generic page-limit setting used by another extractor does not
 * silently change this extraction.
 */
const PAGE_LIMIT = Number(process.env.PIANO_SUBSCRIPTION_PAGE_LIMIT || 50);

const MAX_PAGES = Number(process.env.MAX_PAGES || 10000);

const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);

const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 0);

const SQL_BULK_BATCH_SIZE = Number(process.env.SQL_BULK_BATCH_SIZE || 1000);

const ENDPOINT = '/publisher/subscription/list';

const RUN_NAME = 'piano-subscriptions';

const SITE_LICENSE_TERM_TYPES = new Set([
	'email_domain_contract',
	'specific_email_addresses_contract',
]);

/* =========================================================
   SQL table definitions

   These column definitions match sql/ddl-subscriptions.sql.
   row_id and extracted_at_utc are database-managed.
   ========================================================= */

const TABLE_SPECS = [
	{
		name: 'subscriptions',
		columns: {
			subscription_id: sql.VarChar(64),
			auto_renew: sql.Bit,
			next_bill_date: sql.BigInt,
			payment_method: sql.NVarChar(500),
			user_payment_info_id: sql.VarChar(64),
			upi_ext_customer_id: sql.NVarChar(255),
			upi_ext_customer_id_label: sql.NVarChar(255),
			billing_plan: sql.NVarChar(1000),
			end_date: sql.BigInt,
			cancelable: sql.Bit,
			cancelable_and_refundadle: sql.Bit,
			psc_subscriber_number: sql.NVarChar(255),
			conversion_result: sql.NVarChar(sql.MAX),
			external_api_name: sql.NVarChar(255),
			status: sql.VarChar(100),
			status_name: sql.NVarChar(255),
			status_name_in_reports: sql.NVarChar(255),
			term_id: sql.VarChar(64),
			resource_rid: sql.VarChar(64),
			user_uid: sql.VarChar(64),
			user_email: sql.NVarChar(320),
			user_first_name: sql.NVarChar(255),
			user_last_name: sql.NVarChar(255),
			user_personal_name: sql.NVarChar(500),
			user_image1: sql.NVarChar(2000),
			user_create_date: sql.BigInt,
			user_last_visit: sql.BigInt,
			user_last_login: sql.BigInt,
			user_display_name: sql.NVarChar(500),
			start_date: sql.BigInt,
			is_in_trial: sql.Bit,
			trial_amount: sql.Decimal(19, 6),
			trial_currency: sql.VarChar(16),
			charge_count: sql.Int,
			acquisition_type: sql.VarChar(100),
			shared_account_limit: sql.Int,
			can_manage_shared_subscription: sql.Bit,
		},
	},
	{
		name: 'subscription_shared_accounts',
		columns: {
			subscription_id: sql.VarChar(64),
			shared_account_number: sql.Int,
			account_id: sql.VarChar(64),
			user_id: sql.VarChar(64),
			email: sql.NVarChar(320),
			first_name: sql.NVarChar(255),
			last_name: sql.NVarChar(255),
			personal_name: sql.NVarChar(500),
			redeemed: sql.BigInt,
			active: sql.Bit,
		},
	},
];

const TABLE_SPEC_BY_NAME = new Map(
	TABLE_SPECS.map((spec) => [spec.name, spec]),
);

/* =========================================================
   Configuration validation
   ========================================================= */

const missingEnv = [];

for (const [name, value] of Object.entries({
	PIANO_AID: AID,
	PIANO_API_TOKEN: API_TOKEN,
	SQL_SERVER,
	SQL_USER,
	SQL_PASSWORD,
	SQL_DATABASE,
})) {
	if (!value) {
		missingEnv.push(name);
	}
}

if (missingEnv.length > 0) {
	throw new Error(
		`Missing required environment variable(s): ${missingEnv.join(', ')}`,
	);
}

if (!Number.isInteger(SQL_PORT) || SQL_PORT <= 0) {
	throw new Error(`SQL_PORT must be a positive integer. Received: ${SQL_PORT}`);
}

if (!Number.isInteger(PAGE_LIMIT) || PAGE_LIMIT <= 0) {
	throw new Error(
		'PIANO_SUBSCRIPTION_PAGE_LIMIT must be a positive integer. ' +
			`Received: ${PAGE_LIMIT}`,
	);
}

if (!Number.isInteger(MAX_PAGES) || MAX_PAGES <= 0) {
	throw new Error(
		`MAX_PAGES must be a positive integer. Received: ${MAX_PAGES}`,
	);
}

if (!Number.isInteger(MAX_RETRIES) || MAX_RETRIES < 0) {
	throw new Error(
		`MAX_RETRIES must be a non-negative integer. Received: ${MAX_RETRIES}`,
	);
}

if (!Number.isFinite(REQUEST_DELAY_MS) || REQUEST_DELAY_MS < 0) {
	throw new Error(
		'REQUEST_DELAY_MS must be a non-negative number. ' +
			`Received: ${REQUEST_DELAY_MS}`,
	);
}

if (!Number.isInteger(SQL_BULK_BATCH_SIZE) || SQL_BULK_BATCH_SIZE <= 0) {
	throw new Error(
		'SQL_BULK_BATCH_SIZE must be a positive integer. ' +
			`Received: ${SQL_BULK_BATCH_SIZE}`,
	);
}

/* =========================================================
   General helpers
   ========================================================= */

function timestampForPath(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, '-');
}

function paddedOffset(offset) {
	return String(offset).padStart(6, '0');
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sqlValue(value) {
	return value === undefined || value === null ? null : value;
}

function quoteSqlIdentifier(name) {
	return `[${String(name).replaceAll(']', ']]')}]`;
}

function asFiniteNumber(value) {
	const number = Number(value);

	return Number.isFinite(number) ? number : null;
}

function redactUrl(url) {
	const copy = new URL(url);

	if (copy.searchParams.has('api_token')) {
		copy.searchParams.set('api_token', '[REDACTED]');
	}

	return copy.toString();
}

function incrementCount(map, value) {
	const key =
		value === null || value === undefined || value === ''
			? '(null)'
			: String(value);

	map.set(key, (map.get(key) || 0) + 1);
}

function mapToSortedObject(map) {
	return Object.fromEntries(
		[...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
	);
}

function sameArray(left, right) {
	if (left.length !== right.length) {
		return false;
	}

	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) {
			return false;
		}
	}

	return true;
}

function getSubscriptionIds(subscriptions) {
	return subscriptions.map((subscription) => {
		if (
			typeof subscription?.subscription_id === 'string' &&
			subscription.subscription_id.length > 0
		) {
			return subscription.subscription_id;
		}

		return null;
	});
}

/*
 * The combined output is written one subscription at a time
 * rather than JSON.stringify()ing the entire 27K+ population
 * into one very large in-memory string.
 */
function indentJson(value, spaces = 2) {
	const prefix = ' '.repeat(spaces);

	return JSON.stringify(value, null, 2)
		.split('\n')
		.map((line) => `${prefix}${line}`)
		.join('\n');
}

/* =========================================================
   Piano API request
   ========================================================= */

async function apiGet(endpoint, params = {}) {
	const url = new URL(`${API_BASE_URL}${endpoint}`);

	const allParams = {
		aid: AID,
		api_token: API_TOKEN,
		...params,
	};

	for (const [key, value] of Object.entries(allParams)) {
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
				const error = new Error(
					'Non-JSON response from ' +
						`${redactUrl(url)}: ` +
						`HTTP ${response.status}`,
				);

				error.status = response.status;

				throw error;
			}

			if (!response.ok) {
				const error = new Error(
					`HTTP ${response.status} ` + `from ${redactUrl(url)}`,
				);

				error.status = response.status;

				error.body = body;

				throw error;
			}

			/*
			 * Piano commonly uses JSON-level error codes,
			 * so HTTP status alone is not enough.
			 */
			const pianoCode = asFiniteNumber(body?.code);

			if (pianoCode !== null && pianoCode !== 0) {
				const error = new Error(
					'Piano API error code ' + `${body.code} from ` + `${redactUrl(url)}`,
				);

				error.body = body;

				throw error;
			}

			if (REQUEST_DELAY_MS > 0) {
				await sleep(REQUEST_DELAY_MS);
			}

			return body;
		} catch (error) {
			lastError = error;

			const retryable =
				error?.name === 'TimeoutError' ||
				error?.name === 'AbortError' ||
				error?.status === 408 ||
				error?.status === 429 ||
				(typeof error?.status === 'number' && error.status >= 500);

			if (!retryable || attempt === MAX_RETRIES) {
				throw error;
			}

			const backoffMs = Math.min(1000 * 2 ** attempt, 30000);

			console.warn(
				`Retrying ${endpoint} ` +
					'after transient error ' +
					`(${attempt + 1}/${MAX_RETRIES})...`,
			);

			await sleep(backoffMs);
		}
	}

	throw lastError;
}

/* =========================================================
   Subscription-page validation
   ========================================================= */

function validatePage(body, expectedOffset) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new Error(
			`Invalid response at offset ${expectedOffset}: ` +
				'body is not an object.',
		);
	}

	if (!Array.isArray(body.subscriptions)) {
		throw new Error(
			`Invalid response at offset ${expectedOffset}: ` +
				'subscriptions is not an array.',
		);
	}

	const total = asFiniteNumber(body.total);

	const count = asFiniteNumber(body.count);

	const offset = asFiniteNumber(body.offset);

	const limit = asFiniteNumber(body.limit);

	if (!Number.isInteger(total) || total < 0) {
		throw new Error(
			`Invalid total at offset ${expectedOffset}: ` + `${body.total}`,
		);
	}

	if (!Number.isInteger(count) || count < 0) {
		throw new Error(
			`Invalid count at offset ${expectedOffset}: ` + `${body.count}`,
		);
	}

	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error(
			'Invalid response offset at ' +
				`expected offset ${expectedOffset}: ` +
				`${body.offset}`,
		);
	}

	if (offset !== expectedOffset) {
		throw new Error(
			'Offset mismatch: ' +
				`requested ${expectedOffset}, ` +
				`received ${offset}.`,
		);
	}

	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error(
			`Invalid limit at offset ${expectedOffset}: ` + `${body.limit}`,
		);
	}

	if (count !== body.subscriptions.length) {
		throw new Error(
			`Count mismatch at offset ${expectedOffset}: ` +
				`count=${count}, ` +
				'subscriptions.length=' +
				`${body.subscriptions.length}`,
		);
	}

	return {
		total,
		count,
		offset,
		limit,
	};
}

/* =========================================================
   Transform subscription source objects into SQL rows

   Nested Term and Resource data are not duplicated relationally;
   only term_id and resource_rid are stored here.

   subscription_shared_accounts is deliberately limited to
   shared_accounts[] under payment subscriptions. Child users
   under site-license contract term types are excluded because
   those belong to the site-license contract tables.
   ========================================================= */

function buildSqlRowsForSubscriptions(subscriptions) {
	const subscriptionRows = [];
	const sharedAccountRows = [];

	const excludedSiteLicenseSharedAccountsByTermType = new Map();

	for (const subscription of subscriptions) {
		const subscriptionId = sqlValue(subscription?.subscription_id);
		const termType = sqlValue(subscription?.term?.type);

		const sourceSharedAccounts = subscription?.shared_accounts;

		if (
			sourceSharedAccounts !== undefined &&
			sourceSharedAccounts !== null &&
			!Array.isArray(sourceSharedAccounts)
		) {
			throw new Error(
				`Subscription ${subscriptionId ?? '(missing)'} has non-array shared_accounts.`,
			);
		}

		subscriptionRows.push({
			subscription_id: subscriptionId,
			auto_renew: sqlValue(subscription?.auto_renew),
			next_bill_date: sqlValue(subscription?.next_bill_date),
			payment_method: sqlValue(subscription?.payment_method),
			user_payment_info_id: sqlValue(subscription?.user_payment_info_id),
			upi_ext_customer_id: sqlValue(subscription?.upi_ext_customer_id),
			upi_ext_customer_id_label: sqlValue(
				subscription?.upi_ext_customer_id_label,
			),
			billing_plan: sqlValue(subscription?.billing_plan),
			end_date: sqlValue(subscription?.end_date),
			cancelable: sqlValue(subscription?.cancelable),
			cancelable_and_refundadle: sqlValue(
				subscription?.cancelable_and_refundadle,
			),
			psc_subscriber_number: sqlValue(subscription?.psc_subscriber_number),
			conversion_result: sqlValue(subscription?.conversion_result),
			external_api_name: sqlValue(subscription?.external_api_name),
			status: sqlValue(subscription?.status),
			status_name: sqlValue(subscription?.status_name),
			status_name_in_reports: sqlValue(subscription?.status_name_in_reports),
			term_id: sqlValue(subscription?.term?.term_id),
			resource_rid: sqlValue(subscription?.resource?.rid),
			user_uid: sqlValue(subscription?.user?.uid),
			user_email: sqlValue(subscription?.user?.email),
			user_first_name: sqlValue(subscription?.user?.first_name),
			user_last_name: sqlValue(subscription?.user?.last_name),
			user_personal_name: sqlValue(subscription?.user?.personal_name),
			user_image1: sqlValue(subscription?.user?.image1),
			user_create_date: sqlValue(subscription?.user?.create_date),
			user_last_visit: sqlValue(subscription?.user?.last_visit),
			user_last_login: sqlValue(subscription?.user?.last_login),
			user_display_name: sqlValue(subscription?.user?.display_name),
			start_date: sqlValue(subscription?.start_date),
			is_in_trial: sqlValue(subscription?.is_in_trial),
			trial_amount: sqlValue(subscription?.trial_amount),
			trial_currency: sqlValue(subscription?.trial_currency),
			charge_count: sqlValue(subscription?.charge_count),
			acquisition_type: sqlValue(subscription?.acquisition_type),
			shared_account_limit: sqlValue(subscription?.shared_account_limit),
			can_manage_shared_subscription: sqlValue(
				subscription?.can_manage_shared_subscription,
			),
		});

		const sharedAccounts = sourceSharedAccounts || [];

		if (sharedAccounts.length === 0) {
			continue;
		}

		if (termType === 'payment') {
			for (let index = 0; index < sharedAccounts.length; index += 1) {
				const account = sharedAccounts[index];

				sharedAccountRows.push({
					subscription_id: subscriptionId,
					shared_account_number: index + 1,
					account_id: sqlValue(account?.account_id),
					user_id: sqlValue(account?.user_id),
					email: sqlValue(account?.email),
					first_name: sqlValue(account?.first_name),
					last_name: sqlValue(account?.last_name),
					personal_name: sqlValue(account?.personal_name),
					redeemed: sqlValue(account?.redeemed),
					active: sqlValue(account?.active),
				});
			}

			continue;
		}

		if (SITE_LICENSE_TERM_TYPES.has(termType)) {
			excludedSiteLicenseSharedAccountsByTermType.set(
				termType,
				(excludedSiteLicenseSharedAccountsByTermType.get(termType) || 0) +
					sharedAccounts.length,
			);

			continue;
		}

		throw new Error(
			`Subscription ${subscriptionId ?? '(missing)'} has ${sharedAccounts.length} shared account(s) under unrecognized term type ${String(termType)}. Refusing to classify those child accounts automatically.`,
		);
	}

	return {
		subscriptions: subscriptionRows,
		subscription_shared_accounts: sharedAccountRows,
		excluded_site_license_shared_accounts_by_term_type: mapToSortedObject(
			excludedSiteLicenseSharedAccountsByTermType,
		),
	};
}

/* =========================================================
   SQL connection and extract_runs tracking
   ========================================================= */

function sqlConfig() {
	return {
		server: SQL_SERVER,
		port: SQL_PORT,
		user: SQL_USER,
		password: SQL_PASSWORD,
		database: SQL_DATABASE,
		options: {
			encrypt:
				String(process.env.SQL_ENCRYPT || 'true').toLowerCase() === 'true',

			trustServerCertificate:
				String(
					process.env.SQL_TRUST_SERVER_CERTIFICATE || 'false',
				).toLowerCase() === 'true',
		},
		pool: {
			max: 5,
			min: 0,
			idleTimeoutMillis: 30000,
		},
		requestTimeout: 120000,
	};
}

async function createExtractRun(pool) {
	const result = await pool
		.request()
		.input('run_name', sql.NVarChar(255), RUN_NAME)
		.input(
			'notes',
			sql.NVarChar(sql.MAX),
			'Piano subscription extraction and SQL snapshot load',
		).query(`
			insert into dbo.extract_runs (
				run_name,
				status,
				notes
			)
			output inserted.extract_run_id
			values (
				@run_name,
				'RUNNING',
				@notes
			);
		`);

	return result.recordset[0].extract_run_id;
}

async function markExtractRunComplete(pool, extractRunId, notes) {
	await pool
		.request()
		.input('extract_run_id', sql.BigInt, extractRunId)
		.input('notes', sql.NVarChar(sql.MAX), notes).query(`
			update dbo.extract_runs
			set
				completed_at_utc = sysutcdatetime(),
				status = 'COMPLETE',
				notes = @notes
			where extract_run_id = @extract_run_id;
		`);
}

async function markExtractRunFailed(pool, extractRunId, notes) {
	await pool
		.request()
		.input('extract_run_id', sql.BigInt, extractRunId)
		.input('notes', sql.NVarChar(sql.MAX), notes).query(`
			update dbo.extract_runs
			set
				completed_at_utc = sysutcdatetime(),
				status = 'FAILED',
				notes = @notes
			where extract_run_id = @extract_run_id;
		`);
}

/* =========================================================
   SQL snapshot helpers
   ========================================================= */

async function getTableCount(transaction, tableName) {
	const result = await new sql.Request(transaction).query(`
		select count_big(*) as row_count
		from dbo.${quoteSqlIdentifier(tableName)};
	`);

	return Number(result.recordset[0].row_count);
}

async function getCounts(transaction, previous = false) {
	const counts = {};

	for (const spec of TABLE_SPECS) {
		const tableName = previous ? `previous_${spec.name}` : spec.name;

		counts[spec.name] = await getTableCount(transaction, tableName);
	}

	return counts;
}

async function truncateTables(transaction, previous = false) {
	for (const spec of [...TABLE_SPECS].reverse()) {
		const tableName = previous ? `previous_${spec.name}` : spec.name;

		await new sql.Request(transaction).query(`
			truncate table dbo.${quoteSqlIdentifier(tableName)};
		`);
	}
}

async function copyCurrentToPrevious(transaction) {
	const beforeCounts = await getCounts(transaction, false);

	await truncateTables(transaction, true);

	for (const spec of TABLE_SPECS) {
		const sourceTable = spec.name;
		const targetTable = `previous_${spec.name}`;

		const columns = [
			'extract_run_id',
			...Object.keys(spec.columns),
			'extracted_at_utc',
		];

		const columnList = columns.map(quoteSqlIdentifier).join(',\n\t\t\t');

		await new sql.Request(transaction).query(`
			insert into dbo.${quoteSqlIdentifier(targetTable)} (
				${columnList}
			)
			select
				${columnList}
			from dbo.${quoteSqlIdentifier(sourceTable)};
		`);
	}

	const previousCounts = await getCounts(transaction, true);

	for (const spec of TABLE_SPECS) {
		if (previousCounts[spec.name] !== beforeCounts[spec.name]) {
			throw new Error(
				`Previous snapshot count mismatch for ${spec.name}: current-before=${beforeCounts[spec.name]}, previous=${previousCounts[spec.name]}`,
			);
		}
	}

	return beforeCounts;
}

async function bulkInsertRows(transaction, extractRunId, tableName, rows) {
	if (rows.length === 0) {
		return;
	}

	const spec = TABLE_SPEC_BY_NAME.get(tableName);

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
			...dataColumns.map((column) => sqlValue(row[column])),
		);
	}

	const request = new sql.Request(transaction);

	await request.bulk(table, {
		checkConstraints: true,
		keepNulls: true,
	});
}

async function loadCurrentTablesFromPages(
	transaction,
	extractRunId,
	runDir,
	pageIndex,
) {
	const loadedCounts = {
		subscriptions: 0,
		subscription_shared_accounts: 0,
	};

	const pendingRows = {
		subscriptions: [],
		subscription_shared_accounts: [],
	};

	const excludedSiteLicenseSharedAccountsByTermType = new Map();

	async function flushPendingRows(tableName, flushAll = false) {
		const pending = pendingRows[tableName];

		while (
			pending.length >= SQL_BULK_BATCH_SIZE ||
			(flushAll && pending.length > 0)
		) {
			const batchSize = Math.min(SQL_BULK_BATCH_SIZE, pending.length);

			const batch = pending.splice(0, batchSize);

			await bulkInsertRows(transaction, extractRunId, tableName, batch);

			loadedCounts[tableName] += batch.length;
		}
	}

	for (let index = 0; index < pageIndex.length; index += 1) {
		const pageEntry = pageIndex[index];
		const pagePath = path.join(runDir, pageEntry.file);
		const body = JSON.parse(await fs.readFile(pagePath, 'utf8'));

		if (!Array.isArray(body?.subscriptions)) {
			throw new Error(`Saved subscription page is invalid: ${pageEntry.file}`);
		}

		if (body.subscriptions.length !== pageEntry.count) {
			throw new Error(
				`Saved subscription page count changed for ${pageEntry.file}: expected=${pageEntry.count}, actual=${body.subscriptions.length}`,
			);
		}

		const rows = buildSqlRowsForSubscriptions(body.subscriptions);

		pendingRows.subscriptions.push(...rows.subscriptions);
		pendingRows.subscription_shared_accounts.push(
			...rows.subscription_shared_accounts,
		);

		const isLastPage = index + 1 === pageIndex.length;

		await flushPendingRows('subscriptions', isLastPage);
		await flushPendingRows('subscription_shared_accounts', isLastPage);

		for (const [termType, count] of Object.entries(
			rows.excluded_site_license_shared_accounts_by_term_type,
		)) {
			excludedSiteLicenseSharedAccountsByTermType.set(
				termType,
				(excludedSiteLicenseSharedAccountsByTermType.get(termType) || 0) +
					count,
			);
		}

		if ((index + 1) % 25 === 0 || index + 1 === pageIndex.length) {
			console.log(
				`SQL load progress: ${index + 1}/${pageIndex.length} saved page(s); ` +
					`subscriptions=${loadedCounts.subscriptions}, ` +
					`shared_accounts=${loadedCounts.subscription_shared_accounts}`,
			);
		}
	}

	return {
		counts: loadedCounts,
		excluded_site_license_shared_accounts_by_term_type: mapToSortedObject(
			excludedSiteLicenseSharedAccountsByTermType,
		),
	};
}

async function validateSqlLoad(transaction, extractRunId, expectedCounts) {
	const actualCounts = await getCounts(transaction, false);

	for (const spec of TABLE_SPECS) {
		if (actualCounts[spec.name] !== expectedCounts[spec.name]) {
			throw new Error(
				`SQL count mismatch for ${spec.name}: expected=${expectedCounts[spec.name]}, actual=${actualCounts[spec.name]}`,
			);
		}
	}

	const result = await new sql.Request(transaction).input(
		'extract_run_id',
		sql.BigInt,
		extractRunId,
	).query(`
			select
				(
					select count_big(*)
					from dbo.subscription_shared_accounts sa
					left join dbo.subscriptions s
						on s.subscription_id = sa.subscription_id
					where s.row_id is null
				) as orphan_shared_account_count,

				(
					select count_big(*)
					from dbo.subscriptions
					where extract_run_id <> @extract_run_id
						or extract_run_id is null
				) as wrong_subscription_extract_run_count,

				(
					select count_big(*)
					from dbo.subscription_shared_accounts
					where extract_run_id <> @extract_run_id
						or extract_run_id is null
				) as wrong_shared_account_extract_run_count;
		`);

	const rawRelationshipCounts = result.recordset[0];
	const relationshipCounts = Object.fromEntries(
		Object.entries(rawRelationshipCounts).map(([key, value]) => [
			key,
			Number(value),
		]),
	);

	for (const [name, value] of Object.entries(relationshipCounts)) {
		if (value !== 0) {
			throw new Error(`SQL subscription validation failed: ${name}=${value}`);
		}
	}

	return {
		counts: actualCounts,
		relationships: relationshipCounts,
	};
}

/* =========================================================
   Main extraction
   ========================================================= */

async function main() {
	const startedAt = new Date();

	const runDir = path.resolve(
		EXTRACT_ROOT,
		'run-subscriptions-' + timestampForPath(startedAt),
	);

	const pagesDir = path.join(runDir, 'pages');

	await fs.mkdir(pagesDir, {
		recursive: true,
	});

	const partialCombinedPath = path.join(
		runDir,
		'all-subscriptions.json.partial',
	);

	const combinedPath = path.join(runDir, 'all-subscriptions.json');

	let combinedFile = null;
	let combinedClosed = false;
	let wroteCombinedItem = false;

	let requestCount = 0;
	let pageCount = 0;
	let extractedCount = 0;

	let initialTotal = null;
	let finalTotal = null;

	let initialFirstPageIds = [];
	let finalFirstPageIds = [];

	const seenIds = new Set();

	const duplicateIds = new Set();

	let missingIdCount = 0;

	const statusCounts = new Map();

	const termTypeCounts = new Map();

	const acquisitionTypeCounts = new Map();

	const pageIndex = [];

	let pool = null;
	let extractRunId = null;
	let transaction = null;
	let transactionStarted = false;
	let sqlLoad = null;
	let previousSnapshotSourceCounts = null;
	let sqlValidation = null;

	try {
		pool = await sql.connect(sqlConfig());
		extractRunId = await createExtractRun(pool);

		console.log(`SQL extract_run_id=${extractRunId}`);
		console.log('Piano subscription extraction');

		console.log(`Endpoint: ${ENDPOINT}`);

		console.log(`Page limit: ${PAGE_LIMIT}`);

		console.log(`SQL bulk batch size: ${SQL_BULK_BATCH_SIZE}`);

		console.log(`Output: ${runDir}`);

		console.log('');

		/*
		 * Write to a .partial file first.
		 *
		 * It is renamed to all-subscriptions.json only after
		 * the entire extract and final stability check pass.
		 */
		combinedFile = await fs.open(partialCombinedPath, 'w');

		await combinedFile.write('[\n');

		let offset = 0;

		for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
			console.log(`Retrieving page ${pageNumber} ` + `at offset ${offset}...`);

			const body = await apiGet(ENDPOINT, {
				offset,
				limit: PAGE_LIMIT,
			});

			requestCount += 1;

			const page = validatePage(body, offset);

			/*
			 * Establish the run's expected source total
			 * from the first page.
			 */
			if (initialTotal === null) {
				initialTotal = page.total;

				initialFirstPageIds = getSubscriptionIds(body.subscriptions);

				console.log(`Reported total: ${initialTotal}`);
			} else if (page.total !== initialTotal) {
				throw new Error(
					'Piano subscription total changed ' +
						'during extraction: ' +
						`initial=${initialTotal}, ` +
						`current=${page.total}, ` +
						`offset=${offset}. ` +
						'The source changed while the run ' +
						'was in progress; rerun the extractor.',
				);
			}

			if (page.count === 0 && extractedCount < initialTotal) {
				throw new Error(
					'Empty page returned before ' +
						'reaching the reported total: ' +
						`offset=${offset}, ` +
						`extracted=${extractedCount}, ` +
						`total=${initialTotal}.`,
				);
			}

			/*
			 * Preserve this complete API page.
			 */
			const pageFilename =
				'subscriptions-offset-' + `${paddedOffset(offset)}.json`;

			const pagePath = path.join(pagesDir, pageFilename);

			await fs.writeFile(
				pagePath,
				JSON.stringify(body, null, 2) + '\n',
				'utf8',
			);

			const ids = getSubscriptionIds(body.subscriptions);

			pageIndex.push({
				page_number: pageNumber,

				offset,

				requested_limit: PAGE_LIMIT,

				response_limit: page.limit,

				count: page.count,

				total: page.total,

				first_subscription_id: ids[0] ?? null,

				last_subscription_id: ids.at(-1) ?? null,

				file: `pages/${pageFilename}`,
			});

			for (const subscription of body.subscriptions) {
				let subscriptionId = null;

				if (
					typeof subscription?.subscription_id === 'string' &&
					subscription.subscription_id.length > 0
				) {
					subscriptionId = subscription.subscription_id;
				}

				if (subscriptionId === null) {
					missingIdCount += 1;
				} else if (seenIds.has(subscriptionId)) {
					duplicateIds.add(subscriptionId);
				} else {
					seenIds.add(subscriptionId);
				}

				incrementCount(statusCounts, subscription?.status);

				incrementCount(termTypeCounts, subscription?.term?.type);

				incrementCount(acquisitionTypeCounts, subscription?.acquisition_type);

				if (wroteCombinedItem) {
					await combinedFile.write(',\n');
				}

				await combinedFile.write(indentJson(subscription, 2));

				wroteCombinedItem = true;

				extractedCount += 1;
			}

			pageCount += 1;

			console.log(
				`Saved ${pageFilename}; ` +
					`extracted ${extractedCount}/` +
					`${initialTotal}`,
			);

			if (extractedCount === initialTotal) {
				break;
			}

			if (extractedCount > initialTotal) {
				throw new Error(
					'Extracted count exceeded ' +
						'reported total: ' +
						`extracted=${extractedCount}, ` +
						`total=${initialTotal}.`,
				);
			}

			/*
			 * Advance by the number actually returned.
			 * This avoids assuming more about Piano's
			 * pagination than necessary.
			 */
			offset += page.count;
		}

		if (initialTotal === null) {
			throw new Error('No API response was received.');
		}

		if (extractedCount !== initialTotal) {
			throw new Error(
				'Extraction stopped before reaching ' +
					'the reported total: ' +
					`extracted=${extractedCount}, ` +
					`total=${initialTotal}, ` +
					`pages=${pageCount}.`,
			);
		}

		if (missingIdCount > 0) {
			throw new Error(
				`Found ${missingIdCount} ` +
					'subscription record(s) with a ' +
					'missing or blank subscription_id.',
			);
		}

		if (duplicateIds.size > 0) {
			throw new Error(
				`Found ${duplicateIds.size} ` +
					'duplicate subscription_id value(s): ' +
					[...duplicateIds].slice(0, 20).join(', '),
			);
		}

		if (seenIds.size !== extractedCount) {
			throw new Error(
				'Unique subscription_id count does ' +
					'not match extracted count: ' +
					`unique=${seenIds.size}, ` +
					`extracted=${extractedCount}.`,
			);
		}

		await combinedFile.write('\n]\n');

		await combinedFile.close();

		combinedClosed = true;

		/*
		 * Final source-stability control.
		 *
		 * The endpoint is live. Query the first page again
		 * after extraction and verify:
		 *
		 * 1. total is unchanged
		 * 2. first-page IDs are unchanged
		 *
		 * This catches the common cases where subscriptions
		 * were inserted/deleted or pagination shifted while
		 * the extraction was running.
		 */
		console.log('\nRunning final source-stability control...');

		const finalControl = await apiGet(ENDPOINT, {
			offset: 0,
			limit: PAGE_LIMIT,
		});

		requestCount += 1;

		const finalPage = validatePage(finalControl, 0);

		finalTotal = finalPage.total;

		finalFirstPageIds = getSubscriptionIds(finalControl.subscriptions);

		await fs.writeFile(
			path.join(runDir, 'final-control-page.json'),
			JSON.stringify(finalControl, null, 2) + '\n',
			'utf8',
		);

		if (finalTotal !== initialTotal) {
			throw new Error(
				'Piano subscription total changed ' +
					'by the end of extraction: ' +
					`initial=${initialTotal}, ` +
					`final=${finalTotal}. ` +
					'The run is not a stable snapshot; ' +
					'rerun the extractor.',
			);
		}

		if (!sameArray(initialFirstPageIds, finalFirstPageIds)) {
			throw new Error(
				'Piano subscription first-page IDs ' +
					'changed during extraction even ' +
					'though the total remained the same. ' +
					'The run is not a stable snapshot; ' +
					'rerun the extractor.',
			);
		}

		/*
		 * Promote the combined file only after every
		 * validation succeeds.
		 */
		await fs.rename(partialCombinedPath, combinedPath);

		/*
		 * A sorted ID-only file will be useful in the next
		 * phase when reconciling this API extract against
		 * the Subscription Log report.
		 */
		const sortedIds = [...seenIds].sort();

		await fs.writeFile(
			path.join(runDir, 'subscription-ids.json'),
			JSON.stringify(sortedIds, null, 2) + '\n',
			'utf8',
		);

		await fs.writeFile(
			path.join(runDir, 'page-index.json'),
			JSON.stringify(pageIndex, null, 2) + '\n',
			'utf8',
		);

		/*
		 * Subscription snapshot tables are modified only after the
		 * complete API extract has passed all source-count,
		 * uniqueness, and stability checks.
		 */
		transaction = new sql.Transaction(pool);
		await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
		transactionStarted = true;

		console.log('\nCreating previous subscription snapshot...');
		previousSnapshotSourceCounts = await copyCurrentToPrevious(transaction);

		console.log('Truncating current subscription tables...');
		await truncateTables(transaction, false);

		console.log('Loading new subscription snapshot...');
		sqlLoad = await loadCurrentTablesFromPages(
			transaction,
			extractRunId,
			runDir,
			pageIndex,
		);

		if (sqlLoad.counts.subscriptions !== extractedCount) {
			throw new Error(
				'SQL source-row count mismatch before validation: ' +
					`extracted=${extractedCount}, ` +
					`sql_source_rows=${sqlLoad.counts.subscriptions}.`,
			);
		}

		console.log('Validating SQL subscription snapshot...');
		sqlValidation = await validateSqlLoad(
			transaction,
			extractRunId,
			sqlLoad.counts,
		);

		await transaction.commit();
		transactionStarted = false;

		const completedAt = new Date();

		const summary = {
			extract_name: RUN_NAME,

			extract_run_id: extractRunId,

			endpoint: ENDPOINT,

			started_at_utc: startedAt.toISOString(),

			completed_at_utc: completedAt.toISOString(),

			piano_api_base_url: API_BASE_URL,

			aid: AID,

			page_limit: PAGE_LIMIT,

			sql_bulk_batch_size: SQL_BULK_BATCH_SIZE,

			api_request_count: requestCount,

			page_count: pageCount,

			initial_api_total: initialTotal,

			final_api_total: finalTotal,

			extracted_subscription_count: extractedCount,

			unique_subscription_id_count: seenIds.size,

			duplicate_subscription_id_count: duplicateIds.size,

			missing_subscription_id_count: missingIdCount,

			first_page_ids_stable: true,

			source_stable: true,

			status_counts: mapToSortedObject(statusCounts),

			term_type_counts: mapToSortedObject(termTypeCounts),

			acquisition_type_counts: mapToSortedObject(acquisitionTypeCounts),

			sql_counts: sqlLoad.counts,

			previous_snapshot_source_counts: previousSnapshotSourceCounts,

			excluded_site_license_shared_accounts_by_term_type:
				sqlLoad.excluded_site_license_shared_accounts_by_term_type,

			sql_validation: sqlValidation,

			complete: true,
		};

		const manifest = {
			extract_name: RUN_NAME,

			extract_run_id: extractRunId,

			generated_at_utc: completedAt.toISOString(),

			files: [
				'all-subscriptions.json',
				'subscription-ids.json',
				'page-index.json',
				'final-control-page.json',
				'summary.json',
				'manifest.json',
			],

			page_directory: 'pages',

			page_file_count: pageCount,

			counts: sqlLoad.counts,

			complete: true,
		};

		await Promise.all([
			fs.writeFile(
				path.join(runDir, 'summary.json'),
				JSON.stringify(summary, null, 2) + '\n',
				'utf8',
			),

			fs.writeFile(
				path.join(runDir, 'manifest.json'),
				JSON.stringify(manifest, null, 2) + '\n',
				'utf8',
			),
		]);

		await markExtractRunComplete(
			pool,
			extractRunId,
			JSON.stringify({
				counts: sqlLoad.counts,
				output: runDir,
			}),
		);

		console.log('\nSubscription extraction complete.');

		console.log(JSON.stringify(summary, null, 2));

		console.log(`Output: ${runDir}`);
	} catch (error) {
		if (combinedFile && !combinedClosed) {
			try {
				await combinedFile.close();

				combinedClosed = true;
			} catch {
				/*
				 * Do not mask the original failure.
				 */
			}
		}

		if (transactionStarted && transaction) {
			try {
				await transaction.rollback();
				transactionStarted = false;
				console.error('SQL transaction rolled back.');
			} catch (rollbackError) {
				console.error(
					`SQL rollback failed: ${rollbackError?.message || rollbackError}`,
				);
			}
		}

		const failure = {
			extract_name: RUN_NAME,

			extract_run_id: extractRunId,

			endpoint: ENDPOINT,

			failed_at_utc: new Date().toISOString(),

			piano_api_base_url: API_BASE_URL,

			aid: AID,

			page_limit: PAGE_LIMIT,

			sql_bulk_batch_size: SQL_BULK_BATCH_SIZE,

			api_request_count: requestCount,

			page_count: pageCount,

			initial_api_total: initialTotal,

			final_api_total: finalTotal,

			extracted_subscription_count: extractedCount,

			unique_subscription_id_count: seenIds.size,

			duplicate_subscription_id_count: duplicateIds.size,

			missing_subscription_id_count: missingIdCount,

			previous_snapshot_source_counts: previousSnapshotSourceCounts,

			sql_load: sqlLoad,

			sql_validation: sqlValidation,

			complete: false,

			error: error?.message || String(error),

			stack: error?.stack || null,

			body: error?.body || null,
		};

		try {
			await Promise.all([
				fs.writeFile(
					path.join(runDir, 'errors.json'),
					JSON.stringify(failure, null, 2) + '\n',
					'utf8',
				),

				fs.writeFile(
					path.join(runDir, 'page-index.json'),
					JSON.stringify(pageIndex, null, 2) + '\n',
					'utf8',
				),
			]);
		} catch {
			/*
			 * Do not mask the original failure.
			 */
		}

		if (pool && extractRunId !== null) {
			try {
				await markExtractRunFailed(
					pool,
					extractRunId,
					error?.message || String(error),
				);
			} catch (runUpdateError) {
				console.error(
					`Could not mark extract_run_id=${extractRunId} FAILED: ${runUpdateError?.message || runUpdateError}`,
				);
			}
		}

		console.error('\nFatal subscription extraction error:');

		console.error(error?.stack || error);

		if (error?.body) {
			console.error(JSON.stringify(error.body, null, 2));
		}

		console.error(`Incomplete run output: ${runDir}`);

		process.exitCode = 1;
	} finally {
		if (pool) {
			await pool.close();
		}
	}
}

await main();

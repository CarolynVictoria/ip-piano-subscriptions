import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import sql from 'mssql';

/* =========================================================
   Piano.io reference-data extractor

   Sources:
   - GET /publisher/resource/list
   - GET /publisher/term/list

   SQL snapshot behavior:
   - previous_* tables are truncated
   - current rows are copied to previous_*
   - current tables are truncated
   - new rows are loaded
   - counts and relationships are validated
   - the entire snapshot/load is one SQL transaction

   Schedules are intentionally not relationalized.
   Offers are intentionally outside this extract.
   Full Resource and Term source objects are retained as JSON.
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

const PAGE_LIMIT = Number(process.env.PIANO_PAGE_LIMIT || 20);
const MAX_PAGES = Number(process.env.MAX_PAGES || 10000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 0);

const RESOURCE_ENDPOINT = '/publisher/resource/list';
const TERM_ENDPOINT = '/publisher/term/list';
const RUN_NAME = 'piano-reference-data';

/* =========================================================
   SQL table definitions

   These column definitions match the DDL already created.
   row_id and extracted_at_utc are database-managed.
   ========================================================= */

const TABLE_SPECS = [
	{
		name: 'resources',
		columns: {
			rid: sql.VarChar(64),
			aid: sql.VarChar(64),
			deleted: sql.Bit,
			disabled: sql.Bit,
			create_date: sql.BigInt,
			update_date: sql.BigInt,
			publish_date: sql.BigInt,
			name: sql.NVarChar(500),
			description: sql.NVarChar(sql.MAX),
			image_url: sql.NVarChar(2000),
			type: sql.VarChar(100),
			type_label: sql.NVarChar(255),
			purchase_url: sql.NVarChar(2000),
			resource_url: sql.NVarChar(2000),
			external_id: sql.NVarChar(500),
			is_fbia_resource: sql.Bit,
			resource_json: sql.NVarChar(sql.MAX),
		},
	},
	{
		name: 'terms',
		columns: {
			aid: sql.VarChar(64),
			term_id: sql.VarChar(64),
			rid: sql.VarChar(64),
			name: sql.NVarChar(500),
			description: sql.NVarChar(sql.MAX),
			type: sql.VarChar(100),
			type_name: sql.NVarChar(255),
			create_date: sql.BigInt,
			update_date: sql.BigInt,
			shared_account_count: sql.Int,
			shared_redemption_url: sql.NVarChar(2000),
			collect_address: sql.Bit,
			registration_access_period: sql.Int,
			registration_grace_period: sql.Int,
			custom_require_user: sql.Bit,
			custom_default_access_period: sql.Int,
			term_billing_descriptor: sql.NVarChar(255),
			payment_currency: sql.VarChar(16),
			currency_symbol: sql.NVarChar(16),
			payment_allow_promo_codes: sql.Bit,
			payment_billing_plan: sql.NVarChar(sql.MAX),
			payment_billing_plan_description: sql.NVarChar(1000),
			payment_first_price: sql.Decimal(19, 6),
			verify_on_renewal: sql.Bit,
			payment_allow_renew_days: sql.Int,
			payment_new_customers_only: sql.Bit,
			payment_trial_new_customers_only: sql.Bit,
			payment_renew_grace_period: sql.Int,
			payment_is_custom_price_available: sql.Bit,
			payment_is_subscription: sql.Bit,
			payment_has_free_trial: sql.Bit,
			payment_force_auto_renew: sql.Bit,
			payment_allow_gift: sql.Bit,
			allow_renewable_gifting: sql.Bit,
			gift_redemption_url: sql.NVarChar(2000),
			evt_verification_period: sql.Int,
			product_category: sql.NVarChar(255),
			is_allowed_to_change_schedule_period_in_past: sql.Bit,
			billing_config: sql.VarChar(100),
			allow_start_in_future: sql.Bit,
			maximum_days_in_advance: sql.Int,
			term_json: sql.NVarChar(sql.MAX),
		},
	},
	{
		name: 'term_billing_plan_rows',
		columns: {
			term_id: sql.VarChar(64),
			term_name: sql.NVarChar(500),
			billing_plan_row_number: sql.Int,
			date: sql.NVarChar(100),
			date_value: sql.BigInt,
			period: sql.NVarChar(100),
			short_period: sql.NVarChar(100),
			payment_interval_unit: sql.VarChar(50),
			billing_without_tax: sql.Decimal(19, 6),
			billing_period: sql.NVarChar(100),
			price_charged_str: sql.NVarChar(100),
			price_value: sql.Decimal(19, 6),
			cycles: sql.VarChar(50),
			is_free_trial: sql.VarChar(10),
			is_trial: sql.VarChar(10),
			is_pay_what_you_want: sql.VarChar(10),
			billing: sql.NVarChar(500),
			duration: sql.NVarChar(500),
			billing_info: sql.NVarChar(500),
			price_and_tax_in_minor_unit: sql.BigInt,
			is_free: sql.VarChar(10),
			price: sql.NVarChar(100),
			price_and_tax: sql.Decimal(19, 6),
			currency: sql.VarChar(16),
			total_billing: sql.NVarChar(500),
			billing_plan_row_json: sql.NVarChar(sql.MAX),
		},
	},
	{
		name: 'term_change_options',
		columns: {
			term_id: sql.VarChar(64),
			term_name: sql.NVarChar(500),
			change_option_number: sql.Int,
			term_change_option_id: sql.VarChar(64),
			from_term_id: sql.VarChar(64),
			from_term_name: sql.NVarChar(500),
			from_period_id: sql.VarChar(64),
			from_period_name: sql.NVarChar(500),
			from_resource_id: sql.VarChar(64),
			from_resource_name: sql.NVarChar(500),
			from_billing_plan: sql.NVarChar(1000),
			to_term_id: sql.VarChar(64),
			to_term_name: sql.NVarChar(500),
			to_period_id: sql.VarChar(64),
			to_period_name: sql.NVarChar(500),
			to_resource_id: sql.VarChar(64),
			to_resource_name: sql.NVarChar(500),
			to_billing_plan: sql.NVarChar(1000),
			billing_timing: sql.VarChar(50),
			immediate_access: sql.Bit,
			prorate_access: sql.Bit,
			description: sql.NVarChar(sql.MAX),
			include_trial: sql.Bit,
			to_scheduled: sql.Bit,
			from_scheduled: sql.Bit,
			shared_account_count: sql.Int,
			collect_address: sql.Bit,
			upgrade_offers_json: sql.NVarChar(sql.MAX),
			change_option_json: sql.NVarChar(sql.MAX),
		},
	},
	{
		name: 'term_change_option_show_options',
		columns: {
			term_id: sql.VarChar(64),
			term_change_option_id: sql.VarChar(64),
			show_option_number: sql.Int,
			show_option: sql.NVarChar(255),
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
	if (!value) missingEnv.push(name);
}

if (missingEnv.length > 0) {
	console.error(
		`Missing required environment variable(s): ${missingEnv.join(', ')}`,
	);
	process.exit(1);
}

if (!Number.isInteger(SQL_PORT) || SQL_PORT <= 0) {
	console.error('SQL_PORT must be a positive integer');
	process.exit(1);
}

if (!Number.isInteger(PAGE_LIMIT) || PAGE_LIMIT <= 0) {
	console.error('PIANO_PAGE_LIMIT must be a positive integer');
	process.exit(1);
}

if (!Number.isInteger(MAX_PAGES) || MAX_PAGES <= 0) {
	console.error('MAX_PAGES must be a positive integer');
	process.exit(1);
}

/* =========================================================
   General helpers
   ========================================================= */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function timestampForPath(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, '-');
}

function asFiniteNumber(value) {
	if (value === null || value === undefined || value === '') {
		return null;
	}

	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function sqlValue(value) {
	return value === undefined || value === null ? null : value;
}

function jsonValue(value) {
	return value === undefined ? null : JSON.stringify(value);
}

function quoteSqlIdentifier(name) {
	return `[${String(name).replaceAll(']', ']]')}]`;
}

function redactUrl(url) {
	const copy = new URL(url);

	if (copy.searchParams.has('api_token')) {
		copy.searchParams.set('api_token', '[REDACTED]');
	}

	return copy.toString();
}

function countBy(items, getter) {
	const counts = {};

	for (const item of items) {
		const rawValue = getter(item);
		const value =
			rawValue === null || rawValue === undefined || rawValue === ''
				? '(empty)'
				: String(rawValue);

		counts[value] = (counts[value] || 0) + 1;
	}

	return Object.fromEntries(
		Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
	);
}

function duplicateValues(values) {
	const counts = new Map();

	for (const value of values) {
		counts.set(value, (counts.get(value) || 0) + 1);
	}

	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([value, count]) => ({ value, count }));
}

/* =========================================================
   Piano API helpers
   ========================================================= */

async function apiGet(endpoint, params = {}) {
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
					`Non-JSON response from ${redactUrl(url)}: HTTP ${response.status}`,
				);
			}

			if (!response.ok) {
				const error = new Error(
					`HTTP ${response.status} from ${redactUrl(url)}`,
				);
				error.status = response.status;
				error.body = body;
				throw error;
			}

			const pianoCode = asFiniteNumber(body?.code);

			if (pianoCode !== null && pianoCode !== 0) {
				const error = new Error(
					`Piano API error code ${body.code} from ${redactUrl(url)}`,
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
				`Retrying ${endpoint} after transient error (${attempt + 1}/${MAX_RETRIES})...`,
			);

			await sleep(backoffMs);
		}
	}

	throw lastError;
}

function extractArray(body, preferredKeys, label) {
	if (Array.isArray(body)) return body;

	for (const key of preferredKeys) {
		if (Array.isArray(body?.[key])) return body[key];
		if (Array.isArray(body?.data?.[key])) return body.data[key];
	}

	if (Array.isArray(body?.data)) return body.data;
	if (Array.isArray(body?.items)) return body.items;
	if (Array.isArray(body?.results)) return body.results;

	const arrays = Object.entries(body || {}).filter(([, value]) =>
		Array.isArray(value),
	);

	if (arrays.length === 1) return arrays[0][1];

	throw new Error(
		`Could not identify ${label} array in Piano response. Response keys: ${
			Object.keys(body || {}).join(', ') || '(none)'
		}`,
	);
}

async function extractPaged({ endpoint, preferredKeys, label }) {
	const items = [];
	const pageResponses = [];

	let offset = 0;
	let completed = false;
	let requestCount = 0;
	let expectedTotal = null;

	for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
		const body = await apiGet(endpoint, {
			offset,
			limit: PAGE_LIMIT,
		});

		requestCount += 1;

		pageResponses.push({
			offset,
			requested_limit: PAGE_LIMIT,
			response: body,
		});

		const pageItems = extractArray(body, preferredKeys, label);

		const returned = pageItems.length;
		const pageTotal = asFiniteNumber(body?.total ?? body?.data?.total);

		if (pageTotal !== null) {
			if (expectedTotal === null) {
				expectedTotal = pageTotal;
			} else if (pageTotal !== expectedTotal) {
				throw new Error(
					`${label} API total changed during pagination: ${expectedTotal} -> ${pageTotal}`,
				);
			}
		}

		console.log(
			`${label}: offset=${offset}, requested_limit=${PAGE_LIMIT}, returned=${returned}${
				pageTotal !== null ? `, total=${pageTotal}` : ''
			}`,
		);

		items.push(...pageItems);

		if (returned === 0) {
			completed = true;
			break;
		}

		offset += returned;

		if (expectedTotal !== null && offset >= expectedTotal) {
			completed = true;
			break;
		}

		if (returned < PAGE_LIMIT) {
			completed = true;
			break;
		}
	}

	if (!completed) {
		throw new Error(
			`Reached MAX_PAGES=${MAX_PAGES} before ${label} pagination completed`,
		);
	}

	if (expectedTotal !== null && items.length !== expectedTotal) {
		throw new Error(
			`${label} count mismatch: API total=${expectedTotal}, extracted=${items.length}`,
		);
	}

	return {
		items,
		pageResponses,
		requestCount,
		expectedTotal,
	};
}

/* =========================================================
   Transform source objects into relational rows

   Source data is not deduplicated, consolidated, cleaned,
   or reinterpreted. Array order is explicitly retained.
   ========================================================= */

function buildReferenceRows(resources, terms) {
	const resourcesRows = resources.map((resource) => ({
		rid: sqlValue(resource?.rid),
		aid: sqlValue(resource?.aid),
		deleted: sqlValue(resource?.deleted),
		disabled: sqlValue(resource?.disabled),
		create_date: sqlValue(resource?.create_date),
		update_date: sqlValue(resource?.update_date),
		publish_date: sqlValue(resource?.publish_date),
		name: sqlValue(resource?.name),
		description: sqlValue(resource?.description),
		image_url: sqlValue(resource?.image_url),
		type: sqlValue(resource?.type),
		type_label: sqlValue(resource?.type_label),
		purchase_url: sqlValue(resource?.purchase_url),
		resource_url: sqlValue(resource?.resource_url),
		external_id: sqlValue(resource?.external_id),
		is_fbia_resource: sqlValue(resource?.is_fbia_resource),
		resource_json: JSON.stringify(resource),
	}));

	const termsRows = [];
	const billingPlanRows = [];
	const changeOptionRows = [];
	const showOptionRows = [];

	for (const term of terms) {
		termsRows.push({
			aid: sqlValue(term?.aid),
			term_id: sqlValue(term?.term_id),
			rid: sqlValue(term?.resource?.rid),
			name: sqlValue(term?.name),
			description: sqlValue(term?.description),
			type: sqlValue(term?.type),
			type_name: sqlValue(term?.type_name),
			create_date: sqlValue(term?.create_date),
			update_date: sqlValue(term?.update_date),
			shared_account_count: sqlValue(term?.shared_account_count),
			shared_redemption_url: sqlValue(term?.shared_redemption_url),
			collect_address: sqlValue(term?.collect_address),
			registration_access_period: sqlValue(term?.registration_access_period),
			registration_grace_period: sqlValue(term?.registration_grace_period),
			custom_require_user: sqlValue(term?.custom_require_user),
			custom_default_access_period: sqlValue(
				term?.custom_default_access_period,
			),
			term_billing_descriptor: sqlValue(term?.term_billing_descriptor),
			payment_currency: sqlValue(term?.payment_currency),
			currency_symbol: sqlValue(term?.currency_symbol),
			payment_allow_promo_codes: sqlValue(term?.payment_allow_promo_codes),
			payment_billing_plan: sqlValue(term?.payment_billing_plan),
			payment_billing_plan_description: sqlValue(
				term?.payment_billing_plan_description,
			),
			payment_first_price: sqlValue(term?.payment_first_price),
			verify_on_renewal: sqlValue(term?.verify_on_renewal),
			payment_allow_renew_days: sqlValue(term?.payment_allow_renew_days),
			payment_new_customers_only: sqlValue(term?.payment_new_customers_only),
			payment_trial_new_customers_only: sqlValue(
				term?.payment_trial_new_customers_only,
			),
			payment_renew_grace_period: sqlValue(term?.payment_renew_grace_period),
			payment_is_custom_price_available: sqlValue(
				term?.payment_is_custom_price_available,
			),
			payment_is_subscription: sqlValue(term?.payment_is_subscription),
			payment_has_free_trial: sqlValue(term?.payment_has_free_trial),
			payment_force_auto_renew: sqlValue(term?.payment_force_auto_renew),
			payment_allow_gift: sqlValue(term?.payment_allow_gift),
			allow_renewable_gifting: sqlValue(term?.allow_renewable_gifting),
			gift_redemption_url: sqlValue(term?.gift_redemption_url),
			evt_verification_period: sqlValue(term?.evt_verification_period),
			product_category: sqlValue(term?.product_category),
			is_allowed_to_change_schedule_period_in_past: sqlValue(
				term?.is_allowed_to_change_schedule_period_in_past,
			),
			billing_config: sqlValue(term?.billing_config),
			allow_start_in_future: sqlValue(term?.allow_start_in_future),
			maximum_days_in_advance: sqlValue(term?.maximum_days_in_advance),
			term_json: JSON.stringify(term),
		});

		const sourceBillingRows = term?.payment_billing_plan_table || [];

		for (let index = 0; index < sourceBillingRows.length; index += 1) {
			const row = sourceBillingRows[index];

			billingPlanRows.push({
				term_id: sqlValue(term?.term_id),
				term_name: sqlValue(term?.name),
				billing_plan_row_number: index + 1,
				date: sqlValue(row?.date),
				date_value: sqlValue(row?.dateValue),
				period: sqlValue(row?.period),
				short_period: sqlValue(row?.shortPeriod),
				payment_interval_unit: sqlValue(row?.paymentIntervalUnit),
				billing_without_tax: sqlValue(row?.billingWithoutTax),
				billing_period: sqlValue(row?.billingPeriod),
				price_charged_str: sqlValue(row?.priceChargedStr),
				price_value: sqlValue(row?.priceValue),
				cycles: sqlValue(row?.cycles),
				is_free_trial: sqlValue(row?.isFreeTrial),
				is_trial: sqlValue(row?.isTrial),
				is_pay_what_you_want: sqlValue(row?.isPayWhatYouWant),
				billing: sqlValue(row?.billing),
				duration: sqlValue(row?.duration),
				billing_info: sqlValue(row?.billingInfo),
				price_and_tax_in_minor_unit: sqlValue(row?.priceAndTaxInMinorUnit),
				is_free: sqlValue(row?.isFree),
				price: sqlValue(row?.price),
				price_and_tax: sqlValue(row?.priceAndTax),
				currency: sqlValue(row?.currency),
				total_billing: sqlValue(row?.totalBilling),
				billing_plan_row_json: JSON.stringify(row),
			});
		}

		const sourceChangeOptions = term?.change_options || [];

		for (let index = 0; index < sourceChangeOptions.length; index += 1) {
			const option = sourceChangeOptions[index];

			/*
			 * upgrade_offers is currently empty throughout this source.
			 * Fail rather than silently discard relational data if that changes.
			 */
			if (
				Array.isArray(option?.upgrade_offers) &&
				option.upgrade_offers.length > 0
			) {
				throw new Error(
					`Term ${term?.term_id ?? '(missing)'} change option ${option?.term_change_option_id ?? '(missing)'} contains non-empty upgrade_offers. This structure is not yet relationalized.`,
				);
			}

			changeOptionRows.push({
				term_id: sqlValue(term?.term_id),
				term_name: sqlValue(term?.name),
				change_option_number: index + 1,
				term_change_option_id: sqlValue(option?.term_change_option_id),
				from_term_id: sqlValue(option?.from_term_id),
				from_term_name: sqlValue(option?.from_term_name),
				from_period_id: sqlValue(option?.from_period_id),
				from_period_name: sqlValue(option?.from_period_name),
				from_resource_id: sqlValue(option?.from_resource_id),
				from_resource_name: sqlValue(option?.from_resource_name),
				from_billing_plan: sqlValue(option?.from_billing_plan),
				to_term_id: sqlValue(option?.to_term_id),
				to_term_name: sqlValue(option?.to_term_name),
				to_period_id: sqlValue(option?.to_period_id),
				to_period_name: sqlValue(option?.to_period_name),
				to_resource_id: sqlValue(option?.to_resource_id),
				to_resource_name: sqlValue(option?.to_resource_name),
				to_billing_plan: sqlValue(option?.to_billing_plan),
				billing_timing: sqlValue(option?.billing_timing),
				immediate_access: sqlValue(option?.immediate_access),
				prorate_access: sqlValue(option?.prorate_access),
				description: sqlValue(option?.description),
				include_trial: sqlValue(option?.include_trial),
				to_scheduled: sqlValue(option?.to_scheduled),
				from_scheduled: sqlValue(option?.from_scheduled),
				shared_account_count: sqlValue(option?.shared_account_count),
				collect_address: sqlValue(option?.collect_address),
				upgrade_offers_json: jsonValue(option?.upgrade_offers),
				change_option_json: JSON.stringify(option),
			});

			const showOptions = option?.advanced_options?.show_options || [];

			for (let showIndex = 0; showIndex < showOptions.length; showIndex += 1) {
				showOptionRows.push({
					term_id: sqlValue(term?.term_id),
					term_change_option_id: sqlValue(option?.term_change_option_id),
					show_option_number: showIndex + 1,
					show_option: sqlValue(showOptions[showIndex]),
				});
			}
		}
	}

	return {
		resources: resourcesRows,
		terms: termsRows,
		term_billing_plan_rows: billingPlanRows,
		term_change_options: changeOptionRows,
		term_change_option_show_options: showOptionRows,
	};
}

/* =========================================================
   Source validation
   ========================================================= */

function validateSource(resources, terms, rowsByTable) {
	const errors = [];

	const resourceIds = resources
		.map((resource) => resource?.rid)
		.filter((value) => value !== null && value !== undefined && value !== '');

	const termIds = terms
		.map((term) => term?.term_id)
		.filter((value) => value !== null && value !== undefined && value !== '');

	if (resourceIds.length !== resources.length) {
		errors.push(
			`${resources.length - resourceIds.length} resource record(s) are missing rid`,
		);
	}

	if (termIds.length !== terms.length) {
		errors.push(
			`${terms.length - termIds.length} term record(s) are missing term_id`,
		);
	}

	const duplicateResourceIds = duplicateValues(resourceIds);
	const duplicateTermIds = duplicateValues(termIds);

	if (duplicateResourceIds.length > 0) {
		errors.push(
			`Duplicate rid value(s): ${duplicateResourceIds.map((item) => `${item.value} (${item.count})`).join(', ')}`,
		);
	}

	if (duplicateTermIds.length > 0) {
		errors.push(
			`Duplicate term_id value(s): ${duplicateTermIds.map((item) => `${item.value} (${item.count})`).join(', ')}`,
		);
	}

	const resourceIdSet = new Set(resourceIds);
	const termIdSet = new Set(termIds);

	const missingResourceReferences = terms
		.filter((term) => !resourceIdSet.has(term?.resource?.rid))
		.map((term) => ({
			term_id: term?.term_id ?? null,
			rid: term?.resource?.rid ?? null,
		}));

	if (missingResourceReferences.length > 0) {
		errors.push(
			`${missingResourceReferences.length} term(s) reference a rid not present in the Resource extract`,
		);
	}

	const changeOptionRows = rowsByTable.term_change_options;
	const showOptionRows = rowsByTable.term_change_option_show_options;

	const changeOptionIds = changeOptionRows
		.map((row) => row.term_change_option_id)
		.filter((value) => value !== null && value !== undefined && value !== '');

	const duplicateChangeOptionIds = duplicateValues(changeOptionIds);

	if (duplicateChangeOptionIds.length > 0) {
		errors.push(
			`Duplicate term_change_option_id value(s): ${duplicateChangeOptionIds.map((item) => `${item.value} (${item.count})`).join(', ')}`,
		);
	}

	for (const row of rowsByTable.term_billing_plan_rows) {
		if (!termIdSet.has(row.term_id)) {
			errors.push(`Billing-plan row references missing term_id=${row.term_id}`);
			break;
		}
	}

	for (const row of changeOptionRows) {
		if (!termIdSet.has(row.term_id)) {
			errors.push(
				`Change-option row references missing parent term_id=${row.term_id}`,
			);
			break;
		}

		if (row.from_term_id && !termIdSet.has(row.from_term_id)) {
			errors.push(
				`Change option ${row.term_change_option_id} references missing from_term_id=${row.from_term_id}`,
			);
			break;
		}

		if (row.to_term_id && !termIdSet.has(row.to_term_id)) {
			errors.push(
				`Change option ${row.term_change_option_id} references missing to_term_id=${row.to_term_id}`,
			);
			break;
		}
	}

	const changeOptionIdSet = new Set(changeOptionIds);

	for (const row of showOptionRows) {
		if (!changeOptionIdSet.has(row.term_change_option_id)) {
			errors.push(
				`Show-option row references missing term_change_option_id=${row.term_change_option_id}`,
			);
			break;
		}
	}

	if (errors.length > 0) {
		throw new Error(
			`Reference-data validation failed:\n- ${errors.join('\n- ')}`,
		);
	}

	return {
		duplicate_resource_ids: duplicateResourceIds,
		duplicate_term_ids: duplicateTermIds,
		duplicate_term_change_option_ids: duplicateChangeOptionIds,
		missing_resource_references: missingResourceReferences,
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
			encrypt: false,
			trustServerCertificate: true,
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
			'Piano Resources + Terms reference-data extraction',
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
   Generic SQL table helpers
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
	/*
	 * Reverse order keeps child tables ahead of parent tables and
	 * matches the established snapshot convention.
	 */
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

async function insertRows(transaction, extractRunId, tableName, rows) {
	const spec = TABLE_SPEC_BY_NAME.get(tableName);

	if (!spec) {
		throw new Error(`No SQL table specification for ${tableName}`);
	}

	const dataColumns = Object.keys(spec.columns);
	const insertColumns = ['extract_run_id', ...dataColumns];

	const insertSql = `
		insert into dbo.${quoteSqlIdentifier(tableName)} (
			${insertColumns.map(quoteSqlIdentifier).join(',\n\t\t\t')}
		)
		values (
			${insertColumns.map((name) => `@${name}`).join(',\n\t\t\t')}
		);
	`;

	for (const row of rows) {
		const request = new sql.Request(transaction).input(
			'extract_run_id',
			sql.BigInt,
			extractRunId,
		);

		for (const column of dataColumns) {
			request.input(column, spec.columns[column], sqlValue(row[column]));
		}

		await request.query(insertSql);
	}
}

async function loadCurrentTables(transaction, extractRunId, rowsByTable) {
	for (const spec of TABLE_SPECS) {
		const rows = rowsByTable[spec.name];

		console.log(`Loading ${spec.name}: ${rows.length} row(s)...`);

		await insertRows(transaction, extractRunId, spec.name, rows);
	}
}

/* =========================================================
   SQL validation
   ========================================================= */

async function validateSqlLoad(transaction, expectedCounts) {
	const actualCounts = await getCounts(transaction, false);

	for (const spec of TABLE_SPECS) {
		if (actualCounts[spec.name] !== expectedCounts[spec.name]) {
			throw new Error(
				`SQL count mismatch for ${spec.name}: expected=${expectedCounts[spec.name]}, actual=${actualCounts[spec.name]}`,
			);
		}
	}

	const result = await new sql.Request(transaction).query(`
		select
			(
				select count_big(*)
				from dbo.terms t
				left join dbo.resources r
					on r.rid = t.rid
				where t.rid is not null
					and r.row_id is null
			) as missing_term_resource_count,

			(
				select count_big(*)
				from dbo.term_billing_plan_rows b
				left join dbo.terms t
					on t.term_id = b.term_id
				where t.row_id is null
			) as missing_billing_term_count,

			(
				select count_big(*)
				from dbo.term_change_options c
				left join dbo.terms t
					on t.term_id = c.term_id
				where t.row_id is null
			) as missing_change_parent_term_count,

			(
				select count_big(*)
				from dbo.term_change_option_show_options s
				left join dbo.term_change_options c
					on c.term_change_option_id = s.term_change_option_id
				where c.row_id is null
			) as missing_show_option_parent_count;
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
			throw new Error(`SQL relationship validation failed: ${name}=${value}`);
		}
	}

	return {
		counts: actualCounts,
		relationships: relationshipCounts,
	};
}

/* =========================================================
   Main
   ========================================================= */

async function main() {
	const startedAt = new Date();
	const runDir = path.resolve(
		EXTRACT_ROOT,
		`run-reference-data-${timestampForPath(startedAt)}`,
	);

	await fs.mkdir(runDir, { recursive: true });

	let pool;
	let extractRunId = null;
	let transaction = null;
	let transactionStarted = false;

	try {
		pool = await sql.connect(sqlConfig());
		extractRunId = await createExtractRun(pool);

		console.log(`SQL extract_run_id=${extractRunId}`);
		console.log('Retrieving all Piano resources...');

		const resourceExtract = await extractPaged({
			endpoint: RESOURCE_ENDPOINT,
			preferredKeys: ['resources'],
			label: 'resources',
		});

		console.log('\nRetrieving all Piano terms...');

		const termExtract = await extractPaged({
			endpoint: TERM_ENDPOINT,
			preferredKeys: ['terms'],
			label: 'terms',
		});

		const resources = resourceExtract.items;
		const terms = termExtract.items;

		const rowsByTable = buildReferenceRows(resources, terms);

		const sourceValidation = validateSource(resources, terms, rowsByTable);

		const expectedCounts = Object.fromEntries(
			TABLE_SPECS.map((spec) => [spec.name, rowsByTable[spec.name].length]),
		);

		/*
		 * Save complete API source data before modifying SQL.
		 * If SQL loading fails, the API output remains available.
		 */
		await Promise.all([
			fs.writeFile(
				path.join(runDir, 'all-resources.json'),
				JSON.stringify(resources, null, 2),
			),
			fs.writeFile(
				path.join(runDir, 'all-terms.json'),
				JSON.stringify(terms, null, 2),
			),
			fs.writeFile(
				path.join(runDir, 'resource-api-pages.json'),
				JSON.stringify(resourceExtract.pageResponses, null, 2),
			),
			fs.writeFile(
				path.join(runDir, 'term-api-pages.json'),
				JSON.stringify(termExtract.pageResponses, null, 2),
			),
		]);

		transaction = new sql.Transaction(pool);
		await transaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
		transactionStarted = true;

		console.log('\nCreating previous reference snapshot...');
		const previousSourceCounts = await copyCurrentToPrevious(transaction);

		console.log('Truncating current reference tables...');
		await truncateTables(transaction, false);

		console.log('Loading new reference snapshot...');
		await loadCurrentTables(transaction, extractRunId, rowsByTable);

		console.log('Validating SQL reference snapshot...');
		const sqlValidation = await validateSqlLoad(transaction, expectedCounts);

		await transaction.commit();
		transactionStarted = false;

		const completedAt = new Date();

		const summary = {
			extract_name: RUN_NAME,
			extract_run_id: extractRunId,
			started_at_utc: startedAt.toISOString(),
			completed_at_utc: completedAt.toISOString(),
			piano_api_base_url: API_BASE_URL,
			aid: AID,
			page_limit: PAGE_LIMIT,
			api_request_count:
				resourceExtract.requestCount + termExtract.requestCount,
			resource_api_total: resourceExtract.expectedTotal,
			term_api_total: termExtract.expectedTotal,
			counts: expectedCounts,
			previous_snapshot_source_counts: previousSourceCounts,
			term_counts_by_type: countBy(terms, (term) => term?.type),
			resource_counts_by_type: countBy(resources, (resource) => resource?.type),
			source_validation: sourceValidation,
			sql_validation: sqlValidation,
			complete: true,
		};

		const manifest = {
			extract_name: RUN_NAME,
			extract_run_id: extractRunId,
			generated_at_utc: completedAt.toISOString(),
			files: [
				'all-resources.json',
				'all-terms.json',
				'resource-api-pages.json',
				'term-api-pages.json',
				'summary.json',
				'manifest.json',
			],
			counts: expectedCounts,
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

		await markExtractRunComplete(
			pool,
			extractRunId,
			JSON.stringify({
				counts: expectedCounts,
				output: runDir,
			}),
		);

		console.log('\nReference-data extraction complete.');
		console.log(JSON.stringify(summary, null, 2));
		console.log(`Output: ${runDir}`);
	} catch (error) {
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
			failed_at_utc: new Date().toISOString(),
			error: error?.message || String(error),
			stack: error?.stack || null,
			body: error?.body || null,
		};

		try {
			await fs.writeFile(
				path.join(runDir, 'errors.json'),
				JSON.stringify(failure, null, 2),
			);
		} catch {
			/* Do not mask the original failure. */
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

		console.error('\nFatal reference-data extraction error:');
		console.error(error?.stack || error);

		if (error?.body) {
			console.error(JSON.stringify(error.body, null, 2));
		}

		process.exitCode = 1;
	} finally {
		if (pool) {
			await pool.close();
		}
	}
}

await main();

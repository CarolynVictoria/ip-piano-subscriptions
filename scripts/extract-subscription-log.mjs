import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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
 *   - performs no SQL loading
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
		column_count: headers.length,

		headers,

		data_row_count: dataRowCount,

		subscription_id_column_present: subscriptionIdIndex >= 0,

		unique_subscription_id_count: subscriptionIds.size,

		missing_subscription_id_count: missingSubscriptionIdCount,

		duplicate_subscription_id_count: duplicateSubscriptionIdCount,

		rows_with_column_count_mismatch: mismatchedRowCount,

		control_header_presence: controlHeaderPresence,
	};
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

		const inspection = inspectCsv(download.buffer);

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

		console.log('\nSubscription Log export complete.');

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

		console.error('\nSubscription Log export failed.');

		console.error(error);

		console.error(`Output: ${runDir}`);

		process.exitCode = 1;
	}
}

await main();

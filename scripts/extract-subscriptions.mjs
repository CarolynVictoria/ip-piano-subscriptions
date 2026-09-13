import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

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

   No SQL loading is performed by this script.
   ========================================================= */

/* =========================================================
   Configuration
   ========================================================= */

const API_BASE_URL = (
	process.env.PIANO_API_BASE_URL || 'https://api.piano.io/api/v3'
).replace(/\/$/, '');

const AID = process.env.PIANO_AID;
const API_TOKEN = process.env.PIANO_API_TOKEN;

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

const ENDPOINT = '/publisher/subscription/list';

const RUN_NAME = 'piano-subscriptions';

/* =========================================================
   Configuration validation
   ========================================================= */

if (!AID || !API_TOKEN) {
	throw new Error('Missing PIANO_AID or PIANO_API_TOKEN in environment.');
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

	try {
		console.log('Piano subscription extraction');

		console.log(`Endpoint: ${ENDPOINT}`);

		console.log(`Page limit: ${PAGE_LIMIT}`);

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

		const completedAt = new Date();

		const summary = {
			extract_name: RUN_NAME,

			endpoint: ENDPOINT,

			started_at_utc: startedAt.toISOString(),

			completed_at_utc: completedAt.toISOString(),

			piano_api_base_url: API_BASE_URL,

			aid: AID,

			page_limit: PAGE_LIMIT,

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

			complete: true,
		};

		const manifest = {
			extract_name: RUN_NAME,

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

		const failure = {
			extract_name: RUN_NAME,

			endpoint: ENDPOINT,

			failed_at_utc: new Date().toISOString(),

			piano_api_base_url: API_BASE_URL,

			aid: AID,

			page_limit: PAGE_LIMIT,

			api_request_count: requestCount,

			page_count: pageCount,

			initial_api_total: initialTotal,

			final_api_total: finalTotal,

			extracted_subscription_count: extractedCount,

			unique_subscription_id_count: seenIds.size,

			duplicate_subscription_id_count: duplicateIds.size,

			missing_subscription_id_count: missingIdCount,

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

		console.error('\nFatal subscription extraction error:');

		console.error(error?.stack || error);

		if (error?.body) {
			console.error(JSON.stringify(error.body, null, 2));
		}

		console.error(`Incomplete run output: ${runDir}`);

		process.exitCode = 1;
	}
}

await main();

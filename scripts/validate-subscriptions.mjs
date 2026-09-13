import fs from 'node:fs/promises';
import path from 'node:path';

const SUBSCRIPTION_LOG_CSV =
	'/Users/carolyn/Projects/ip-piano-subscriptions/extracts/piano-subscription-log-raw-2026-09-13T12-12-35-008Z/subscription-log.csv';

const SUBSCRIPTION_RUN_DIR =
	'/Users/carolyn/Projects/ip-piano-subscriptions/extracts/run-subscriptions-2026-09-13T12-58-44-141Z';

const SUBSCRIPTION_IDS_JSON = path.join(
	SUBSCRIPTION_RUN_DIR,
	'subscription-ids.json',
);

const OUTPUT_DIR = path.join(
	SUBSCRIPTION_RUN_DIR,
	'validation-subscription-log',
);

const SUBSCRIPTION_LOG_ID_HEADER = 'Subscription ID';

function parseCsv(text) {
	const rows = [];

	let row = [];
	let field = '';
	let inQuotes = false;

	if (text.charCodeAt(0) === 0xfeff) {
		text = text.slice(1);
	}

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

		if (char === '"' && field.length === 0) {
			inQuotes = true;
			continue;
		}

		if (char === ',') {
			row.push(field);
			field = '';
			continue;
		}

		if (char === '\n') {
			row.push(field);
			rows.push(row);

			row = [];
			field = '';

			continue;
		}

		if (char === '\r') {
			if (text[i + 1] === '\n') {
				continue;
			}

			row.push(field);
			rows.push(row);

			row = [];
			field = '';

			continue;
		}

		field += char;
	}

	if (inQuotes) {
		throw new Error('CSV ended while still inside a quoted field.');
	}

	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows;
}

function normalizeHeader(value) {
	return String(value ?? '')
		.replace(/^\uFEFF/, '')
		.trim();
}

function normalizeId(value) {
	return String(value ?? '').trim();
}

function countValues(values) {
	const counts = new Map();

	for (const value of values) {
		counts.set(value, (counts.get(value) || 0) + 1);
	}

	return counts;
}

function duplicateEntries(counts) {
	return [...counts.entries()]
		.filter(([, count]) => count > 1)
		.map(([subscription_id, count]) => ({
			subscription_id,
			count,
		}))
		.sort((a, b) => a.subscription_id.localeCompare(b.subscription_id));
}

function sortedSetDifference(leftSet, rightSet) {
	return [...leftSet].filter((value) => !rightSet.has(value)).sort();
}

async function writeLines(filePath, values) {
	const text = values.length > 0 ? `${values.join('\n')}\n` : '';

	await fs.writeFile(filePath, text, 'utf8');
}

async function main() {
	console.log('Subscription reconciliation validation');

	console.log('');

	console.log(`Subscription Log CSV: ${SUBSCRIPTION_LOG_CSV}`);

	console.log(`Subscription run:     ${SUBSCRIPTION_RUN_DIR}`);

	console.log('');

	const [subscriptionIdsText, subscriptionLogText] = await Promise.all([
		fs.readFile(SUBSCRIPTION_IDS_JSON, 'utf8'),

		fs.readFile(SUBSCRIPTION_LOG_CSV, 'utf8'),
	]);

	/* =======================================================
     Subscription List IDs
     ======================================================= */

	const subscriptionListIdsRaw = JSON.parse(subscriptionIdsText);

	if (!Array.isArray(subscriptionListIdsRaw)) {
		throw new Error('subscription-ids.json must contain a JSON array.');
	}

	const subscriptionListIds = subscriptionListIdsRaw.map(normalizeId);

	const blankSubscriptionListIds = subscriptionListIds.filter(
		(value) => value.length === 0,
	);

	const subscriptionListNonblankIds = subscriptionListIds.filter(
		(value) => value.length > 0,
	);

	const subscriptionListCounts = countValues(subscriptionListNonblankIds);

	const subscriptionListDuplicates = duplicateEntries(subscriptionListCounts);

	const subscriptionListSet = new Set(subscriptionListNonblankIds);

	/* =======================================================
     Subscription Log CSV
     ======================================================= */

	const csvRows = parseCsv(subscriptionLogText);

	if (csvRows.length === 0) {
		throw new Error('Subscription Log CSV is empty.');
	}

	const headers = csvRows[0].map(normalizeHeader);

	const subscriptionIdColumnIndex = headers.indexOf(SUBSCRIPTION_LOG_ID_HEADER);

	if (subscriptionIdColumnIndex === -1) {
		throw new Error(
			`Could not find CSV column "${SUBSCRIPTION_LOG_ID_HEADER}". ` +
				`Headers found: ${headers.join(' | ')}`,
		);
	}

	/*
	 * Ignore completely empty trailing rows,
	 * but otherwise preserve every CSV data row.
	 */
	const dataRows = csvRows
		.slice(1)
		.filter((row) => row.some((value) => String(value ?? '').length > 0));

	const subscriptionLogIds = dataRows.map((row) =>
		normalizeId(row[subscriptionIdColumnIndex]),
	);

	const blankSubscriptionLogIds = subscriptionLogIds.filter(
		(value) => value.length === 0,
	);

	const subscriptionLogNonblankIds = subscriptionLogIds.filter(
		(value) => value.length > 0,
	);

	const subscriptionLogCounts = countValues(subscriptionLogNonblankIds);

	const subscriptionLogDuplicates = duplicateEntries(subscriptionLogCounts);

	const subscriptionLogSet = new Set(subscriptionLogNonblankIds);

	/* =======================================================
     Reconciliation
     ======================================================= */

	const onlyInSubscriptionList = sortedSetDifference(
		subscriptionListSet,
		subscriptionLogSet,
	);

	const onlyInSubscriptionLog = sortedSetDifference(
		subscriptionLogSet,
		subscriptionListSet,
	);

	const intersectionCount = [...subscriptionListSet].filter((value) =>
		subscriptionLogSet.has(value),
	).length;

	const idSetsIdentical =
		onlyInSubscriptionList.length === 0 && onlyInSubscriptionLog.length === 0;

	/* =======================================================
     Summary
     ======================================================= */

	const summary = {
		subscription_list_source: SUBSCRIPTION_IDS_JSON,

		subscription_log_source: SUBSCRIPTION_LOG_CSV,

		subscription_log_id_column: SUBSCRIPTION_LOG_ID_HEADER,

		subscription_list_array_count: subscriptionListIds.length,

		subscription_list_nonblank_id_count: subscriptionListNonblankIds.length,

		subscription_list_unique_id_count: subscriptionListSet.size,

		subscription_list_duplicate_id_count: subscriptionListDuplicates.length,

		subscription_list_blank_id_count: blankSubscriptionListIds.length,

		subscription_log_data_row_count: dataRows.length,

		subscription_log_nonblank_id_count: subscriptionLogNonblankIds.length,

		subscription_log_unique_id_count: subscriptionLogSet.size,

		subscription_log_duplicate_id_count: subscriptionLogDuplicates.length,

		subscription_log_blank_id_count: blankSubscriptionLogIds.length,

		intersection_unique_id_count: intersectionCount,

		only_in_subscription_list_count: onlyInSubscriptionList.length,

		only_in_subscription_log_count: onlyInSubscriptionLog.length,

		unique_count_difference: subscriptionListSet.size - subscriptionLogSet.size,

		id_sets_identical: idSetsIdentical,
	};

	/* =======================================================
     Output
     ======================================================= */

	await fs.mkdir(OUTPUT_DIR, {
		recursive: true,
	});

	await Promise.all([
		fs.writeFile(
			path.join(OUTPUT_DIR, 'summary.json'),
			`${JSON.stringify(summary, null, 2)}\n`,
			'utf8',
		),

		writeLines(
			path.join(OUTPUT_DIR, 'only-in-subscription-list.txt'),
			onlyInSubscriptionList,
		),

		writeLines(
			path.join(OUTPUT_DIR, 'only-in-subscription-log.txt'),
			onlyInSubscriptionLog,
		),

		fs.writeFile(
			path.join(OUTPUT_DIR, 'subscription-list-duplicates.json'),
			`${JSON.stringify(subscriptionListDuplicates, null, 2)}\n`,
			'utf8',
		),

		fs.writeFile(
			path.join(OUTPUT_DIR, 'subscription-log-duplicates.json'),
			`${JSON.stringify(subscriptionLogDuplicates, null, 2)}\n`,
			'utf8',
		),
	]);

	/* =======================================================
     Console report
     ======================================================= */

	console.log(JSON.stringify(summary, null, 2));

	if (onlyInSubscriptionList.length > 0) {
		console.log('');
		console.log('Only in /publisher/subscription/list:');

		for (const id of onlyInSubscriptionList.slice(0, 25)) {
			console.log(`  ${id}`);
		}

		if (onlyInSubscriptionList.length > 25) {
			console.log(`  ... plus ${onlyInSubscriptionList.length - 25} more`);
		}
	}

	if (onlyInSubscriptionLog.length > 0) {
		console.log('');
		console.log('Only in Subscription Log:');

		for (const id of onlyInSubscriptionLog.slice(0, 25)) {
			console.log(`  ${id}`);
		}

		if (onlyInSubscriptionLog.length > 25) {
			console.log(`  ... plus ${onlyInSubscriptionLog.length - 25} more`);
		}
	}

	console.log('');

	console.log(`Validation output: ${OUTPUT_DIR}`);
}

await main();

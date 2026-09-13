import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE_URL = (
	process.env.PIANO_API_BASE_URL || 'https://api.piano.io/api/v3'
).replace(/\/$/, '');

const AID = process.env.PIANO_AID;
const API_TOKEN = process.env.PIANO_API_TOKEN;

const PROBE_LIMIT = 50;

if (!AID || !API_TOKEN) {
	throw new Error('Missing PIANO_AID or PIANO_API_TOKEN in environment.');
}

function timestampForPath() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

function paddedOffset(offset) {
	return String(offset).padStart(6, '0');
}

async function pianoRequest(endpoint, params = {}) {
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

	const response = await fetch(url, {
		method: 'GET',
		headers: {
			Accept: 'application/json',
		},
	});

	const text = await response.text();

	let body;

	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(
			`Non-JSON response from ${endpoint}: ${text.slice(0, 500)}`,
		);
	}

	/*
	 * Piano normally returns HTTP 200 even for API-level errors,
	 * so the JSON code must be checked separately.
	 */
	if (body.code !== undefined && Number(body.code) !== 0) {
		throw new Error(
			`Piano API error from ${endpoint}: ` + JSON.stringify(body, null, 2),
		);
	}

	if (!response.ok) {
		throw new Error(
			`HTTP ${response.status} from ${endpoint}: ` +
				JSON.stringify(body, null, 2),
		);
	}

	return body;
}

function validateSubscriptionPage(body, expectedOffset) {
	if (!body || typeof body !== 'object') {
		throw new Error(
			`Invalid response at offset ${expectedOffset}: body is not an object.`,
		);
	}

	if (!Array.isArray(body.subscriptions)) {
		throw new Error(
			`Invalid response at offset ${expectedOffset}: ` +
				'subscriptions is not an array.',
		);
	}

	const total = Number(body.total);
	const count = Number(body.count);
	const offset = Number(body.offset);
	const limit = Number(body.limit);

	if (!Number.isInteger(total) || total < 0) {
		throw new Error(`Invalid total at offset ${expectedOffset}: ${body.total}`);
	}

	if (!Number.isInteger(count) || count < 0) {
		throw new Error(`Invalid count at offset ${expectedOffset}: ${body.count}`);
	}

	if (!Number.isInteger(offset) || offset < 0) {
		throw new Error(
			`Invalid response offset at expected offset ${expectedOffset}: ` +
				`${body.offset}`,
		);
	}

	if (offset !== expectedOffset) {
		throw new Error(
			`Offset mismatch: requested ${expectedOffset}, received ${offset}.`,
		);
	}

	if (!Number.isInteger(limit) || limit <= 0) {
		throw new Error(`Invalid limit at offset ${expectedOffset}: ${body.limit}`);
	}

	if (count !== body.subscriptions.length) {
		throw new Error(
			`Count mismatch at offset ${expectedOffset}: ` +
				`count=${count}, subscriptions.length=${body.subscriptions.length}`,
		);
	}

	return {
		total,
		count,
		offset,
		limit,
	};
}

function subscriptionIds(body) {
	return body.subscriptions
		.map((subscription) => subscription?.subscription_id)
		.filter(
			(subscriptionId) =>
				typeof subscriptionId === 'string' && subscriptionId.length > 0,
		);
}

function collectObjectKeys(objects) {
	const keys = new Set();

	for (const object of objects) {
		if (object && typeof object === 'object' && !Array.isArray(object)) {
			for (const key of Object.keys(object)) {
				keys.add(key);
			}
		}
	}

	return [...keys].sort();
}

async function main() {
	const endpoint = '/publisher/subscription/list';

	const outputDir = path.resolve(
		'samples',
		`probe-subscriptions-${timestampForPath()}`,
	);

	await fs.mkdir(outputDir, {
		recursive: true,
	});

	console.log('Piano subscription list probe');
	console.log(`Endpoint: ${endpoint}`);
	console.log(`Probe limit: ${PROBE_LIMIT}`);
	console.log('');

	/*
	 * First page establishes the reported total and response shape.
	 */
	console.log('Retrieving first page...');

	const firstPage = await pianoRequest(endpoint, {
		offset: 0,
		limit: PROBE_LIMIT,
	});

	const firstPageInfo = validateSubscriptionPage(firstPage, 0);

	console.log(`Reported total: ${firstPageInfo.total}`);
	console.log(`First-page count: ${firstPageInfo.count}`);

	/*
	 * Probe three pagination positions:
	 *
	 *   1. First page
	 *   2. Second page
	 *   3. Final page
	 *
	 * Duplicate offsets are removed automatically for small datasets.
	 */
	const offsets = new Set([0]);

	if (firstPageInfo.total > PROBE_LIMIT) {
		offsets.add(PROBE_LIMIT);
	}

	if (firstPageInfo.total > 0) {
		const lastOffset =
			Math.floor((firstPageInfo.total - 1) / PROBE_LIMIT) * PROBE_LIMIT;

		offsets.add(lastOffset);
	}

	const pages = new Map();
	pages.set(0, firstPage);

	for (const offset of [...offsets].sort((a, b) => a - b)) {
		let body;

		if (offset === 0) {
			body = firstPage;
		} else {
			console.log(`Retrieving page at offset ${offset}...`);

			body = await pianoRequest(endpoint, {
				offset,
				limit: PROBE_LIMIT,
			});

			validateSubscriptionPage(body, offset);
			pages.set(offset, body);
		}

		const outputPath = path.join(
			outputDir,
			`subscriptions-offset-${paddedOffset(offset)}.json`,
		);

		await fs.writeFile(outputPath, JSON.stringify(body, null, 2), 'utf8');

		console.log(`Saved ${outputPath}`);
	}

	/*
	 * Verify that the reported total remains stable across the
	 * pagination probe.
	 */
	const totals = new Set();

	for (const [offset, body] of pages) {
		const info = validateSubscriptionPage(body, offset);
		totals.add(info.total);
	}

	if (totals.size !== 1) {
		throw new Error(
			'The API total changed during the pagination probe: ' +
				JSON.stringify([...totals]),
		);
	}

	/*
	 * Check subscription IDs across the probed pages.
	 */
	const seenIds = new Set();
	const duplicateIds = new Set();

	for (const body of pages.values()) {
		for (const subscriptionId of subscriptionIds(body)) {
			if (seenIds.has(subscriptionId)) {
				duplicateIds.add(subscriptionId);
			}

			seenIds.add(subscriptionId);
		}
	}

	/*
	 * Build a structural summary. This does not modify any source
	 * response; all raw API responses have already been written
	 * separately above.
	 */
	const allSubscriptions = [...pages.values()].flatMap(
		(body) => body.subscriptions,
	);

	const summary = {
		endpoint,
		probe_limit: PROBE_LIMIT,
		generated_at: new Date().toISOString(),

		reported_total: firstPageInfo.total,

		top_level_keys: Object.keys(firstPage).sort(),

		subscription_keys_seen: collectObjectKeys(allSubscriptions),

		term_keys_seen: collectObjectKeys(
			allSubscriptions.map((subscription) => subscription?.term),
		),

		user_keys_seen: collectObjectKeys(
			allSubscriptions.map((subscription) => subscription?.user),
		),

		resource_keys_seen: collectObjectKeys(
			allSubscriptions.map((subscription) => subscription?.resource),
		),

		pages: [...pages.entries()]
			.sort(([a], [b]) => a - b)
			.map(([offset, body]) => {
				const ids = subscriptionIds(body);

				return {
					offset,
					limit: Number(body.limit),
					count: Number(body.count),
					subscriptions_length: body.subscriptions.length,
					total: Number(body.total),
					first_subscription_id: ids[0] ?? null,
					last_subscription_id: ids.at(-1) ?? null,
				};
			}),

		duplicate_subscription_ids_across_probe_pages: [...duplicateIds].sort(),
	};

	const summaryPath = path.join(outputDir, 'summary.json');

	await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

	console.log('');
	console.log('Probe complete.');
	console.log(`Output: ${outputDir}`);
	console.log(`Reported total: ${summary.reported_total}`);
	console.log(`Pages probed: ${summary.pages.length}`);
	console.log(
		'Duplicate subscription IDs across probed pages: ' +
			summary.duplicate_subscription_ids_across_probe_pages.length,
	);
	console.log(`Summary: ${summaryPath}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

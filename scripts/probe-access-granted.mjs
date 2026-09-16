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

async function pianoPost(endpoint, params = {}) {
	const url = new URL(`${API_BASE_URL}${endpoint}`);

	const body = new URLSearchParams();

	body.set('aid', AID);
	body.set('api_token', API_TOKEN);

	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null) {
			body.set(key, String(value));
		}
	}

	const response = await fetch(url, {
		method: 'POST',

		headers: {
			Accept: 'application/json',
			'Content-Type': 'application/x-www-form-urlencoded',
		},

		body,
	});

	const text = await response.text();

	let responseBody;

	try {
		responseBody = JSON.parse(text);
	} catch {
		throw new Error(
			`Non-JSON response from ${endpoint}: ${text.slice(0, 500)}`,
		);
	}

	/*
	 * Piano normally returns HTTP 200 even for API-level errors,
	 * so the JSON code must be checked separately.
	 */
	if (responseBody.code !== undefined && Number(responseBody.code) !== 0) {
		throw new Error(
			`Piano API error from ${endpoint}: ` +
				JSON.stringify(responseBody, null, 2),
		);
	}

	if (!response.ok) {
		throw new Error(
			`HTTP ${response.status} from ${endpoint}: ` +
				JSON.stringify(responseBody, null, 2),
		);
	}

	return responseBody;
}

function validateUserPage(body, expectedOffset) {
	if (!body || typeof body !== 'object') {
		throw new Error(
			`Invalid response at offset ${expectedOffset}: body is not an object.`,
		);
	}

	if (!Array.isArray(body.users)) {
		throw new Error(
			`Invalid response at offset ${expectedOffset}: users is not an array.`,
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

	if (count !== body.users.length) {
		throw new Error(
			`Count mismatch at offset ${expectedOffset}: ` +
				`count=${count}, users.length=${body.users.length}`,
		);
	}

	return {
		total,
		count,
		offset,
		limit,
	};
}

function userUids(body) {
	return body.users
		.map((user) => user?.uid)
		.filter((uid) => typeof uid === 'string' && uid.length > 0);
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
	const endpoint = '/publisher/user/search';

	const outputDir = path.resolve(
		'samples',
		`probe-access-granted-${timestampForPath()}`,
	);

	await fs.mkdir(outputDir, {
		recursive: true,
	});

	console.log('Piano Access Granted user probe');
	console.log(`Endpoint: ${endpoint}`);
	console.log('Filter: converted_term_types=7');
	console.log('Filter: has_access=true');
	console.log(`Probe limit: ${PROBE_LIMIT}`);
	console.log('');

	/*
	 * First page establishes the reported total and response shape.
	 */
	console.log('Retrieving first page...');

	const firstPage = await pianoPost(endpoint, {
		converted_term_types: 7,
		has_access: true,
		offset: 0,
		limit: PROBE_LIMIT,
	});

	const firstPageInfo = validateUserPage(firstPage, 0);

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

			body = await pianoPost(endpoint, {
				converted_term_types: 7,
				has_access: true,
				offset,
				limit: PROBE_LIMIT,
			});

			validateUserPage(body, offset);

			pages.set(offset, body);
		}

		const outputPath = path.join(
			outputDir,
			`access-granted-offset-${paddedOffset(offset)}.json`,
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
		const info = validateUserPage(body, offset);

		totals.add(info.total);
	}

	if (totals.size !== 1) {
		throw new Error(
			'The API total changed during the pagination probe: ' +
				JSON.stringify([...totals]),
		);
	}

	/*
	 * Check user UIDs across the probed pages.
	 */
	const seenUids = new Set();
	const duplicateUids = new Set();

	for (const body of pages.values()) {
		for (const uid of userUids(body)) {
			if (seenUids.has(uid)) {
				duplicateUids.add(uid);
			}

			seenUids.add(uid);
		}
	}

	/*
	 * Build a structural summary.
	 *
	 * Raw API responses are preserved separately and are not modified.
	 */
	const allUsers = [...pages.values()].flatMap((body) => body.users);

	const summary = {
		endpoint,

		filters: {
			converted_term_types: 7,
			has_access: true,
		},

		probe_limit: PROBE_LIMIT,

		generated_at: new Date().toISOString(),

		reported_total: firstPageInfo.total,

		top_level_keys: Object.keys(firstPage).sort(),

		user_keys_seen: collectObjectKeys(allUsers),

		pages: [...pages.entries()]
			.sort(([a], [b]) => a - b)
			.map(([offset, body]) => {
				const uids = userUids(body);

				return {
					offset,

					limit: Number(body.limit),

					count: Number(body.count),

					users_length: body.users.length,

					total: Number(body.total),

					first_uid: uids[0] ?? null,

					last_uid: uids.at(-1) ?? null,
				};
			}),

		duplicate_uids_across_probe_pages: [...duplicateUids].sort(),
	};

	const summaryPath = path.join(outputDir, 'summary.json');

	await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

	console.log('');
	console.log('Probe complete.');
	console.log(`Output: ${outputDir}`);
	console.log(`Reported total: ${summary.reported_total}`);
	console.log(`Pages probed: ${summary.pages.length}`);
	console.log(
		'Duplicate UIDs across probed pages: ' +
			summary.duplicate_uids_across_probe_pages.length,
	);
	console.log(`Summary: ${summaryPath}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE_URL = (
	process.env.PIANO_API_BASE_URL || 'https://api.piano.io/api/v3'
).replace(/\/$/, '');

const AID = process.env.PIANO_AID;
const API_TOKEN = process.env.PIANO_API_TOKEN;

const PAGE_SIZE = 50;

if (!AID || !API_TOKEN) {
	throw new Error('Missing PIANO_AID or PIANO_API_TOKEN in environment.');
}

function asNumber(value) {
	if (value === null || value === undefined || value === '') {
		return null;
	}

	const number = Number(value);

	return Number.isFinite(number) ? number : null;
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
			`Non-JSON response from ${endpoint}: ` + text.slice(0, 500),
		);
	}

	if (!response.ok) {
		throw new Error(`HTTP ${response.status} from ${endpoint}`);
	}

	/*
	 * Piano frequently returns HTTP 200 even when the
	 * API-level response represents an error.
	 */
	if (
		body &&
		!Array.isArray(body) &&
		body.code !== undefined &&
		Number(body.code) !== 0
	) {
		throw new Error(
			`Piano API error from ${endpoint}: ` + JSON.stringify(body, null, 2),
		);
	}

	return body;
}

function findArray(body, preferredKeys, label) {
	/*
	 * Piano documentation describes these list endpoints
	 * as returning arrays, but observed responses can also
	 * contain the array inside a response wrapper.
	 */

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

	throw new Error(
		`Could not identify ${label} array. Response keys: ` +
			Object.keys(body || {}).join(', '),
	);
}

async function getAllPages({ endpoint, params = {}, preferredKeys, label }) {
	const records = [];

	let offset = 0;
	let page = 1;

	while (true) {
		const body = await pianoGet(endpoint, {
			...params,
			offset,
			limit: PAGE_SIZE,
		});

		const items = findArray(body, preferredKeys, label);

		const total = asNumber(body?.total);
		const count = asNumber(body?.count);

		console.log(
			`${label}: page=${page}, ` +
				`offset=${offset}, ` +
				`returned=${items.length}` +
				(total !== null ? `, total=${total}` : ''),
		);

		if (items.length === 0) {
			break;
		}

		records.push(...items);

		/*
		 * Advance by Piano's reported count when present;
		 * otherwise use the actual number returned.
		 */
		const advanceBy = count !== null && count > 0 ? count : items.length;

		offset += advanceBy;
		page += 1;

		/*
		 * If Piano gives us a total, stop when we've
		 * reached it.
		 */
		if (total !== null && offset >= total) {
			break;
		}

		/*
		 * Without a total, a short page indicates the
		 * end of the result set.
		 */
		if (total === null && items.length < PAGE_SIZE) {
			break;
		}

		if (advanceBy <= 0) {
			throw new Error(`Pagination failed to advance for ${label}`);
		}
	}

	return records;
}

async function main() {
	const outputDir = process.argv[2]
		? path.resolve(process.argv[2])
		: path.resolve('samples');

	await fs.mkdir(outputDir, {
		recursive: true,
	});

	console.log('Retrieving all licensees...');

	const licensees = await getAllPages({
		endpoint: '/publisher/licensing/licensee/list',
		preferredKeys: ['licensees', 'items', 'results'],
		label: 'licensees',
	});

	console.log('');
	console.log(`Total licensees retrieved: ${licensees.length}`);
	console.log('');

	/*
	 * Keep a complete licensee file as well, since we
	 * already had to retrieve the records.
	 */
	await fs.writeFile(
		path.join(outputDir, 'all-licensees.json'),
		JSON.stringify(licensees, null, 2),
		'utf8',
	);

	const output = [];

	for (let index = 0; index < licensees.length; index += 1) {
		const licensee = licensees[index];

		if (!licensee.licensee_id) {
			throw new Error(`Licensee at index ${index} has no licensee_id`);
		}

		console.log(
			`[${index + 1}/${licensees.length}] ` +
				`${licensee.licensee_id} - ` +
				`${licensee.name ?? ''}`,
		);

		const contracts = await getAllPages({
			endpoint: '/publisher/licensing/contract/list',
			params: {
				licensee_id: licensee.licensee_id,
			},
			preferredKeys: ['contracts', 'items', 'results'],
			label: `contracts for ${licensee.licensee_id}`,
		});

		output.push({
			licensee_id: licensee.licensee_id,
			licensee_name: licensee.name ?? null,
			contracts,
		});

		console.log('');
	}

	const outputPath = path.join(outputDir, 'all-contracts.json');

	await fs.writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');

	const allContracts = output.flatMap((item) => item.contracts);

	const contractTypeCounts = {};

	for (const contract of allContracts) {
		const type = contract.contract_type || '(missing)';

		contractTypeCounts[type] = (contractTypeCounts[type] || 0) + 1;
	}

	const licenseesWithoutContracts = output.filter(
		(item) => item.contracts.length === 0,
	).length;

	console.log('Extraction complete.');
	console.log('');
	console.log(`Licensees: ${licensees.length}`);
	console.log(`Contracts: ${allContracts.length}`);
	console.log(`Licensees without contracts: ` + licenseesWithoutContracts);
	console.log('');
	console.log('Contracts by type:');
	console.log(contractTypeCounts);
	console.log('');
	console.log(`Saved: ${outputPath}`);
}

main().catch((error) => {
	console.error('');
	console.error('Extraction failed:');
	console.error(error?.stack || error);
	process.exit(1);
});

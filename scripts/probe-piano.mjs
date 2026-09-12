import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE_URL = (
	process.env.PIANO_API_BASE_URL || 'https://api.piano.io/api/v3'
).replace(/\/$/, '');

const AID = process.env.PIANO_AID;
const API_TOKEN = process.env.PIANO_API_TOKEN;

if (!AID || !API_TOKEN) {
	throw new Error('Missing PIANO_AID or PIANO_API_TOKEN in environment.');
}

function timestampForPath() {
	return new Date().toISOString().replace(/[:.]/g, '-');
}

async function pianoRequest({ method, endpoint, params = {} }) {
	const url = new URL(`${API_BASE_URL}${endpoint}`);

	const allParams = {
		aid: AID,
		api_token: API_TOKEN,
		...params,
	};

	const options = {
		method,
		headers: {
			Accept: 'application/json',
		},
	};

	if (method === 'GET') {
		for (const [key, value] of Object.entries(allParams)) {
			if (value !== undefined && value !== null) {
				url.searchParams.set(key, String(value));
			}
		}
	} else {
		options.headers['Content-Type'] = 'application/x-www-form-urlencoded';

		options.body = new URLSearchParams(
			Object.entries(allParams)
				.filter(([, value]) => value !== undefined && value !== null)
				.map(([key, value]) => [key, String(value)]),
		);
	}

	const response = await fetch(url, options);

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
	 * Piano normally returns HTTP 200 even for API-level errors.
	 * The JSON code must therefore be checked separately.
	 */
	if (body.code !== undefined && Number(body.code) !== 0) {
		throw new Error(
			`Piano API error from ${endpoint}: ` + JSON.stringify(body, null, 2),
		);
	}

	return body;
}

async function main() {
	const outputDir = path.resolve('samples', `probe-${timestampForPath()}`);

	await fs.mkdir(outputDir, {
		recursive: true,
	});

	const requests = [
		{
			name: 'subscriptions',
			method: 'GET',
			endpoint: '/publisher/subscription/list',
			params: {
				offset: 0,
				limit: 50,
			},
		},
		{
			name: 'shared-subscriptions',
			method: 'POST',
			endpoint: '/publisher/subscription/share/list',
			params: {
				offset: 0,
				limit: 50,
			},
		},
		{
			name: 'users',
			method: 'POST',
			endpoint: '/publisher/user/list',
			params: {
				offset: 0,
				limit: 50,
			},
		},
		{
			name: 'licensees',
			method: 'GET',
			endpoint: '/publisher/licensing/licensee/list',
			params: {
				offset: 0,
				limit: 50,
			},
		},
		{
			name: 'active-subscriptions',
			method: 'GET',
			endpoint: '/publisher/subscription/list',
			params: {
				offset: 0,
				limit: 50,
				status: 'active',
			},
		},
	];

	for (const request of requests) {
		console.log(`Retrieving ${request.name}...`);

		const body = await pianoRequest(request);

		const outputPath = path.join(outputDir, `${request.name}.json`);

		await fs.writeFile(outputPath, JSON.stringify(body, null, 2), 'utf8');

		console.log(`Saved ${outputPath}`);

		console.log(`Top-level keys: ${Object.keys(body).join(', ')}`);
	}

	console.log('\nProbe complete.');
	console.log(`Output: ${outputDir}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

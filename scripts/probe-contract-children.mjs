import fs from 'node:fs/promises';
import path from 'node:path';

const API_BASE_URL = (
	process.env.PIANO_API_BASE_URL || 'https://api.piano.io/api/v3'
).replace(/\/$/, '');

const AID = process.env.PIANO_AID;
const API_TOKEN = process.env.PIANO_API_TOKEN;

const PAGE_SIZE = 50;
const MAX_PAGES = 10000;
const MAX_RETRIES = 3;

if (!AID || !API_TOKEN) {
	throw new Error('Missing PIANO_AID or PIANO_API_TOKEN in environment.');
}

const ENDPOINTS = {
	contractUsers: '/publisher/licensing/contractUser/list',

	contractDomains: '/publisher/licensing/contractDomain/list',

	domainUsers: '/publisher/licensing/contractDomain/contractUser/list',
};

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactUrl(url) {
	const copy = new URL(url);

	if (copy.searchParams.has('api_token')) {
		copy.searchParams.set('api_token', '[REDACTED]');
	}

	return copy.toString();
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
					`Non-JSON response from ` +
						`${redactUrl(url)}: ` +
						`HTTP ${response.status}`,
				);
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
			 * Piano may return HTTP 200 while reporting
			 * an API-level error in the JSON body.
			 */
			if (
				body &&
				!Array.isArray(body) &&
				body.code !== undefined &&
				Number(body.code) !== 0
			) {
				const error = new Error(
					`Piano API error ` + `${body.code} from ` + `${redactUrl(url)}`,
				);

				error.body = body;

				throw error;
			}

			return body;
		} catch (error) {
			lastError = error;

			const retryable =
				error?.status === 429 ||
				error?.status >= 500 ||
				error?.name === 'TimeoutError';

			if (!retryable || attempt === MAX_RETRIES) {
				throw error;
			}

			const waitMs = 500 * (attempt + 1);

			console.log(`Retrying after error: ` + `${error.message}`);

			await sleep(waitMs);
		}
	}

	throw lastError;
}

function findArray(body, preferredKeys, label) {
	if (Array.isArray(body)) {
		return body;
	}

	/*
	 * First try the expected Piano response keys,
	 * case-insensitively.
	 */
	for (const preferredKey of preferredKeys) {
		const actualKey = Object.keys(body || {}).find(
			(key) => key.toLowerCase() === preferredKey.toLowerCase(),
		);

		if (actualKey && Array.isArray(body[actualKey])) {
			return body[actualKey];
		}
	}

	/*
	 * Piano list responses sometimes use undocumented
	 * wrapper names such as ContractUserList.
	 *
	 * If the response contains exactly one array,
	 * use that array rather than guessing its name.
	 */
	const arrays = Object.entries(body || {}).filter(([, value]) =>
		Array.isArray(value),
	);

	if (arrays.length === 1) {
		return arrays[0][1];
	}

	throw new Error(
		`Could not identify ${label} array. ` +
			`Response keys: ` +
			Object.keys(body || {}).join(', '),
	);
}

async function getAllPages({ endpoint, params, preferredKeys, label }) {
	const records = [];

	let offset = 0;
	let page = 1;

	while (true) {
		if (page > MAX_PAGES) {
			throw new Error(`Exceeded MAX_PAGES while ` + `retrieving ${label}`);
		}

		const body = await pianoGet(endpoint, {
			...params,
			offset,
			limit: PAGE_SIZE,
		});

		const items = findArray(body, preferredKeys, label);

		console.log(
			`${label}: ` + `offset=${offset}, ` + `returned=${items.length}`,
		);

		if (items.length === 0) {
			break;
		}

		/*
		 * Preserve the records exactly as Piano
		 * returned them.
		 */
		records.push(...items);

		offset += items.length;
		page += 1;
	}

	return records;
}

async function main() {
	const inputPath = process.argv[2];

	if (!inputPath) {
		throw new Error(
			'Usage: node --env-file=.env ' +
				'scripts/probe-contract-children.mjs ' +
				'<all-contracts.json>',
		);
	}

	const resolvedInputPath = path.resolve(inputPath);

	const outputDir = path.dirname(resolvedInputPath);

	const raw = await fs.readFile(resolvedInputPath, 'utf8');

	const licensees = JSON.parse(raw);

	if (!Array.isArray(licensees)) {
		throw new Error('all-contracts.json must contain ' + 'a top-level array.');
	}

	const allContracts = licensees.flatMap((licensee) =>
		Array.isArray(licensee.contracts)
			? licensee.contracts.map((contract) => ({
					licensee_id: licensee.licensee_id ?? null,

					licensee_name: licensee.licensee_name ?? null,

					contract,
				}))
			: [],
	);

	console.log(`Contracts loaded from file: ` + `${allContracts.length}`);

	const specificContracts = allContracts.filter(
		({ contract }) =>
			contract.contract_type === 'SPECIFIC_EMAIL_ADDRESSES_CONTRACT',
	);

	const domainContracts = allContracts.filter(
		({ contract }) => contract.contract_type === 'EMAIL_DOMAIN_CONTRACT',
	);

	console.log(`Specific-email contracts: ` + `${specificContracts.length}`);

	console.log(`Email-domain contracts: ` + `${domainContracts.length}`);

	console.log('');

	const contractUsersOutput = [];
	const contractDomainsOutput = [];
	const domainUsersOutput = [];

	/*
	 * ------------------------------------------------
	 * SPECIFIC_EMAIL_ADDRESSES_CONTRACT
	 * ------------------------------------------------
	 */
	for (let index = 0; index < specificContracts.length; index += 1) {
		const { licensee_id, licensee_name, contract } = specificContracts[index];

		const contractId = contract.contract_id;

		if (!contractId) {
			throw new Error('Specific-email contract has ' + 'no contract_id.');
		}

		console.log(
			`[Specific ${index + 1}/` +
				`${specificContracts.length}] ` +
				`${contractId}`,
		);

		const users = await getAllPages({
			endpoint: ENDPOINTS.contractUsers,

			params: {
				contract_id: contractId,
			},

			preferredKeys: [
				'ContractUserList',
				'contract_users',
				'contractUsers',
				'users',
				'items',
				'results',
			],

			label: `users for contract ` + `${contractId}`,
		});

		/*
		 * Context is added around the returned array,
		 * but each Piano user object remains untouched.
		 */
		contractUsersOutput.push({
			licensee_id,
			licensee_name,

			contract_id: contractId,

			contract_name: contract.name ?? null,

			contract_type: contract.contract_type ?? null,

			users,
		});

		console.log('');
	}

	/*
	 * ------------------------------------------------
	 * EMAIL_DOMAIN_CONTRACT
	 * ------------------------------------------------
	 */
	for (let index = 0; index < domainContracts.length; index += 1) {
		const { licensee_id, licensee_name, contract } = domainContracts[index];

		const contractId = contract.contract_id;

		if (!contractId) {
			throw new Error('Email-domain contract has ' + 'no contract_id.');
		}

		console.log(
			`[Domain ${index + 1}/` + `${domainContracts.length}] ` + `${contractId}`,
		);

		const domains = await getAllPages({
			endpoint: ENDPOINTS.contractDomains,

			params: {
				contract_id: contractId,
			},

			preferredKeys: [
				'contract_domains',
				'contractDomains',
				'domains',
				'items',
				'results',
			],

			label: `domains for contract ` + `${contractId}`,
		});

		/*
		 * Preserve every domain returned under its
		 * source contract. No deduplication.
		 */
		contractDomainsOutput.push({
			licensee_id,
			licensee_name,

			contract_id: contractId,

			contract_name: contract.name ?? null,

			contract_type: contract.contract_type ?? null,

			domains,
		});

		for (let domainIndex = 0; domainIndex < domains.length; domainIndex += 1) {
			const domain = domains[domainIndex];

			const contractDomainId = domain.contract_domain_id;

			if (!contractDomainId) {
				throw new Error(
					`Domain under contract ` +
						`${contractId} has no ` +
						`contract_domain_id.`,
				);
			}

			const users = await getAllPages({
				endpoint: ENDPOINTS.domainUsers,

				params: {
					contract_id: contractId,

					contract_domain_id: contractDomainId,
				},

				preferredKeys: [
					'ContractUserList',
					'contract_users',
					'contractUsers',
					'users',
					'items',
					'results',
				],

				label: `users for domain ` + `${contractDomainId}`,
			});

			/*
			 * Again, keep Piano's domain and user
			 * objects unchanged. Context is only
			 * added around them.
			 */
			domainUsersOutput.push({
				licensee_id,
				licensee_name,

				contract_id: contractId,

				contract_name: contract.name ?? null,

				contract_type: contract.contract_type ?? null,

				contract_domain_id: contractDomainId,

				contract_domain_value: domain.contract_domain_value ?? null,

				domain,

				users,
			});
		}

		console.log('');
	}

	const contractUsersPath = path.join(outputDir, 'contract-users.json');

	const contractDomainsPath = path.join(outputDir, 'contract-domains.json');

	const domainUsersPath = path.join(outputDir, 'domain-users.json');

	await fs.writeFile(
		contractUsersPath,
		JSON.stringify(contractUsersOutput, null, 2),
		'utf8',
	);

	await fs.writeFile(
		contractDomainsPath,
		JSON.stringify(contractDomainsOutput, null, 2),
		'utf8',
	);

	await fs.writeFile(
		domainUsersPath,
		JSON.stringify(domainUsersOutput, null, 2),
		'utf8',
	);

	const directUserCount = contractUsersOutput.reduce(
		(total, item) => total + item.users.length,
		0,
	);

	const domainCount = contractDomainsOutput.reduce(
		(total, item) => total + item.domains.length,
		0,
	);

	const domainUserCount = domainUsersOutput.reduce(
		(total, item) => total + item.users.length,
		0,
	);

	console.log('Extraction complete.');
	console.log('');

	console.log(`Specific-email contracts: ` + `${specificContracts.length}`);

	console.log(`Contract users: ` + `${directUserCount}`);

	console.log(`Email-domain contracts: ` + `${domainContracts.length}`);

	console.log(`Contract domains: ` + `${domainCount}`);

	console.log(`Domain users: ` + `${domainUserCount}`);

	console.log('');
	console.log(`Saved: ${contractUsersPath}`);
	console.log(`Saved: ${contractDomainsPath}`);
	console.log(`Saved: ${domainUsersPath}`);
}

main().catch((error) => {
	console.error('');
	console.error('Extraction failed:');
	console.error(error?.stack || error);
	process.exit(1);
});

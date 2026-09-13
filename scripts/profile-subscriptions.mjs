import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/* =========================================================
   Piano subscription structure profiler

   Purpose:
   - Read the exact raw subscription page files created by
     extract-subscriptions.mjs.
   - Inventory the actual JSON structure across the complete
     extracted subscription population.
   - Report object scopes, fields, JSON types, null/missing
     counts, string lengths, numeric ranges, booleans, arrays,
     and nested object/array occurrence counts.

   This script does NOT:
   - alter the source extraction
   - normalize source values
   - deduplicate data
   - infer a relational model
   - load SQL Server
   ========================================================= */

const DEFAULT_RUN_DIR =
	'/Users/carolyn/Projects/ip-piano-subscriptions/extracts/run-subscriptions-2026-09-13T12-58-44-141Z';

const RUN_DIR = path.resolve(process.argv[2] || DEFAULT_RUN_DIR);

const PAGES_DIR = path.join(RUN_DIR, 'pages');

const OUTPUT_DIR = path.join(RUN_DIR, 'profile');

const EXTRACTION_SUMMARY_PATH = path.join(RUN_DIR, 'summary.json');

const ROOT_SCOPE = 'subscription';

/* =========================================================
   Type helpers
   ========================================================= */

function classifyType(value) {
	if (value === null) {
		return 'null';
	}

	if (Array.isArray(value)) {
		return 'array';
	}

	if (typeof value === 'number') {
		return Number.isInteger(value) ? 'integer' : 'number';
	}

	return typeof value;
}

function getOrCreate(map, key, factory) {
	if (!map.has(key)) {
		map.set(key, factory());
	}

	return map.get(key);
}

function incrementMap(map, key, amount = 1) {
	map.set(key, (map.get(key) || 0) + amount);
}

function mapToObject(map) {
	return Object.fromEntries(
		[...map.entries()].sort(([left], [right]) => left.localeCompare(right)),
	);
}

/* =========================================================
   Primitive-value profiling
   ========================================================= */

function updatePrimitiveMetrics(stats, value, type) {
	if (type === 'string') {
		const length = value.length;

		stats.string_count += 1;

		if (length === 0) {
			stats.empty_string_count += 1;
		}

		if (stats.string_min_length === null || length < stats.string_min_length) {
			stats.string_min_length = length;
		}

		if (stats.string_max_length === null || length > stats.string_max_length) {
			stats.string_max_length = length;
		}

		return;
	}

	if (type === 'integer' || type === 'number') {
		stats.number_count += 1;

		if (stats.number_min === null || value < stats.number_min) {
			stats.number_min = value;
		}

		if (stats.number_max === null || value > stats.number_max) {
			stats.number_max = value;
		}

		return;
	}

	if (type === 'boolean') {
		if (value) {
			stats.boolean_true_count += 1;
		} else {
			stats.boolean_false_count += 1;
		}
	}
}

/* =========================================================
   Statistics structures
   ========================================================= */

function newFieldStats() {
	return {
		present_count: 0,
		null_count: 0,

		type_counts: new Map(),

		string_count: 0,
		empty_string_count: 0,
		string_min_length: null,
		string_max_length: null,

		number_count: 0,
		number_min: null,
		number_max: null,

		boolean_true_count: 0,
		boolean_false_count: 0,
	};
}

function newScopeStats() {
	return {
		object_count: 0,
		fields: new Map(),
	};
}

function newArrayStats() {
	return {
		array_count: 0,
		empty_array_count: 0,
		total_element_count: 0,
		min_length: null,
		max_length: null,

		element_type_counts: new Map(),

		string_count: 0,
		empty_string_count: 0,
		string_min_length: null,
		string_max_length: null,

		number_count: 0,
		number_min: null,
		number_max: null,

		boolean_true_count: 0,
		boolean_false_count: 0,
	};
}

/* =========================================================
   CSV helpers
   ========================================================= */

function csvEscape(value) {
	if (value === null || value === undefined) {
		return '';
	}

	const text = String(value);

	if (
		text.includes(',') ||
		text.includes('"') ||
		text.includes('\n') ||
		text.includes('\r')
	) {
		return `"${text.replaceAll('"', '""')}"`;
	}

	return text;
}

function rowsToCsv(headers, rows) {
	const lines = [headers.map(csvEscape).join(',')];

	for (const row of rows) {
		lines.push(headers.map((header) => csvEscape(row[header])).join(','));
	}

	return `${lines.join('\n')}\n`;
}

function formatJsonCell(value) {
	return JSON.stringify(value);
}

/* =========================================================
   File helpers
   ========================================================= */

async function readJson(filePath) {
	return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function fileExists(filePath) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function pageOffsetFromFilename(filename) {
	const match = filename.match(/^subscriptions-offset-(\d+)\.json$/);

	if (!match) {
		return null;
	}

	return Number(match[1]);
}

/* =========================================================
   Main
   ========================================================= */

async function main() {
	const startedAt = new Date();

	console.log('Subscription structure profile');

	console.log('');

	console.log(`Run directory: ${RUN_DIR}`);

	console.log(`Pages:         ${PAGES_DIR}`);

	console.log(`Output:        ${OUTPUT_DIR}`);

	console.log('');

	const pageEntries = await fs.readdir(PAGES_DIR, {
		withFileTypes: true,
	});

	const pageFiles = pageEntries
		.filter(
			(entry) =>
				entry.isFile() && /^subscriptions-offset-\d+\.json$/.test(entry.name),
		)
		.map((entry) => entry.name)
		.sort(
			(left, right) =>
				pageOffsetFromFilename(left) - pageOffsetFromFilename(right),
		);

	if (pageFiles.length === 0) {
		throw new Error(`No subscription page files found in ${PAGES_DIR}`);
	}

	/* =======================================================
     Profile state
     ======================================================= */

	const scopeStats = new Map();

	const arrayStats = new Map();

	let subscriptionCount = 0;
	let pageSubscriptionCount = 0;
	let pageTotalReference = null;
	let maxDepth = 0;

	/* =======================================================
     Recursive array profiler
     ======================================================= */

	function observeArray(array, arrayPath, depth) {
		if (depth > maxDepth) {
			maxDepth = depth;
		}

		const stats = getOrCreate(arrayStats, arrayPath, newArrayStats);

		stats.array_count += 1;

		stats.total_element_count += array.length;

		if (array.length === 0) {
			stats.empty_array_count += 1;
		}

		if (stats.min_length === null || array.length < stats.min_length) {
			stats.min_length = array.length;
		}

		if (stats.max_length === null || array.length > stats.max_length) {
			stats.max_length = array.length;
		}

		for (const element of array) {
			const type = classifyType(element);

			incrementMap(stats.element_type_counts, type);

			if (type === 'object') {
				observeObject(element, `${arrayPath}[]`, depth + 1);

				continue;
			}

			if (type === 'array') {
				observeArray(element, `${arrayPath}[]`, depth + 1);

				continue;
			}

			if (type !== 'null') {
				updatePrimitiveMetrics(stats, element, type);
			}
		}
	}

	/* =======================================================
     Recursive object profiler
     ======================================================= */

	function observeObject(object, scopePath, depth) {
		if (depth > maxDepth) {
			maxDepth = depth;
		}

		const scope = getOrCreate(scopeStats, scopePath, newScopeStats);

		scope.object_count += 1;

		for (const [fieldName, value] of Object.entries(object)) {
			const field = getOrCreate(scope.fields, fieldName, newFieldStats);

			field.present_count += 1;

			const type = classifyType(value);

			if (type === 'null') {
				field.null_count += 1;

				continue;
			}

			incrementMap(field.type_counts, type);

			if (type === 'object') {
				observeObject(value, `${scopePath}.${fieldName}`, depth + 1);

				continue;
			}

			if (type === 'array') {
				observeArray(value, `${scopePath}.${fieldName}`, depth + 1);

				continue;
			}

			updatePrimitiveMetrics(field, value, type);
		}
	}

	/* =======================================================
     Process all raw API pages
     ======================================================= */

	for (let index = 0; index < pageFiles.length; index += 1) {
		const pageFile = pageFiles[index];

		const pagePath = path.join(PAGES_DIR, pageFile);

		const body = await readJson(pagePath);

		if (!Array.isArray(body.subscriptions)) {
			throw new Error(`${pageFile} does not contain a subscriptions array.`);
		}

		if (
			!Number.isInteger(body.count) ||
			body.count !== body.subscriptions.length
		) {
			throw new Error(`${pageFile} count does not match subscriptions.length.`);
		}

		if (!Number.isInteger(body.total)) {
			throw new Error(`${pageFile} has an invalid total.`);
		}

		if (pageTotalReference === null) {
			pageTotalReference = body.total;
		} else if (body.total !== pageTotalReference) {
			throw new Error(
				'API total changed between saved page files: ' +
					`${pageTotalReference} versus ${body.total} ` +
					`in ${pageFile}.`,
			);
		}

		pageSubscriptionCount += body.subscriptions.length;

		for (const subscription of body.subscriptions) {
			if (
				!subscription ||
				typeof subscription !== 'object' ||
				Array.isArray(subscription)
			) {
				throw new Error(
					`${pageFile} contains a non-object subscription record.`,
				);
			}

			observeObject(subscription, ROOT_SCOPE, 0);

			subscriptionCount += 1;
		}

		if ((index + 1) % 25 === 0 || index === pageFiles.length - 1) {
			console.log(
				`Profiled ${index + 1}/${pageFiles.length} pages ` +
					`(${subscriptionCount} subscriptions)...`,
			);
		}
	}

	/* =======================================================
     Validate profile source counts
     ======================================================= */

	if (subscriptionCount !== pageSubscriptionCount) {
		throw new Error(
			'Internal count mismatch: ' +
				`subscriptionCount=${subscriptionCount}, ` +
				`pageSubscriptionCount=${pageSubscriptionCount}.`,
		);
	}

	if (pageTotalReference !== null && subscriptionCount !== pageTotalReference) {
		throw new Error(
			`Profiled subscription count ${subscriptionCount} ` +
				`does not match saved API total ${pageTotalReference}.`,
		);
	}

	/* =======================================================
     Compare against extraction summary
     ======================================================= */

	let extractionSummary = null;

	if (await fileExists(EXTRACTION_SUMMARY_PATH)) {
		extractionSummary = await readJson(EXTRACTION_SUMMARY_PATH);

		if (
			Number.isInteger(extractionSummary.extracted_subscription_count) &&
			extractionSummary.extracted_subscription_count !== subscriptionCount
		) {
			throw new Error(
				`Profile count ${subscriptionCount} does not match ` +
					'extraction summary count ' +
					`${extractionSummary.extracted_subscription_count}.`,
			);
		}
	}

	/* =======================================================
     Build output rows
     ======================================================= */

	const scopeRows = [];
	const fieldRows = [];
	const arrayRows = [];

	const scopeJson = {};
	const arrayJson = {};

	const sortedScopes = [...scopeStats.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	);

	for (const [scopePath, scope] of sortedScopes) {
		scopeRows.push({
			scope_path: scopePath,

			object_count: scope.object_count,

			field_count: scope.fields.size,
		});

		const fieldObject = {};

		const sortedFields = [...scope.fields.entries()].sort(([left], [right]) =>
			left.localeCompare(right),
		);

		for (const [fieldName, field] of sortedFields) {
			const missingCount = scope.object_count - field.present_count;

			const nonNullCount = field.present_count - field.null_count;

			const typeCountsObject = mapToObject(field.type_counts);

			const fieldPath = `${scopePath}.${fieldName}`;

			fieldRows.push({
				scope_path: scopePath,

				field_name: fieldName,

				field_path: fieldPath,

				scope_object_count: scope.object_count,

				present_count: field.present_count,

				missing_count: missingCount,

				null_count: field.null_count,

				non_null_count: nonNullCount,

				type_counts: formatJsonCell(typeCountsObject),

				string_count: field.string_count,

				empty_string_count: field.empty_string_count,

				string_min_length: field.string_min_length,

				string_max_length: field.string_max_length,

				number_count: field.number_count,

				number_min: field.number_min,

				number_max: field.number_max,

				boolean_true_count: field.boolean_true_count,

				boolean_false_count: field.boolean_false_count,
			});

			fieldObject[fieldName] = {
				field_path: fieldPath,

				present_count: field.present_count,

				missing_count: missingCount,

				null_count: field.null_count,

				non_null_count: nonNullCount,

				type_counts: typeCountsObject,

				string_count: field.string_count,

				empty_string_count: field.empty_string_count,

				string_min_length: field.string_min_length,

				string_max_length: field.string_max_length,

				number_count: field.number_count,

				number_min: field.number_min,

				number_max: field.number_max,

				boolean_true_count: field.boolean_true_count,

				boolean_false_count: field.boolean_false_count,
			};
		}

		scopeJson[scopePath] = {
			object_count: scope.object_count,

			field_count: scope.fields.size,

			fields: fieldObject,
		};
	}

	/* =======================================================
     Array output
     ======================================================= */

	const sortedArrays = [...arrayStats.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	);

	for (const [arrayPath, array] of sortedArrays) {
		const averageLength =
			array.array_count > 0
				? array.total_element_count / array.array_count
				: null;

		const elementTypeCountsObject = mapToObject(array.element_type_counts);

		arrayRows.push({
			array_path: arrayPath,

			array_count: array.array_count,

			empty_array_count: array.empty_array_count,

			total_element_count: array.total_element_count,

			min_length: array.min_length,

			max_length: array.max_length,

			average_length: averageLength === null ? null : averageLength.toFixed(6),

			element_type_counts: formatJsonCell(elementTypeCountsObject),

			string_count: array.string_count,

			empty_string_count: array.empty_string_count,

			string_min_length: array.string_min_length,

			string_max_length: array.string_max_length,

			number_count: array.number_count,

			number_min: array.number_min,

			number_max: array.number_max,

			boolean_true_count: array.boolean_true_count,

			boolean_false_count: array.boolean_false_count,
		});

		arrayJson[arrayPath] = {
			array_count: array.array_count,

			empty_array_count: array.empty_array_count,

			total_element_count: array.total_element_count,

			min_length: array.min_length,

			max_length: array.max_length,

			average_length: averageLength,

			element_type_counts: elementTypeCountsObject,

			string_count: array.string_count,

			empty_string_count: array.empty_string_count,

			string_min_length: array.string_min_length,

			string_max_length: array.string_max_length,

			number_count: array.number_count,

			number_min: array.number_min,

			number_max: array.number_max,

			boolean_true_count: array.boolean_true_count,

			boolean_false_count: array.boolean_false_count,
		};
	}

	/* =======================================================
     Summary
     ======================================================= */

	const completedAt = new Date();

	const profileSummary = {
		profile_name: 'piano-subscriptions-structure-profile',

		source_run_directory: RUN_DIR,

		source_pages_directory: PAGES_DIR,

		started_at_utc: startedAt.toISOString(),

		completed_at_utc: completedAt.toISOString(),

		page_file_count: pageFiles.length,

		subscription_count: subscriptionCount,

		saved_api_total: pageTotalReference,

		extraction_summary_count:
			extractionSummary?.extracted_subscription_count ?? null,

		object_scope_count: scopeStats.size,

		array_path_count: arrayStats.size,

		maximum_observed_depth: maxDepth,

		complete: true,
	};

	const fullProfile = {
		summary: profileSummary,

		scopes: scopeJson,

		arrays: arrayJson,
	};

	/* =======================================================
     Write profile files
     ======================================================= */

	await fs.mkdir(OUTPUT_DIR, {
		recursive: true,
	});

	const scopeHeaders = ['scope_path', 'object_count', 'field_count'];

	const fieldHeaders = [
		'scope_path',
		'field_name',
		'field_path',
		'scope_object_count',
		'present_count',
		'missing_count',
		'null_count',
		'non_null_count',
		'type_counts',
		'string_count',
		'empty_string_count',
		'string_min_length',
		'string_max_length',
		'number_count',
		'number_min',
		'number_max',
		'boolean_true_count',
		'boolean_false_count',
	];

	const arrayHeaders = [
		'array_path',
		'array_count',
		'empty_array_count',
		'total_element_count',
		'min_length',
		'max_length',
		'average_length',
		'element_type_counts',
		'string_count',
		'empty_string_count',
		'string_min_length',
		'string_max_length',
		'number_count',
		'number_min',
		'number_max',
		'boolean_true_count',
		'boolean_false_count',
	];

	await Promise.all([
		fs.writeFile(
			path.join(OUTPUT_DIR, 'profile-summary.json'),
			`${JSON.stringify(profileSummary, null, 2)}\n`,
			'utf8',
		),

		fs.writeFile(
			path.join(OUTPUT_DIR, 'profile.json'),
			`${JSON.stringify(fullProfile, null, 2)}\n`,
			'utf8',
		),

		fs.writeFile(
			path.join(OUTPUT_DIR, 'object-scopes.csv'),
			rowsToCsv(scopeHeaders, scopeRows),
			'utf8',
		),

		fs.writeFile(
			path.join(OUTPUT_DIR, 'field-profile.csv'),
			rowsToCsv(fieldHeaders, fieldRows),
			'utf8',
		),

		fs.writeFile(
			path.join(OUTPUT_DIR, 'array-profile.csv'),
			rowsToCsv(arrayHeaders, arrayRows),
			'utf8',
		),
	]);

	console.log('');
	console.log('Profile complete.');

	console.log(JSON.stringify(profileSummary, null, 2));

	console.log('');

	console.log(`Output: ${OUTPUT_DIR}`);
}

await main();

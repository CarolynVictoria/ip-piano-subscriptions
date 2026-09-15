import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

/* =========================================================
   Copy dbo.subscription_log_export
   from local Docker SQL Server to Azure SQL Database.

   Source configuration:      .env
   Destination configuration: .env.azure

   Behavior:
   - validates both connections
   - validates source/destination table schemas match
   - refuses to overwrite a non-empty Azure table unless --replace
   - reads the source table without modifying it
   - bulk-inserts into Azure in batches
   - performs the Azure load inside one transaction
   - verifies source and destination row counts before commit
   ========================================================= */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

const SOURCE_ENV_PATH = path.join(PROJECT_ROOT, '.env');
const DESTINATION_ENV_PATH = path.join(PROJECT_ROOT, '.env.azure');

const TABLE_SCHEMA = 'dbo';
const TABLE_NAME = 'subscription_log_export';

const FULL_TABLE_NAME = `[${TABLE_SCHEMA}].[${TABLE_NAME}]`;

const BULK_BATCH_SIZE = 500;

const REPLACE_DESTINATION = process.argv.includes('--replace');

/* =========================================================
   Environment-file handling
   ========================================================= */

function decodeDoubleQuotedValue(value) {
	return value.replace(/\\(n|r|t|\\|")/g, (_match, token) => {
		switch (token) {
			case 'n':
				return '\n';

			case 'r':
				return '\r';

			case 't':
				return '\t';

			case '\\':
				return '\\';

			case '"':
				return '"';

			default:
				return token;
		}
	});
}

function parseEnvFile(text, filePath) {
	const values = {};

	const lines = text.split(/\r?\n/);

	for (let index = 0; index < lines.length; index += 1) {
		let line = lines[index].trim();

		if (!line || line.startsWith('#')) {
			continue;
		}

		if (line.startsWith('export ')) {
			line = line.slice(7).trim();
		}

		const equalsIndex = line.indexOf('=');

		if (equalsIndex <= 0) {
			throw new Error(
				`Invalid environment-file line ${index + 1} in ${filePath}.`,
			);
		}

		const key = line.slice(0, equalsIndex).trim();

		let value = line.slice(equalsIndex + 1).trim();

		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error(
				`Invalid environment variable name ` +
					`on line ${index + 1} in ` +
					`${filePath}: ${key}`,
			);
		}

		if (value.startsWith('"')) {
			if (!value.endsWith('"') || value.length < 2) {
				throw new Error(
					`Unterminated double-quoted ` +
						`value for ${key} in ` +
						`${filePath}.`,
				);
			}

			value = decodeDoubleQuotedValue(value.slice(1, -1));
		} else if (value.startsWith("'")) {
			if (!value.endsWith("'") || value.length < 2) {
				throw new Error(
					`Unterminated single-quoted ` +
						`value for ${key} in ` +
						`${filePath}.`,
				);
			}

			value = value.slice(1, -1);
		} else {
			const commentIndex = value.search(/\s#/);

			if (commentIndex >= 0) {
				value = value.slice(0, commentIndex).trimEnd();
			}
		}

		values[key] = value;
	}

	return values;
}

async function loadEnvFile(filePath) {
	const text = await fs.readFile(filePath, 'utf8');

	return parseEnvFile(text, filePath);
}

function requiredEnv(env, name, filePath) {
	const value = env[name];

	if (value === undefined || value === '') {
		throw new Error(`Missing ${name} in ${filePath}.`);
	}

	return value;
}

function parseBoolean(value, defaultValue) {
	if (value === undefined || value === '') {
		return defaultValue;
	}

	const normalized = String(value).trim().toLowerCase();

	if (normalized === 'true') {
		return true;
	}

	if (normalized === 'false') {
		return false;
	}

	throw new Error(`Expected boolean value true/false; ` + `received: ${value}`);
}

function sqlConfigFromEnv(
	env,
	filePath,
	{ encryptDefault, trustServerCertificateDefault },
) {
	const port = Number(env.SQL_PORT || 1433);

	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error(
			`SQL_PORT in ${filePath} must be ` +
				`an integer between 1 and 65535. ` +
				`Received: ${env.SQL_PORT}`,
		);
	}

	return {
		server: requiredEnv(env, 'SQL_SERVER', filePath),

		port,

		user: requiredEnv(env, 'SQL_USER', filePath),

		password: requiredEnv(env, 'SQL_PASSWORD', filePath),

		database: requiredEnv(env, 'SQL_DATABASE', filePath),

		options: {
			encrypt: parseBoolean(env.SQL_ENCRYPT, encryptDefault),

			trustServerCertificate: parseBoolean(
				env.SQL_TRUST_SERVER_CERTIFICATE,
				trustServerCertificateDefault,
			),
		},

		pool: {
			max: 5,
			min: 0,
			idleTimeoutMillis: 30000,
		},

		connectionTimeout: 30000,
		requestTimeout: 300000,
	};
}

/* =========================================================
   SQL metadata helpers
   ========================================================= */

function quoteIdentifier(identifier) {
	return `[${String(identifier).replace(/]/g, ']]')}]`;
}

async function getDatabaseIdentity(pool) {
	const result = await pool.request().query(`
			SELECT
				DB_NAME() AS database_name,
				@@SERVERNAME AS server_name;
		`);

	return result.recordset[0];
}

async function getTableColumns(pool) {
	const result = await pool
		.request()

		.input('table_schema', sql.NVarChar(128), TABLE_SCHEMA)

		.input('table_name', sql.NVarChar(128), TABLE_NAME).query(`
			SELECT
				ORDINAL_POSITION AS ordinal_position,
				COLUMN_NAME AS column_name,
				DATA_TYPE AS data_type,

				CHARACTER_MAXIMUM_LENGTH
					AS character_maximum_length,

				NUMERIC_PRECISION
					AS numeric_precision,

				NUMERIC_SCALE
					AS numeric_scale,

				DATETIME_PRECISION
					AS datetime_precision,

				IS_NULLABLE
					AS is_nullable

			FROM INFORMATION_SCHEMA.COLUMNS

			WHERE
				TABLE_SCHEMA = @table_schema
				AND TABLE_NAME = @table_name

			ORDER BY
				ORDINAL_POSITION;
		`);

	return result.recordset;
}

function metadataSignature(column) {
	return JSON.stringify({
		ordinal_position: Number(column.ordinal_position),

		column_name: column.column_name,

		data_type: column.data_type,

		character_maximum_length:
			column.character_maximum_length === null
				? null
				: Number(column.character_maximum_length),

		numeric_precision:
			column.numeric_precision === null
				? null
				: Number(column.numeric_precision),

		numeric_scale:
			column.numeric_scale === null ? null : Number(column.numeric_scale),

		datetime_precision:
			column.datetime_precision === null
				? null
				: Number(column.datetime_precision),

		is_nullable: column.is_nullable,
	});
}

function validateMatchingSchemas(sourceColumns, destinationColumns) {
	if (sourceColumns.length === 0) {
		throw new Error(
			`Source table ${FULL_TABLE_NAME} ` + `does not exist or has no columns.`,
		);
	}

	if (destinationColumns.length === 0) {
		throw new Error(
			`Destination table ` +
				`${FULL_TABLE_NAME} does not ` +
				`exist or has no columns.`,
		);
	}

	if (sourceColumns.length !== destinationColumns.length) {
		throw new Error(
			`Schema mismatch: source has ` +
				`${sourceColumns.length} columns; ` +
				`destination has ` +
				`${destinationColumns.length}.`,
		);
	}

	for (let index = 0; index < sourceColumns.length; index += 1) {
		const sourceColumn = sourceColumns[index];

		const destinationColumn = destinationColumns[index];

		if (
			metadataSignature(sourceColumn) !== metadataSignature(destinationColumn)
		) {
			throw new Error(
				`Schema mismatch at ordinal ` +
					`${index + 1}.\n` +
					`Source:      ` +
					`${metadataSignature(sourceColumn)}\n` +
					`Destination: ` +
					`${metadataSignature(destinationColumn)}`,
			);
		}
	}
}

function sqlTypeForColumn(column) {
	const type = String(column.data_type).toLowerCase();

	const length =
		column.character_maximum_length === null
			? null
			: Number(column.character_maximum_length);

	switch (type) {
		case 'nvarchar':
			return sql.NVarChar(length === -1 ? sql.MAX : length);

		case 'varchar':
			return sql.VarChar(length === -1 ? sql.MAX : length);

		case 'datetime':
			return sql.DateTime;

		case 'int':
			return sql.Int;

		case 'smallint':
			return sql.SmallInt;

		case 'tinyint':
			return sql.TinyInt;

		case 'bit':
			return sql.Bit;

		case 'money':
			return sql.Money;

		case 'float':
			return sql.Float;

		default:
			throw new Error(
				`Unsupported SQL type ` +
					`${column.data_type} for ` +
					`column ` +
					`${column.column_name}.`,
			);
	}
}

async function getRowCount(pool) {
	const result = await pool.request().query(`
			SELECT
				COUNT_BIG(*) AS row_count
			FROM ${FULL_TABLE_NAME};
		`);

	return Number(result.recordset[0].row_count);
}

function buildBulkTable(columns, rows) {
	const table = new sql.Table(`${TABLE_SCHEMA}.${TABLE_NAME}`);

	table.create = false;

	for (const column of columns) {
		table.columns.add(column.column_name, sqlTypeForColumn(column), {
			nullable: column.is_nullable === 'YES',
		});
	}

	for (const row of rows) {
		table.rows.add(...columns.map((column) => row[column.column_name] ?? null));
	}

	return table;
}

/* =========================================================
   Transfer
   ========================================================= */

async function main() {
	console.log(`Source env:      ${SOURCE_ENV_PATH}`);

	console.log(`Destination env: ` + `${DESTINATION_ENV_PATH}`);

	console.log(`Table:           ${FULL_TABLE_NAME}`);

	console.log(`Bulk batch size: ${BULK_BATCH_SIZE}`);

	console.log(`Replace mode:    ${REPLACE_DESTINATION ? 'yes' : 'no'}`);

	const [sourceEnv, destinationEnv] = await Promise.all([
		loadEnvFile(SOURCE_ENV_PATH),

		loadEnvFile(DESTINATION_ENV_PATH),
	]);

	const sourceConfig = sqlConfigFromEnv(sourceEnv, SOURCE_ENV_PATH, {
		encryptDefault: false,

		trustServerCertificateDefault: true,
	});

	const destinationConfig = sqlConfigFromEnv(
		destinationEnv,
		DESTINATION_ENV_PATH,
		{
			encryptDefault: true,

			trustServerCertificateDefault: false,
		},
	);

	if (
		sourceConfig.server === destinationConfig.server &&
		sourceConfig.port === destinationConfig.port &&
		sourceConfig.database === destinationConfig.database
	) {
		throw new Error(
			'Source and destination resolve ' +
				'to the same SQL Server/database. ' +
				'Refusing to continue.',
		);
	}

	const sourcePool = new sql.ConnectionPool(sourceConfig);

	const destinationPool = new sql.ConnectionPool(destinationConfig);

	let destinationTransaction = null;

	try {
		console.log('Connecting to local Docker SQL Server...');

		await sourcePool.connect();

		console.log('Connecting to Azure SQL Database...');

		await destinationPool.connect();

		const [
			sourceIdentity,
			destinationIdentity,
			sourceColumns,
			destinationColumns,
			sourceCount,
			destinationCount,
		] = await Promise.all([
			getDatabaseIdentity(sourcePool),

			getDatabaseIdentity(destinationPool),

			getTableColumns(sourcePool),

			getTableColumns(destinationPool),

			getRowCount(sourcePool),

			getRowCount(destinationPool),
		]);

		console.log(
			`Source:      ` +
				`${sourceIdentity.server_name} / ` +
				`${sourceIdentity.database_name}`,
		);

		console.log(
			`Destination: ` +
				`${destinationIdentity.server_name} / ` +
				`${destinationIdentity.database_name}`,
		);

		validateMatchingSchemas(sourceColumns, destinationColumns);

		console.log(
			`Schema validated: ` + `${sourceColumns.length} ` + `matching columns.`,
		);

		console.log(`Source rows:      ` + sourceCount.toLocaleString());

		console.log(`Destination rows: ` + destinationCount.toLocaleString());

		if (sourceCount === 0) {
			throw new Error('Source table is empty. ' + 'Nothing will be copied.');
		}

		if (destinationCount > 0 && !REPLACE_DESTINATION) {
			throw new Error(
				`Destination table already ` +
					`contains ` +
					`${destinationCount.toLocaleString()} ` +
					`rows. Re-run with --replace ` +
					`only if you intend to replace ` +
					`the destination contents.`,
			);
		}

		const selectColumns = sourceColumns
			.map((column) => quoteIdentifier(column.column_name))
			.join(',\n\t');

		console.log('Reading source rows...');

		const sourceResult = await sourcePool.request().query(`
					SELECT
						${selectColumns}

					FROM ${FULL_TABLE_NAME};
				`);

		const sourceRows = sourceResult.recordset;

		if (sourceRows.length !== sourceCount) {
			throw new Error(
				`Source count changed while ` +
					`reading: expected ` +
					`${sourceCount}, read ` +
					`${sourceRows.length}. ` +
					`Refusing to load an ` +
					`inconsistent snapshot.`,
			);
		}

		console.log(
			`Read ` +
				`${sourceRows.length.toLocaleString()} ` +
				`source rows. Starting ` +
				`Azure transaction...`,
		);

		destinationTransaction = new sql.Transaction(destinationPool);

		await destinationTransaction.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);

		if (destinationCount > 0) {
			console.log('Truncating destination table ' + 'inside transaction...');

			await new sql.Request(destinationTransaction).query(`
				TRUNCATE TABLE
					${FULL_TABLE_NAME};
			`);
		}

		let inserted = 0;

		for (
			let offset = 0;
			offset < sourceRows.length;
			offset += BULK_BATCH_SIZE
		) {
			const batchRows = sourceRows.slice(offset, offset + BULK_BATCH_SIZE);

			const bulkTable = buildBulkTable(destinationColumns, batchRows);

			const request = new sql.Request(destinationTransaction);

			await request.bulk(bulkTable);

			inserted += batchRows.length;

			console.log(
				`Inserted ` +
					`${inserted.toLocaleString()} ` +
					`/ ` +
					`${sourceCount.toLocaleString()} ` +
					`rows...`,
			);
		}

		const verificationResult = await new sql.Request(destinationTransaction)
			.query(`
				SELECT
					COUNT_BIG(*) AS row_count

				FROM ${FULL_TABLE_NAME};
			`);

		const destinationCountBeforeCommit = Number(
			verificationResult.recordset[0].row_count,
		);

		if (destinationCountBeforeCommit !== sourceCount) {
			throw new Error(
				`Destination verification ` +
					`failed: source has ` +
					`${sourceCount} rows; ` +
					`destination has ` +
					`${destinationCountBeforeCommit} ` +
					`rows before commit.`,
			);
		}

		await destinationTransaction.commit();

		destinationTransaction = null;

		const finalDestinationCount = await getRowCount(destinationPool);

		if (finalDestinationCount !== sourceCount) {
			throw new Error(
				`Post-commit verification ` +
					`failed: source has ` +
					`${sourceCount} rows; ` +
					`destination has ` +
					`${finalDestinationCount} rows.`,
			);
		}

		console.log('');
		console.log('Transfer complete.');

		console.log(`Source rows:      ` + sourceCount.toLocaleString());

		console.log(`Destination rows: ` + finalDestinationCount.toLocaleString());
	} catch (error) {
		if (destinationTransaction) {
			try {
				await destinationTransaction.rollback();

				console.error('Azure transaction rolled back.');
			} catch (rollbackError) {
				console.error('Azure rollback also failed:', rollbackError);
			}
		}

		throw error;
	} finally {
		await Promise.allSettled([sourcePool.close(), destinationPool.close()]);
	}
}

main().catch((error) => {
	console.error('');
	console.error('Transfer failed:');

	console.error(error);

	process.exitCode = 1;
});

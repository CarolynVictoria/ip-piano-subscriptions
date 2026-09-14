import express from 'express';
import sql from 'mssql';

import { getPool } from '../db.mjs';

const router = express.Router();

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const MAX_SEARCH_LENGTH = 200;
const MAX_STATUS_LENGTH = 100;

/* =========================================================
   Query-parameter validation
   ========================================================= */

class QueryParameterError extends Error {
	constructor(message) {
		super(message);
		this.name = 'QueryParameterError';
	}
}

function readPositiveInteger(value, { name, defaultValue, maximum }) {
	if (value === undefined) {
		return defaultValue;
	}

	if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
		throw new QueryParameterError(`${name} must be a positive integer.`);
	}

	const parsed = Number(value);

	if (!Number.isSafeInteger(parsed)) {
		throw new QueryParameterError(
			`${name} is outside the supported integer range.`,
		);
	}

	if (maximum !== undefined && parsed > maximum) {
		throw new QueryParameterError(`${name} must not exceed ${maximum}.`);
	}

	return parsed;
}

function readOptionalString(value, { name, maxLength }) {
	if (value === undefined) {
		return null;
	}

	if (typeof value !== 'string') {
		throw new QueryParameterError(`${name} must be a single string value.`);
	}

	const trimmed = value.trim();

	if (trimmed.length === 0) {
		return null;
	}

	if (trimmed.length > maxLength) {
		throw new QueryParameterError(
			`${name} must not exceed ${maxLength} characters.`,
		);
	}

	return trimmed;
}

/* =========================================================
   Subscription filtering
   ========================================================= */

function buildWhereClause({ search, status }) {
	const clauses = [];

	if (search !== null) {
		/*
		 * CHARINDEX is intentional here rather than LIKE.
		 *
		 * The user's search text is treated literally, so
		 * characters such as %, _, and [ do not unexpectedly
		 * become SQL LIKE wildcards.
		 */
		clauses.push(`
			(
				CHARINDEX(
					@search,
					COALESCE(s.user_email, N'')
				) > 0

				OR CHARINDEX(
					@search,
					COALESCE(s.user_first_name, N'')
				) > 0

				OR CHARINDEX(
					@search,
					COALESCE(s.user_last_name, N'')
				) > 0

				OR CHARINDEX(
					@search,
					COALESCE(s.user_display_name, N'')
				) > 0

				OR CHARINDEX(
					@search,
					COALESCE(s.user_personal_name, N'')
				) > 0

				OR CHARINDEX(
					@search,
					LTRIM(
						RTRIM(
							CONCAT(
								COALESCE(s.user_first_name, N''),
								N' ',
								COALESCE(s.user_last_name, N'')
							)
						)
					)
				) > 0
			)
		`);
	}

	if (status !== null) {
		clauses.push('s.status = @status');
	}

	if (clauses.length === 0) {
		return '';
	}

	return `WHERE ${clauses.join('\nAND ')}`;
}

function addFilterParameters(request, { search, status }) {
	if (search !== null) {
		request.input('search', sql.NVarChar(MAX_SEARCH_LENGTH), search);
	}

	if (status !== null) {
		request.input('status', sql.VarChar(MAX_STATUS_LENGTH), status);
	}

	return request;
}

/* =========================================================
   GET /api/subscriptions
   ========================================================= */

router.get('/', async (req, res, next) => {
	let page;
	let pageSize;
	let search;
	let status;

	try {
		page = readPositiveInteger(req.query.page, {
			name: 'page',
			defaultValue: 1,
		});

		pageSize = readPositiveInteger(req.query.pageSize, {
			name: 'pageSize',
			defaultValue: DEFAULT_PAGE_SIZE,
			maximum: MAX_PAGE_SIZE,
		});

		search = readOptionalString(req.query.q, {
			name: 'q',
			maxLength: MAX_SEARCH_LENGTH,
		});

		status = readOptionalString(req.query.status, {
			name: 'status',
			maxLength: MAX_STATUS_LENGTH,
		});
	} catch (error) {
		if (error instanceof QueryParameterError) {
			return res.status(400).json({
				ok: false,
				error: error.message,
			});
		}

		throw error;
	}

	const offset = (page - 1) * pageSize;

	const filters = {
		search,
		status,
	};

	const whereClause = buildWhereClause(filters);

	try {
		const pool = await getPool();

		/*
		 * Count the complete filtered result set.
		 */
		const countRequest = addFilterParameters(pool.request(), filters);

		const countPromise = countRequest.query(`
			SELECT
				COUNT_BIG(*) AS total
			FROM dbo.subscriptions AS s
			${whereClause};
		`);

		/*
		 * Retrieve only the requested page.
		 *
		 * subscription_id is the final sort column so that
		 * ordering remains deterministic when user names or
		 * email addresses are duplicated.
		 */
		const dataRequest = addFilterParameters(pool.request(), filters);

		dataRequest.input('offset', sql.Int, offset);

		dataRequest.input('page_size', sql.Int, pageSize);

		const dataPromise = dataRequest.query(`
			SELECT
				s.subscription_id,

				s.status,
				s.status_name,
				s.status_name_in_reports,

				s.user_uid,
				s.user_email,
				s.user_first_name,
				s.user_last_name,
				s.user_personal_name,
				s.user_display_name,

				s.start_date,
				s.end_date,

				s.auto_renew,
				s.next_bill_date,

				s.billing_plan,

				s.term_id,
				s.resource_rid,

				s.is_in_trial,

				s.shared_account_limit,
				s.can_manage_shared_subscription,

				s.acquisition_type,

				s.extract_run_id,
				s.extracted_at_utc

			FROM dbo.subscriptions AS s

			${whereClause}

			ORDER BY
				CASE
					WHEN NULLIF(
						LTRIM(RTRIM(s.user_last_name)),
						''
					) IS NULL
					THEN 1
					ELSE 0
				END,

				s.user_last_name,
				s.user_first_name,
				s.user_email,
				s.subscription_id

			OFFSET @offset ROWS
			FETCH NEXT @page_size ROWS ONLY;
		`);

		/*
		 * Build the status filter from the current SQL snapshot.
		 *
		 * This deliberately avoids hard-coding Piano status
		 * values into the application.
		 */
		const statusesPromise = pool.request().query(`
			SELECT
				s.status,
				COUNT_BIG(*) AS subscription_count

			FROM dbo.subscriptions AS s

			WHERE
				s.status IS NOT NULL
				AND LTRIM(RTRIM(s.status)) <> ''

			GROUP BY
				s.status

			ORDER BY
				s.status;
		`);

		const planSummaryPromise = pool.request().query(`
			WITH subscription_plan_counts AS (
				SELECT
					SUM(
						CAST(
							CASE
								WHEN LOWER(
									REPLACE(
										COALESCE(s.billing_plan, N''),
										N' ',
										N''
									)
								) LIKE N'%peryear%'
								THEN 1
								ELSE 0
							END
							AS BIGINT
						)
					) AS annual,

					SUM(
						CAST(
							CASE
								WHEN LOWER(
									REPLACE(
										COALESCE(s.billing_plan, N''),
										N' ',
										N''
									)
								) LIKE N'%permonth%'
								THEN 1
								ELSE 0
							END
							AS BIGINT
						)
					) AS monthly,

					SUM(
						CAST(
							CASE
								WHEN LOWER(
									REPLACE(
										COALESCE(s.billing_plan, N''),
										N' ',
										N''
									)
								) LIKE N'%every3months%'
								THEN 1
								ELSE 0
							END
							AS BIGINT
						)
					) AS quarterly,

					SUM(
						CAST(
							CASE
								WHEN
									LOWER(
										REPLACE(
											COALESCE(s.billing_plan, N''),
											N' ',
											N''
										)
									) NOT LIKE N'%peryear%'

									AND LOWER(
										REPLACE(
											COALESCE(s.billing_plan, N''),
											N' ',
											N''
										)
									) NOT LIKE N'%permonth%'

									AND LOWER(
										REPLACE(
											COALESCE(s.billing_plan, N''),
											N' ',
											N''
										)
									) NOT LIKE N'%every3months%'

								THEN 1
								ELSE 0
							END
							AS BIGINT
						)
					) AS other

				FROM dbo.subscriptions AS s
			),

			site_license_counts AS (
				SELECT
					COUNT_BIG(*) AS site_licenses
				FROM dbo.site_licensees
			)

			SELECT
				p.annual,
				p.monthly,
				p.quarterly,
				p.other,
				l.site_licenses

			FROM subscription_plan_counts AS p
			CROSS JOIN site_license_counts AS l;
		`);

		const [countResult, dataResult, statusesResult, planSummaryResult] =
			await Promise.all([
				countPromise,
				dataPromise,
				statusesPromise,
				planSummaryPromise,
			]);

		const total = Number(countResult.recordset[0]?.total ?? 0);

		const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

		const statusOptions = statusesResult.recordset.map((row) => ({
			value: row.status,
			count: Number(row.subscription_count),
		}));

		const totalSubscriptionRecords = statusOptions.reduce(
			(sum, item) => sum + item.count,
			0,
		);

		const planSummaryRow = planSummaryResult.recordset[0] ?? {};

		const planSummary = {
			annual: Number(planSummaryRow.annual ?? 0),

			monthly: Number(planSummaryRow.monthly ?? 0),

			quarterly: Number(planSummaryRow.quarterly ?? 0),

			siteLicenses: Number(planSummaryRow.site_licenses ?? 0),

			other: Number(planSummaryRow.other ?? 0),
		};

		return res.json({
			ok: true,

			items: dataResult.recordset,

			summary: {
				totalSubscriptionRecords,
				statuses: statusOptions,
				plans: planSummary,
			},

			pagination: {
				page,
				pageSize,
				total,
				totalPages,
			},

			filters: {
				q: search,
				status,
			},

			filterOptions: {
				status: statusOptions,
			},
		});
	} catch (error) {
		return next(error);
	}
});

export default router;

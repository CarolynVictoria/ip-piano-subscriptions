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
	WITH payment_subscription_base AS (
		SELECT
			s.status,
			s.status_name_in_reports,
			s.auto_renew,
			s.shared_account_limit,

			LOWER(
				REPLACE(
					COALESCE(s.billing_plan, N''),
					N' ',
					N''
				)
			) AS normalized_plan

		FROM dbo.subscriptions AS s

		WHERE EXISTS (
			SELECT 1
			FROM dbo.terms AS t
			WHERE
				t.term_id = s.term_id
				AND t.type = 'payment'
		)
	),

	renewal_counts AS (
		SELECT
			SUM(
				CAST(
					CASE
						WHEN
							auto_renew = 1
							AND normalized_plan LIKE N'%peryear%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS all_annual,

			SUM(
				CAST(
					CASE
						WHEN
							auto_renew = 1
							AND normalized_plan LIKE N'%permonth%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS all_monthly,

			SUM(
				CAST(
					CASE
						WHEN
							auto_renew = 1
							AND normalized_plan LIKE N'%every3months%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS all_quarterly,

			SUM(
				CAST(
					CASE
						WHEN auto_renew = 0
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS all_wont_renew,

			SUM(
				CAST(
					CASE
						WHEN
							auto_renew = 0
							AND normalized_plan LIKE N'%peryear%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS all_wont_renew_annual,

			SUM(
				CAST(
					CASE
						WHEN
							auto_renew = 0
							AND normalized_plan LIKE N'%permonth%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS all_wont_renew_monthly,

			SUM(
				CAST(
					CASE
						WHEN
							auto_renew = 0
							AND normalized_plan LIKE N'%every3months%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS all_wont_renew_quarterly,

			SUM(
				CAST(
					CASE
						WHEN
							status_name_in_reports = 'active'
							AND auto_renew = 1
							AND normalized_plan LIKE N'%peryear%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS active_annual,

			SUM(
				CAST(
					CASE
						WHEN
							status_name_in_reports = 'active'
							AND auto_renew = 1
							AND normalized_plan LIKE N'%permonth%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS active_monthly,

			SUM(
				CAST(
					CASE
						WHEN
							status_name_in_reports = 'active'
							AND auto_renew = 1
							AND normalized_plan LIKE N'%every3months%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS active_quarterly,

			SUM(
				CAST(
					CASE
						WHEN
							status_name_in_reports = 'active'
							AND auto_renew = 0
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS active_wont_renew,

			SUM(
				CAST(
					CASE
						WHEN
							status_name_in_reports = 'active'
							AND auto_renew = 0
							AND normalized_plan LIKE N'%peryear%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS active_wont_renew_annual,

			SUM(
				CAST(
					CASE
						WHEN
							status_name_in_reports = 'active'
							AND auto_renew = 0
							AND normalized_plan LIKE N'%permonth%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS active_wont_renew_monthly,

			SUM(
				CAST(
					CASE
						WHEN
							status_name_in_reports = 'active'
							AND auto_renew = 0
							AND normalized_plan LIKE N'%every3months%'
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS active_wont_renew_quarterly

		FROM payment_subscription_base
	),

	subscription_type_counts AS (
		SELECT
			SUM(
				CAST(
					CASE
						WHEN COALESCE(shared_account_limit, 0) <= 0
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS all_single_user,

			SUM(
				CAST(
					CASE
						WHEN COALESCE(shared_account_limit, 0) > 0
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS all_shared_subscription,

			SUM(
				CAST(
					CASE
						WHEN
							status_name_in_reports = 'active'
							AND COALESCE(shared_account_limit, 0) <= 0
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS active_single_user,

			SUM(
				CAST(
					CASE
						WHEN
							status_name_in_reports = 'active'
							AND COALESCE(shared_account_limit, 0) > 0
						THEN 1
						ELSE 0
					END
					AS BIGINT
				)
			) AS active_shared_subscription

		FROM payment_subscription_base
	),

	site_license_counts AS (
		SELECT
			(
				SELECT COUNT_BIG(*)
				FROM dbo.site_licensees
			) AS all_site_licenses,

			(
				SELECT COUNT_BIG(*)
				FROM dbo.site_licensees AS sl
				WHERE EXISTS (
					SELECT 1
					FROM dbo.site_contracts AS sc
					WHERE
						sc.licensee_id = sl.licensee_id
						AND sc.contract_is_active = 1
				)
			) AS active_site_licenses
	),

	access_granted_counts AS (
		SELECT
			COUNT_BIG(DISTINCT user_uid) AS access_granted_users

		FROM dbo.access_granted

		WHERE
			user_uid IS NOT NULL
			AND LTRIM(RTRIM(user_uid)) <> ''
	)

	SELECT
		r.all_annual,
		r.all_monthly,
		r.all_quarterly,
		r.all_wont_renew,
		r.all_wont_renew_annual,
		r.all_wont_renew_monthly,
		r.all_wont_renew_quarterly,

		r.active_annual,
		r.active_monthly,
		r.active_quarterly,
		r.active_wont_renew,
		r.active_wont_renew_annual,
		r.active_wont_renew_monthly,
		r.active_wont_renew_quarterly,

		t.all_single_user,
		t.all_shared_subscription,
		t.active_single_user,
		t.active_shared_subscription,

		l.all_site_licenses,
		l.active_site_licenses,

		a.access_granted_users

	FROM renewal_counts AS r
	CROSS JOIN subscription_type_counts AS t
	CROSS JOIN site_license_counts AS l
	CROSS JOIN access_granted_counts AS a;
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

		const accessGrantedUsers = Number(planSummaryRow.access_granted_users ?? 0);

		const activeSubscriptionRecords =
			Number(planSummaryRow.active_single_user ?? 0) +
			Number(planSummaryRow.active_shared_subscription ?? 0);

		const allPlanSummary = {
			annual: Number(planSummaryRow.all_annual ?? 0),

			monthly: Number(planSummaryRow.all_monthly ?? 0),

			quarterly: Number(planSummaryRow.all_quarterly ?? 0),

			wontRenew: Number(planSummaryRow.all_wont_renew ?? 0),

			wontRenewBreakdown: {
				annual: Number(planSummaryRow.all_wont_renew_annual ?? 0),

				monthly: Number(planSummaryRow.all_wont_renew_monthly ?? 0),

				quarterly: Number(planSummaryRow.all_wont_renew_quarterly ?? 0),
			},
		};

		const activePlanSummary = {
			annual: Number(planSummaryRow.active_annual ?? 0),

			monthly: Number(planSummaryRow.active_monthly ?? 0),

			quarterly: Number(planSummaryRow.active_quarterly ?? 0),

			wontRenew: Number(planSummaryRow.active_wont_renew ?? 0),

			wontRenewBreakdown: {
				annual: Number(planSummaryRow.active_wont_renew_annual ?? 0),

				monthly: Number(planSummaryRow.active_wont_renew_monthly ?? 0),

				quarterly: Number(planSummaryRow.active_wont_renew_quarterly ?? 0),
			},
		};

		const allSubscriptionTypes = {
			singleUser: Number(planSummaryRow.all_single_user ?? 0),

			sharedSubscription: Number(planSummaryRow.all_shared_subscription ?? 0),

			siteLicense: Number(planSummaryRow.all_site_licenses ?? 0),

			accessGranted: accessGrantedUsers,
		};

		const activeSubscriptionTypes = {
			singleUser: Number(planSummaryRow.active_single_user ?? 0),

			sharedSubscription: Number(
				planSummaryRow.active_shared_subscription ?? 0,
			),

			siteLicense: Number(planSummaryRow.active_site_licenses ?? 0),

			accessGranted: accessGrantedUsers,
		};

		return res.json({
			ok: true,

			items: dataResult.recordset,

			summary: {
				all: {
					totalSubscriptionRecords,
					statuses: statusOptions,
					plans: allPlanSummary,
					subscriptionTypes: allSubscriptionTypes,
				},

				active: {
					totalSubscriptionRecords: activeSubscriptionRecords,

					statuses: statusOptions.filter((item) => item.value === 'active'),

					plans: activePlanSummary,
					subscriptionTypes: activeSubscriptionTypes,
				},
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

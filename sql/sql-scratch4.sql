
	SELECT COUNT(*) shared_subscription_children FROM dbo.subscription_shared_accounts

	SELECT COUNT(*) AS site_license_email_children FROM dbo.site_contract_users
	
	SELECT COUNT(*) AS site_license_domain_children FROM dbo.site_contract_domain_users

/* =========================================================
   1. Shared Subscription child-account population
   ========================================================= */

SELECT
	COUNT_BIG(*) AS total_rows,

	COUNT_BIG(
		DISTINCT NULLIF(LTRIM(RTRIM(account_id)), '')
	) AS distinct_account_ids,

	COUNT_BIG(
		DISTINCT NULLIF(LTRIM(RTRIM(user_id)), '')
	) AS distinct_user_ids,

	COUNT_BIG(
		DISTINCT NULLIF(LOWER(LTRIM(RTRIM(email))), '')
	) AS distinct_emails,

	SUM(
		CASE
			WHEN active = 1 THEN CAST(1 AS BIGINT)
			ELSE CAST(0 AS BIGINT)
		END
	) AS active_rows,

	SUM(
		CASE
			WHEN redeemed IS NOT NULL
				AND redeemed <> 0
			THEN CAST(1 AS BIGINT)
			ELSE CAST(0 AS BIGINT)
		END
	) AS redeemed_rows

FROM dbo.subscription_shared_accounts;


/* =========================================================
   2. Shared children grouped by child active flag
   ========================================================= */

SELECT
	active,
	COUNT_BIG(*) AS row_count
FROM dbo.subscription_shared_accounts
GROUP BY active
ORDER BY active;


/* =========================================================
   3. Shared children by parent access state
   ========================================================= */

SELECT
	s.status_name_in_reports,
	COUNT_BIG(*) AS child_rows,

	SUM(
		CASE
			WHEN sa.active = 1 THEN CAST(1 AS BIGINT)
			ELSE CAST(0 AS BIGINT)
		END
	) AS child_active_rows

FROM dbo.subscription_shared_accounts AS sa

INNER JOIN dbo.subscriptions AS s
	ON s.subscription_id = sa.subscription_id

GROUP BY
	s.status_name_in_reports

ORDER BY
	s.status_name_in_reports;


/* =========================================================
   4. Explicit site-license users
   ========================================================= */

SELECT
	COUNT_BIG(*) AS total_rows,

	COUNT_BIG(
		DISTINCT NULLIF(LTRIM(RTRIM(contract_user_id)), '')
	) AS distinct_contract_user_ids,

	COUNT_BIG(
		DISTINCT NULLIF(LOWER(LTRIM(RTRIM(email))), '')
	) AS distinct_emails

FROM dbo.site_contract_users;


/* =========================================================
   5. Explicit site-license user statuses
   ========================================================= */

SELECT
	status,
	COUNT_BIG(*) AS row_count
FROM dbo.site_contract_users
GROUP BY status
ORDER BY status;


/* =========================================================
   6. Domain site-license users
   ========================================================= */

SELECT
	COUNT_BIG(*) AS total_rows,

	COUNT_BIG(
		DISTINCT NULLIF(LTRIM(RTRIM(contract_user_id)), '')
	) AS distinct_contract_user_ids,

	COUNT_BIG(
		DISTINCT NULLIF(LOWER(LTRIM(RTRIM(email))), '')
	) AS distinct_emails

FROM dbo.site_contract_domain_users;


/* =========================================================
   7. Domain site-license user statuses
   ========================================================= */

SELECT
	status,
	COUNT_BIG(*) AS row_count
FROM dbo.site_contract_domain_users
GROUP BY status
ORDER BY status;


/* =========================================================
   8. Overlap between the two site-license user populations
   ========================================================= */

SELECT
	COUNT_BIG(*) AS overlapping_email_count
FROM (
	SELECT DISTINCT
		LOWER(LTRIM(RTRIM(email))) AS email
	FROM dbo.site_contract_users
	WHERE
		email IS NOT NULL
		AND LTRIM(RTRIM(email)) <> ''

	INTERSECT

	SELECT DISTINCT
		LOWER(LTRIM(RTRIM(email))) AS email
	FROM dbo.site_contract_domain_users
	WHERE
		email IS NOT NULL
		AND LTRIM(RTRIM(email)) <> ''
) AS overlap;


/* =========================================================
   9. Combined unique site-license users by email
   ========================================================= */

SELECT
	COUNT_BIG(*) AS combined_distinct_site_license_emails
FROM (
	SELECT
		LOWER(LTRIM(RTRIM(email))) AS email
	FROM dbo.site_contract_users
	WHERE
		email IS NOT NULL
		AND LTRIM(RTRIM(email)) <> ''

	UNION

	SELECT
		LOWER(LTRIM(RTRIM(email))) AS email
	FROM dbo.site_contract_domain_users
	WHERE
		email IS NOT NULL
		AND LTRIM(RTRIM(email)) <> ''
) AS combined_users;
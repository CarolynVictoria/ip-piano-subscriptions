WITH active_shared_subscriptions AS (
	SELECT
		s.subscription_id,
		s.shared_account_limit

	FROM dbo.subscriptions AS s

	WHERE
		s.status_name_in_reports = 'active'
		AND COALESCE(s.shared_account_limit, 0) > 0
		AND EXISTS (
			SELECT 1
			FROM dbo.terms AS t
			WHERE
				t.term_id = s.term_id
				AND t.type = 'payment'
		)
)

SELECT
	(
		SELECT COUNT_BIG(*)
		FROM active_shared_subscriptions
	) AS active_shared_subscription_count,

	(
		SELECT SUM(CAST(shared_account_limit AS BIGINT))
		FROM active_shared_subscriptions
	) AS available_child_seats,

	COUNT_BIG(sa.account_id) AS shared_account_rows,

	SUM(
		CASE
			WHEN sa.redeemed IS NOT NULL
			THEN CAST(1 AS BIGINT)
			ELSE CAST(0 AS BIGINT)
		END
	) AS redeemed_rows,

	SUM(
		CASE
			WHEN sa.user_id IS NOT NULL
				AND LTRIM(RTRIM(sa.user_id)) <> ''
			THEN CAST(1 AS BIGINT)
			ELSE CAST(0 AS BIGINT)
		END
	) AS rows_with_user_id,

	COUNT_BIG(
		DISTINCT NULLIF(LTRIM(RTRIM(sa.user_id)), '')
	) AS distinct_user_ids,

	COUNT_BIG(
		DISTINCT NULLIF(LOWER(LTRIM(RTRIM(sa.email))), '')
	) AS distinct_emails,

	SUM(
		CASE
			WHEN sa.redeemed IS NULL
			THEN CAST(1 AS BIGINT)
			ELSE CAST(0 AS BIGINT)
		END
	) AS unredeemed_rows

FROM active_shared_subscriptions AS p

LEFT JOIN dbo.subscription_shared_accounts AS sa
	ON sa.subscription_id = p.subscription_id;

 SELECT *
FROM dbo.subscription_log_export
WHERE
	LOWER(COALESCE(Summary, '')) LIKE '%revok%'
	OR LOWER(COALESCE(Subscription_status, '')) LIKE '%revok%'
	OR LOWER(COALESCE(Upgrade_status, '')) LIKE '%revok%'
	OR LOWER(COALESCE(Term_name, '')) LIKE '%revok%'
	OR LOWER(COALESCE(Template_name, '')) LIKE '%revok%'
	OR LOWER(COALESCE(Offer_name, '')) LIKE '%revok%';
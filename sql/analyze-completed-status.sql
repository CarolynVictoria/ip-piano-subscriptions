SELECT *
FROM dbo.subscription_log_export
WHERE Subscription_status = 'Completed'
ORDER BY User_email ASC;


SELECT
	COALESCE(Subscription_status, 'TOTAL') AS Subscription_status,
	COUNT(*) AS StatusCount
FROM dbo.subscription_log_export
GROUP BY ROLLUP (Subscription_status)
ORDER BY
	CASE
		WHEN Subscription_status IS NULL THEN 1
		ELSE 0
	END,
	Subscription_status;

 /* compare subscription log data to api extract data */
 SELECT
	s.status AS ApiStatus,
	s.status_name AS ApiStatusName,
	s.status_name_in_reports AS ApiStatusNameInReports,
	l.Subscription_status AS SubscriptionLogStatus,
	COUNT_BIG(*) AS SubscriptionCount

FROM dbo.subscriptions AS s

INNER JOIN dbo.subscription_log_export AS l
	ON l.Subscription_ID = s.subscription_id

GROUP BY
	s.status,
	s.status_name,
	s.status_name_in_reports,
	l.Subscription_status

ORDER BY
	s.status,
	l.Subscription_status,
	s.status_name_in_reports;

 /* check the Completed status specifically */
SELECT
	l.Term_type,
	s.acquisition_type,
	l.Payment_source,
	l.Shared_subscriptions,
	COUNT_BIG(*) AS SubscriptionCount,

	SUM(
		CASE
			WHEN s.status_name_in_reports = 'active'
			THEN 1
			ELSE 0
		END
	) AS ActiveAccessCount,

	SUM(
		CASE
			WHEN s.status_name_in_reports = 'won''t renew'
			THEN 1
			ELSE 0
		END
	) AS EndedAccessCount

FROM dbo.subscriptions AS s

INNER JOIN dbo.subscription_log_export AS l
	ON l.Subscription_ID = s.subscription_id

WHERE s.status = 'completed'

GROUP BY
	l.Term_type,
	s.acquisition_type,
	l.Payment_source,
	l.Shared_subscriptions

ORDER BY
	SubscriptionCount DESC;

 /* Who are the Completed exceptions that are not site licenses? */
 SELECT
	s.subscription_id,
	s.status,
	s.status_name,
	s.status_name_in_reports,
	s.user_uid,
	s.user_email,
	s.billing_plan,
	s.shared_account_limit,
	s.can_manage_shared_subscription,
	s.acquisition_type,

	l.Summary,
	l.Term_type,
	l.Term_ID,
	l.Term_name,
	l.Subscription_status,
	l.Access_expiration_date,
	l.Shared_subscriptions,
	l.Payment_source,
	l.Regular_price,
	l.Total_charged,
	l.Charge_count

FROM dbo.subscriptions AS s

INNER JOIN dbo.subscription_log_export AS l
	ON l.Subscription_ID = s.subscription_id

WHERE
	s.status = 'completed'
	AND l.Term_type = 'Payment'

ORDER BY
	s.user_email,
	s.subscription_id;
SELECT
	status,
	status_name_in_reports,
	auto_renew,
	COUNT_BIG(*) AS subscription_count
FROM dbo.subscriptions
WHERE status_name_in_reports = 'active'
GROUP BY
	status,
	status_name_in_reports,
	auto_renew
ORDER BY
	status,
	auto_renew;

 SELECT
	s.status,
	s.status_name_in_reports,
	s.auto_renew,
	COUNT_BIG(*) AS subscription_count
FROM dbo.subscriptions AS s
WHERE
	s.status_name_in_reports = 'active'
	AND EXISTS (
		SELECT 1
		FROM dbo.terms AS t
		WHERE
			t.term_id = s.term_id
			AND t.type = 'payment'
	)
GROUP BY
	s.status,
	s.status_name_in_reports,
	s.auto_renew
ORDER BY
	s.status,
	s.auto_renew;
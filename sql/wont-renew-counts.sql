WITH active_wont_renew AS (
	SELECT
		LOWER(
			REPLACE(
				COALESCE(s.billing_plan, N''),
				N' ',
				N''
			)
		) AS normalized_plan
	FROM dbo.subscriptions AS s
	WHERE
		s.status_name_in_reports = 'active'
		AND s.auto_renew = 0
		AND EXISTS (
			SELECT 1
			FROM dbo.terms AS t
			WHERE
				t.term_id = s.term_id
				AND t.type = 'payment'
		)
)
SELECT
	CASE
		WHEN normalized_plan LIKE N'%peryear%'
			THEN 'Annual'

		WHEN normalized_plan LIKE N'%permonth%'
			THEN 'Monthly'

		WHEN normalized_plan LIKE N'%every3months%'
			THEN 'Quarterly'

		ELSE 'Other'
	END AS renewal_cadence,

	COUNT_BIG(*) AS subscription_count

FROM active_wont_renew

GROUP BY
	CASE
		WHEN normalized_plan LIKE N'%peryear%'
			THEN 'Annual'

		WHEN normalized_plan LIKE N'%permonth%'
			THEN 'Monthly'

		WHEN normalized_plan LIKE N'%every3months%'
			THEN 'Quarterly'

		ELSE 'Other'
	END

ORDER BY renewal_cadence;
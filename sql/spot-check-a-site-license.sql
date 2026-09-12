SELECT
    c.licensee_name,
    c.contract_id,
    c.name AS contract_name,
    c.contract_type,
    c.contract_is_active,
    c.seats_number,

    COUNT(DISTINCT d.contract_domain_id) AS domain_count,

    COUNT(DISTINCT cu.contract_user_id) AS direct_user_count,

    COUNT(DISTINCT du.contract_user_id) AS domain_user_count,

    COUNT(
        DISTINCT CASE
            WHEN cu.status = 'ACTIVE'
            THEN cu.contract_user_id
        END
    )
    +
    COUNT(
        DISTINCT CASE
            WHEN du.status = 'ACTIVE'
            THEN du.contract_user_id
        END
    ) AS redeemed_user_count

FROM dbo.contracts c

LEFT JOIN dbo.contract_domains d
    ON d.contract_id = c.contract_id

LEFT JOIN dbo.contract_users cu
    ON cu.contract_id = c.contract_id

LEFT JOIN dbo.contract_domain_users du
    ON du.contract_id = c.contract_id

WHERE c.licensee_name = 'Harvard Library'

GROUP BY
    c.licensee_name,
    c.contract_id,
    c.name,
    c.contract_type,
    c.contract_is_active,
    c.seats_number

ORDER BY c.name;
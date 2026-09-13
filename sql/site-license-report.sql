WITH direct_users AS (
    SELECT
        contract_id,
        COUNT(*) AS direct_users,
        SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_users,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_users,
        SUM(CASE WHEN status = 'REVOKED' THEN 1 ELSE 0 END) AS revoked_users,
        SUM(CASE WHEN status = 'INVALID_EMAIL' THEN 1 ELSE 0 END) AS invalid_email_users
    FROM dbo.site_contract_users
    GROUP BY contract_id
),

domain_users AS (
    SELECT
        contract_id,
        COUNT(*) AS domain_users,
        SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_users,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_users,
        SUM(CASE WHEN status = 'REVOKED' THEN 1 ELSE 0 END) AS revoked_users,
        SUM(CASE WHEN status = 'INVALID_EMAIL' THEN 1 ELSE 0 END) AS invalid_email_users
    FROM    dbo.site_contract_domain_users
    GROUP BY contract_id
),

domains AS (
    SELECT
        contract_id,
        COUNT(*) AS domain_count
    FROM dbo.site_contract_domains
    GROUP BY contract_id
)

SELECT
    c.licensee_name,
    c.contract_id,
    c.name AS contract_name,
    c.contract_type,
    c.contract_is_active,
    c.seats_number,

    COALESCE(d.domain_count, 0) AS domain_count,

    COALESCE(du.direct_users, 0)
        + COALESCE(dmu.domain_users, 0) AS total_users,

    COALESCE(du.active_users, 0)
        + COALESCE(dmu.active_users, 0) AS active_users,

    COALESCE(du.pending_users, 0)
        + COALESCE(dmu.pending_users, 0) AS pending_users,

    COALESCE(du.revoked_users, 0)
        + COALESCE(dmu.revoked_users, 0) AS revoked_users,

    COALESCE(du.invalid_email_users, 0)
        + COALESCE(dmu.invalid_email_users, 0) AS invalid_email_users

FROM dbo.site_contracts c

LEFT JOIN direct_users du
    ON du.contract_id = c.contract_id

LEFT JOIN domain_users dmu
    ON dmu.contract_id = c.contract_id

LEFT JOIN domains d
    ON d.contract_id = c.contract_id

ORDER BY
    c.licensee_name,
    c.name;
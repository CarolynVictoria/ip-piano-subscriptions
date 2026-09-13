SELECT
    -- Subscription record
    s.subscription_id,
    s.user_email AS subscriber_email,
    s.user_first_name AS subscriber_first_name,
    s.user_last_name AS subscriber_last_name,
    s.status AS subscription_status,
    s.status_name AS subscription_status_name,
    s.term_id,
    s.resource_rid,
    s.start_date AS subscription_start_date,
    s.end_date AS subscription_end_date,

    -- Site-license owner
    l.licensee_id,
    l.name AS licensee_name,

    -- Site-license contract
    c.contract_id,
    c.name AS contract_name,
    c.contract_type,
    c.contract_is_active,
    c.seats_number,
    c.rid AS contract_resource_rid,

    -- Domain through which this user belongs
    cdu.contract_domain_id,
    cdu.contract_domain_value,

    -- Site-license child-user record
    cdu.contract_user_id,
    cdu.email AS contract_user_email,
    cdu.first_name AS contract_user_first_name,
    cdu.last_name AS contract_user_last_name,
    cdu.status AS contract_user_status

FROM dbo.subscriptions AS s

INNER JOIN dbo.site_contracts AS c
    ON c.contract_id = s.term_id

INNER JOIN dbo.site_licensees AS l
    ON l.licensee_id = c.licensee_id

INNER JOIN dbo.site_contract_domain_users AS cdu
    ON cdu.contract_id = c.contract_id
    AND cdu.email = s.user_email

WHERE s.user_email = N'aaryanrawal@college.harvard.edu';
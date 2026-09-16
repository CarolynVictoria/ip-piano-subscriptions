select count(*) from dbo.access_granted 

SELECT
    user_uid,
    user_email,
    COUNT(*) AS active_grant_count
FROM dbo.access_granted
GROUP BY
    user_uid,
    user_email
HAVING COUNT(*) > 1
ORDER BY
    active_grant_count DESC,
    user_email;
IF COL_LENGTH('dbo.subscriptions', 'subscription_json') IS NOT NULL
BEGIN
    ALTER TABLE dbo.subscriptions
    DROP COLUMN subscription_json;
END;

IF COL_LENGTH('dbo.previous_subscriptions', 'subscription_json') IS NOT NULL
BEGIN
    ALTER TABLE dbo.previous_subscriptions
    DROP COLUMN subscription_json;
END;

IF COL_LENGTH('dbo.subscription_shared_accounts', 'shared_account_json') IS NOT NULL
BEGIN
    ALTER TABLE dbo.subscription_shared_accounts
    DROP COLUMN shared_account_json;
END;

IF COL_LENGTH('dbo.previous_subscription_shared_accounts', 'shared_account_json') IS NOT NULL
BEGIN
    ALTER TABLE dbo.previous_subscription_shared_accounts
    DROP COLUMN shared_account_json;
END;
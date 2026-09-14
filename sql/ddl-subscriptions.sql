/* =========================================================
   Piano.io subscription extraction tables

   Design rules:
   - Preserve Piano source values as returned.
   - Do not deduplicate, consolidate, or reinterpret source data.
   - Do not convert empty strings to NULL.
   - Do not convert epoch timestamps to datetime during load.
   - Do not duplicate canonical Resource or Term data already
     stored in dbo.resources and dbo.terms.
   - Keep term_id and resource_rid as relational reference values.
   - Flatten the nested subscription user because there is no
     separate canonical users table in this extraction schema.
   - subscription_shared_accounts contains only child accounts
     from ordinary shared/payment subscriptions.
   - Site-license contract users remain exclusively in the
     site-license contract tables and are not loaded into
     subscription_shared_accounts.
   - Avoid foreign keys and source-field UNIQUE constraints.
   - Internal row_id values are database-only identifiers.
   ========================================================= */


/* ---------------------------------------------------------
   Current subscriptions

   Source:
   GET /publisher/subscription/list

   One row per object in subscriptions[].

   term:
     Only term_id is stored here. Full Term data is already in
     dbo.terms.

   resource:
     Only resource_rid is stored here. Full Resource data is
     already in dbo.resources.

   user:
     Flattened because there is no separate canonical Piano
     users table in the current migration schema.

   shared_accounts:
     Eligible ordinary shared-subscription children are stored
     in dbo.subscription_shared_accounts.

   --------------------------------------------------------- */

create table dbo.subscriptions (
    row_id                              bigint identity(1,1) not null
        constraint pk_subscriptions primary key,

    extract_run_id                      bigint null,

    subscription_id                     varchar(64) null,

    auto_renew                          bit null,
    next_bill_date                      bigint null,
    payment_method                      nvarchar(500) null,
    user_payment_info_id                varchar(64) null,

    upi_ext_customer_id                 nvarchar(255) null,
    upi_ext_customer_id_label           nvarchar(255) null,

    billing_plan                        nvarchar(1000) null,

    end_date                            bigint null,

    cancelable                          bit null,
    cancelable_and_refundadle           bit null,

    psc_subscriber_number               nvarchar(255) null,
    conversion_result                   nvarchar(max) null,
    external_api_name                   nvarchar(255) null,

    status                              varchar(100) null,
    status_name                         nvarchar(255) null,
    status_name_in_reports              nvarchar(255) null,

    term_id                             varchar(64) null,
    resource_rid                        varchar(64) null,

    user_uid                            varchar(64) null,
    user_email                          nvarchar(320) null,
    user_first_name                     nvarchar(255) null,
    user_last_name                      nvarchar(255) null,
    user_personal_name                  nvarchar(500) null,
    user_image1                         nvarchar(2000) null,
    user_create_date                    bigint null,
    user_last_visit                     bigint null,
    user_last_login                     bigint null,
    user_display_name                   nvarchar(500) null,

    start_date                          bigint null,

    is_in_trial                         bit null,
    trial_amount                        decimal(19,6) null,
    trial_currency                      varchar(16) null,

    charge_count                        int null,
    acquisition_type                    varchar(100) null,

    shared_account_limit                int null,
    can_manage_shared_subscription      bit null,

    extracted_at_utc                    datetime2(0) not null
        constraint df_subscriptions_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Current subscription shared accounts

   Source:
   shared_accounts[] nested under ordinary subscriptions from
   GET /publisher/subscription/list.

   One row per child object in shared_accounts[].

   This table contains only child accounts associated with
   ordinary shared/payment subscriptions.

   Site-license contract users belong in the existing
   site-license contract tables and must not be loaded here.

   shared_account_number preserves the child's position in the
   source shared_accounts[] array.

   --------------------------------------------------------- */

create table dbo.subscription_shared_accounts (
    row_id                      bigint identity(1,1) not null
        constraint pk_subscription_shared_accounts primary key,

    extract_run_id              bigint null,

    subscription_id             varchar(64) null,
    shared_account_number       int null,

    account_id                  varchar(64) null,
    user_id                     varchar(64) null,

    email                       nvarchar(320) null,
    first_name                  nvarchar(255) null,
    last_name                   nvarchar(255) null,
    personal_name               nvarchar(500) null,

    redeemed                    bigint null,
    active                      bit null,

    extracted_at_utc            datetime2(0) not null
        constraint df_subscription_shared_accounts_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Previous subscriptions

   One-generation snapshot of dbo.subscriptions.

   row_id is regenerated when current rows are copied into the
   previous table. All extraction/source columns are copied.
   --------------------------------------------------------- */

create table dbo.previous_subscriptions (
    row_id                              bigint identity(1,1) not null
        constraint pk_previous_subscriptions primary key,

    extract_run_id                      bigint null,

    subscription_id                     varchar(64) null,

    auto_renew                          bit null,
    next_bill_date                      bigint null,
    payment_method                      nvarchar(500) null,
    user_payment_info_id                varchar(64) null,

    upi_ext_customer_id                 nvarchar(255) null,
    upi_ext_customer_id_label           nvarchar(255) null,

    billing_plan                        nvarchar(1000) null,

    end_date                            bigint null,

    cancelable                          bit null,
    cancelable_and_refundadle           bit null,

    psc_subscriber_number               nvarchar(255) null,
    conversion_result                   nvarchar(max) null,
    external_api_name                   nvarchar(255) null,

    status                              varchar(100) null,
    status_name                         nvarchar(255) null,
    status_name_in_reports              nvarchar(255) null,

    term_id                             varchar(64) null,
    resource_rid                        varchar(64) null,

    user_uid                            varchar(64) null,
    user_email                          nvarchar(320) null,
    user_first_name                     nvarchar(255) null,
    user_last_name                      nvarchar(255) null,
    user_personal_name                  nvarchar(500) null,
    user_image1                         nvarchar(2000) null,
    user_create_date                    bigint null,
    user_last_visit                     bigint null,
    user_last_login                     bigint null,
    user_display_name                   nvarchar(500) null,

    start_date                          bigint null,

    is_in_trial                         bit null,
    trial_amount                        decimal(19,6) null,
    trial_currency                      varchar(16) null,

    charge_count                        int null,
    acquisition_type                    varchar(100) null,

    shared_account_limit                int null,
    can_manage_shared_subscription      bit null,

    extracted_at_utc                    datetime2(0) not null
        constraint df_previous_subscriptions_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Previous subscription shared accounts

   One-generation snapshot of
   dbo.subscription_shared_accounts.
   --------------------------------------------------------- */

create table dbo.previous_subscription_shared_accounts (
    row_id                      bigint identity(1,1) not null
        constraint pk_previous_subscription_shared_accounts primary key,

    extract_run_id              bigint null,

    subscription_id             varchar(64) null,
    shared_account_number       int null,

    account_id                  varchar(64) null,
    user_id                     varchar(64) null,

    email                       nvarchar(320) null,
    first_name                  nvarchar(255) null,
    last_name                   nvarchar(255) null,
    personal_name               nvarchar(500) null,

    redeemed                    bigint null,
    active                      bit null,

    extracted_at_utc            datetime2(0) not null
        constraint df_previous_subscription_shared_accounts_extracted_at
        default sysutcdatetime()
);
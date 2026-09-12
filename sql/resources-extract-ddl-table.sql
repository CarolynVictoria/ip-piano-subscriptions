/* =========================================================
   Piano.io subscription reference-data tables

   Sources:
   - /publisher/resource/list
   - /publisher/term/list

   Design rules:
   - Preserve Piano source values as returned.
   - Do not deduplicate, consolidate, or clean source data.
   - Do not convert empty strings to NULL.
   - Do not convert Piano epoch timestamps to datetime.
   - Represent meaningful repeating structures relationally.
   - Retain complete source objects as JSON for audit.
   - Do not relationalize schedules at this stage.
   - Offers are outside the current migration scope.
   - Avoid foreign keys and source-field UNIQUE constraints.
   - No secondary indexes are created at this stage.
   - Internal row_id values are database-only identifiers.

   dbo.extract_runs already exists and is NOT recreated here.
   ========================================================= */


/* =========================================================
   Drop existing reference-data tables

   Children are dropped before their parent tables.
   ========================================================= */

drop table if exists dbo.previous_term_change_option_show_options;
drop table if exists dbo.previous_term_change_options;
drop table if exists dbo.previous_term_billing_plan_rows;
drop table if exists dbo.previous_terms;
drop table if exists dbo.previous_resources;

drop table if exists dbo.term_change_option_show_options;
drop table if exists dbo.term_change_options;
drop table if exists dbo.term_billing_plan_rows;
drop table if exists dbo.terms;
drop table if exists dbo.resources;


/* =========================================================
   RESOURCES
   ========================================================= */


/* ---------------------------------------------------------
   Current resources

   Source:
   all-resources.json

   One row per Piano Resource object.
   --------------------------------------------------------- */

create table dbo.resources (
    row_id                  bigint identity(1,1) not null
        constraint pk_resources primary key,

    extract_run_id          bigint null,

    rid                     varchar(64) null,
    aid                     varchar(64) null,

    deleted                 bit null,
    disabled                bit null,

    create_date             bigint null,
    update_date             bigint null,
    publish_date            bigint null,

    name                    nvarchar(500) null,
    description             nvarchar(max) null,

    image_url               nvarchar(2000) null,

    type                    varchar(100) null,
    type_label              nvarchar(255) null,

    purchase_url            nvarchar(2000) null,
    resource_url            nvarchar(2000) null,

    external_id             nvarchar(500) null,
    is_fbia_resource        bit null,

    resource_json           nvarchar(max) null,

    extracted_at_utc        datetime2(0) not null
        constraint df_resources_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Previous resources
   --------------------------------------------------------- */

create table dbo.previous_resources (
    row_id                  bigint identity(1,1) not null
        constraint pk_previous_resources primary key,

    extract_run_id          bigint null,

    rid                     varchar(64) null,
    aid                     varchar(64) null,

    deleted                 bit null,
    disabled                bit null,

    create_date             bigint null,
    update_date             bigint null,
    publish_date            bigint null,

    name                    nvarchar(500) null,
    description             nvarchar(max) null,

    image_url               nvarchar(2000) null,

    type                    varchar(100) null,
    type_label              nvarchar(255) null,

    purchase_url            nvarchar(2000) null,
    resource_url            nvarchar(2000) null,

    external_id             nvarchar(500) null,
    is_fbia_resource        bit null,

    resource_json           nvarchar(max) null,

    extracted_at_utc        datetime2(0) not null
        constraint df_previous_resources_extracted_at
        default sysutcdatetime()
);


/* =========================================================
   TERMS
   ========================================================= */


/* ---------------------------------------------------------
   Current terms

   Source:
   all-terms.json

   One row per Piano Term object.

   The embedded resource object is represented by rid because
   Resources are independently extracted into dbo.resources.

   payment_billing_plan_table and change_options are expanded
   into child tables below.

   schedule is deliberately not expanded into relational
   tables for the main-subscription migration.

   term_json contains the complete original Piano Term object.
   --------------------------------------------------------- */

create table dbo.terms (
    row_id                                      bigint identity(1,1) not null
        constraint pk_terms primary key,

    extract_run_id                              bigint null,

    aid                                         varchar(64) null,
    term_id                                     varchar(64) null,
    rid                                         varchar(64) null,

    name                                        nvarchar(500) null,
    description                                 nvarchar(max) null,

    type                                        varchar(100) null,
    type_name                                   nvarchar(255) null,

    create_date                                 bigint null,
    update_date                                 bigint null,

    shared_account_count                        int null,
    shared_redemption_url                       nvarchar(2000) null,
    collect_address                             bit null,

    /* Registration terms */

    registration_access_period                  int null,
    registration_grace_period                   int null,

    /* Custom terms */

    custom_require_user                         bit null,
    custom_default_access_period                int null,

    /* Payment terms */

    term_billing_descriptor                     nvarchar(255) null,

    payment_currency                            varchar(16) null,
    currency_symbol                             nvarchar(16) null,

    payment_allow_promo_codes                   bit null,

    payment_billing_plan                        nvarchar(max) null,
    payment_billing_plan_description            nvarchar(1000) null,

    payment_first_price                         decimal(19,6) null,

    verify_on_renewal                           bit null,
    payment_allow_renew_days                    int null,

    payment_new_customers_only                  bit null,
    payment_trial_new_customers_only            bit null,

    payment_renew_grace_period                  int null,

    payment_is_custom_price_available           bit null,
    payment_is_subscription                     bit null,
    payment_has_free_trial                      bit null,
    payment_force_auto_renew                    bit null,

    payment_allow_gift                          bit null,
    allow_renewable_gifting                     bit null,
    gift_redemption_url                         nvarchar(2000) null,

    evt_verification_period                     int null,

    product_category                            nvarchar(255) null,

    is_allowed_to_change_schedule_period_in_past bit null,

    billing_config                              varchar(100) null,

    allow_start_in_future                       bit null,
    maximum_days_in_advance                     int null,

    /* Complete original Piano Term object */

    term_json                                   nvarchar(max) null,

    extracted_at_utc                            datetime2(0) not null
        constraint df_terms_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Previous terms
   --------------------------------------------------------- */

create table dbo.previous_terms (
    row_id                                      bigint identity(1,1) not null
        constraint pk_previous_terms primary key,

    extract_run_id                              bigint null,

    aid                                         varchar(64) null,
    term_id                                     varchar(64) null,
    rid                                         varchar(64) null,

    name                                        nvarchar(500) null,
    description                                 nvarchar(max) null,

    type                                        varchar(100) null,
    type_name                                   nvarchar(255) null,

    create_date                                 bigint null,
    update_date                                 bigint null,

    shared_account_count                        int null,
    shared_redemption_url                       nvarchar(2000) null,
    collect_address                             bit null,

    registration_access_period                  int null,
    registration_grace_period                   int null,

    custom_require_user                         bit null,
    custom_default_access_period                int null,

    term_billing_descriptor                     nvarchar(255) null,

    payment_currency                            varchar(16) null,
    currency_symbol                             nvarchar(16) null,

    payment_allow_promo_codes                   bit null,

    payment_billing_plan                        nvarchar(max) null,
    payment_billing_plan_description            nvarchar(1000) null,

    payment_first_price                         decimal(19,6) null,

    verify_on_renewal                           bit null,
    payment_allow_renew_days                    int null,

    payment_new_customers_only                  bit null,
    payment_trial_new_customers_only            bit null,

    payment_renew_grace_period                  int null,

    payment_is_custom_price_available           bit null,
    payment_is_subscription                     bit null,
    payment_has_free_trial                      bit null,
    payment_force_auto_renew                    bit null,

    payment_allow_gift                          bit null,
    allow_renewable_gifting                     bit null,
    gift_redemption_url                         nvarchar(2000) null,

    evt_verification_period                     int null,

    product_category                            nvarchar(255) null,

    is_allowed_to_change_schedule_period_in_past bit null,

    billing_config                              varchar(100) null,

    allow_start_in_future                       bit null,
    maximum_days_in_advance                     int null,

    term_json                                   nvarchar(max) null,

    extracted_at_utc                            datetime2(0) not null
        constraint df_previous_terms_extracted_at
        default sysutcdatetime()
);


/* =========================================================
   TERM BILLING PLAN ROWS
   ========================================================= */


/* ---------------------------------------------------------
   Current payment_billing_plan_table rows

   Source:
   term.payment_billing_plan_table[]

   One row per object in the array.

   billing_plan_row_number preserves Piano's array order.

   Important:
   Several boolean-looking Piano values in this structure are
   actually returned as strings ("true"/"false"), so they are
   deliberately stored as varchar rather than bit.
   --------------------------------------------------------- */

create table dbo.term_billing_plan_rows (
    row_id                       bigint identity(1,1) not null
        constraint pk_term_billing_plan_rows primary key,

    extract_run_id               bigint null,

    term_id                      varchar(64) null,
    term_name                    nvarchar(500) null,

    billing_plan_row_number      int null,

    [date]                       nvarchar(100) null,
    date_value                   bigint null,

    period                       nvarchar(100) null,
    short_period                 nvarchar(100) null,
    payment_interval_unit        varchar(50) null,

    billing_without_tax          decimal(19,6) null,
    billing_period               nvarchar(100) null,

    price_charged_str            nvarchar(100) null,
    price_value                  decimal(19,6) null,

    cycles                       varchar(50) null,

    is_free_trial                varchar(10) null,
    is_trial                     varchar(10) null,
    is_pay_what_you_want         varchar(10) null,

    billing                      nvarchar(500) null,
    duration                     nvarchar(500) null,
    billing_info                 nvarchar(500) null,

    price_and_tax_in_minor_unit  bigint null,

    is_free                      varchar(10) null,

    price                        nvarchar(100) null,
    price_and_tax                decimal(19,6) null,

    currency                     varchar(16) null,

    total_billing                nvarchar(500) null,

    billing_plan_row_json        nvarchar(max) null,

    extracted_at_utc             datetime2(0) not null
        constraint df_term_billing_plan_rows_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Previous payment_billing_plan_table rows
   --------------------------------------------------------- */

create table dbo.previous_term_billing_plan_rows (
    row_id                       bigint identity(1,1) not null
        constraint pk_previous_term_billing_plan_rows primary key,

    extract_run_id               bigint null,

    term_id                      varchar(64) null,
    term_name                    nvarchar(500) null,

    billing_plan_row_number      int null,

    [date]                       nvarchar(100) null,
    date_value                   bigint null,

    period                       nvarchar(100) null,
    short_period                 nvarchar(100) null,
    payment_interval_unit        varchar(50) null,

    billing_without_tax          decimal(19,6) null,
    billing_period               nvarchar(100) null,

    price_charged_str            nvarchar(100) null,
    price_value                  decimal(19,6) null,

    cycles                       varchar(50) null,

    is_free_trial                varchar(10) null,
    is_trial                     varchar(10) null,
    is_pay_what_you_want         varchar(10) null,

    billing                      nvarchar(500) null,
    duration                     nvarchar(500) null,
    billing_info                 nvarchar(500) null,

    price_and_tax_in_minor_unit  bigint null,

    is_free                      varchar(10) null,

    price                        nvarchar(100) null,
    price_and_tax                decimal(19,6) null,

    currency                     varchar(16) null,

    total_billing                nvarchar(500) null,

    billing_plan_row_json        nvarchar(max) null,

    extracted_at_utc             datetime2(0) not null
        constraint df_previous_term_billing_plan_rows_extracted_at
        default sysutcdatetime()
);


/* =========================================================
   TERM CHANGE OPTIONS
   ========================================================= */


/* ---------------------------------------------------------
   Current term change options

   Source:
   term.change_options[]

   One row per TermChangeOption.

   change_option_number preserves Piano's array order.

   upgrade_offers is currently empty in all extracted records.
   It is retained as JSON rather than introducing an unused
   relational structure.

   advanced_options.show_options is expanded into the child
   table below.
   --------------------------------------------------------- */

create table dbo.term_change_options (
    row_id                    bigint identity(1,1) not null
        constraint pk_term_change_options primary key,

    extract_run_id            bigint null,

    term_id                   varchar(64) null,
    term_name                 nvarchar(500) null,

    change_option_number      int null,

    term_change_option_id     varchar(64) null,

    from_term_id              varchar(64) null,
    from_term_name            nvarchar(500) null,

    from_period_id            varchar(64) null,
    from_period_name          nvarchar(500) null,

    from_resource_id          varchar(64) null,
    from_resource_name        nvarchar(500) null,

    from_billing_plan         nvarchar(1000) null,

    to_term_id                varchar(64) null,
    to_term_name              nvarchar(500) null,

    to_period_id              varchar(64) null,
    to_period_name            nvarchar(500) null,

    to_resource_id            varchar(64) null,
    to_resource_name          nvarchar(500) null,

    to_billing_plan           nvarchar(1000) null,

    billing_timing            varchar(50) null,

    immediate_access          bit null,
    prorate_access            bit null,

    description               nvarchar(max) null,

    include_trial             bit null,

    to_scheduled              bit null,
    from_scheduled            bit null,

    shared_account_count      int null,
    collect_address           bit null,

    upgrade_offers_json       nvarchar(max) null,

    change_option_json        nvarchar(max) null,

    extracted_at_utc          datetime2(0) not null
        constraint df_term_change_options_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Previous term change options
   --------------------------------------------------------- */

create table dbo.previous_term_change_options (
    row_id                    bigint identity(1,1) not null
        constraint pk_previous_term_change_options primary key,

    extract_run_id            bigint null,

    term_id                   varchar(64) null,
    term_name                 nvarchar(500) null,

    change_option_number      int null,

    term_change_option_id     varchar(64) null,

    from_term_id              varchar(64) null,
    from_term_name            nvarchar(500) null,

    from_period_id            varchar(64) null,
    from_period_name          nvarchar(500) null,

    from_resource_id          varchar(64) null,
    from_resource_name        nvarchar(500) null,

    from_billing_plan         nvarchar(1000) null,

    to_term_id                varchar(64) null,
    to_term_name              nvarchar(500) null,

    to_period_id              varchar(64) null,
    to_period_name            nvarchar(500) null,

    to_resource_id            varchar(64) null,
    to_resource_name          nvarchar(500) null,

    to_billing_plan           nvarchar(1000) null,

    billing_timing            varchar(50) null,

    immediate_access          bit null,
    prorate_access            bit null,

    description               nvarchar(max) null,

    include_trial             bit null,

    to_scheduled              bit null,
    from_scheduled            bit null,

    shared_account_count      int null,
    collect_address           bit null,

    upgrade_offers_json       nvarchar(max) null,

    change_option_json        nvarchar(max) null,

    extracted_at_utc          datetime2(0) not null
        constraint df_previous_term_change_options_extracted_at
        default sysutcdatetime()
);


/* =========================================================
   TERM CHANGE OPTION SHOW OPTIONS
   ========================================================= */


/* ---------------------------------------------------------
   Current advanced_options.show_options rows

   Source:
   term.change_options[].advanced_options.show_options[]

   One row per string in show_options[].

   show_option_number preserves Piano's array order.
   --------------------------------------------------------- */

create table dbo.term_change_option_show_options (
    row_id                  bigint identity(1,1) not null
        constraint pk_term_change_option_show_options primary key,

    extract_run_id          bigint null,

    term_id                 varchar(64) null,
    term_change_option_id   varchar(64) null,

    show_option_number      int null,
    show_option             nvarchar(255) null,

    extracted_at_utc        datetime2(0) not null
        constraint df_term_change_option_show_options_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Previous advanced_options.show_options rows
   --------------------------------------------------------- */

create table dbo.previous_term_change_option_show_options (
    row_id                  bigint identity(1,1) not null
        constraint pk_previous_term_change_option_show_options primary key,

    extract_run_id          bigint null,

    term_id                 varchar(64) null,
    term_change_option_id   varchar(64) null,

    show_option_number      int null,
    show_option             nvarchar(255) null,

    extracted_at_utc        datetime2(0) not null
        constraint df_previous_term_change_option_show_options_extracted_at
        default sysutcdatetime()
);
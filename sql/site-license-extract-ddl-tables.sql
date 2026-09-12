/* =========================================================
   Drop existing tables so this script can be rerun
   ========================================================= */

drop table if exists dbo.contract_domain_users;
drop table if exists dbo.contract_domains;
drop table if exists dbo.contract_users;
drop table if exists dbo.contracts;
drop table if exists dbo.licensees;
drop table if exists dbo.extract_runs;


/* =========================================================
   Piano.io site-license extraction tables

   Design rules:
   - Preserve Piano source values as returned.
   - Do not deduplicate or consolidate source data.
   - Do not convert empty strings to NULL.
   - Do not convert epoch timestamps to datetime during load.
   - Keep naturally nested arrays as JSON where practical.
   - Avoid foreign keys and source-field UNIQUE constraints.
   - Internal row_id values are database-only identifiers.
   ========================================================= */


/* ---------------------------------------------------------
   Extraction run
   --------------------------------------------------------- */

create table dbo.extract_runs (
    extract_run_id       bigint identity(1,1) not null
        constraint pk_extract_runs primary key,

    run_name             nvarchar(255) null,
    started_at_utc       datetime2(0) not null
        constraint df_extract_runs_started_at
        default sysutcdatetime(),

    completed_at_utc     datetime2(0) null,
    status               varchar(30) null,
    notes                nvarchar(max) null
);


/* ---------------------------------------------------------
   Licensees

   Source:
   all-licensees.json

   representatives and managers remain as JSON arrays rather
   than being split into additional tables.
   --------------------------------------------------------- */

create table dbo.licensees (
    row_id                bigint identity(1,1) not null
        constraint pk_licensees primary key,

    extract_run_id        bigint null,

    aid                   varchar(64) null,
    licensee_id           varchar(64) null,
    name                  nvarchar(500) null,
    description           nvarchar(max) null,
    logo_url              nvarchar(2000) null,

    representatives_json  nvarchar(max) null,
    managers_json         nvarchar(max) null,

    extracted_at_utc      datetime2(0) not null
        constraint df_licensees_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Contracts

   Source:
   all-contracts.json

   contract_periods is deliberately retained as the exact
   nested JSON array returned under each contract.

   create_date remains the original Piano epoch value.
   --------------------------------------------------------- */

create table dbo.contracts (
    row_id                      bigint identity(1,1) not null
        constraint pk_contracts primary key,

    extract_run_id              bigint null,

    licensee_id                 varchar(64) null,
    licensee_name               nvarchar(500) null,

    contract_id                 varchar(64) null,
    aid                         varchar(64) null,
    name                        nvarchar(500) null,
    description                 nvarchar(max) null,

    create_date                 bigint null,
    landing_page_url            nvarchar(2000) null,

    seats_number                int null,
    is_hard_seats_limit_type    bit null,

    rid                         varchar(64) null,
    schedule_id                 varchar(64) null,

    contract_is_active          bit null,
    contract_type               varchar(100) null,

    contract_periods_json       nvarchar(max) null,

    contract_conversions_count  int null,

    extracted_at_utc            datetime2(0) not null
        constraint df_contracts_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Direct contract users

   Source:
   contract-users.json

   One database row per object in each users[] array.

   Wrapper-level licensee and contract information is
   intentionally repeated here rather than requiring joins.
   --------------------------------------------------------- */

create table dbo.contract_users (
    row_id             bigint identity(1,1) not null
        constraint pk_contract_users primary key,

    extract_run_id     bigint null,

    licensee_id        varchar(64) null,
    licensee_name      nvarchar(500) null,

    contract_id        varchar(64) null,
    contract_name      nvarchar(500) null,
    contract_type      varchar(100) null,

    contract_user_id   varchar(64) null,
    status             varchar(50) null,
    email              nvarchar(320) null,
    first_name         nvarchar(255) null,
    last_name          nvarchar(255) null,

    extracted_at_utc   datetime2(0) not null
        constraint df_contract_users_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Contract domains

   Source:
   contract-domains.json

   One database row per object in each domains[] array.
   --------------------------------------------------------- */

create table dbo.contract_domains (
    row_id                       bigint identity(1,1) not null
        constraint pk_contract_domains primary key,

    extract_run_id               bigint null,

    licensee_id                  varchar(64) null,
    licensee_name                nvarchar(500) null,

    contract_id                  varchar(64) null,
    contract_name                nvarchar(500) null,
    contract_type                varchar(100) null,

    contract_domain_id           varchar(64) null,
    status                       varchar(50) null,
    contract_domain_value        nvarchar(500) null,

    contract_users_count         int null,
    active_contract_users_count  int null,

    extracted_at_utc             datetime2(0) not null
        constraint df_contract_domains_extracted_at
        default sysutcdatetime()
);


/* ---------------------------------------------------------
   Domain users

   Source:
   contract_domain-users.json


   One database row per object in each users[] array.

   The complete nested "domain" object is also retained as
   domain_json so nothing from that portion of the extract
   needs to be reconstructed later.
   --------------------------------------------------------- */

create table dbo.contract_domain_users (
    row_id                  bigint identity(1,1) not null
        constraint pk_domain_users primary key,

    extract_run_id          bigint null,

    licensee_id             varchar(64) null,
    licensee_name           nvarchar(500) null,

    contract_id             varchar(64) null,
    contract_name           nvarchar(500) null,
    contract_type           varchar(100) null,

    contract_domain_id      varchar(64) null,
    contract_domain_value   nvarchar(500) null,

    domain_json             nvarchar(max) null,

    contract_user_id        varchar(64) null,
    status                  varchar(50) null,
    email                   nvarchar(320) null,
    first_name              nvarchar(255) null,
    last_name               nvarchar(255) null,

    extracted_at_utc        datetime2(0) not null
        constraint df_domain_users_extracted_at
        default sysutcdatetime()
);

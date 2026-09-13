drop table if exists dbo.previous_site_contract_domain_users;
drop table if exists dbo.previous_site_contract_domains;
drop table if exists dbo.previous_site_contract_users;
drop table if exists dbo.previous_site_contracts;
drop table if exists dbo.previous_site_licensees;

select top (0) *
into dbo.previous_site_licensees
from dbo.site_licensees;

select top (0) *
into dbo.previous_site_contracts
from dbo.site_contracts;

select top (0) *
into dbo.previous_site_contract_users
from dbo.site_contract_users;

select top (0) *
into dbo.previous_site_contract_domains
from dbo.site_contract_domains;

select top (0) *
into dbo.previous_site_contract_domain_users
from dbo.site_contract_domain_users;
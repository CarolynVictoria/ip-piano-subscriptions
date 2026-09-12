drop table if exists dbo.previous_contract_domain_users;
drop table if exists dbo.previous_contract_domains;
drop table if exists dbo.previous_contract_users;
drop table if exists dbo.previous_contracts;
drop table if exists dbo.previous_licensees;

select top (0) *
into dbo.previous_licensees
from dbo.licensees;

select top (0) *
into dbo.previous_contracts
from dbo.contracts;

select top (0) *
into dbo.previous_contract_users
from dbo.contract_users;

select top (0) *
into dbo.previous_contract_domains
from dbo.contract_domains;

select top (0) *
into dbo.previous_contract_domain_users
from dbo.contract_domain_users;
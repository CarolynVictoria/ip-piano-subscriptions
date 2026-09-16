IF EXISTS (
	SELECT *
	FROM sys.objects
	WHERE object_id = OBJECT_ID(N'[dbo].[access_granted]')
		AND type IN (N'U')
)
DROP TABLE [dbo].[access_granted]
GO

SET ANSI_NULLS ON
GO

SET QUOTED_IDENTIFIER ON
GO

CREATE TABLE [dbo].[access_granted](
	[access_id] [nvarchar](50) NULL,
	[term_conversion_id] [nvarchar](50) NULL,

	[user_uid] [nvarchar](50) NULL,
	[user_email] [nvarchar](max) NULL,
	[first_name] [nvarchar](max) NULL,
	[last_name] [nvarchar](max) NULL,
	[display_name] [nvarchar](max) NULL,

	[term_id] [nvarchar](50) NULL,
	[term_name] [nvarchar](max) NULL,
	[term_type] [nvarchar](50) NULL,
	[conversion_type] [nvarchar](50) NULL,

	[resource_id] [nvarchar](50) NULL,
	[resource_name] [nvarchar](max) NULL,

	[granted] [bit] NULL,
	[revoked] [bit] NULL,
	[start_date] [datetime] NULL,
	[expire_date] [datetime] NULL,

	[conversion_create_date] [datetime] NULL
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
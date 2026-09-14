function SummaryMetric({ label, value }) {
	return (
		<div className='rounded-md border border-base-300 bg-base-100 px-4 py-3'>
			<div className='text-sm opacity-65'>{label}</div>

			<div className='mt-1 text-2xl font-semibold'>
				{value.toLocaleString()}
			</div>
		</div>
	);
}

export default function SubscriptionsSummary({ summary, loading }) {
	const statuses = summary?.statuses ?? [];

	const plans = summary?.plans ?? {
		annual: 0,
		monthly: 0,
		quarterly: 0,
		siteLicenses: 0,
		other: 0,
	};

	const totalSubscriptionRecords = summary?.totalSubscriptionRecords ?? 0;

	return (
		<section className='mb-4 rounded-lg bg-base-100 p-4 shadow-sm'>
			<div className='mb-4 flex items-baseline justify-between gap-4'>
				<div>
					<h2 className='text-lg font-semibold'>Subscription Summary</h2>

					<p className='mt-1 text-sm opacity-65'>
						Current extracted Piano subscription data
					</p>
				</div>

				<div className='text-right'>
					<div className='text-sm opacity-65'>Subscription records</div>

					<div className='text-xl font-semibold'>
						{loading ? '—' : totalSubscriptionRecords.toLocaleString()}
					</div>
				</div>
			</div>

			<div>
				<h3 className='mb-2 text-sm font-semibold uppercase tracking-wide opacity-60'>
					Status
				</h3>

				<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6'>
					{statuses.map((status) => (
						<SummaryMetric
							key={status.value}
							label={status.value}
							value={status.count}
						/>
					))}
				</div>
			</div>

			<div className='mt-5'>
				<h3 className='mb-2 text-sm font-semibold uppercase tracking-wide opacity-60'>
					Plan Type
				</h3>

				<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5'>
					<SummaryMetric label='Annual' value={plans.annual} />

					<SummaryMetric label='Monthly' value={plans.monthly} />

					<SummaryMetric label='Quarterly' value={plans.quarterly} />

					<SummaryMetric label='Site Licenses' value={plans.siteLicenses} />

					{plans.other > 0 && (
						<SummaryMetric label='Other' value={plans.other} />
					)}
				</div>
			</div>
		</section>
	);
}

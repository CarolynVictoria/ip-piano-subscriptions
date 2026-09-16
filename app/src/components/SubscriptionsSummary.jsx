import { useState } from 'react';

const EMPTY_WONT_RENEW_BREAKDOWN = {
	annual: 0,
	monthly: 0,
	quarterly: 0,
};

const EMPTY_PLANS = {
	annual: 0,
	monthly: 0,
	quarterly: 0,
	wontRenew: 0,
	wontRenewBreakdown: EMPTY_WONT_RENEW_BREAKDOWN,
};

const EMPTY_SUBSCRIPTION_TYPES = {
	singleUser: 0,
	sharedSubscription: 0,
	siteLicense: 0,
	accessGranted: 0,
};

const EMPTY_SHARED_SUBSCRIPTION_CHILDREN = {
	invited: 0,
	redeemed: 0,
	total: 0,
};

function SummaryMetric({ label, value = 0 }) {
	return (
		<div className='rounded-md border border-base-300 bg-base-100 px-4 py-3'>
			<div className='text-sm opacity-65'>{label}</div>

			<div className='mt-1 text-2xl font-semibold'>
				{Number(value ?? 0).toLocaleString()}
			</div>
		</div>
	);
}

function WontRenewMetric({ value = 0, breakdown }) {
	const [expanded, setExpanded] = useState(false);

	const safeBreakdown = {
		...EMPTY_WONT_RENEW_BREAKDOWN,
		...(breakdown ?? {}),
	};

	return (
		<div className='rounded-md border border-base-300 bg-base-100 px-4 py-3'>
			<div className='flex items-start justify-between gap-3'>
				<div>
					<div className='text-sm opacity-65'>Won&apos;t Renew</div>

					<div className='mt-1 text-2xl font-semibold'>
						{Number(value ?? 0).toLocaleString()}
					</div>
				</div>

				<button
					type='button'
					className='btn btn-ghost btn-sm btn-square'
					aria-label={
						expanded
							? "Hide Won't Renew breakdown"
							: "Show Won't Renew breakdown"
					}
					aria-expanded={expanded}
					onClick={() => setExpanded((current) => !current)}
				>
					<span
						className={`text-lg transition-transform ${
							expanded ? 'rotate-180' : ''
						}`}
						aria-hidden='true'
					>
						⌄
					</span>
				</button>
			</div>

			{expanded && (
				<div className='mt-3 border-t border-base-300 pt-3'>
					<div className='flex items-center justify-between gap-3 text-sm'>
						<span className='opacity-65'>Annual</span>

						<span className='font-medium'>
							{Number(safeBreakdown.annual).toLocaleString()}
						</span>
					</div>

					<div className='mt-2 flex items-center justify-between gap-3 text-sm'>
						<span className='opacity-65'>Monthly</span>

						<span className='font-medium'>
							{Number(safeBreakdown.monthly).toLocaleString()}
						</span>
					</div>

					<div className='mt-2 flex items-center justify-between gap-3 text-sm'>
						<span className='opacity-65'>Quarterly</span>

						<span className='font-medium'>
							{Number(safeBreakdown.quarterly).toLocaleString()}
						</span>
					</div>
				</div>
			)}
		</div>
	);
}

function statusLabel(value) {
	if (value === 'completed') {
		return "completed (won't renew)";
	}

	return value;
}

export default function SubscriptionsSummary({
	summary,
	loading,
	planView,
	onPlanViewChange,
}) {
	const allSummary = {
		totalSubscriptionRecords: 0,
		statuses: [],
		plans: EMPTY_PLANS,
		subscriptionTypes: EMPTY_SUBSCRIPTION_TYPES,
		...(summary?.all ?? {}),
	};

	const activeSummary = {
		totalSubscriptionRecords: 0,
		statuses: [],
		plans: EMPTY_PLANS,
		subscriptionTypes: EMPTY_SUBSCRIPTION_TYPES,
		...(summary?.active ?? {}),
	};

	const statuses = allSummary.statuses ?? [];

	const selectedSummary = planView === 'active' ? activeSummary : allSummary;

	const plans = {
		...EMPTY_PLANS,
		...(selectedSummary.plans ?? {}),
		wontRenewBreakdown: {
			...EMPTY_WONT_RENEW_BREAKDOWN,
			...(selectedSummary.plans?.wontRenewBreakdown ?? {}),
		},
	};

	const subscriptionTypes = {
		...EMPTY_SUBSCRIPTION_TYPES,
		...(selectedSummary.subscriptionTypes ?? {}),
	};

	const sharedSubscriptionChildren = {
		...EMPTY_SHARED_SUBSCRIPTION_CHILDREN,
		...(selectedSummary.sharedSubscriptionChildren ?? {}),
	};

	const renewalTotal =
		Number(plans.annual ?? 0) +
		Number(plans.monthly ?? 0) +
		Number(plans.quarterly ?? 0) +
		Number(plans.wontRenew ?? 0);

	const subscriptionTypeTotal =
		Number(subscriptionTypes.singleUser ?? 0) +
		Number(subscriptionTypes.sharedSubscription ?? 0) +
		Number(subscriptionTypes.siteLicense ?? 0) +
		Number(subscriptionTypes.accessGranted ?? 0);

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
						{loading
							? '—'
							: Number(
									allSummary.totalSubscriptionRecords ?? 0,
								).toLocaleString()}
					</div>
				</div>
			</div>

			<div>
				<div className='mb-2'>
					<h3 className='text-sm font-semibold uppercase tracking-wide opacity-60'>
						Status
					</h3>

					<p className='mt-1 text-sm opacity-65'>API Realtime Statistics</p>
				</div>

				<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6'>
					{statuses.map((status) => (
						<SummaryMetric
							key={status.value}
							label={statusLabel(status.value)}
							value={status.count}
						/>
					))}
				</div>
			</div>

			<div className='mt-5'>
				<div className='mb-2 flex items-center justify-between gap-4'>
					<h3 className='text-sm font-semibold uppercase tracking-wide opacity-60'>
						Renewal Type
					</h3>

					<div className='join'>
						<button
							type='button'
							className={`btn btn-sm join-item ${
								planView === 'active' ? 'btn-active' : ''
							}`}
							onClick={() => onPlanViewChange('active')}
						>
							Active Only
						</button>

						<button
							type='button'
							className={`btn btn-sm join-item ${
								planView === 'all' ? 'btn-active' : ''
							}`}
							onClick={() => onPlanViewChange('all')}
						>
							All
						</button>
					</div>
				</div>

				<div className='grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-5'>
					<SummaryMetric label='Annual' value={plans.annual} />

					<SummaryMetric label='Monthly' value={plans.monthly} />

					<SummaryMetric label='Quarterly' value={plans.quarterly} />

					<WontRenewMetric
						value={plans.wontRenew}
						breakdown={plans.wontRenewBreakdown}
					/>

					<SummaryMetric label='Total' value={renewalTotal} />
				</div>
			</div>

			<div className='mt-5'>
				<h3 className='mb-2 text-sm font-semibold uppercase tracking-wide opacity-60'>
					Subscription Type
				</h3>

				<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-5'>
					<SummaryMetric
						label='Single User'
						value={subscriptionTypes.singleUser}
					/>

					<SummaryMetric
						label='Shared Subscription'
						value={subscriptionTypes.sharedSubscription}
					/>

					<SummaryMetric
						label='Site License'
						value={subscriptionTypes.siteLicense}
					/>

					<SummaryMetric
						label='Access Granted'
						value={subscriptionTypes.accessGranted}
					/>

					<SummaryMetric label='Total' value={subscriptionTypeTotal} />
				</div>
			</div>

			<div className='mt-5'>
				<h3 className='mb-2 text-sm font-semibold uppercase tracking-wide opacity-60'>
					Shared Subscription Child Accounts
				</h3>

				<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
					<SummaryMetric
						label='Redeemed'
						value={sharedSubscriptionChildren.redeemed}
					/>

					<SummaryMetric
						label='Invited Not Redeemed'
						value={sharedSubscriptionChildren.invited}
					/>

					<SummaryMetric
						label='Total Shared Subscription Child Accounts'
						value={sharedSubscriptionChildren.total}
					/>
				</div>
			</div>
		</section>
	);
}

import { useEffect, useState } from 'react';
import { getSubscriptions } from '../lib/api.js';
import SubscriptionsSummary from '../components/SubscriptionsSummary.jsx';

const DEFAULT_PAGE_SIZE = 25;

function formatDate(unixSeconds) {
	if (unixSeconds === null || unixSeconds === undefined || unixSeconds === '') {
		return '—';
	}

	const value = Number(unixSeconds);

	if (!Number.isFinite(value)) {
		return String(unixSeconds);
	}

	const date = new Date(value * 1000);

	if (Number.isNaN(date.getTime())) {
		return String(unixSeconds);
	}

	return new Intl.DateTimeFormat('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	}).format(date);
}

function getSubscriberName(subscription) {
	if (subscription.user_personal_name?.trim()) {
		return subscription.user_personal_name.trim();
	}

	const name = [subscription.user_first_name, subscription.user_last_name]
		.filter(Boolean)
		.join(' ')
		.trim();

	return name || '—';
}

function getStatusLabel(subscription) {
	return subscription.status_name || subscription.status || '—';
}

export default function SubscriptionsPage() {
	const [subscriptions, setSubscriptions] = useState([]);

	const [summary, setSummary] = useState({
		all: {
			totalSubscriptionRecords: 0,
			statuses: [],
			plans: {
				annual: 0,
				monthly: 0,
				quarterly: 0,
				siteLicenses: 0,
				other: 0,
			},
		},

		active: {
			totalSubscriptionRecords: 0,
			statuses: [],
			plans: {
				annual: 0,
				monthly: 0,
				quarterly: 0,
				siteLicenses: 0,
				other: 0,
			},
		},
	});

	/* Begin refactor for clickable summary cards. */
	const [summaryView, setSummaryView] = useState('active');
	const [renewalType, setRenewalType] = useState('');

	/*
	 * Active Only / All controls the scope of a drill-down.
	 *
	 * With no drill-down selected, preserve the existing grid behavior
	 * by requesting all subscriptions.
	 */
	const subscriptionScope = renewalType ? summaryView : 'all';

	/* End refactor for clickable summary cards. */

	const [pagination, setPagination] = useState({
		page: 1,
		pageSize: DEFAULT_PAGE_SIZE,
		total: 0,
		totalPages: 0,
	});

	const [statusOptions, setStatusOptions] = useState([]);

	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

	const [searchInput, setSearchInput] = useState('');
	const [search, setSearch] = useState('');

	const [status, setStatus] = useState('');

	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');

	useEffect(() => {
		const controller = new AbortController();

		async function loadSubscriptions() {
			setLoading(true);
			setError('');

			try {
				const data = await getSubscriptions({
					page,
					pageSize,
					q: search,
					status,
					scope: subscriptionScope,
					renewalType,
					signal: controller.signal,
				});

				setSubscriptions(data.items ?? []);

				setSummary(
					data.summary ?? {
						all: {
							totalSubscriptionRecords: 0,
							statuses: [],
							plans: {
								annual: 0,
								monthly: 0,
								quarterly: 0,
								siteLicenses: 0,
								other: 0,
							},
						},

						active: {
							totalSubscriptionRecords: 0,
							statuses: [],
							plans: {
								annual: 0,
								monthly: 0,
								quarterly: 0,
								siteLicenses: 0,
								other: 0,
							},
						},
					},
				);

				setPagination(
					data.pagination ?? {
						page,
						pageSize,
						total: 0,
						totalPages: 0,
					},
				);

				setStatusOptions(data.filterOptions?.status ?? []);
			} catch (loadError) {
				if (loadError.name === 'AbortError') {
					return;
				}

				console.error('Could not load subscriptions:', loadError);

				setSubscriptions([]);

				setError(loadError.message || 'Could not load subscriptions.');
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			}
		}

		loadSubscriptions();

		return () => {
			controller.abort();
		};
	}, [page, pageSize, search, status, subscriptionScope, renewalType]);

	function handleSummaryViewChange(value) {
		setSummaryView(value);

		if (renewalType) {
			setPage(1);
		}
	}

	function handleRenewalTypeChange(value) {
		setRenewalType(value);
		setPage(1);
	}

	function handleClearRenewalType() {
		setRenewalType('');
		setPage(1);
	}

	function handleSearchSubmit(event) {
		event.preventDefault();

		setPage(1);
		setSearch(searchInput.trim());
	}

	function handleClearSearch() {
		setSearchInput('');
		setSearch('');
		setPage(1);
	}

	function handleStatusChange(event) {
		setStatus(event.target.value);
		setPage(1);
	}

	function handlePageSizeChange(event) {
		setPageSize(Number(event.target.value));
		setPage(1);
	}

	function handlePreviousPage() {
		setPage((currentPage) => Math.max(1, currentPage - 1));
	}

	function handleNextPage() {
		setPage((currentPage) => {
			if (pagination.totalPages === 0) {
				return currentPage;
			}

			return Math.min(pagination.totalPages, currentPage + 1);
		});
	}

	const hasPreviousPage = page > 1;

	const hasNextPage = pagination.totalPages > 0 && page < pagination.totalPages;

	return (
		<main className='min-h-screen bg-base-200'>
			<div className='mx-auto max-w-screen-2xl p-6'>
				<div className='mb-6'>
					<h1 className='text-3xl font-semibold'>
						Inside Philanthropy Paywall Subscriptions
					</h1>
				</div>

				<SubscriptionsSummary
					summary={summary}
					loading={loading}
					planView={summaryView}
					onPlanViewChange={handleSummaryViewChange}
					selectedRenewalType={renewalType}
					onRenewalTypeChange={handleRenewalTypeChange}
					onClearRenewalType={handleClearRenewalType}
				/>

				<div className='mb-4 rounded-lg bg-base-100 p-4 shadow-sm'>
					<div className='flex flex-col gap-4 lg:flex-row lg:items-end'>
						<form
							className='flex flex-1 flex-col gap-2 sm:flex-row sm:items-end'
							onSubmit={handleSearchSubmit}
						>
							<label className='form-control flex-1'>
								<span className='mb-1 text-sm font-medium'>Name or email</span>

								<input
									type='search'
									className='input input-bordered w-full'
									value={searchInput}
									onChange={(event) => setSearchInput(event.target.value)}
									placeholder='Search subscriptions'
								/>
							</label>

							<div className='flex gap-2'>
								<button
									type='submit'
									className='btn border-[#2d6ed8] bg-[#2d6ed8] text-white hover:border-[#245bb3] hover:bg-[#245bb3]'
								>
									Search
								</button>

								{search && (
									<button
										type='button'
										className='btn'
										onClick={handleClearSearch}
									>
										Clear
									</button>
								)}
							</div>
						</form>

						<label className='form-control'>
							<span className='mb-1 text-sm font-medium'>Status</span>

							<select
								className='select select-bordered min-w-52'
								value={status}
								onChange={handleStatusChange}
							>
								<option value=''>All Status</option>

								{statusOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.value} ({option.count.toLocaleString()})
									</option>
								))}
							</select>
						</label>

						<label className='form-control'>
							<span className='mb-1 text-sm font-medium'>Rows</span>

							<select
								className='select select-bordered'
								value={pageSize}
								onChange={handlePageSizeChange}
							>
								<option value='25'>25</option>
								<option value='50'>50</option>
								<option value='100'>100</option>
								<option value='500'>500</option>
								<option value='1000'>1000</option>
							</select>
						</label>
					</div>
				</div>

				{error && (
					<div className='alert alert-error mb-4' role='alert'>
						<span>{error}</span>
					</div>
				)}

				<div className='overflow-hidden rounded-lg bg-base-100 shadow-sm'>
					<div className='overflow-x-auto'>
						<table className='table'>
							<thead>
								<tr>
									<th>Subscriber</th>
									<th>Status</th>
									<th>Plan</th>
									<th>Start</th>
									<th>Next Bill</th>
									<th>Auto Renew</th>
								</tr>
							</thead>

							<tbody>
								{loading ? (
									<tr>
										<td colSpan='6' className='py-10 text-center'>
											<span className='loading loading-spinner loading-md' />
											<span className='ml-3'>Loading subscriptions...</span>
										</td>
									</tr>
								) : subscriptions.length === 0 ? (
									<tr>
										<td colSpan='6' className='py-10 text-center opacity-70'>
											No subscriptions found.
										</td>
									</tr>
								) : (
									subscriptions.map((subscription) => (
										<tr key={subscription.subscription_id}>
											<td>
												<div className='font-medium'>
													{getSubscriberName(subscription)}
												</div>

												<div className='text-sm opacity-70'>
													{subscription.user_email || '—'}
												</div>

												<div className='mt-1 font-mono text-xs opacity-50'>
													{subscription.subscription_id}
												</div>
											</td>

											<td>{getStatusLabel(subscription)}</td>

											<td>{subscription.billing_plan || '—'}</td>

											<td className='whitespace-nowrap'>
												{formatDate(subscription.start_date)}
											</td>

											<td className='whitespace-nowrap'>
												{formatDate(subscription.next_bill_date)}
											</td>

											<td>
												{subscription.auto_renew === true
													? 'Yes'
													: subscription.auto_renew === false
														? 'No'
														: '—'}
											</td>
										</tr>
									))
								)}
							</tbody>
						</table>
					</div>

					<div className='flex flex-col gap-3 border-t border-base-300 p-4 sm:flex-row sm:items-center sm:justify-between'>
						<div className='text-sm opacity-70'>
							{loading ? (
								'Loading...'
							) : (
								<>{pagination.total.toLocaleString()} subscriptions</>
							)}
						</div>

						<div className='flex items-center gap-3'>
							<button
								type='button'
								className='btn btn-sm'
								onClick={handlePreviousPage}
								disabled={loading || !hasPreviousPage}
							>
								Previous
							</button>

							<span className='min-w-32 text-center text-sm'>
								Page {pagination.page}
								{' of '}
								{pagination.totalPages || 0}
							</span>

							<button
								type='button'
								className='btn btn-sm'
								onClick={handleNextPage}
								disabled={loading || !hasNextPage}
							>
								Next
							</button>
						</div>
					</div>
				</div>
			</div>
		</main>
	);
}

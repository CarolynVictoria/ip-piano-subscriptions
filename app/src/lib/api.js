export class ApiError extends Error {
	constructor(message, status, body = null) {
		super(message);

		this.name = 'ApiError';
		this.status = status;
		this.body = body;
	}
}

export async function getSubscriptions({
	page = 1,
	pageSize = 25,
	q = '',
	status = '',
	signal,
} = {}) {
	const params = new URLSearchParams();

	params.set('page', String(page));
	params.set('pageSize', String(pageSize));

	const trimmedSearch = q.trim();

	if (trimmedSearch) {
		params.set('q', trimmedSearch);
	}

	if (status) {
		params.set('status', status);
	}

	const response = await fetch(`/api/subscriptions?${params.toString()}`, {
		method: 'GET',

		headers: {
			Accept: 'application/json',
		},

		signal,
	});

	let body = null;

	try {
		body = await response.json();
	} catch {
		// Leave body as null if the server did not return JSON.
	}

	if (!response.ok) {
		const message =
			body?.error ||
			`Subscription request failed with HTTP ${response.status}.`;

		throw new ApiError(message, response.status, body);
	}

	if (!body || body.ok !== true) {
		throw new ApiError(
			'The subscription API returned an unexpected response.',
			response.status,
			body,
		);
	}

	return body;
}
